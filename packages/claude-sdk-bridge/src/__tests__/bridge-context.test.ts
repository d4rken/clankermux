/**
 * What the bridge does so a client's conversation reaches the model as the
 * client sent it, and so the client can tell how it did: tool results Claude
 * Code would have shortened, context rewrites it reports, a refusal, and the
 * history header on every response of a turn.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import {
	SDK_BRIDGE_HISTORY_HEADER,
	type SdkBridgeRoutePlan,
	type SdkBridgeTurnMeta,
} from "@clankermux/types";
import { MAX_TOOL_RESULT_CHARS } from "../tool-server";
import {
	assistantMessage,
	type FakeQuery,
	foldReply,
	type Harness,
	initMessage,
	MODEL,
	makeHarness,
	makeMeta,
	makePlan,
	memoryParkRepo,
	memoryTurnRepo,
	messagesRequest,
	parseSse,
	READ_TOOL,
	resultMessage,
	streamedMessage,
	waitFor,
} from "./fixtures/fake-sdk";

type Msg = { role: string; content: unknown };

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.bridge.dispose();
		rmSync(h.workRoot, { recursive: true, force: true });
	}
});

function harness(): Harness {
	const h = makeHarness();
	harnesses.push(h);
	return h;
}

/** A bridge that releases a parked query after 60 ms into its own park store. */
async function releaseHarness(limits: Record<string, number> = {}) {
	const repo = memoryTurnRepo();
	const parkRepo = memoryParkRepo(repo.turns);
	const h = makeHarness(
		{
			parkRepo,
			parkNamespace: parkRepo.namespace,
			limits: () => ({
				parkReleaseMs: 60,
				releasedParkTtlMs: 60_000,
				parkedTimeoutMs: 60_000,
				...limits,
			}),
			timing: {
				headHoldMs: 1_000,
				pingIntervalMs: 100,
				settleWaitMs: 500,
				idleTimeoutMs: 5_000,
				exitGraceMs: 50,
				maintenanceIntervalMs: 60_000,
				releaseDrainMs: 8_000,
			},
		},
		{
			process: "normal",
			repo,
			workRoot: mkdtempSync(join(tmpdir(), "sdk-bridge-context-release-")),
		},
	);
	harnesses.push(h);
	await h.bridge.ready();
	return { ...h, parkRepo };
}

/**
 * A turn parked on `toolu_p`, with Claude Code's envelope for the call
 * reported after `message_stop` unless `envelopes` is false.
 */
async function parkForRelease(h: Harness, envelopes = true) {
	const t = await start(h, { tools, messages: [first] });
	const msgId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
	const use = {
		type: "tool_use" as const,
		id: "toolu_p",
		name: "mcp__c__read",
		input: { path: "a" },
	};
	t.query.emit(initMessage(), ...streamedMessage([use], { id: msgId }));
	const r1 = await reply(t.response);
	const envelope = () =>
		t.query.emit(
			assistantMessage([use], { id: msgId, stopReason: "tool_use" }),
		);
	if (envelopes) envelope();
	const call = t.query.callTool("toolu_p", "read");
	const answer = (content: unknown): Msg[] => [
		first,
		{ role: "assistant", content: r1.content },
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_p", content }],
		},
	];
	return { t, r1, call, answer, envelope };
}

async function start(
	h: Harness,
	body: Record<string, unknown>,
	opts: {
		meta?: Partial<SdkBridgeTurnMeta>;
		plan?: Partial<SdkBridgeRoutePlan>;
	} = {},
) {
	const plan = makePlan(opts.plan);
	const meta = makeMeta(opts.meta);
	const response = h.bridge.startTurn({
		request: messagesRequest(body),
		plan,
		meta,
		signal: new AbortController().signal,
	});
	const query = await h.sdk.next();
	return { response, query, plan, meta };
}

function continueTurn(
	h: Harness,
	turnId: string,
	body: Record<string, unknown>,
	meta: Partial<SdkBridgeTurnMeta> = {},
) {
	const m = makeMeta(meta);
	return {
		meta: m,
		response: h.bridge.continueTurn({
			turnId,
			request: messagesRequest(body),
			meta: m,
			signal: new AbortController().signal,
		}),
	};
}

