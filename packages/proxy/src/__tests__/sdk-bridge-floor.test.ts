/**
 * The floor for non-Claude-Code clients: an official Anthropic account may
 * serve such a request only through the SDK bridge. With a bridge available the
 * account stays a candidate and its attempt goes to the bridge instead of a
 * direct fetch; without one the account is excluded exactly as before.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	type Account,
	type ChatRequirements,
	type ModelAlias,
	SdkBridgeCapacityError,
	SdkBridgeUnavailableError,
	setChatContext,
	setNativeResponsesRequestContext,
} from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import { setForcedAccount } from "../handlers";
import * as rateLimitCooldown from "../handlers/rate-limit-cooldown";
import {
	markCapacityRestoredProbePending,
	resetRateLimitProbeGatesForTests,
} from "../handlers/rate-limit-cooldown";
import * as tokenManager from "../handlers/token-manager";
import { clearAliasAffinity } from "../model-alias-routing";
import { getProviderOverloadUntil } from "../provider-overload-cooldown";
import { handleProxy } from "../proxy";
import { CLIENT_REQUEST_ID_HEADER } from "../response-handler";
import { provisionRouting, routingAttempts } from "./fixtures/routing-harness";
import {
	type BridgeHarness,
	type FakeBridge,
	makeBridgeAccount,
	makeBridgeHarness,
	makeFakeBridge,
	messagesRequest,
} from "./fixtures/sdk-bridge-harness";

const MODEL = "claude-sonnet-4-5";
const KEY = "key-pi";
const realAdmission = rateLimitCooldown.getRateLimitProbeAdmission;
const URL_ = new URL("https://proxy.local/v1/messages");

const claudeA = () => makeBridgeAccount({ id: "claude-a", name: "A" });
const claudeB = () => makeBridgeAccount({ id: "claude-b", name: "B" });
/** Not an official Anthropic provider; served by the context's mock provider. */
const other = () =>
	makeBridgeAccount({
		id: "other",
		name: "Other",
		provider: "test-provider" as Account["provider"],
	});

/** A request as the Responses adapter hands it over: floored in-process. */
function flooredRequest(
	body: Record<string, unknown> = {},
	headers: Record<string, string> = {},
): Request {
	const req = messagesRequest(body, headers);
	setNativeResponsesRequestContext(req, {
		nativeBody: JSON.stringify({ model: body.model ?? MODEL }),
		denyDirectOfficialAnthropic: true,
	});
	return req;
}

let harness: BridgeHarness | null = null;
afterEach(() => {
	harness?.restore();
	harness = null;
	setForcedAccount(null);
	clearAliasAffinity();
	for (const spy of spies.splice(0)) spy.mockRestore();
});

const spies: Array<{ mockRestore: () => void }> = [];
function spyAccountHandling() {
	const token = spyOn(tokenManager, "getValidAccessToken");
	const stage = spyOn(cacheBodyStore, "stageRequest");
	spies.push(token, stage);
	return { token, stage };
}

async function run(req: Request, ctx: BridgeHarness["ctx"], apiKeyId = KEY) {
	const response = await handleProxy(req, URL_, ctx, apiKeyId, "pi-key");
	const text = await response.text();
	return { response, text };
}

function sends(h: BridgeHarness) {
	return routingAttempts(h.ctx).filter((r) => r.kind === "upstream_send");
}

