import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import {
	type SdkBridgeInnerOutcome,
	type SdkBridgeRoutePlan,
	type SdkBridgeTurnMeta,
	SdkBridgeUnavailableError,
} from "@clankermux/types";
import { FileSessionStore } from "../session-store";
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

function harness(overrides: Parameters<typeof makeHarness>[0] = {}): Harness {
	const h = makeHarness(overrides);
	harnesses.push(h);
	return h;
}

interface Started {
	response: Promise<Response>;
	query: FakeQuery;
	plan: SdkBridgeRoutePlan;
	meta: SdkBridgeTurnMeta;
	abort: AbortController;
}

async function start(
	h: Harness,
	body: Record<string, unknown>,
	opts: {
		meta?: Partial<SdkBridgeTurnMeta>;
		plan?: Partial<SdkBridgeRoutePlan>;
	} = {},
): Promise<Started> {
	const plan = makePlan(opts.plan);
	const meta = makeMeta(opts.meta);
	const abort = new AbortController();
	const response = h.bridge.startTurn({
		request: messagesRequest(body),
		plan,
		meta,
		signal: abort.signal,
	});
	const query = await h.sdk.next();
	return { response, query, plan, meta, abort };
}

function continueTurn(
	h: Harness,
	turnId: string,
	body: Record<string, unknown>,
	meta: Partial<SdkBridgeTurnMeta> = {},
) {
	const abort = new AbortController();
	return {
		abort,
		response: h.bridge.continueTurn({
			turnId,
			request: messagesRequest(body),
			meta: makeMeta(meta),
			signal: abort.signal,
		}),
	};
}

async function reply(response: Promise<Response>) {
	const res = await response;
	const events = parseSse(await res.text());
	return { status: res.status, events, ...foldReply(events) };
}

/** Claude Code making a model call through the bridge's inner listener. */
async function innerCall(query: FakeQuery, model = MODEL): Promise<Response> {
	const env = query.options.env ?? {};
	return fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ model, messages: [], stream: true }),
	});
}

function failInner(
	h: Harness,
	outcome: Partial<SdkBridgeInnerOutcome> & { status: number },
) {
	h.inner.respond = (_req, ctx) => {
		const full: SdkBridgeInnerOutcome = {
			requestId: "inner-1",
			errorType: null,
			message: "upstream failed",
			retryAfter: null,
			accountId: "acct-a",
			...outcome,
		};
		ctx.onInnerOutcome?.(full);
		return Response.json(
			{
				type: "error",
				error: { type: full.errorType ?? "api_error", message: full.message },
			},
			{ status: full.status },
		);
	};
}

async function settled(h: Harness) {
	await waitFor(() => h.bridge.status().live === 0);
	await Bun.sleep(10);
}