async function reply(response: Promise<Response>) {
	const res = await response;
	const text = await res.text();
	const events = res.headers.get("content-type")?.includes("event-stream")
		? parseSse(text)
		: [];
	return {
		status: res.status,
		history: res.headers.get(SDK_BRIDGE_HISTORY_HEADER),
		json: events.length ? null : (JSON.parse(text) as Record<string, unknown>),
		events,
		...foldReply(events),
	};
}

async function settled(h: Harness) {
	await waitFor(() => h.bridge.status().live === 0);
	await Bun.sleep(10);
}

const tools = [READ_TOOL];
const first: Msg = { role: "user", content: "TOOL read a.txt" };

/** A turn parked on one client call, `toolu_1`. */
async function parked(h: Harness) {
	const t = await start(h, { tools, messages: [first] });
	t.query.emit(
		initMessage(),
		...streamedMessage([
			{
				type: "tool_use",
				id: "toolu_1",
				name: "mcp__c__read",
				input: { path: "a.txt" },
			},
		]),
	);
	const r1 = await reply(t.response);
	const call = t.query.callTool("toolu_1", "read", { path: "a.txt" });
	await waitFor(() => h.bridge.status().parked === 1);
	const answer = (content: unknown): Msg[] => [
		first,
		{ role: "assistant", content: r1.content },
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1", content }],
		},
	];
	return { t, r1, call, answer };
}

describe("client tool results Claude Code would replace", () => {
	it("lists every tool with Claude Code's largest result size, so results arrive whole", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		const listed = await (await t.query.mcp()).listTools();
		expect(MAX_TOOL_RESULT_CHARS).toBe(500_000);
		expect(listed.tools.map((tool) => tool._meta)).toEqual([
			{
				"anthropic/alwaysLoad": true,
				"anthropic/maxResultSizeChars": 500_000,
			},
		]);
	});

	it("delivers a result of exactly the limit, counted over its text blocks", async () => {
		const h = harness();
		const { t, call, answer } = await parked(h);
		const half = "x".repeat(MAX_TOOL_RESULT_CHARS / 2);
		const c = continueTurn(h, t.plan.turnId, {
			tools,
			messages: answer([
				{ type: "text", text: half },
				{ type: "text", text: half },
			]),
		});
		const delivered = await call;
		expect(
			(delivered.content as Array<{ text: string }>).map((b) => b.text.length),
		).toEqual([half.length, half.length]);
		t.query.emit(
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		expect((await reply(c.response)).status).toBe(200);
	});

	it("refuses a larger result with a named 400, delivers nothing, and keeps the turn parked", async () => {
		const h = harness();
		const { t, call, answer } = await parked(h);
		const tooBig = "x".repeat(MAX_TOOL_RESULT_CHARS + 1);
		const refused = continueTurn(h, t.plan.turnId, {
			tools,
			messages: answer([{ type: "text", text: tooBig }]),
		});
		const r = await reply(refused.response);
		expect(r.status).toBe(400);
		expect(r.json).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "sdk_bridge_tool_result_too_large",
				message:
					"The result for tool call toolu_1 is 500,001 characters; Claude Code passes at most 500,000 to the model whole",
			},
		});
		await waitFor(() => h.repo.legs.get(refused.meta.legId)?.finished === true);
		expect(h.repo.legs.get(refused.meta.legId)).toMatchObject({
			turnId: t.plan.turnId,
			kind: "continue",
			httpStatus: 400,
			errorType: "invalid_request_error",
		});
		expect(h.bridge.status().parked).toBe(1);

		// A result within the limit still continues the turn.
		const retry = continueTurn(h, t.plan.turnId, {
			tools,
			messages: answer("SHORTER"),
		});
		expect(await call).toEqual({
			content: [{ type: "text", text: "SHORTER" }],
			isError: false,
		});
		t.query.emit(
			...streamedMessage([{ type: "text", text: "done" }]),
			resultMessage(),
		);
		expect((await reply(retry.response)).status).toBe(200);
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)?.status).toBe("completed");
	});
});