describe("SDK bridge floor without a bridge", () => {
	it("excludes official Anthropic accounts, naming why", async () => {
		harness = await makeBridgeHarness([claudeA()]);

		const { response, text } = await run(flooredRequest(), harness.ctx);

		expect(response.status).toBe(403);
		expect(JSON.parse(text).error.message).toContain(
			"only through the SDK bridge, which is unavailable (not configured)",
		);
		expect(harness.upstreamKeys).toEqual([]);
	});

	it("still serves the request from a non-Anthropic candidate", async () => {
		harness = await makeBridgeHarness([claudeA(), other()]);

		const { response } = await run(flooredRequest(), harness.ctx);

		expect(response.status).toBe(200);
		expect(sends(harness).map((r) => r.account_id)).toEqual(["other"]);
	});

	it("names the unavailable reason the bridge reports", async () => {
		const bridge = makeFakeBridge();
		bridge.state = { state: "unavailable", reason: "compiled binary" };
		harness = await makeBridgeHarness([claudeA()], { bridge });

		const { response, text } = await run(flooredRequest(), harness.ctx);

		expect(response.status).toBe(403);
		expect(JSON.parse(text).error.message).toContain("(compiled binary)");
		expect(bridge.starts).toEqual([]);
	});
});

describe("SDK bridge floor with a bridge", () => {
	it("sends the attempt to the bridge instead of fetching, with no account handling", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA(), claudeB()], { bridge });
		const { token, stage } = spyAccountHandling();

		const { response, text } = await run(
			flooredRequest({}, { authorization: "Bearer client-secret" }),
			harness.ctx,
		);

		expect(response.status).toBe(200);
		expect(JSON.parse(text).content[0].text).toBe("from the bridge");
		expect(harness.upstreamKeys).toEqual([]);
		expect(token).not.toHaveBeenCalled();
		expect(stage).not.toHaveBeenCalled();
		expect(harness.ctx.requestRecorder.begin).not.toHaveBeenCalled();
		expect(bridge.starts).toHaveLength(1);
		const [start] = bridge.starts;
		expect(start.body.model).toBe(MODEL);
		expect(start.request.headers.get("authorization")).toBeNull();
		expect(response.headers.get(CLIENT_REQUEST_ID_HEADER)).toBe(
			start.meta.legId,
		);
		expect(start.meta.apiKeyId).toBe(KEY);
		const [send] = sends(harness);
		expect(send.account_id).toBe("claude-a");
		expect(send.outgoing_model).toBe(MODEL);
		expect(send.status).toBe(200);
	});

	it("freezes a plan of the official Anthropic candidates in order", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([other(), claudeB(), claudeA()], {
			bridge,
			upstream: () => new Response("down", { status: 500 }),
		});

		await run(flooredRequest(), harness.ctx);

		expect(sends(harness).map((r) => r.account_id)).toEqual([
			"other",
			"claude-b",
		]);
		const [{ plan }] = bridge.starts;
		expect(plan.candidates).toEqual([
			{ accountId: "claude-b", provider: "anthropic", upstreamModel: MODEL },
			{ accountId: "claude-a", provider: "anthropic", upstreamModel: MODEL },
		]);
		expect(plan.preferredAccountId).toBe("claude-b");
		expect(plan.apiKeyId).toBe(KEY);
		expect(plan.turnId).toMatch(/^[0-9a-f-]{36}$/);
		expect(JSON.parse(plan.routeSnapshot ?? "{}").requestedModel).toBe(MODEL);
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.candidates)).toBe(true);
	});

	it("fetches a non-Anthropic first candidate directly", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([other(), claudeA()], { bridge });

		const { response } = await run(flooredRequest(), harness.ctx);

		expect(response.status).toBe(200);
		expect(sends(harness).map((r) => r.account_id)).toEqual(["other"]);
		expect(bridge.starts).toEqual([]);
	});

	it("returns a bridge 429 or 529 as final: no failover, no cooldown", async () => {
		for (const status of [429, 529]) {
			const bridge = makeFakeBridge(
				() =>
					new Response(
						JSON.stringify({
							type: "error",
							error: { type: "rate_limit_error" },
						}),
						{
							status,
							headers: {
								"content-type": "application/json",
								"retry-after": "42",
							},
						},
					),
			);
			const a = claudeA();
			harness = await makeBridgeHarness([a, claudeB(), other()], { bridge });

			const { response } = await run(flooredRequest(), harness.ctx);

			expect(response.status).toBe(status);
			expect(response.headers.get("retry-after")).toBe("42");
			expect(bridge.starts).toHaveLength(1);
			expect(harness.upstreamKeys).toEqual([]);
			expect(sends(harness)).toHaveLength(1);
			expect(harness.ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
			expect(a.rate_limited_until ?? null).toBeNull();
			expect(
				getProviderOverloadUntil("anthropic", Date.now(), MODEL),
			).toBeNull();
			harness.restore();
		}
	});

	it("fails over to the next candidate when the bridge cannot run the turn", async () => {
		const bridge = makeFakeBridge(() => {
			throw new SdkBridgeUnavailableError("process cap reached");
		});
		harness = await makeBridgeHarness([claudeA(), other()], { bridge });

		const { response } = await run(flooredRequest(), harness.ctx);

		expect(response.status).toBe(200);
		expect(bridge.starts).toHaveLength(1);
		const rows = sends(harness);
		expect(rows.map((r) => r.account_id)).toEqual(["claude-a", "other"]);
		expect(rows[0].status).toBe(503);
		expect(rows[0].error).toContain("process cap reached");
	});

	it("fails over when the bridge starts shutting down after admission", async () => {
		const bridge = makeFakeBridge();
		let reads = 0;
		bridge.availability = () =>
			++reads === 1 ? { state: "available" } : { state: "shutting_down" };
		harness = await makeBridgeHarness([claudeA(), other()], { bridge });

		const { response } = await run(flooredRequest(), harness.ctx);

		expect(response.status).toBe(200);
		expect(bridge.starts).toEqual([]);
		expect(sends(harness).map((r) => r.account_id)).toEqual(["other"]);
	});

	describe("at the bridge's capacity", () => {
		const atCapacity = () =>
			makeFakeBridge(() => {
				throw new SdkBridgeCapacityError({
					reason: "process_cap",
					status: 529,
					type: "overloaded_error",
					message: "The SDK bridge is running its maximum of 8 processes",
					retryAfter: "10",
				});
			});

		it("fails over to the next candidate", async () => {
			const bridge = atCapacity();
			harness = await makeBridgeHarness([claudeA(), other()], { bridge });

			const { response } = await run(flooredRequest(), harness.ctx);

			expect(response.status).toBe(200);
			const rows = sends(harness);
			expect(rows.map((r) => r.account_id)).toEqual(["claude-a", "other"]);
			expect(rows[0].status).toBe(529);
		});

		it("answers its 529 and Retry-After when no other candidate serves", async () => {
			const bridge = atCapacity();
			harness = await makeBridgeHarness([claudeA(), claudeB()], { bridge });

			const { response, text } = await run(flooredRequest(), harness.ctx);

			expect(response.status).toBe(529);
			expect(response.headers.get("retry-after")).toBe("10");
			expect(JSON.parse(text).error).toEqual({
				type: "overloaded_error",
				message: "The SDK bridge is running its maximum of 8 processes",
			});
			// One refusal is enough: the second official candidate is the same bridge.
			expect(bridge.starts).toHaveLength(1);
			expect(harness.upstreamKeys).toEqual([]);
			const recorded = harness.ctx.requestRecorder
				.recordSynthetic as ReturnType<typeof spyOn>;
			expect(recorded.mock.calls[0]?.[2]).toBe("sdk_bridge_capacity");
		});

		it("answers its 529 when it was the last candidate to fail", async () => {
			const bridge = atCapacity();
			harness = await makeBridgeHarness([other(), claudeA()], {
				bridge,
				upstream: () => new Response("down", { status: 500 }),
			});

			const { response } = await run(flooredRequest(), harness.ctx);

			expect(response.status).toBe(529);
			expect(sends(harness).map((r) => r.account_id)).toEqual([
				"other",
				"claude-a",
			]);
		});

		it("answers a forced official account with the 529 directly", async () => {
			const bridge = atCapacity();
			harness = await makeBridgeHarness([claudeA(), other()], { bridge });
			setForcedAccount("claude-a");

			const { response } = await run(flooredRequest(), harness.ctx);

			expect(response.status).toBe(529);
			expect(response.headers.get("retry-after")).toBe("10");
			expect(response.headers.get("x-clankermux-forced-account")).toBe(
				"claude-a",
			);
			expect(harness.upstreamKeys).toEqual([]);
		});

		it("answers its 529 after the last alias stage, not the alias 503", async () => {
			const bridge = atCapacity();
			const a = claudeA();
			const o = other();
			harness = await makeBridgeHarness([o, a], {
				bridge,
				model: "alias:mixed",
				upstream: () => new Response("down", { status: 503 }),
			});
			const alias: ModelAlias = {
				id: "alias:mixed",
				displayName: "Mixed",
				revision: 0,
				targets: [
					{ model: "gpt-x", accountIds: [o.id] },
					{ model: MODEL, accountIds: [a.id] },
				],
			};
			Object.assign(harness.ctx.dbOps, {
				modelAliases: { get: async () => alias },
			});
			await provisionRouting(harness.ctx, "gpt-x");
			await provisionRouting(harness.ctx, MODEL);

			const { response } = await run(
				flooredRequest({ model: "alias:mixed" }),
				harness.ctx,
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("retry-after")).toBe("10");
			expect(bridge.starts).toHaveLength(1);
		});
	});

	it("bridges an alias stage that lands on Claude, planning that stage only", async () => {
		const bridge = makeFakeBridge();
		const a = claudeA();
		const o = other();
		harness = await makeBridgeHarness([o, a], {
			bridge,
			model: "alias:mixed",
			upstream: () => new Response("down", { status: 503 }),
		});
		const alias: ModelAlias = {
			id: "alias:mixed",
			displayName: "Mixed",
			revision: 0,
			targets: [
				{ model: "gpt-x", accountIds: [o.id] },
				{ model: MODEL, accountIds: [a.id] },
			],
		};
		Object.assign(harness.ctx.dbOps, {
			modelAliases: { get: async () => alias },
		});
		await provisionRouting(harness.ctx, "gpt-x");
		await provisionRouting(harness.ctx, MODEL);

		const { response } = await run(
			flooredRequest({ model: "alias:mixed" }),
			harness.ctx,
		);

		expect(response.status).toBe(200);
		expect(sends(harness).map((r) => r.account_id)).toEqual([o.id, a.id]);
		const [{ plan, body }] = bridge.starts;
		expect(body.model).toBe(MODEL);
		expect(plan.candidates).toEqual([
			{ accountId: a.id, provider: "anthropic", upstreamModel: MODEL },
		]);
		expect(JSON.parse(plan.routeSnapshot ?? "{}").alias.targetIndex).toBe(1);
	});

	it("serves a globally forced official account through the bridge", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA(), other()], { bridge });
		setForcedAccount("claude-a");

		const { response } = await run(flooredRequest(), harness.ctx);

		expect(response.status).toBe(200);
		expect(harness.upstreamKeys).toEqual([]);
		expect(bridge.starts[0].plan.candidates.map((c) => c.accountId)).toEqual([
			"claude-a",
		]);
	});

	it("answers 503 for a forced official account the bridge cannot serve", async () => {
		const bridge = makeFakeBridge(() => {
			throw new SdkBridgeUnavailableError("shutting down");
		});
		harness = await makeBridgeHarness([claudeA(), other()], { bridge });
		setForcedAccount("claude-a");

		const { response, text } = await run(flooredRequest(), harness.ctx);

		expect(response.status).toBe(503);
		expect(JSON.parse(text).error.type).toBe("sdk_bridge_unavailable");
		expect(harness.upstreamKeys).toEqual([]);
	});

	it("does not bridge an unfloored request, whatever headers it sends", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA()], { bridge });
		// The same spies the bridged case asserts silent, shown live here.
		const { token, stage } = spyAccountHandling();

		const { response } = await run(
			messagesRequest({}, { "x-clankermux-deny-official-anthropic": "1" }),
			harness.ctx,
		);

		expect(response.status).toBe(200);
		expect(bridge.starts).toEqual([]);
		expect(harness.upstreamKeys).toEqual(["key-claude-a"]);
		expect(token).toHaveBeenCalled();
		expect(stage).toHaveBeenCalled();
		expect(harness.ctx.requestRecorder.begin).toHaveBeenCalled();
	});
});