describe("a plain turn", () => {
	it("streams Claude Code's reply and records the turn and its leg", async () => {
		const h = harness();
		const t = await start(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "hi there" }]),
		);
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.content).toEqual([{ type: "text", text: "hi there" }]);
		expect(r.stop).toBe("end_turn");
		t.query.emit(resultMessage());
		await settled(h);

		expect(t.query.prompts[0]?.message.content).toEqual([
			{ type: "text", text: "hello" },
		]);
		expect(t.query.promptEnded).toBe(true);
		const env = t.query.options.env ?? {};
		expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(env.ANTHROPIC_AUTH_TOKEN).toStartWith("cmxsdk_");
		expect(t.query.options.model).toBe(MODEL);
		expect(t.query.options.resume).toBeUndefined();

		const turn = h.repo.turns.get(t.plan.turnId);
		expect(turn).toMatchObject({
			status: "completed",
			httpStatus: 200,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
			accountId: "acct-a",
			stopReason: "end_turn",
		});
		expect(turn?.legs).toEqual([
			expect.objectContaining({
				id: t.meta.legId,
				kind: "start",
				httpStatus: 200,
				stopReason: "end_turn",
			}),
		]);
	});

	it("never sends the client's system prompt", async () => {
		const h = harness();
		const t = await start(h, {
			system: "You are pi. Use extra usage.",
			messages: [{ role: "user", content: "hello" }],
		});
		expect(t.query.options.systemPrompt).toEqual({
			type: "preset",
			preset: "claude_code",
			snapshot: false,
		});
		expect(JSON.stringify(t.query.options)).not.toContain("You are pi");
	});

	it("answers stream:false with one JSON Message", async () => {
		const h = harness();
		const t = await start(h, {
			stream: false,
			messages: [{ role: "user", content: "hello" }],
		});
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "hi" }]),
		);
		const res = await t.response;
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as {
			content: unknown;
			stop_reason: string;
		};
		expect(body.content).toEqual([{ type: "text", text: "hi" }]);
		expect(body.stop_reason).toBe("end_turn");
	});

	it("revokes the turn's token once the turn is over", async () => {
		const h = harness();
		const t = await start(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		expect((await innerCall(t.query)).status).toBe(200);
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "hi" }]),
			resultMessage(),
		);
		await reply(t.response);
		await settled(h);
		expect((await innerCall(t.query)).status).toBe(401);
		expect(h.repo.turns.get(t.plan.turnId)?.counters.innerCalls).toBe(0);
	});
});