describe("client tool results that carry an image", () => {
	it("are delivered whole past the limit: Claude Code never previews a result with an image", async () => {
		const h = harness();
		const { t, call, answer } = await parked(h);
		const text = "x".repeat(MAX_TOOL_RESULT_CHARS + 1);
		const c = continueTurn(h, t.plan.turnId, {
			tools,
			messages: answer([
				{
					type: "image",
					source: {
						type: "base64",
						media_type: "image/png",
						data: "iVBORw0KGgo=",
					},
				},
				{ type: "text", text },
			]),
		});
		const delivered = await call;
		expect(
			(delivered.content as Array<{ type: string; text?: string }>).map((b) =>
				b.type === "text" ? (b.text as string).length : b.type,
			),
		).toEqual(["image", text.length]);
		t.query.emit(
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		expect((await reply(c.response)).status).toBe(200);
	});
});

describe("a context Claude Code rewrote", () => {
	const rewrites: Array<[string, SDKMessage]> = [
		[
			"compact_boundary",
			{
				type: "system",
				subtype: "compact_boundary",
				compact_metadata: { trigger: "auto", pre_tokens: 190_000 },
				uuid: crypto.randomUUID(),
				session_id: "s",
			} as unknown as SDKMessage,
		],
		[
			"microcompact_boundary",
			{
				type: "system",
				subtype: "microcompact_boundary",
				uuid: crypto.randomUUID(),
				session_id: "s",
			} as unknown as SDKMessage,
		],
		[
			"hint_clears",
			{
				type: "hint_clears",
				ids: ["toolu_old"],
				content_by_id: {},
				uuid: crypto.randomUUID(),
				session_id: "s",
			} as unknown as SDKMessage,
		],
	];

	for (const [name, message] of rewrites)
		it(`fails the turn on ${name} with a named 502, and records it`, async () => {
			const h = harness();
			const t = await start(h, { messages: [{ role: "user", content: "hi" }] });
			t.query.emit(initMessage(), message);
			const r = await reply(t.response);
			expect(r.status).toBe(502);
			expect(r.json).toEqual({
				type: "error",
				error: {
					type: "api_error",
					code: "sdk_bridge_context_rewritten",
					message: `Claude Code rewrote the conversation's context (${name}); the model no longer sees it as the client sent it`,
				},
			});
			await settled(h);
			expect(t.query.interrupted || t.query.closed).toBe(true);
			expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
				status: "failed",
				httpStatus: 502,
				errorType: "api_error",
			});
			expect(String(h.repo.turns.get(t.plan.turnId)?.errorMessage)).toContain(
				name,
			);
		});

	it("ends a reply already streaming with an SSE error", async () => {
		const h = harness();
		const t = await start(h, { messages: [{ role: "user", content: "hi" }] });
		const [, message] = rewrites[0] as [string, SDKMessage];
		const streamed = streamedMessage([{ type: "text", text: "partial" }]);
		// Everything up to message_stop: the reply is open, not finished.
		t.query.emit(initMessage(), ...streamed.slice(0, -1), message);
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.errors.map((e) => e.data)).toEqual([
			{
				type: "error",
				error: expect.objectContaining({
					type: "api_error",
					code: "sdk_bridge_context_rewritten",
				}),
			},
		]);
	});
});

describe("a refusal", () => {
	it("reaches the client with stop_reason refusal and completes the turn", async () => {
		const h = harness();
		const t = await start(h, { messages: [{ role: "user", content: "hi" }] });
		// Claude Code without a fallback model: the refused message, then its
		// own error message and an error result.
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "I can't help" }], {
				stopReason: "refusal",
			}),
			{
				type: "system",
				subtype: "model_refusal_no_fallback",
				uuid: crypto.randomUUID(),
				session_id: "s",
			} as unknown as SDKMessage,
			assistantMessage(
				[{ type: "text", text: "API Error: safeguards flagged this message" }],
				{
					model: "<synthetic>",
					error: "invalid_request",
					stopReason: "refusal",
				},
			),
			resultMessage({
				isError: true,
				result: "API Error: safeguards flagged this message",
				terminalReason: "api_error",
			}),
		);
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.stop).toBe("refusal");
		expect(r.content).toEqual([{ type: "text", text: "I can't help" }]);
		expect(r.errors).toEqual([]);
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
			status: "completed",
			stopReason: "refusal",
			httpStatus: 200,
			errorType: null,
		});
	});
});