describe("Chat Completions through the SDK bridge", () => {
	/** A request as the Chat adapter hands it over. */
	function chatRequest(
		requirements: ChatRequirements = { fields: [] },
	): Request {
		const req = messagesRequest({ stream: true });
		setChatContext(req, {
			requirements,
			defaultMaxTokens: 8192,
			denyDirectOfficialAnthropic: true,
		});
		return req;
	}

	it("reaches an official Anthropic account only through the bridge", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA()], { bridge });

		const { response } = await run(chatRequest(), harness.ctx);

		expect(response.status).toBe(200);
		expect(bridge.starts).toHaveLength(1);
		expect(harness.upstreamKeys).toEqual([]);
		expect(sends(harness).map((r) => r.account_id)).toEqual(["claude-a"]);
	});

	it("never sends Chat to an official Anthropic account directly", async () => {
		harness = await makeBridgeHarness([claudeA()]);

		const { response, text } = await run(chatRequest(), harness.ctx);

		expect(response.status).toBe(403);
		expect(JSON.parse(text).error.message).toContain(
			"only through the SDK bridge",
		);
		expect(harness.upstreamKeys).toEqual([]);
	});

	it("hands every Chat field to the bridge, whose field policy decides", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA()], { bridge });

		const { response } = await run(
			chatRequest({ fields: ["max_tokens", "temperature", "top_p", "stop"] }),
			harness.ctx,
		);

		expect(response.status).toBe(200);
		expect(bridge.starts).toHaveLength(1);
		expect(bridge.starts[0].meta.translationGaps).toBeNull();
	});

	it("tells the bridge what the Responses translation could not carry", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA()], { bridge });
		const gaps = { maxTokensDefaulted: true, droppedFields: ["temperature"] };
		const req = messagesRequest();
		setNativeResponsesRequestContext(req, {
			nativeBody: JSON.stringify({ model: MODEL }),
			denyDirectOfficialAnthropic: true,
			translationGaps: gaps,
		});

		await run(req, harness.ctx);

		expect(bridge.starts[0].meta.translationGaps).toEqual(gaps);
	});

	it("tells the bridge the pi prompt layout the client declared, sanitized", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA()], { bridge });
		const declared = (value: string | null) => {
			const req = messagesRequest(
				{},
				value === null ? {} : { "x-clankermux-pi-prompt": value },
			);
			setChatContext(req, {
				requirements: { fields: [] },
				defaultMaxTokens: 8192,
				denyDirectOfficialAnthropic: true,
			});
			return req;
		};

		await run(declared(" 0.87 "), harness.ctx);
		await run(declared(`0.9\t${"9".repeat(40)}`), harness.ctx);
		await run(declared(null), harness.ctx);
		await run(declared("   "), harness.ctx);

		expect(bridge.starts.map((s) => s.meta.piPromptVersion)).toEqual([
			"0.87",
			`0.9${"9".repeat(29)}`,
			null,
			null,
		]);
	});

	it("replays reasoning_content through the bridge", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA()], { bridge });

		const { response } = await run(
			chatRequest({ fields: ["reasoning_content"] }),
			harness.ctx,
		);

		expect(response.status).toBe(200);
		expect(bridge.starts).toHaveLength(1);
	});
});