describe("parked tool calls", () => {
	const tools = [READ_TOOL];
	const first: Msg = { role: "user", content: "TOOL read a.txt" };

	it("round-trips a client tool call through a parked MCP handler", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		const listed = await (await t.query.mcp()).listTools();
		expect(listed.tools).toEqual([
			{
				name: "read",
				description: "Read a file",
				inputSchema: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
				_meta: { "anthropic/alwaysLoad": true },
			},
		]);
		expect(t.query.options.allowedTools).toEqual(["mcp__client__read"]);

		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "text", text: "Reading." },
				{
					type: "tool_use",
					id: "toolu_1",
					name: "mcp__client__read",
					input: { path: "a.txt" },
				},
			]),
		);
		const r1 = await reply(t.response);
		expect(r1.stop).toBe("tool_use");
		expect(r1.content[1]).toEqual({
			type: "tool_use",
			id: "toolu_1",
			name: "read",
			input: { path: "a.txt" },
		});

		const call = t.query.callTool("toolu_1", "read", { path: "a.txt" });
		await waitFor(() => h.bridge.status().parked === 1);
		expect(h.bridge.findContinuation(["toolu_1"])).toEqual({
			turnId: t.plan.turnId,
			ownerApiKeyId: "key-1",
		});

		const c = continueTurn(h, t.plan.turnId, {
			tools,
			messages: [
				first,
				{ role: "assistant", content: r1.content },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_1",
							content: "CONTENT-A",
						},
					],
				},
			],
		});
		expect(await call).toEqual({
			content: [{ type: "text", text: "CONTENT-A" }],
			isError: false,
		});
		t.query.emit(
			...streamedMessage([{ type: "text", text: "done: CONTENT-A" }]),
		);
		const r2 = await reply(c.response);
		expect(r2.content).toEqual([{ type: "text", text: "done: CONTENT-A" }]);
		t.query.emit(resultMessage());
		await settled(h);

		const turn = h.repo.turns.get(t.plan.turnId);
		expect(turn?.status).toBe("completed");
		expect(turn?.counters.toolRounds).toBe(1);
		expect(
			turn?.legs.map((l) => [l.kind, l.httpStatus, l.stopReason, l.toolUseIds]),
		).toEqual([
			["start", 200, "tool_use", ["toolu_1"]],
			["continue", 200, "end_turn", null],
		]);
		expect(h.bridge.findContinuation(["toolu_1"])).toBeNull();
	});

	it("handles parallel calls whose results arrive before Claude Code asks", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{
					type: "tool_use",
					id: "toolu_a",
					name: "mcp__client__read",
					input: { path: "a" },
				},
				{
					type: "tool_use",
					id: "toolu_b",
					name: "mcp__client__read",
					input: { path: "b" },
				},
			]),
		);
		const r1 = await reply(t.response);
		expect(r1.content.map((b) => b.id)).toEqual(["toolu_a", "toolu_b"]);
		// Only one call reached the MCP handler before the client answered both.
		const callA = t.query.callTool("toolu_a", "read");
		await waitFor(() => h.bridge.status().parked === 1);
		const c = continueTurn(h, t.plan.turnId, {
			tools,
			messages: [
				first,
				{ role: "assistant", content: r1.content },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_a", content: "A" },
						{
							type: "tool_result",
							tool_use_id: "toolu_b",
							content: [{ type: "text", text: "B" }],
						},
					],
				},
			],
		});
		const callB = t.query.callTool("toolu_b", "read");
		expect(((await callA).content as Array<{ text: string }>)[0]?.text).toBe(
			"A",
		);
		expect(((await callB).content as Array<{ text: string }>)[0]?.text).toBe(
			"B",
		);
		t.query.emit(
			...streamedMessage([{ type: "text", text: "both" }]),
			resultMessage(),
		);
		expect((await reply(c.response)).content).toEqual([
			{ type: "text", text: "both" },
		]);
	});

	it("keeps a streamed reply open when Claude Code starts a tool before the message ends", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		const events = streamedMessage([
			{
				type: "tool_use",
				id: "toolu_s1",
				name: "mcp__client__read",
				input: { path: "a" },
			},
			{
				type: "tool_use",
				id: "toolu_s2",
				name: "mcp__client__read",
				input: { path: "b" },
			},
		]);
		// Up to the first block's content_block_stop.
		t.query.emit(initMessage(), ...events.slice(0, 4));
		await Bun.sleep(10);
		const call = t.query.callTool("toolu_s1", "read");
		await waitFor(
			() =>
				h.bridge.status().parked === 0 &&
				h.bridge.findContinuation(["toolu_s1"]) !== null,
		);
		await Bun.sleep(20);
		t.query.emit(...events.slice(4));
		const r = await reply(t.response);
		expect(r.content.map((b) => b.id)).toEqual(["toolu_s1", "toolu_s2"]);
		expect(r.stop).toBe("tool_use");
		void call;
	});

	it("does not forward a tool the client does not have, and keeps one message per reply", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "text", text: "Let me look." },
				{
					type: "tool_use",
					id: "toolu_x",
					name: "Bash",
					input: { command: "ls" },
				},
			]),
			// Claude Code answers the unknown tool itself and asks the model again.
			...streamedMessage([{ type: "text", text: "Here is the answer." }]),
		);
		const r = await reply(t.response);
		expect(r.events.filter((e) => e.event === "message_start")).toHaveLength(1);
		expect(r.events.filter((e) => e.event === "message_stop")).toHaveLength(1);
		expect(r.content).toEqual([
			{ type: "text", text: "Let me look." },
			{ type: "text", text: "Here is the answer." },
		]);
		expect(r.stop).toBe("end_turn");
		expect(h.bridge.findContinuation(["toolu_x"])).toBeNull();
	});

	it("does not forward a prefixed name that is not one of the client's tools", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{
					type: "tool_use",
					id: "toolu_y",
					name: "mcp__client__write",
					input: {},
				},
			]),
			...streamedMessage([{ type: "text", text: "ok" }]),
		);
		const r = await reply(t.response);
		expect(r.content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("ends the reply at the tool call when Claude Code fell back to a non-streamed message", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		t.query.emit(
			initMessage(),
			assistantMessage([
				{
					type: "tool_use",
					id: "toolu_f",
					name: "mcp__client__read",
					input: { path: "f" },
				},
			]),
		);
		const call = t.query.callTool("toolu_f", "read", { path: "f" });
		const r = await reply(t.response);
		expect(r.stop).toBe("tool_use");
		expect(r.content).toEqual([
			{ type: "tool_use", id: "toolu_f", name: "read", input: { path: "f" } },
		]);
		continueTurn(h, t.plan.turnId, {
			tools,
			messages: [
				first,
				{ role: "assistant", content: r.content },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_f", content: "F" },
					],
				},
			],
		});
		expect(((await call).content as Array<{ text: string }>)[0]?.text).toBe(
			"F",
		);
	});

	it("refuses a continuation from another API key", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{
					type: "tool_use",
					id: "toolu_1",
					name: "mcp__client__read",
					input: {},
				},
			]),
		);
		await reply(t.response);
		const c = continueTurn(
			h,
			t.plan.turnId,
			{
				tools,
				messages: [
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_1", content: "x" },
						],
					},
				],
			},
			{ apiKeyId: "key-2" },
		);
		expect((await c.response).status).toBe(409);
	});

	it("tears a query down when the client never answers, and later results get 409", async () => {
		const h = harness({ limits: () => ({ parkedTimeoutMs: 80 }) });
		const t = await start(h, { tools, messages: [first] });
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{
					type: "tool_use",
					id: "toolu_1",
					name: "mcp__client__read",
					input: {},
				},
			]),
		);
		await reply(t.response);
		const call = t.query.callTool("toolu_1", "read");
		expect((await call).isError).toBe(true);
		await settled(h);
		expect(t.query.interrupted).toBe(true);
		expect(t.query.closed).toBe(true);
		expect(h.bridge.findContinuation(["toolu_1"])).toBeNull();
		const c = continueTurn(h, t.plan.turnId, {
			tools,
			messages: [
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: "late" },
					],
				},
			],
		});
		expect((await c.response).status).toBe(409);
		expect(h.repo.turns.get(t.plan.turnId)?.status).toBe("timed_out");
	});

	it("refuses a start request that answers tool calls no live query issued", async () => {
		const h = harness();
		const res = await h.bridge.startTurn({
			request: messagesRequest({
				tools,
				messages: [
					first,
					{
						role: "assistant",
						content: [
							{ type: "tool_use", id: "gone", name: "read", input: {} },
						],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "gone", content: "x" },
						],
					},
				],
			}),
			plan: makePlan(),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		expect(res.status).toBe(409);
		expect(h.sdk.queries).toHaveLength(0);
	});

	it("stops a turn that issues more parallel calls than the limit", async () => {
		const h = harness({ limits: () => ({ maxParkedCallsPerTurn: 1 }) });
		const t = await start(h, { tools, messages: [first] });
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{
					type: "tool_use",
					id: "toolu_1",
					name: "mcp__client__read",
					input: {},
				},
				{
					type: "tool_use",
					id: "toolu_2",
					name: "mcp__client__read",
					input: {},
				},
			]),
		);
		const r = await reply(t.response);
		expect(r.errors[0]?.data).toMatchObject({
			error: {
				message: "SDK bridge limit maxParkedCallsPerTurn exceeded: 2 > 1",
			},
		});
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)?.status).toBe("failed");
	});
});