describe(`the ${SDK_BRIDGE_HISTORY_HEADER} header`, () => {
	const session = {
		affinityScope: "client_session",
		affinityKey: "sess-h",
	} as const;

	async function mirror(query: FakeQuery, text: string) {
		const store = query.options.sessionStore as SessionStore;
		const sessionId = (query.options.sessionId ??
			query.options.resume) as string;
		await store.append({ projectKey: "p", sessionId }, [
			{
				type: "user",
				sessionId,
				uuid: crypto.randomUUID(),
				message: { role: "user", content: text },
			},
		]);
	}

	/** One user turn answered "echo: <text>". */
	async function answered(
		h: Harness,
		messages: Msg[],
		opts: { plan?: Partial<SdkBridgeRoutePlan>; stream?: boolean } = {},
	) {
		const t = await start(
			h,
			{ messages, ...(opts.stream === false ? { stream: false } : {}) },
			{ meta: session, plan: opts.plan },
		);
		await mirror(t.query, "hello");
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "echo" }]),
			resultMessage(),
		);
		const r = await reply(t.response);
		await settled(h);
		return { t, r };
	}

	const hello: Msg = { role: "user", content: "hello" };
	const echoed: Msg = {
		role: "assistant",
		content: [{ type: "text", text: "echo" }],
	};

	it("reports fresh, an edit, resume and an account change, streamed and as JSON", async () => {
		const h = harness();
		const fresh = await answered(h, [hello]);
		expect(fresh.r.history).toBe("fresh");

		const edited: Msg[] = [
			hello,
			{ role: "assistant", content: "an edited answer" },
			{ role: "user", content: "again" },
		];
		const rebuilt = await answered(h, edited);
		expect(rebuilt.r.history).toBe("rebuild_transcript; reason=edit");

		const third: Msg[] = [
			...edited,
			echoed,
			{ role: "user", content: "third" },
		];
		const resumed = await answered(h, third, { stream: false });
		expect(resumed.r.json).toMatchObject({ type: "message" });
		expect(resumed.r.history).toBe("resume");

		const onB = {
			candidates: [
				{ accountId: "acct-b", provider: "anthropic", upstreamModel: MODEL },
			],
			preferredAccountId: "acct-b",
		} as const;
		const moved = await answered(
			h,
			[...third, echoed, { role: "user", content: "fourth" }],
			{ plan: onB },
		);
		expect(moved.r.history).toBe("resume; reason=account_change");
	});

	it("reports the turn's decision on its continuation legs and their refusals", async () => {
		const h = harness();
		const t = await start(h, {
			tools,
			messages: [
				{ role: "user", content: "earlier" },
				{ role: "assistant", content: "earlier answer" },
				first,
			],
		});
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "tool_use", id: "toolu_1", name: "mcp__c__read", input: {} },
			]),
		);
		const r1 = await reply(t.response);
		expect(r1.history).toBe("rebuild_transcript; reason=unknown");
		const call = t.query.callTool("toolu_1", "read");
		await waitFor(() => h.bridge.status().parked === 1);
		const history: Msg[] = [
			{ role: "user", content: "earlier" },
			{ role: "assistant", content: "earlier answer" },
			first,
			{ role: "assistant", content: r1.content },
		];

		const stale = continueTurn(h, t.plan.turnId, {
			tools,
			messages: [
				...history,
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "other", content: "x" },
					],
				},
			],
		});
		const refused = await reply(stale.response);
		expect(refused.status).toBe(409);
		expect(refused.history).toBe("rebuild_transcript; reason=unknown");

		const c = continueTurn(h, t.plan.turnId, {
			tools,
			messages: [
				...history,
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: "A" },
					],
				},
			],
		});
		await call;
		t.query.emit(
			...streamedMessage([{ type: "text", text: "done" }]),
			resultMessage(),
		);
		expect((await reply(c.response)).history).toBe(
			"rebuild_transcript; reason=unknown",
		);
	});

	it("rides on an error the turn answers after it started, and not on a refusal before it", async () => {
		const h = harness();
		const t = await start(h, { messages: [hello] });
		t.query.emit(
			initMessage(),
			assistantMessage([{ type: "text", text: "API Error: 500" }], {
				error: "unknown",
			}),
			resultMessage({ isError: true, result: "API Error: 500" }),
		);
		const failed = await reply(t.response);
		expect(failed.status).toBe(502);
		expect(failed.history).toBe("fresh");

		const res = await h.bridge.startTurn({
			request: messagesRequest({
				messages: [hello],
				stop_sequences: ["END"],
			}),
			plan: makePlan(),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		expect(res.status).toBe(400);
		expect(res.headers.get(SDK_BRIDGE_HISTORY_HEADER)).toBeNull();
	});
});

