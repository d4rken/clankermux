/**
 * Bridge inner calls: Claude Code's own model calls, dispatched back into the
 * proxy with an in-process SdkBridgeInnerContext. Their destinations are the
 * frozen plan's, whatever the key's pin, the routing rules, a global force or
 * an account header would say, and they are ordinary direct requests otherwise.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import type {
	RoutingRule,
	SdkBridgeInnerContext,
	SdkBridgeInnerOutcome,
	SdkBridgeRoutePlan,
} from "@clankermux/types";
import { setSdkBridgeInnerRequestContext } from "@clankermux/types";
import { dispatchProxyRequest } from "../dispatch";
import { setForcedAccount } from "../handlers";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { routingAttempts } from "./fixtures/routing-harness";
import {
	type BridgeHarness,
	makeBridgeAccount,
	makeBridgeHarness,
	makeFakeBridge,
	messagesRequest,
} from "./fixtures/sdk-bridge-harness";

const MODEL = "claude-sonnet-4-5";
const KEY = "key-outer";

const a = makeBridgeAccount({ id: "claude-a", name: "A", priority: 0 });
const b = makeBridgeAccount({ id: "claude-b", name: "B", priority: 1 });
const c = makeBridgeAccount({ id: "claude-c", name: "C", priority: 2 });

function plan(overrides: Partial<SdkBridgeRoutePlan> = {}): SdkBridgeRoutePlan {
	return {
		turnId: "turn-1",
		routeSnapshot: null,
		candidates: [
			{ accountId: a.id, provider: "anthropic", upstreamModel: MODEL },
			{ accountId: b.id, provider: "anthropic", upstreamModel: MODEL },
		],
		preferredAccountId: b.id,
		apiKeyId: KEY,
		apiKeyName: "outer",
		...overrides,
	};
}

function innerContext(
	overrides: Partial<SdkBridgeInnerContext> = {},
): SdkBridgeInnerContext {
	return {
		turnId: "turn-1",
		plan: plan(),
		apiKeyId: KEY,
		apiKeyName: "outer",
		clientHarness: "pi",
		project: "outer-project",
		projectAttributionSource: "header",
		deadlineAt: Date.now() + 60_000,
		...overrides,
	};
}

function innerRequest(
	ctx: SdkBridgeInnerContext,
	body: Record<string, unknown> = {},
	headers: Record<string, string> = {},
): Request {
	const req = messagesRequest(body, {
		"user-agent": "claude-cli/2.1.300 (external, sdk-ts)",
		...headers,
	});
	setSdkBridgeInnerRequestContext(req, ctx);
	return req;
}

function upstreamAccounts(h: BridgeHarness): string[] {
	return routingAttempts(h.ctx)
		.filter((row) => row.kind === "upstream_send")
		.map((row) => row.account_id ?? "");
}

const cRule: RoutingRule = {
	id: "only-c",
	name: "Only C",
	enabled: true,
	position: 0,
	match_api_key_id: null,
	match_model_kind: "any",
	match_model_value: null,
	pool_kind: "accounts",
	pool_provider: null,
	pool_account_ids: [c.id],
	target_kind: "literal",
	target_model: MODEL,
};

let harness: BridgeHarness | null = null;
afterEach(() => {
	harness?.restore();
	harness = null;
	setForcedAccount(null);
	clearProviderOverloadCooldown();
});

describe("SDK bridge inner calls", () => {
	it("route to the plan's candidates, preferring the outer account, and ignore pin, rules, force and the account header", async () => {
		harness = await makeBridgeHarness([a, b, c], {
			bridge: makeFakeBridge(),
			pin: { pinnedAccountId: c.id, pinnedProviders: null },
		});
		harness.ctx.dbOps.routing.listRules = mock(async () => [cRule]);
		setForcedAccount(c.id);

		const res = await dispatchProxyRequest(
			innerRequest(innerContext(), {}, { "x-clankermux-account-id": c.id }),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);

		expect(res.status).toBe(200);
		expect((await res.json()).content[0].text).toBe("direct");
		expect(upstreamAccounts(harness)).toEqual([b.id]);
		expect(harness.upstreamKeys).toEqual([b.api_key ?? ""]);
		const snapshot = JSON.parse(
			routingAttempts(harness.ctx)[0].route_snapshot ?? "{}",
		);
		expect(snapshot.sdkBridgeTurnId).toBe("turn-1");
		expect(
			snapshot.targets.map((t: { accountId: string }) => t.accountId),
		).toEqual([a.id, b.id]);
	});

	it("fail over within the plan and never outside it", async () => {
		harness = await makeBridgeHarness([a, b, c], {
			upstream: (key) =>
				key === b.api_key
					? Response.json(
							{ type: "error", error: { type: "api_error", message: "down" } },
							{ status: 500 },
						)
					: undefined,
		});

		const res = await dispatchProxyRequest(
			innerRequest(innerContext()),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);

		expect(res.status).toBe(200);
		expect(upstreamAccounts(harness)).toEqual([b.id, a.id]);
	});

	it("reject a model the plan does not target, without an upstream call", async () => {
		harness = await makeBridgeHarness([a, b, c]);

		const res = await dispatchProxyRequest(
			innerRequest(innerContext(), { model: "claude-opus-4-7" }),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);

		expect(res.status).toBe(403);
		expect((await res.json()).error.message).toContain(
			"not a destination model of this SDK bridge turn",
		);
		expect(harness.upstreamKeys).toEqual([]);
	});

	it("route a planned [1m] model under the bare id Claude Code sends for it", async () => {
		harness = await makeBridgeHarness([a, b]);
		const oneMillion = plan({
			candidates: [
				{
					accountId: a.id,
					provider: "anthropic",
					upstreamModel: `${MODEL}[1m]`,
				},
				{
					accountId: b.id,
					provider: "anthropic",
					upstreamModel: `${MODEL}[1m]`,
				},
			],
		});

		const res = await dispatchProxyRequest(
			innerRequest(innerContext({ plan: oneMillion }), { model: MODEL }),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);

		expect(res.status).toBe(200);
		const sends = routingAttempts(harness.ctx).filter(
			(row) => row.kind === "upstream_send",
		);
		expect(sends.map((row) => [row.account_id, row.resolved_model])).toEqual([
			[b.id, MODEL],
		]);

		const other = await dispatchProxyRequest(
			innerRequest(innerContext({ plan: oneMillion }), {
				model: "claude-opus-4-7",
			}),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);
		expect(other.status).toBe(403);
	});

	it("are refused once the turn's deadline has passed", async () => {
		harness = await makeBridgeHarness([a, b]);

		const res = await dispatchProxyRequest(
			innerRequest(innerContext({ deadlineAt: Date.now() - 1 })),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);

		expect(res.status).toBe(403);
		expect(harness.upstreamKeys).toEqual([]);
	});

	it("record the turn id and the outer request's project and harness", async () => {
		harness = await makeBridgeHarness([a, b]);

		await dispatchProxyRequest(
			innerRequest(innerContext(), {
				metadata: {
					user_id: JSON.stringify({ session_id: "cc-session-1" }),
				},
			}),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);

		const begin = harness.ctx.requestRecorder.begin as ReturnType<typeof mock>;
		expect(begin).toHaveBeenCalledTimes(1);
		const meta = begin.mock.calls[0][0];
		expect(meta.sdkBridgeTurnId).toBe("turn-1");
		expect(meta.project).toBe("outer-project");
		expect(meta.projectAttributionSource).toBe("header");
		expect(meta.clientHarness).toBe("pi");
		expect(meta.clientUserAgent).toContain("claude-cli");
		expect(meta.sessionKey).toBe(`${KEY}:cc-session-1`);
	});

	it("report their outcome to the bridge", async () => {
		harness = await makeBridgeHarness([a], {
			upstream: () =>
				Response.json(
					{
						type: "error",
						error: { type: "invalid_request_error", message: "bad" },
					},
					{ status: 400 },
				),
		});
		const outcomes: SdkBridgeInnerOutcome[] = [];
		const reported = new Promise<void>((resolve) => {
			const ctx = innerContext({
				plan: plan({
					candidates: [
						{ accountId: a.id, provider: "anthropic", upstreamModel: MODEL },
					],
					preferredAccountId: a.id,
				}),
				onInnerOutcome: (o) => {
					outcomes.push(o);
					resolve();
				},
			});
			void dispatchProxyRequest(
				innerRequest(ctx),
				new URL("https://proxy.local/v1/messages"),
				harness?.ctx as BridgeHarness["ctx"],
				KEY,
				"outer",
			).then((res) => res.text());
		});
		await reported;

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].status).toBe(400);
		expect(outcomes[0].errorType).toBe("invalid_request_error");
		expect(outcomes[0].message).toBe("bad");
		expect(outcomes[0].accountId).toBe(a.id);
	});

	describe("a streamed reply", () => {
		const sse = (...events: Array<Record<string, unknown>>) =>
			events
				.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
				.join("");
		const start = { type: "message_start", message: { model: MODEL } };
		const stop = { type: "message_stop" };

		async function streamed(body: string) {
			// A fresh account each time: a mid-stream 429 cools the one it hit.
			const fresh = makeBridgeAccount({ id: a.id, name: "A", priority: 0 });
			harness = await makeBridgeHarness([fresh], {
				upstream: () =>
					new Response(body, {
						headers: { "content-type": "text/event-stream" },
					}),
			});
			const outcomes: SdkBridgeInnerOutcome[] = [];
			const started: string[] = [];
			const ctx = innerContext({
				plan: plan({
					candidates: [
						{ accountId: a.id, provider: "anthropic", upstreamModel: MODEL },
					],
					preferredAccountId: a.id,
				}),
				onInnerRequestStarted: (id) => started.push(id),
				onInnerOutcome: (o) => outcomes.push(o),
			});
			const res = await dispatchProxyRequest(
				innerRequest(ctx, { stream: true }),
				new URL("https://proxy.local/v1/messages"),
				harness.ctx,
				KEY,
				"outer",
			);
			return { res, outcomes, started };
		}

		it("is reported when it ends, not when its head arrives", async () => {
			const { res, outcomes, started } = await streamed(
				sse(start, { type: "content_block_delta" }, stop),
			);
			expect(res.status).toBe(200);
			expect(outcomes).toEqual([]);
			const begin = harness?.ctx.requestRecorder.begin as ReturnType<
				typeof mock
			>;
			expect(started).toEqual([begin.mock.calls[0][0].requestId]);
			expect(await res.text()).toContain("message_stop");
			await Bun.sleep(0);
			expect(outcomes).toEqual([
				expect.objectContaining({ status: 200, errorType: null }),
			]);
			expect(outcomes[0]?.requestId).toBe(started[0]);
		});

		it("counts an error event inside the 200 as that error", async () => {
			for (const [type, status] of [
				["overloaded_error", 529],
				["rate_limit_error", 429],
				["api_error", 500],
				["invalid_request_error", 400],
				["billing_error", 402],
				["request_too_large", 413],
				["not_an_anthropic_type", 502],
			] as const) {
				const { res, outcomes } = await streamed(
					sse(start, {
						type: "error",
						error: { type, message: `mid-stream ${type}` },
					}),
				);
				await res.text();
				await Bun.sleep(0);
				expect(outcomes).toEqual([
					expect.objectContaining({
						status,
						errorType: type,
						message: `mid-stream ${type}`,
					}),
				]);
				harness?.restore();
				// A mid-stream overload trips the provider's breaker; the next
				// iteration must not wait on it.
				clearProviderOverloadCooldown();
			}
		});

		it("counts a stream that ends without message_stop as a 502", async () => {
			const { res, outcomes } = await streamed(sse(start));
			await res.text();
			await Bun.sleep(0);
			expect(outcomes).toEqual([
				expect.objectContaining({ status: 502, errorType: "api_error" }),
			]);
		});

		it("reports once when Claude Code stops reading", async () => {
			const { res, outcomes } = await streamed(
				sse(start, { type: "content_block_delta" }),
			);
			const reader = res.body?.getReader();
			await reader?.read();
			await reader?.cancel();
			await Bun.sleep(0);
			expect(outcomes).toEqual([
				expect.objectContaining({ status: 502, errorType: "api_error" }),
			]);
		});
	});

	it("report their row's start once, apart from the outcome", async () => {
		harness = await makeBridgeHarness([a]);
		const started: string[] = [];
		const ctx = innerContext({
			plan: plan({
				candidates: [
					{ accountId: a.id, provider: "anthropic", upstreamModel: MODEL },
				],
				preferredAccountId: a.id,
			}),
			onInnerRequestStarted: (id) => started.push(id),
		});
		const res = await dispatchProxyRequest(
			innerRequest(ctx),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);
		await res.text();
		expect(started).toHaveLength(1);
		const begin = harness.ctx.requestRecorder.begin as ReturnType<typeof mock>;
		expect(started[0]).toBe(begin.mock.calls[0][0].requestId);
	});

	it("report a synthetic terminal row's start as well", async () => {
		harness = await makeBridgeHarness([a]);
		const started: string[] = [];
		const outcomes: SdkBridgeInnerOutcome[] = [];
		const res = await dispatchProxyRequest(
			innerRequest(
				innerContext({
					deadlineAt: Date.now() - 1,
					onInnerRequestStarted: (id) => started.push(id),
					onInnerOutcome: (o) => outcomes.push(o),
				}),
			),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);
		await res.text();
		const synthetic = harness.ctx.requestRecorder.recordSynthetic as ReturnType<
			typeof mock
		>;
		expect(synthetic).toHaveBeenCalledTimes(1);
		expect(started).toEqual([synthetic.mock.calls[0][0].requestId]);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.status).toBeGreaterThanOrEqual(400);
	});

	it("cannot be entered through headers: without the in-process context the key's pin applies", async () => {
		harness = await makeBridgeHarness([a, b, c], {
			pin: { pinnedAccountId: c.id, pinnedProviders: null },
		});

		const res = await dispatchProxyRequest(
			messagesRequest(
				{},
				{
					"x-clankermux-sdk-bridge-turn-id": "turn-1",
					"x-clankermux-sdk-bridge-inner": "1",
				},
			),
			new URL("https://proxy.local/v1/messages"),
			harness.ctx,
			KEY,
			"outer",
		);

		expect(res.status).toBe(200);
		expect(upstreamAccounts(harness)).toEqual([c.id]);
		const begin = harness.ctx.requestRecorder.begin as ReturnType<typeof mock>;
		expect(begin.mock.calls[0][0].sdkBridgeTurnId ?? null).toBeNull();
	});
});