describe("conversations", () => {
	const header = {
		affinityScope: "client_session",
		affinityKey: "sess-1",
	} as const;

	/** What the real CLI does through `sessionStore.append`: mirror its transcript. */
	async function mirror(
		query: FakeQuery,
		entries: Array<Record<string, unknown>>,
	) {
		const store = query.options.sessionStore as SessionStore;
		const sessionId = (query.options.sessionId ??
			query.options.resume) as string;
		await store.append(
			{ projectKey: "p", sessionId },
			entries.map((e) => ({ type: "user", sessionId, ...e })),
		);
	}

	async function firstTurn(h: Harness, meta: Partial<SdkBridgeTurnMeta>) {
		const t = await start(
			h,
			{ messages: [{ role: "user", content: "hello" }] },
			{ meta },
		);
		await mirror(t.query, [
			{ uuid: "u1", message: { role: "user", content: "hello" } },
		]);
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "echo: hello" }]),
		);
		const r = await reply(t.response);
		return { t, r };
	}

	const second = (r: { content: unknown }) => ({
		messages: [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: r.content },
			{ role: "user", content: "again" },
		],
	});

	it("resumes the conversation's session on the next user turn when a session header is present", async () => {
		const h = harness();
		const { t, r } = await firstTurn(h, header);
		t.query.emit(resultMessage());
		await settled(h);
		const t2 = await start(h, second(r), { meta: header });
		const resumed = t2.query.options.resume as string;
		expect(resumed).toBeTruthy();
		expect(resumed).not.toBe(t.query.options.sessionId);
		// The new session is a copy under its own id; the old one stays pristine.
		const store = new FileSessionStore(join(h.workRoot, "sessions"));
		expect(store.read(resumed)?.map((e) => [e.uuid, e.sessionId])).toEqual([
			["u1", resumed],
		]);
		expect(t2.query.prompts[0]?.message.content).toEqual([
			{ type: "text", text: "again" },
		]);
		expect(h.repo.turns.get(t2.plan.turnId)).toMatchObject({
			historyMode: "resume",
			rebuildReason: null,
		});
	});

	it("waits for the previous turn to settle when the next request overtakes its result", async () => {
		const h = harness();
		const { t, r } = await firstTurn(h, header);
		// The reply ended at message_stop; Claude Code has not reported `result` yet.
		const nextStarted = h.bridge.startTurn({
			request: messagesRequest(second(r)),
			plan: makePlan(),
			meta: makeMeta(header),
			signal: new AbortController().signal,
		});
		await Bun.sleep(50);
		expect(h.sdk.queries).toHaveLength(1);
		t.query.emit(resultMessage());
		const t2 = await h.sdk.next();
		expect(t2.options.resume).toBeTruthy();
		t2.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "echo: again" }]),
			resultMessage(),
		);
		expect((await reply(nextStarted)).content).toEqual([
			{ type: "text", text: "echo: again" },
		]);
	});

	it("never resumes without a session header, even for an identical history", async () => {
		const h = harness();
		const a = await firstTurn(h, {});
		a.t.query.emit(resultMessage());
		await settled(h);
		const b = await start(h, second(a.r));
		const b2 = await start(h, second(a.r));
		for (const q of [b.query, b2.query]) {
			const store = new FileSessionStore(join(h.workRoot, "sessions"));
			const entries = store.read(q.options.resume as string);
			// A rebuilt transcript, not a copy of the first turn's session.
			expect(entries?.map((e) => e.type)).toEqual(["user", "assistant"]);
			expect(entries?.[0]?.uuid).not.toBe("u1");
		}
		expect(b.query.options.resume).not.toBe(b2.query.options.resume);
		expect(h.repo.turns.get(b.plan.turnId)).toMatchObject({
			historyMode: "rebuild_transcript",
			rebuildReason: "unknown",
			conversationKeyHash: null,
		});
	});

	it("rebuilds with a classified reason when the history no longer matches", async () => {
		const h = harness();
		const { t } = await firstTurn(h, header);
		t.query.emit(resultMessage());
		await settled(h);
		const t2 = await start(
			h,
			{
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "an edited answer" },
					{ role: "user", content: "again" },
				],
			},
			{ meta: header },
		);
		expect(h.repo.turns.get(t2.plan.turnId)).toMatchObject({
			historyMode: "rebuild_transcript",
			rebuildReason: "edit",
		});
	});

	it("rebuilds on an account change", async () => {
		const h = harness();
		const { t, r } = await firstTurn(h, header);
		t.query.emit(resultMessage());
		await settled(h);
		const t2 = await start(h, second(r), {
			meta: header,
			plan: {
				candidates: [
					{ accountId: "acct-b", provider: "anthropic", upstreamModel: MODEL },
				],
				preferredAccountId: "acct-b",
			},
		});
		expect(h.repo.turns.get(t2.plan.turnId)).toMatchObject({
			rebuildReason: "account_change",
		});
	});

	it("flattens a history a transcript cannot represent, with a provenance note", async () => {
		const h = harness();
		const t = await start(h, {
			messages: [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "t0", name: "gone_tool", input: {} },
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t0", content: "r" }],
				},
				{ role: "assistant", content: "done" },
				{ role: "user", content: "next" },
			],
		});
		const content = t.query.prompts[0]?.message.content as Array<{
			type: string;
			text: string;
		}>;
		expect(content[0]?.text).toContain("not a new message");
		expect(content[0]?.text).toContain("[tool call gone_tool id=t0]");
		expect(content.at(-1)).toEqual({ type: "text", text: "next" });
		expect(t.query.options.resume).toBeUndefined();
		expect(h.repo.turns.get(t.plan.turnId)?.historyMode).toBe(
			"rebuild_flattened",
		);
	});

	it("deletes the session files of turns no conversation can resume", async () => {
		const h = harness();
		const { t } = await firstTurn(h, {});
		t.query.emit(resultMessage());
		await settled(h);
		expect(readdirSync(join(h.workRoot, "sessions"))).toEqual([]);
	});
});