describe(`the ${SDK_BRIDGE_HISTORY_HEADER} header on a refused continuation`, () => {
	it("stays on the refusal of a live turn torn down for another model, and never goes to another key", async () => {
		const h = harness();
		const { t, answer } = await parked(h);
		const other = await reply(
			continueTurn(
				h,
				t.plan.turnId,
				{ tools, messages: answer("A") },
				{ apiKeyId: "key-2" },
			).response,
		);
		expect(other.status).toBe(409);
		expect(other.history).toBeNull();

		const moved = await reply(
			continueTurn(
				h,
				t.plan.turnId,
				{ tools, messages: answer("A") },
				{ model: "claude-opus-5-5" },
			).response,
		);
		expect(moved.status).toBe(409);
		expect(JSON.stringify(moved.json)).toContain("claude-opus-5-5");
		expect(moved.history).toBe("fresh");
	});

	it("stays on the refusals of a released park: another model and an expired park, and never goes to another key", async () => {
		const h = await releaseHarness();
		const other = await parkForRelease(h);
		await waitFor(
			() => h.repo.turns.get(other.t.plan.turnId)?.status === "released",
			8_000,
		);
		const foreign = await reply(
			continueTurn(
				h,
				other.t.plan.turnId,
				{ tools, messages: other.answer("A") },
				{ apiKeyId: "key-2" },
			).response,
		);
		expect(foreign.status).toBe(409);
		expect(foreign.history).toBeNull();
		const moved = await reply(
			continueTurn(
				h,
				other.t.plan.turnId,
				{ tools, messages: other.answer("A") },
				{ model: "claude-opus-5-5" },
			).response,
		);
		expect(moved.status).toBe(409);
		expect(moved.history).toBe("fresh");
	});

	it("stays on the refusal of an expired released park", async () => {
		const h = await releaseHarness({ releasedParkTtlMs: 300 });
		const p = await parkForRelease(h);
		await waitFor(
			() => h.repo.turns.get(p.t.plan.turnId)?.status === "released",
			8_000,
		);
		await Bun.sleep(400);
		const expired = await reply(
			continueTurn(h, p.t.plan.turnId, {
				tools,
				messages: p.answer("A"),
			}).response,
		);
		expect(expired.status).toBe(409);
		expect(expired.history).toBe("fresh");
	});
});