describe("fields the SDK bridge refuses", () => {
	const refusals = [
		["stop_sequences", { stop_sequences: ["END"] }],
		["tool_choice", { tool_choice: { type: "any" } }],
	] as const;

	it("leave the request to a candidate that is not bridged", async () => {
		for (const [, body] of refusals) {
			const bridge = makeFakeBridge();
			harness = await makeBridgeHarness([claudeA(), other()], { bridge });

			const { response } = await run(flooredRequest(body), harness.ctx);

			expect(response.status).toBe(200);
			expect(bridge.starts).toEqual([]);
			expect(sends(harness).map((r) => r.account_id)).toEqual(["other"]);
			harness.restore();
			harness = null;
		}
	});

	it("answer 400 naming the field when only bridged accounts remain", async () => {
		for (const [field, body] of refusals) {
			const bridge = makeFakeBridge();
			harness = await makeBridgeHarness([claudeA(), claudeB()], { bridge });

			const { response, text } = await run(flooredRequest(body), harness.ctx);

			expect(response.status).toBe(400);
			const { error } = JSON.parse(text);
			expect(error.type).toBe("invalid_request_error");
			expect(error.param).toBe(field);
			expect(error.message).toContain(field);
			expect(bridge.starts).toEqual([]);
			expect(harness.upstreamKeys).toEqual([]);
			harness.restore();
			harness = null;
		}
	});

	it("answer a Chat request the same way", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA()], { bridge });
		const req = messagesRequest({ stream: true, stop_sequences: ["END"] });
		setChatContext(req, {
			requirements: { fields: ["stop"] },
			defaultMaxTokens: 8192,
			denyDirectOfficialAnthropic: true,
		});

		const { response, text } = await run(req, harness.ctx);

		expect(response.status).toBe(400);
		expect(JSON.parse(text).error.message).toContain(
			"stop_sequences (stop in Chat Completions)",
		);
		expect(bridge.starts).toEqual([]);
	});

	it("leave a request without them bridged", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA(), other()], { bridge });

		const { response } = await run(
			flooredRequest({ stop_sequences: [], tool_choice: { type: "auto" } }),
			harness.ctx,
		);

		expect(response.status).toBe(200);
		expect(bridge.starts).toHaveLength(1);
		expect(sends(harness).map((r) => r.account_id)).toEqual(["claude-a"]);
	});

	it("do not touch a direct request", async () => {
		const bridge = makeFakeBridge();
		harness = await makeBridgeHarness([claudeA()], { bridge });

		const { response } = await run(
			messagesRequest({ stop_sequences: ["END"] }),
			harness.ctx,
		);

		expect(response.status).toBe(200);
		expect(harness.upstreamKeys).toEqual(["key-claude-a"]);
	});
});