describe("errors", () => {
	it("answers a pre-output inner 429 with its status and Retry-After", async () => {
		const h = harness();
		failInner(h, {
			status: 429,
			errorType: "rate_limit_error",
			message: "all accounts limited",
			retryAfter: "12",
		});
		const t = await start(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		expect((await innerCall(t.query)).status).toBe(429);
		t.query.emit(
			initMessage(),
			assistantMessage(
				[{ type: "text", text: "API Error: 429 rate limited" }],
				{
					error: "rate_limit",
					model: "<synthetic>",
				},
			),
			resultMessage({ isError: true, result: "API Error: 429 rate limited" }),
		);
		const res = await t.response;
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("12");
		expect(await res.json()).toEqual({
			type: "error",
			error: { type: "rate_limit_error", message: "all accounts limited" },
		});
		await settled(h);
		const turn = h.repo.turns.get(t.plan.turnId);
		expect(turn).toMatchObject({ status: "failed", httpStatus: 429 });
		expect(turn?.counters).toMatchObject({ innerCalls: 1, innerErrors: 1 });
		expect(turn?.legs[0]).toMatchObject({
			httpStatus: 429,
			errorPhase: "pre_head",
		});
	});

	it("sends a mid-stream failure as an SSE error event", async () => {
		const h = harness();
		failInner(h, {
			status: 529,
			errorType: "overloaded_error",
			message: "overloaded",
		});
		const t = await start(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		const partial = streamedMessage([{ type: "text", text: "partial" }]).slice(
			0,
			3,
		);
		t.query.emit(initMessage(), ...partial);
		await innerCall(t.query);
		t.query.emit(resultMessage({ isError: true, result: "API Error: 529" }));
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.errors[0]?.data).toEqual({
			type: "error",
			error: { type: "overloaded_error", message: "overloaded" },
		});
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)?.legs[0]).toMatchObject({
			httpStatus: 529,
			errorPhase: "mid_stream",
		});
	});

	it("passes an inner 400 (out of extra usage) through verbatim from a success-typed error result", async () => {
		const h = harness();
		const message =
			"You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
		failInner(h, { status: 400, errorType: "invalid_request_error", message });
		const t = await start(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		await innerCall(t.query);
		t.query.emit(
			initMessage(),
			resultMessage({
				isError: true,
				subtype: "success",
				result: `API Error: 400 ${message}`,
			}),
		);
		const res = await t.response;
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			type: "error",
			error: { type: "invalid_request_error", message },
		});
	});

	it("never passes Claude Code's 'Failed to authenticate' through", async () => {
		const h = harness();
		const t = await start(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		t.query.emit(
			initMessage(),
			resultMessage({
				isError: true,
				result: "Failed to authenticate. API Error: 401 invalid bearer token",
			}),
		);
		const res = await t.response;
		expect(res.status).toBe(502);
		const text = await res.text();
		expect(text.toLowerCase()).not.toContain("authenticate");
		expect(text.toLowerCase()).not.toContain("bearer");
	});

	it("answers 502 when Claude Code exits without a result", async () => {
		const h = harness();
		const t = await start(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		t.query.emit(initMessage());
		t.query.end();
		expect((await t.response).status).toBe(502);
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)?.status).toBe("failed");
	});

	it("answers 504 at the turn deadline and kills the query", async () => {
		const h = harness({ limits: () => ({ turnDeadlineMs: 80 }) });
		const t = await start(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		const res = await t.response;
		expect(res.status).toBe(504);
		expect(t.query.closed).toBe(true);
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
			status: "timed_out",
			httpStatus: 504,
		});
	});
});