describe("a context rewrite Claude Code reports late", () => {
	const compaction = () =>
		({
			type: "system",
			subtype: "compact_boundary",
			compact_metadata: { trigger: "auto", pre_tokens: 190_000 },
			uuid: crypto.randomUUID(),
			session_id: "s",
		}) as unknown as SDKMessage;

	it("while its parked query is being released: the turn fails with the named error and no park is stored", async () => {
		const h = await releaseHarness();
		// No envelope yet: the release waits for one, and the rewrite comes first.
		const p = await parkForRelease(h, false);
		await Bun.sleep(200);
		p.t.query.emit(compaction());
		p.envelope();
		await waitFor(
			() => h.repo.turns.get(p.t.plan.turnId)?.finishedAt != null,
			8_000,
		);
		expect(h.repo.turns.get(p.t.plan.turnId)).toMatchObject({
			status: "failed",
			httpStatus: 502,
			errorType: "api_error",
		});
		expect(String(h.repo.turns.get(p.t.plan.turnId)?.errorMessage)).toContain(
			"compact_boundary",
		);
		expect(h.parkRepo.parks.size).toBe(0);
	});

	it("after the reply went out: the turn completes, records the rewrite, and the next turn rebuilds", async () => {
		const h = harness();
		const session = {
			affinityScope: "client_session",
			affinityKey: "sess-late",
		} as const;
		const t = await start(
			h,
			{ messages: [{ role: "user", content: "hello" }] },
			{ meta: session },
		);
		const store = t.query.options.sessionStore as SessionStore;
		await store.append(
			{ projectKey: "p", sessionId: t.query.options.sessionId as string },
			[
				{
					type: "user",
					sessionId: t.query.options.sessionId as string,
					uuid: crypto.randomUUID(),
					message: { role: "user", content: "hello" },
				},
			],
		);
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "echo" }]),
		);
		const r = await reply(t.response);
		expect(r).toMatchObject({ status: 200, stop: "end_turn" });
		t.query.emit(compaction(), resultMessage());
		await settled(h);
		const row = h.repo.turns.get(t.plan.turnId);
		expect(row).toMatchObject({ status: "completed", httpStatus: 200 });
		expect(String(row?.errorMessage)).toContain("compact_boundary");
		expect(h.bridge.status().counters).toMatchObject({
			turnsCompleted: 1,
			turnsFailed: 0,
		});

		const next = await start(
			h,
			{
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: r.content },
					{ role: "user", content: "again" },
				],
			},
			{ meta: session },
		);
		expect(h.repo.turns.get(next.plan.turnId)?.historyMode).toBe(
			"rebuild_transcript",
		);
	});

	it("after a side request's reply settled: the side request completes and records the rewrite", async () => {
		const h = harness();
		const session = {
			affinityScope: "client_session",
			affinityKey: "sess-side-late",
		} as const;
		const main = await start(
			h,
			{ messages: [{ role: "user", content: "hello" }] },
			{ meta: session },
		);
		const sessionId = main.query.options.sessionId as string;
		await (main.query.options.sessionStore as SessionStore).append(
			{ projectKey: "p", sessionId },
			[
				{
					type: "user",
					sessionId,
					uuid: crypto.randomUUID(),
					message: { role: "user", content: "hello" },
				},
			],
		);
		main.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "echo" }]),
			resultMessage(),
		);
		const r = await reply(main.response);
		await settled(h);

		const side = await start(
			h,
			{
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: r.content },
					{ role: "user", content: "RECAP" },
				],
				tool_choice: { type: "none" },
			},
			{ meta: { ...session, sideRequest: "session-fork-v1" } },
		);
		side.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "recap" }]),
		);
		const answered = await reply(side.response);
		expect(answered).toMatchObject({ status: 200, stop: "end_turn" });
		side.query.emit(compaction(), resultMessage());
		await settled(h);
		const row = h.repo.turns.get(side.plan.turnId);
		expect(row).toMatchObject({
			kind: "side_request",
			status: "completed",
			httpStatus: 200,
		});
		expect(String(row?.errorMessage)).toContain("compact_boundary");
	});
});

describe("a reply that ends on another reason after a tool call", () => {
	it("answers the call Claude Code started, so the query does not hold its slot until the parked timeout", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		const msgId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
		const stream = streamedMessage(
			[
				{
					type: "tool_use",
					id: "toolu_r",
					name: "mcp__c__read",
					input: { path: "a" },
				},
			],
			{ id: msgId, stopReason: "refusal" },
		);
		// Claude Code starts the call as soon as its block is complete.
		const stop = stream.length - 2;
		t.query.emit(initMessage(), ...stream.slice(0, stop));
		await waitFor(() => t.query.prompts.length > 0);
		const call = t.query.callTool("toolu_r", "read");
		await Bun.sleep(50);
		t.query.emit(...stream.slice(stop));
		const r = await reply(t.response);
		expect(r.stop).toBe("refusal");
		const result = await Promise.race([
			call,
			Bun.sleep(2_000).then(() => "still parked"),
		]);
		expect(result).toMatchObject({ isError: true });
		expect(h.bridge.status().parked).toBe(0);
		// Nothing the aborted call leads Claude Code to do reaches a model.
		const env = t.query.options.env ?? {};
		const after = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: MODEL, messages: [], stream: true }),
		});
		expect(after.status).toBe(401);
	});
});