describe("SDK bridge continuations", () => {
	const toolResults = {
		messages: [
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
				],
			},
		],
	};

	async function withContinuation(
		owner: string | null,
	): Promise<{ bridge: FakeBridge; h: BridgeHarness }> {
		const bridge = makeFakeBridge();
		bridge.continuation = { turnId: "turn-parked", ownerApiKeyId: owner };
		harness = await makeBridgeHarness([claudeA()], { bridge });
		return { bridge, h: harness };
	}

	it("go straight to the parked turn, without routing", async () => {
		const { bridge, h } = await withContinuation(KEY);

		const { response, text } = await run(flooredRequest(toolResults), h.ctx);

		expect(response.status).toBe(200);
		expect(JSON.parse(text)).toEqual({ continued: "turn-parked" });
		expect(bridge.lookups).toEqual([["toolu_1"]]);
		expect(bridge.continues[0].meta.legId).toBe(
			response.headers.get(CLIENT_REQUEST_ID_HEADER) ?? "",
		);
		expect(bridge.starts).toEqual([]);
		expect(routingAttempts(h.ctx)).toEqual([]);
	});

	it("name the key and the model as the client asked for it, for the bridge to compare with the turn's", async () => {
		const { bridge, h } = await withContinuation(KEY);

		await run(flooredRequest({ ...toolResults, model: "sonnet" }), h.ctx);

		expect(bridge.lookupCallers).toEqual([{ apiKeyId: KEY, model: "sonnet" }]);
		expect(bridge.continues[0]?.meta.model).toBe("sonnet");
	});

	it("leave another key's turn to the bridge, which refuses and records it", async () => {
		const { bridge, h } = await withContinuation("someone-else");
		bridge.continueTurn = async ({ turnId, meta }) => {
			bridge.continues.push({ turnId, body: {}, meta });
			return Response.json(
				{ type: "error", error: { type: "invalid_request_error" } },
				{ status: 409 },
			);
		};

		const { response } = await run(flooredRequest(toolResults), h.ctx);

		expect(response.status).toBe(409);
		// Handed over exactly once, so exactly one leg records the refusal.
		expect(bridge.continues).toHaveLength(1);
		expect(bridge.starts).toEqual([]);
	});

	it("find the results when Chat sends the user's text in a message after them", async () => {
		const { bridge, h } = await withContinuation(KEY);

		const { response } = await run(
			flooredRequest({
				messages: [
					...toolResults.messages,
					{ role: "user", content: [{ type: "text", text: "and also" }] },
				],
			}),
			h.ctx,
		);

		expect(response.status).toBe(200);
		expect(bridge.lookups).toEqual([["toolu_1"]]);
		expect(bridge.continues).toHaveLength(1);
	});

	it("route normally when the bridge knows none of the ids", async () => {
		const { bridge, h } = await withContinuation(KEY);
		bridge.continuation = null;

		const { response } = await run(flooredRequest(toolResults), h.ctx);

		expect(response.status).toBe(200);
		expect(bridge.lookups).toEqual([["toolu_1"]]);
		expect(bridge.starts).toHaveLength(1);
	});

	it("are never looked up for an unfloored request", async () => {
		const { bridge, h } = await withContinuation(KEY);

		await run(messagesRequest(toolResults), h.ctx);

		expect(bridge.lookups).toEqual([]);
	});
});