describe("admission through the bridge", () => {
	it("answers 529 once the process cap is reached", async () => {
		const h = harness({ limits: () => ({ maxProcesses: 1 }) });
		await start(h, { messages: [{ role: "user", content: "one" }] });
		const plan = makePlan();
		const res = await h.bridge.startTurn({
			request: messagesRequest({
				messages: [{ role: "user", content: "two" }],
			}),
			plan,
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		expect(res.status).toBe(529);
		expect(res.headers.get("retry-after")).toBeTruthy();
		expect(h.sdk.queries).toHaveLength(1);
		await Bun.sleep(10);
		expect(h.repo.turns.get(plan.turnId)).toMatchObject({
			status: "rejected",
			httpStatus: 529,
		});
		expect(h.bridge.status().counters.rejected).toEqual({ process_cap: 1 });
	});

	it("answers 503 for an empty plan and 413 for an oversized body", async () => {
		const h = harness({ limits: () => ({ maxHistoryBytes: 200 }) });
		const empty = await h.bridge.startTurn({
			request: messagesRequest({ messages: [{ role: "user", content: "x" }] }),
			plan: makePlan({ candidates: [] }),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		expect(empty.status).toBe(503);
		const big = await h.bridge.startTurn({
			request: messagesRequest({
				messages: [{ role: "user", content: "x".repeat(500) }],
			}),
			plan: makePlan(),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		expect(big.status).toBe(413);
		expect(
			((await big.json()) as { error: { message: string } }).error.message,
		).toContain("maxHistoryBytes");
		expect(h.sdk.queries).toHaveLength(0);
	});

	it("rejects server tools with 400 before spawning", async () => {
		const h = harness();
		const res = await h.bridge.startTurn({
			request: messagesRequest({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
				messages: [{ role: "user", content: "x" }],
			}),
			plan: makePlan(),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		expect(res.status).toBe(400);
		expect(h.sdk.queries).toHaveLength(0);
	});
});

describe("client disconnect", () => {
	it("answers the awaiting caller when the client leaves before any output", async () => {
		const h = harness();
		const t = await start(h, { messages: [{ role: "user", content: "SLOW" }] });
		t.query.emit(initMessage());
		t.abort.abort();
		expect((await t.response).status).toBe(499);
		await settled(h);
		expect(t.query.closed).toBe(true);
		expect(h.repo.turns.get(t.plan.turnId)?.legs[0]).toMatchObject({
			httpStatus: 499,
			errorPhase: "pre_head",
		});
	});

	it("tears the query down and records the leg", async () => {
		const h = harness();
		const t = await start(h, { messages: [{ role: "user", content: "SLOW" }] });
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "partial" }]).slice(0, 3),
		);
		const res = await t.response;
		expect(res.status).toBe(200);
		t.abort.abort();
		await settled(h);
		expect(t.query.interrupted).toBe(true);
		expect(t.query.closed).toBe(true);
		expect((await innerCall(t.query)).status).toBe(401);
		const turn = h.repo.turns.get(t.plan.turnId);
		expect(turn?.status).toBe("aborted");
		expect(turn?.legs[0]).toMatchObject({
			httpStatus: 499,
			errorPhase: "mid_stream",
		});
	});
});

describe("availability and shutdown", () => {
	it("is unavailable, with a reason, without a Claude Code executable", async () => {
		const h = harness({ claudeExecutablePath: null });
		expect(h.bridge.availability()).toEqual({
			state: "unavailable",
			reason: "no Claude Code executable configured",
		});
		await expect(
			h.bridge.startTurn({
				request: messagesRequest({
					messages: [{ role: "user", content: "x" }],
				}),
				plan: makePlan(),
				meta: makeMeta(),
				signal: new AbortController().signal,
			}),
		).rejects.toBeInstanceOf(SdkBridgeUnavailableError);
	});

	it("fails over (throws SdkBridgeUnavailableError) when Claude Code cannot start", async () => {
		const h = harness({
			queryFn: () => {
				throw new Error("dependency missing");
			},
		});
		await expect(
			h.bridge.startTurn({
				request: messagesRequest({
					messages: [{ role: "user", content: "x" }],
				}),
				plan: makePlan(),
				meta: makeMeta(),
				signal: new AbortController().signal,
			}),
		).rejects.toBeInstanceOf(SdkBridgeUnavailableError);
	});

	it("kills parked queries at beginShutdown, and any that park later, and refuses new turns", async () => {
		const h = harness();
		const tools = [READ_TOOL];
		const parked = await start(h, {
			tools,
			messages: [{ role: "user", content: "TOOL" }],
		});
		parked.query.emit(
			initMessage(),
			...streamedMessage([
				{
					type: "tool_use",
					id: "toolu_p",
					name: "mcp__client__read",
					input: {},
				},
			]),
		);
		await reply(parked.response);
		const parkedCall = parked.query.callTool("toolu_p", "read");
		const running = await start(h, {
			tools,
			messages: [{ role: "user", content: "TOOL 2" }],
		});
		running.query.emit(initMessage());

		h.bridge.beginShutdown();
		expect(h.bridge.availability()).toEqual({ state: "shutting_down" });
		expect((await parkedCall).isError).toBe(true);
		await waitFor(() => parked.query.closed);
		expect(running.query.closed).toBe(false);
		await expect(
			h.bridge.startTurn({
				request: messagesRequest({
					messages: [{ role: "user", content: "x" }],
				}),
				plan: makePlan(),
				meta: makeMeta(),
				signal: new AbortController().signal,
			}),
		).rejects.toBeInstanceOf(SdkBridgeUnavailableError);

		running.query.emit(
			...streamedMessage([
				{
					type: "tool_use",
					id: "toolu_r",
					name: "mcp__client__read",
					input: {},
				},
			]),
		);
		expect((await reply(running.response)).stop).toBe("tool_use");
		await waitFor(() => running.query.closed);
		await settled(h);
		expect(h.repo.turns.get(parked.plan.turnId)?.status).toBe("shutdown");
		expect(h.repo.turns.get(running.plan.turnId)?.status).toBe("shutdown");
	});

	it("dispose aborts running queries with 503", async () => {
		const h = harness();
		const t = await start(h, {
			messages: [{ role: "user", content: "hello" }],
		});
		await h.bridge.dispose();
		const res = await t.response;
		expect(res.status).toBe(503);
		expect(t.query.closed).toBe(true);
		expect(h.bridge.status().live).toBe(0);
	});
});