describe("a turn whose reply the client already has, and whose session goes", () => {
	const session = {
		affinityScope: "client_session",
		affinityKey: "sess-settled",
	} as const;
	const compaction = () =>
		({
			type: "system",
			subtype: "compact_boundary",
			compact_metadata: { trigger: "auto", pre_tokens: 190_000 },
			uuid: crypto.randomUUID(),
			session_id: "s",
		}) as unknown as SDKMessage;

	async function mirrored(t: { query: FakeQuery }, text: string) {
		const sessionId = t.query.options.sessionId as string;
		await (t.query.options.sessionStore as SessionStore).append(
			{ projectKey: "p", sessionId },
			[
				{
					type: "user",
					sessionId,
					uuid: crypto.randomUUID(),
					message: { role: "user", content: text },
				},
			],
		);
	}

	/** The conversation's next turn: how its history reached Claude Code. */
	async function nextTurn(h: Harness, history: Msg[]) {
		const next = await start(h, { messages: history }, { meta: session });
		return h.repo.turns.get(next.plan.turnId)?.historyMode;
	}

	it("a rewrite after the reply, then an exit without a result: completed, annotated, counted, and the next turn rebuilds", async () => {
		const h = harness();
		const t = await start(
			h,
			{ messages: [{ role: "user", content: "hello" }] },
			{ meta: session },
		);
		await mirrored(t, "hello");
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "echo" }]),
		);
		const r = await reply(t.response);
		t.query.emit(compaction());
		// Claude Code dies without reporting a result.
		t.query.end();
		await settled(h);
		const row = h.repo.turns.get(t.plan.turnId);
		expect(row).toMatchObject({ status: "completed", httpStatus: 200 });
		expect(String(row?.errorMessage)).toContain("compact_boundary");
		expect(h.bridge.status().counters).toMatchObject({
			turnsCompleted: 1,
			turnsFailed: 0,
		});
		expect(
			await nextTurn(h, [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: r.content },
				{ role: "user", content: "again" },
			]),
		).toBe("rebuild_transcript");
	});

	it("a refusal after a tool call, then an error result: completed, annotated, counted, and the next turn rebuilds", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] }, { meta: session });
		await mirrored(t, "TOOL read a.txt");
		const stream = streamedMessage(
			[
				{
					type: "tool_use",
					id: "toolu_s",
					name: "mcp__c__read",
					input: { path: "a" },
				},
			],
			{ stopReason: "refusal" },
		);
		t.query.emit(initMessage(), ...stream);
		const r = await reply(t.response);
		expect(r.stop).toBe("refusal");
		// What Claude Code reports once its aborted call is answered.
		t.query.emit(
			assistantMessage([{ type: "text", text: "API Error: 401" }], {
				error: "authentication_failed",
				model: "<synthetic>",
			}),
			resultMessage({ isError: true, result: "API Error: 401" }),
		);
		await settled(h);
		const row = h.repo.turns.get(t.plan.turnId);
		expect(row).toMatchObject({
			status: "completed",
			httpStatus: 200,
			stopReason: "refusal",
		});
		expect(String(row?.errorMessage)).toContain("refusal");
		expect(h.bridge.status().counters).toMatchObject({
			turnsCompleted: 1,
			turnsFailed: 0,
		});
		expect(
			await nextTurn(h, [
				first,
				{ role: "assistant", content: r.content },
				{ role: "user", content: "again" },
			]),
		).toMatch(/^rebuild_/);
	});

	it("stops the process once the turn is settled, whatever Claude Code does next", async () => {
		const h = harness();
		const t = await start(
			h,
			{ messages: [{ role: "user", content: "hello" }] },
			{ meta: session },
		);
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "echo" }]),
		);
		await reply(t.response);
		t.query.emit(compaction());
		await settled(h);
		expect(t.query.interrupted || t.query.closed).toBe(true);
		expect(h.repo.turns.get(t.plan.turnId)?.status).toBe("completed");
	});
});