describe("SDK bridge and the recovery-probe gate", () => {
	afterEach(() => resetRateLimitProbeGatesForTests());

	it("a bridged attempt takes no probe lease, so the turn's own model call on that account can", async () => {
		// The account owes exactly one recovery probe.
		const a = claudeA();
		markCapacityRestoredProbePending(a.id);
		const admissions: Array<{ account: string; decision: string }> = [];
		const gate = spyOn(rateLimitCooldown, "getRateLimitProbeAdmission");
		gate.mockImplementation((account, now, options) => {
			const admission = realAdmission(account, now, options);
			admissions.push({ account: account.id, decision: admission.decision });
			return admission;
		});
		spies.push(gate);
		const seen: { inner?: { status: number; leaseFreeDuringTurn: boolean } } =
			{};
		const bridge = makeFakeBridge(async () => {
			const leaseFreeDuringTurn = !rateLimitCooldown.wouldSuppressProbe(a);
			// Claude Code's model call: direct traffic on the same account, while
			// the outer attempt is still in flight.
			const response = await handleProxy(
				messagesRequest(),
				URL_,
				harness?.ctx as BridgeHarness["ctx"],
				KEY,
				"pi-key",
			);
			await response.text();
			seen.inner = { status: response.status, leaseFreeDuringTurn };
			return Response.json({
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "bridged" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		});
		harness = await makeBridgeHarness([a], { bridge });

		const { response } = await run(flooredRequest(), harness.ctx);

		expect(response.status).toBe(200);
		expect(bridge.starts).toHaveLength(1);
		expect(seen.inner).toEqual({ status: 200, leaseFreeDuringTurn: true });
		// The gate was consulted once, by the inner call, which became the probe.
		expect(admissions).toEqual([{ account: a.id, decision: "admitted" }]);
		expect(harness.upstreamKeys).toEqual(["key-claude-a"]);
	});
});
