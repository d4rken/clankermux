import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import {
	SdkBridgeCapacityError,
	type SdkBridgeInnerOutcome,
	type SdkBridgeRoutePlan,
	type SdkBridgeTurnMeta,
	SdkBridgeUnavailableError,
} from "@clankermux/types";
import { FileSessionStore } from "../session-store";
import {
	assistantMessage,
	type FakeQuery,
	fakeQueryFn,
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

/** The start meta's key and model, as the proxy's lookup names them. */
const CALLER = { apiKeyId: "key-1", model: MODEL };
type Block = { type: string; [key: string]: unknown };

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.bridge.dispose();
		rmSync(h.workRoot, { recursive: true, force: true });
	}
});

/** The bridge process's own directory under the work root. */
function generationDir(h: Harness): string {
	const [name] = readdirSync(h.workRoot).filter((n) => n.startsWith("gen-"));
	if (!name) throw new Error("no generation directory");
	return join(h.workRoot, name);
}

function sessionsDir(h: Harness): string {
	return join(generationDir(h), "sessions");
}

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
		const requestId = crypto.randomUUID();
		// The proxy reports the row's start before the call's outcome.
		ctx.onInnerRequestStarted?.(requestId);
		const full: SdkBridgeInnerOutcome = {
			requestId,
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

	it("gives Claude Code the client's output limit and records the fields it ignores", async () => {
		const h = harness();
		const t = await start(h, {
			max_tokens: 777,
			temperature: 0.1,
			messages: [{ role: "user", content: "hello" }],
		});
		expect(t.query.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("777");
		await waitFor(() => h.repo.turns.has(t.plan.turnId));
		expect(h.repo.turns.get(t.plan.turnId)?.ignoredFields).toEqual([
			"temperature",
		]);

		// An adapter's default limit is not the client's.
		const d = await start(
			h,
			{ max_tokens: 4096, messages: [{ role: "user", content: "hello" }] },
			{
				meta: {
					translationGaps: {
						maxTokensDefaulted: true,
						droppedFields: ["top_p"],
					},
				},
			},
		);
		expect(d.query.options.env).not.toHaveProperty(
			"CLAUDE_CODE_MAX_OUTPUT_TOKENS",
		);
		await waitFor(() => h.repo.turns.has(d.plan.turnId));
		expect(h.repo.turns.get(d.plan.turnId)?.ignoredFields).toEqual(["top_p"]);
	});

	it("refuses stop sequences before starting Claude Code", async () => {
		const h = harness();
		const plan = makePlan();
		const res = await h.bridge.startTurn({
			request: messagesRequest({
				stop_sequences: ["END"],
				messages: [{ role: "user", content: "hello" }],
			}),
			plan,
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		expect(res.status).toBe(400);
		expect(
			((await res.json()) as { error: { message: string } }).error.message,
		).toContain("stop_sequences");
		expect(h.sdk.queries).toEqual([]);
		await waitFor(() => h.repo.turns.get(plan.turnId)?.status === "rejected");
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
		expect(t.query.options.allowedTools).toEqual(["mcp__c__read"]);

		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "text", text: "Reading." },
				{
					type: "tool_use",
					id: "toolu_1",
					name: "mcp__c__read",
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
		expect(h.bridge.findContinuation(["toolu_1"], CALLER)).toEqual({
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
		expect(h.bridge.findContinuation(["toolu_1"], CALLER)).toBeNull();
	});

	describe("tool names that would not fit the API's 64 characters", () => {
		const UPSTREAM_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
		// The longest name a client may send, and the Chat adapter's encoding.
		const long = `${"x".repeat(60)}read`;
		const chat = `cmux_chat_${"a1b2c3d4".repeat(6)}`;
		const aliasedTools = [
			{ ...READ_TOOL, name: long },
			{ ...READ_TOOL, name: chat },
			READ_TOOL,
		];

		it("go by a short alias inside Claude Code and by their own name to the client", async () => {
			const h = harness();
			const t = await start(h, { tools: aliasedTools, messages: [first] });
			const listed = (await (await t.query.mcp()).listTools()).tools.map(
				(tool) => tool.name,
			);
			const upstream = t.query.options.allowedTools ?? [];
			expect(upstream).toEqual(listed.map((name) => `mcp__c__${name}`));
			for (const name of upstream) expect(name).toMatch(UPSTREAM_NAME);
			expect(listed[0]).toMatch(/^t_[0-9a-f]{16}$/);
			expect(listed[1]).toMatch(/^t_[0-9a-f]{16}$/);
			expect(listed[2]).toBe("read");

			t.query.emit(
				initMessage(),
				...streamedMessage([
					{ type: "tool_use", id: "tl_1", name: upstream[0], input: {} },
					{ type: "tool_use", id: "tl_2", name: upstream[1], input: {} },
				]),
			);
			const r1 = await reply(t.response);
			expect(r1.content.map((b) => b.name)).toEqual([long, chat]);

			const calls = [
				t.query.callTool("tl_1", listed[0] ?? ""),
				t.query.callTool("tl_2", listed[1] ?? ""),
			];
			await waitFor(() => h.bridge.status().parked === 1);
			const c = continueTurn(h, t.plan.turnId, {
				tools: aliasedTools,
				messages: [
					first,
					{ role: "assistant", content: r1.content },
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "tl_1", content: "L" },
							{ type: "tool_result", tool_use_id: "tl_2", content: "C" },
						],
					},
				],
			});
			expect(
				(await Promise.all(calls)).map(
					(r) => (r.content as Array<{ text: string }>)[0]?.text,
				),
			).toEqual(["L", "C"]);
			t.query.emit(
				...streamedMessage([{ type: "text", text: "ok" }]),
				resultMessage(),
			);
			expect((await reply(c.response)).content).toEqual([
				{ type: "text", text: "ok" },
			]);
		});

		it("keep their alias in a rebuilt transcript and a flattened history", async () => {
			const h = harness();
			const history = [
				first,
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tl_0", name: long, input: {} }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tl_0", content: "r" }],
				},
				{ role: "assistant", content: "done" },
				{ role: "user", content: "next" },
			];
			const t = await start(h, { tools: aliasedTools, messages: history });
			const [alias] = t.query.options.allowedTools ?? [];
			const store = new FileSessionStore(sessionsDir(h));
			const entries = store.read(t.query.options.resume as string) ?? [];
			const names = entries.flatMap((e) =>
				e.type === "assistant"
					? (
							(e.message as { content: Array<{ type: string; name?: string }> })
								.content ?? []
						)
							.filter((b) => b.type === "tool_use")
							.map((b) => b.name)
					: [],
			);
			expect(names).toEqual([alias]);

			// A tool the turn no longer declares forces the flattened form.
			const f = await start(h, {
				tools: aliasedTools,
				messages: [
					...history.slice(0, 4),
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "g", name: "gone", input: {} }],
					},
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "g", content: "x" }],
					},
					{ role: "user", content: "next" },
				],
			});
			const flat = (
				f.query.prompts[0]?.message.content as Array<{ text: string }>
			)[0]?.text;
			expect(flat).toContain(
				`[tool call ${alias?.slice("mcp__c__".length)} id=tl_0]`,
			);
			expect(flat).toContain("[tool call gone id=g]");
		});
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
					name: "mcp__c__read",
					input: { path: "a" },
				},
				{
					type: "tool_use",
					id: "toolu_b",
					name: "mcp__c__read",
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
				name: "mcp__c__read",
				input: { path: "a" },
			},
			{
				type: "tool_use",
				id: "toolu_s2",
				name: "mcp__c__read",
				input: { path: "b" },
			},
		]);
		// Up to the first block's content_block_stop.
		t.query.emit(initMessage(), ...events.slice(0, 4));
		await Bun.sleep(10);
		const call = t.query.callTool("toolu_s1", "read");
		await Bun.sleep(30);
		// The call waits, but the reply is still open: nothing is parked yet.
		expect(h.bridge.status().parked).toBe(0);
		expect(h.bridge.findContinuation(["toolu_s1"], CALLER)).toBeNull();
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
		expect(h.bridge.findContinuation(["toolu_x"], CALLER)).toBeNull();
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
					name: "mcp__c__write",
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
					name: "mcp__c__read",
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
					name: "mcp__c__read",
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
		// Recorded once, as a refused continuation leg; the turn stays parked.
		await waitFor(
			() => h.repo.turns.get(t.plan.turnId)?.legs[1]?.finished === true,
		);
		expect(h.repo.turns.get(t.plan.turnId)?.legs[1]).toMatchObject({
			kind: "continue",
			httpStatus: 409,
			errorPhase: "pre_head",
		});
		expect(h.bridge.status().parked).toBe(1);
	});

	describe("the model a continuation names", () => {
		async function parked(model: string) {
			const h = harness();
			const t = await start(
				h,
				{ tools, messages: [first] },
				{ meta: { model } },
			);
			t.query.emit(
				initMessage(),
				...streamedMessage([
					{
						type: "tool_use",
						id: "toolu_1",
						name: "mcp__c__read",
						input: {},
					},
				]),
			);
			await reply(t.response);
			return { h, t };
		}
		const results = {
			tools,
			messages: [
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: "x" },
					],
				},
			],
		};

		// The route resolves an alias to a different upstream model; only the
		// client's own string is compared.
		for (const model of ["sonnet", MODEL])
			it(`continues a turn that started on "${model}" with the same name`, async () => {
				const { h, t } = await parked(model);
				expect(
					h.bridge.findContinuation(["toolu_1"], { apiKeyId: "key-1", model })
						?.turnId,
				).toBe(t.plan.turnId);
				const call = t.query.callTool("toolu_1", "read");
				const c = continueTurn(h, t.plan.turnId, results, { model });
				expect(((await call).content as Array<{ text: string }>)[0]?.text).toBe(
					"x",
				);
				t.query.emit(
					...streamedMessage([{ type: "text", text: "done" }]),
					resultMessage(),
				);
				expect((await c.response).status).toBe(200);
			});

		it("hands results under another model to a fresh turn, freeing the parked one", async () => {
			const { h, t } = await parked("sonnet");
			const r1 = t.query;
			expect(
				h.bridge.findContinuation(["toolu_1"], {
					apiKeyId: "key-1",
					model: "opus",
				}),
			).toBeNull();
			expect(h.bridge.status().parked).toBe(0);
			expect(r1.interrupted).toBe(true);
			await settled(h);
			expect(h.repo.turns.get(t.plan.turnId)?.status).toBe("aborted");

			// What the proxy then does with the same request: a start.
			const issued = {
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }],
			};
			const fresh = await start(
				h,
				{ tools, messages: [first, issued, ...results.messages] },
				{ meta: { model: "opus" } },
			);
			await waitFor(() => h.repo.turns.has(fresh.plan.turnId));
			expect(h.repo.turns.get(fresh.plan.turnId)).toMatchObject({
				historyMode: "rebuild_flattened",
				rebuildReason: "dead_continuation",
			});
		});

		it("leaves another key's results to the refusal, whatever model they name", async () => {
			const { h, t } = await parked("sonnet");
			const caller = { apiKeyId: "key-2", model: "opus" };
			expect(h.bridge.findContinuation(["toolu_1"], caller)?.turnId).toBe(
				t.plan.turnId,
			);
			const c = continueTurn(h, t.plan.turnId, results, caller);
			expect((await c.response).status).toBe(409);
			expect(h.bridge.status().parked).toBe(1);
		});

		it("refuses partial results under another model as stale, and keeps the turn", async () => {
			const h = harness();
			const t = await start(
				h,
				{ tools, messages: [first] },
				{ meta: { model: "sonnet" } },
			);
			t.query.emit(
				initMessage(),
				...streamedMessage([
					{ type: "tool_use", id: "toolu_a", name: "mcp__c__read", input: {} },
					{ type: "tool_use", id: "toolu_b", name: "mcp__c__read", input: {} },
				]),
			);
			await reply(t.response);
			const partial = {
				tools,
				messages: [
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_a", content: "a" },
						],
					},
				],
			};
			const caller = { apiKeyId: "key-1", model: "opus" };
			expect(h.bridge.findContinuation(["toolu_a"], caller)?.turnId).toBe(
				t.plan.turnId,
			);
			const c = continueTurn(h, t.plan.turnId, partial, caller);
			const res = await c.response;
			expect(res.status).toBe(409);
			expect((await res.json()).error.message).toContain("stale tool results");
			expect(h.bridge.status().parked).toBe(1);
		});

		it("refuses results under another model sent past the lookup, and frees the turn", async () => {
			const { h, t } = await parked("sonnet");
			const c = continueTurn(h, t.plan.turnId, results, { model: "opus" });
			const res = await c.response;
			expect(res.status).toBe(409);
			expect((await res.json()).error.message).toContain('"opus"');
			await settled(h);
			expect(h.bridge.status().parked).toBe(0);
			expect(h.repo.turns.get(t.plan.turnId)?.legs[1]).toMatchObject({
				kind: "continue",
				httpStatus: 409,
			});
		});
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
					name: "mcp__c__read",
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
		expect(h.bridge.findContinuation(["toolu_1"], CALLER)).toBeNull();
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

	describe("tool results whose query is gone", () => {
		const issued: Msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "Reading." },
				{ type: "tool_use", id: "gone", name: "read", input: { path: "a" } },
			],
		};
		const answer: Msg = {
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "gone", content: "GONE-RESULT" },
				{ type: "text", text: "and summarize" },
			],
		};

		it("rebuild the history up to the calls, flattened with the results after it", async () => {
			const h = harness();
			const t = await start(h, { tools, messages: [first, issued, answer] });
			await t.query.nextPrompt();
			const content = t.query.prompts[0]?.message.content as unknown as Block[];
			expect(content.some((b) => b.type === "tool_result")).toBe(false);
			expect(String(content[0]?.text)).toContain(
				'[tool call read id=gone] {"path":"a"}',
			);
			expect(content.slice(1)).toEqual([
				{ type: "text", text: "[tool result id=gone]\nGONE-RESULT" },
				{ type: "text", text: "and summarize" },
			]);
			expect(t.query.options.resume).toBeUndefined();
			await waitFor(() => h.repo.turns.has(t.plan.turnId));
			expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
				historyMode: "rebuild_flattened",
				rebuildReason: "dead_continuation",
			});
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "summary" }]),
				resultMessage(),
			);
			expect((await reply(t.response)).content).toEqual([
				{ type: "text", text: "summary" },
			]);
		});

		it("get 409 when the request does not carry the calls they answer", async () => {
			const h = harness();
			for (const messages of [
				[first, answer],
				[
					first,
					{ ...issued, content: [{ type: "text", text: "no calls" }] },
					answer,
				],
			]) {
				const res = await h.bridge.startTurn({
					request: messagesRequest({ tools, messages }),
					plan: makePlan(),
					meta: makeMeta(),
					signal: new AbortController().signal,
				});
				expect(res.status).toBe(409);
			}
			expect(h.sdk.queries).toHaveLength(0);
		});
	});

	describe("stale tool results", () => {
		/** A turn parked on its second round of calls, `r2-a` and `r2-b`. */
		async function parkedTwice(h: Harness) {
			const t = await start(h, { tools, messages: [first] });
			t.query.emit(
				initMessage(),
				...streamedMessage([
					{ type: "tool_use", id: "r1", name: "mcp__c__read", input: {} },
				]),
			);
			const r1 = await reply(t.response);
			const call1 = t.query.callTool("r1", "read");
			const round1: Msg[] = [
				first,
				{ role: "assistant", content: r1.content },
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "r1", content: "1" }],
				},
			];
			const c1 = continueTurn(h, t.plan.turnId, { tools, messages: round1 });
			await call1;
			t.query.emit(
				...streamedMessage([
					{ type: "tool_use", id: "r2-a", name: "mcp__c__read", input: {} },
					{ type: "tool_use", id: "r2-b", name: "mcp__c__read", input: {} },
				]),
			);
			const r2 = await reply(c1.response);
			return { t, round1, r2 };
		}

		it("select a parked turn only by the calls it waits on now", async () => {
			const h = harness();
			const { t } = await parkedTwice(h);
			expect(h.bridge.findContinuation(["r2-b"], CALLER)?.turnId).toBe(
				t.plan.turnId,
			);
			expect(h.bridge.findContinuation(["r1"], CALLER)).toBeNull();
		});

		it("replaying an earlier round gets 409, recorded, and the turn stays parked", async () => {
			const h = harness();
			const { t, round1 } = await parkedTwice(h);
			const meta = makeMeta();
			const res = await h.bridge.startTurn({
				request: messagesRequest({ tools, messages: round1 }),
				plan: makePlan(),
				meta,
				signal: new AbortController().signal,
			});
			expect(res.status).toBe(409);
			expect(await res.text()).toContain("stale tool results");
			expect(h.sdk.queries).toHaveLength(1);
			await waitFor(() => h.repo.legs.get(meta.legId)?.finished === true);
			expect(h.repo.legs.get(meta.legId)).toMatchObject({
				turnId: t.plan.turnId,
				kind: "continue",
				httpStatus: 409,
			});
			expect(h.bridge.status().parked).toBe(1);
		});

		it("answering only some of the awaited calls gets 409 and delivers nothing", async () => {
			const h = harness();
			const { t, round1, r2 } = await parkedTwice(h);
			const partial = continueTurn(h, t.plan.turnId, {
				tools,
				messages: [
					...round1,
					{ role: "assistant", content: r2.content },
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "r2-a", content: "A" },
						],
					},
				],
			});
			expect((await partial.response).status).toBe(409);
			expect(h.bridge.status().parked).toBe(1);
			const callA = t.query.callTool("r2-a", "read");
			const callB = t.query.callTool("r2-b", "read");
			const full = continueTurn(h, t.plan.turnId, {
				tools,
				messages: [
					...round1,
					{ role: "assistant", content: r2.content },
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "r2-a", content: "A" },
							{ type: "tool_result", tool_use_id: "r2-b", content: "B" },
						],
					},
				],
			});
			expect(
				(await Promise.all([callA, callB])).map(
					(r) => (r.content as Array<{ text: string }>)[0]?.text,
				),
			).toEqual(["A", "B"]);
			t.query.emit(
				...streamedMessage([{ type: "text", text: "ok" }]),
				resultMessage(),
			);
			expect((await reply(full.response)).status).toBe(200);
		});
	});

	it("hands text sent with the tool results to Claude Code while it still waits on them", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "tool_use", id: "toolu_t", name: "mcp__c__read", input: {} },
			]),
		);
		const r1 = await reply(t.response);
		continueTurn(h, t.plan.turnId, {
			tools,
			messages: [
				first,
				{ role: "assistant", content: r1.content },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_t", content: "T" },
						{ type: "text", text: "  " },
						{ type: "text", text: "also check b.txt" },
					],
				},
			],
		});
		// The text is read first, as one message without the blank block...
		await waitFor(() => t.query.prompts.length === 2);
		expect(t.query.prompts[1]?.message.content).toEqual([
			{ type: "text", text: "also check b.txt" },
		]);
		// ...and the result follows it.
		expect(
			((await t.query.callTool("toolu_t", "read")).content as Block[])[0],
		).toMatchObject({ text: "T" });
	});

	it("delivers the results only after Claude Code has read the text", async () => {
		const h = harness();
		const t = await start(h, { tools, messages: [first] });
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "tool_use", id: "toolu_u", name: "mcp__c__read", input: {} },
			]),
		);
		const r1 = await reply(t.response);
		// Claude Code already waits on the call.
		let answered = false;
		const call = t.query.callTool("toolu_u", "read").then((r) => {
			answered = true;
			return r;
		});
		await waitFor(() => h.bridge.status().parked === 1);
		await Bun.sleep(20);
		continueTurn(h, t.plan.turnId, {
			tools,
			messages: [
				first,
				{ role: "assistant", content: r1.content },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_u", content: "U" },
						{ type: "text", text: "note" },
					],
				},
			],
		});
		await waitFor(() => t.query.prompts.length === 2);
		expect(answered).toBe(false);
		await call;
		expect(answered).toBe(true);
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
					name: "mcp__c__read",
					input: {},
				},
				{
					type: "tool_use",
					id: "toolu_2",
					name: "mcp__c__read",
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
		const store = new FileSessionStore(sessionsDir(h));
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
			const store = new FileSessionStore(sessionsDir(h));
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
		expect(readdirSync(sessionsDir(h))).toEqual([]);
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

	describe("a conversation too long for the model's context", () => {
		const overflow = {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "prompt is too long",
				code: "context_length_exceeded",
			},
		};

		it("answers an inner 400 overflow with its token counts", async () => {
			const h = harness();
			const message = "prompt is too long: 215012 tokens > 200000 maximum";
			failInner(h, {
				status: 400,
				errorType: "invalid_request_error",
				message,
			});
			const t = await start(h, {
				messages: [{ role: "user", content: "hello" }],
			});
			await innerCall(t.query);
			t.query.emit(
				initMessage(),
				resultMessage({
					isError: true,
					result: "Prompt is too long",
					terminalReason: "prompt_too_long",
				}),
			);
			const res = await t.response;
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				type: "error",
				error: {
					type: "invalid_request_error",
					message,
					code: "context_length_exceeded",
				},
			});
		});

		it("answers Claude Code's own refusal by its terminal reason", async () => {
			const h = harness();
			const t = await start(h, {
				messages: [{ role: "user", content: "hello" }],
			});
			t.query.emit(
				initMessage(),
				resultMessage({
					isError: true,
					result: "Context limit reached",
					terminalReason: "blocking_limit",
				}),
			);
			const res = await t.response;
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual(overflow);
			await settled(h);
			expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
				status: "failed",
				httpStatus: 400,
				errorType: "invalid_request_error",
			});
		});

		it("answers Claude Code's error message saying so", async () => {
			const h = harness();
			const t = await start(h, {
				messages: [{ role: "user", content: "hello" }],
			});
			t.query.emit(
				initMessage(),
				assistantMessage([{ type: "text", text: "Prompt is too long" }], {
					error: "invalid_request",
					model: "<synthetic>",
				}),
				resultMessage({ isError: true, result: "Prompt is too long" }),
			);
			const res = await t.response;
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual(overflow);
		});

		it("answers an SDK failure saying so", async () => {
			const h = harness();
			const t = await start(h, {
				messages: [{ role: "user", content: "hello" }],
			});
			t.query.emit(initMessage());
			t.query.fail(new Error("Claude Code process exited: Prompt is too long"));
			const res = await t.response;
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual(overflow);
		});

		it("sends it as an SSE error event once output went out", async () => {
			const h = harness();
			const t = await start(h, {
				messages: [{ role: "user", content: "hello" }],
			});
			const partial = streamedMessage([
				{ type: "text", text: "partial" },
			]).slice(0, 3);
			t.query.emit(initMessage(), ...partial);
			t.query.emit(
				resultMessage({
					isError: true,
					result: "Prompt is too long",
					terminalReason: "prompt_too_long",
				}),
			);
			const r = await reply(t.response);
			expect(r.status).toBe(200);
			expect(r.errors[0]?.data).toEqual(overflow);
		});

		it("answers a result that only says so", async () => {
			const h = harness();
			const t = await start(h, {
				messages: [{ role: "user", content: "hello" }],
			});
			t.query.emit(
				initMessage(),
				resultMessage({ isError: true, result: "Prompt is too long" }),
			);
			const res = await t.response;
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual(overflow);
		});

		it("is not masked by an earlier leg's inner failure", async () => {
			const h = harness();
			failInner(h, {
				status: 529,
				errorType: "overloaded_error",
				message: "overloaded",
			});
			const t = await start(h, {
				tools: [READ_TOOL],
				messages: [{ role: "user", content: "TOOL read" }],
			});
			// Claude Code recovered from this call and parked on a tool call.
			await innerCall(t.query);
			t.query.emit(
				initMessage(),
				...streamedMessage([
					{ type: "tool_use", id: "toolu_1", name: "mcp__c__read", input: {} },
				]),
			);
			expect((await reply(t.response)).stop).toBe("tool_use");
			const call = t.query.callTool("toolu_1", "read");
			const c = continueTurn(h, t.plan.turnId, {
				tools: [READ_TOOL],
				messages: [
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_1", content: "x" },
						],
					},
				],
			});
			await call;
			// Its next model request never went out: blocking_limit.
			t.query.emit(
				resultMessage({
					isError: true,
					result: "Context limit reached",
					terminalReason: "blocking_limit",
				}),
			);
			const res = await c.response;
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual(overflow);
		});

		it("leaves Claude Code's other self-endings at 502", async () => {
			const h = harness();
			const t = await start(h, {
				messages: [{ role: "user", content: "hello" }],
			});
			t.query.emit(
				initMessage(),
				assistantMessage(
					[
						{
							type: "text",
							text: "Claude's response exceeded the output limit",
						},
					],
					{ error: "max_output_tokens", model: "<synthetic>" },
				),
				resultMessage({
					isError: true,
					subtype: "error_max_structured_output_retries",
					terminalReason: "structured_output_retry_exhausted",
				}),
			);
			const res = await t.response;
			expect(res.status).toBe(502);
			expect((await res.json()).error).not.toHaveProperty("code");
		});
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
	it("refuses a turn at the process cap with a capacity error the proxy can fail over on", async () => {
		const h = harness({ limits: () => ({ maxProcesses: 1 }) });
		await start(h, { messages: [{ role: "user", content: "one" }] });
		const plan = makePlan();
		const meta = makeMeta();
		const error = await h.bridge
			.startTurn({
				request: messagesRequest({
					messages: [{ role: "user", content: "two" }],
				}),
				plan,
				meta,
				signal: new AbortController().signal,
			})
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(error).toBeInstanceOf(SdkBridgeCapacityError);
		expect(error).toBeInstanceOf(SdkBridgeUnavailableError);
		const res = (error as SdkBridgeCapacityError).terminalResponse();
		expect(res.status).toBe(529);
		expect(res.headers.get("retry-after")).toBe("10");
		expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
			"overloaded_error",
		);
		expect(h.sdk.queries).toHaveLength(1);
		await waitFor(() => h.repo.legs.get(meta.legId)?.finished === true);
		expect(h.repo.turns.get(plan.turnId)).toMatchObject({
			status: "rejected",
			httpStatus: 529,
		});
		expect(h.repo.legs.get(meta.legId)).toMatchObject({ httpStatus: 529 });
		expect(h.bridge.status().counters.rejected).toEqual({ process_cap: 1 });
	});

	it("refuses a rebuild at the rebuild cap the same way, and gives its conversation back", async () => {
		const h = harness({ limits: () => ({ maxConcurrentRebuilds: 1 }) });
		const history = [
			{ role: "user", content: "q" },
			{ role: "assistant", content: "a" },
			{ role: "user", content: "again" },
		];
		await start(h, { messages: history });
		const header = { affinityScope: "client_session", affinityKey: "rc" };
		await expect(
			h.bridge.startTurn({
				request: messagesRequest({ messages: history }),
				plan: makePlan(),
				meta: makeMeta(header),
				signal: new AbortController().signal,
			}),
		).rejects.toBeInstanceOf(SdkBridgeCapacityError);
		// The conversation was released: a fresh turn in it starts at once.
		const t0 = Date.now();
		const fresh = h.bridge.startTurn({
			request: messagesRequest({ messages: [{ role: "user", content: "q" }] }),
			plan: makePlan(),
			meta: makeMeta(header),
			signal: new AbortController().signal,
		});
		await h.sdk.next();
		expect(Date.now() - t0).toBeLessThan(400);
		void fresh;
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
					name: "mcp__c__read",
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
					name: "mcp__c__read",
					input: {},
				},
			]),
		);
		// The stream was open: the calls it would hand out end in an SSE error
		// instead, since nobody could ever answer them.
		const late = await reply(running.response);
		expect(late.status).toBe(200);
		expect(late.stop).toBeNull();
		expect(late.events.some((e) => e.event === "message_stop")).toBe(false);
		expect(late.errors[0]?.data).toMatchObject({
			error: { message: "The SDK bridge is shutting down" },
		});
		await waitFor(() => running.query.closed);
		await settled(h);
		expect(h.repo.turns.get(parked.plan.turnId)?.status).toBe("shutdown");
		expect(h.repo.turns.get(running.plan.turnId)?.status).toBe("shutdown");
		expect(h.repo.turns.get(running.plan.turnId)?.legs[0]).toMatchObject({
			httpStatus: 503,
			errorPhase: "mid_stream",
		});
	});

	it("fails a not-yet-sent reply that would park during shutdown with 503", async () => {
		const h = harness();
		const t = await start(h, {
			stream: false,
			tools: [READ_TOOL],
			messages: [{ role: "user", content: "TOOL" }],
		});
		t.query.emit(initMessage());
		h.bridge.beginShutdown();
		t.query.emit(
			...streamedMessage([
				{ type: "tool_use", id: "toolu_n", name: "mcp__c__read", input: {} },
			]),
		);
		const res = await t.response;
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBeTruthy();
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)?.legs[0]).toMatchObject({
			httpStatus: 503,
			errorPhase: "pre_head",
		});
		expect(h.bridge.findContinuation(["toolu_n"], CALLER)).toBeNull();
	});

	it("answers a continuation during shutdown with 503, recorded on its turn", async () => {
		const h = harness();
		const t = await start(h, {
			tools: [READ_TOOL],
			messages: [{ role: "user", content: "TOOL" }],
		});
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "tool_use", id: "toolu_d", name: "mcp__c__read", input: {} },
			]),
		);
		await reply(t.response);
		h.bridge.beginShutdown();
		const meta = makeMeta();
		const res = await h.bridge.continueTurn({
			turnId: t.plan.turnId,
			request: messagesRequest({
				messages: [
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_d", content: "x" },
						],
					},
				],
			}),
			meta,
			signal: new AbortController().signal,
		});
		expect(res.status).toBe(503);
		await waitFor(() => h.repo.legs.get(meta.legId)?.finished === true);
		expect(h.repo.legs.get(meta.legId)).toMatchObject({
			turnId: t.plan.turnId,
			kind: "continue",
			httpStatus: 503,
			errorPhase: "pre_head",
		});
	});

	it("answers a continuation that fails unexpectedly with 502, recorded once", async () => {
		const h = harness();
		const t = await start(h, {
			tools: [READ_TOOL],
			messages: [{ role: "user", content: "TOOL" }],
		});
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "tool_use", id: "toolu_e", name: "mcp__c__read", input: {} },
			]),
		);
		await reply(t.response);
		const meta = makeMeta();
		const request = messagesRequest({ messages: [] });
		// A body that cannot be read.
		request.arrayBuffer = () => Promise.reject(new Error("socket reset"));
		const res = await h.bridge.continueTurn({
			turnId: t.plan.turnId,
			request,
			meta,
			signal: new AbortController().signal,
		});
		expect(res.status).toBe(502);
		await waitFor(() => h.repo.legs.get(meta.legId)?.finished === true);
		expect(
			h.repo.turns.get(t.plan.turnId)?.legs.filter((l) => l.id === meta.legId),
		).toEqual([expect.objectContaining({ kind: "continue", httpStatus: 502 })]);
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

describe("inner call accounting", () => {
	it("counts calls by their requests row and errors by their outcome, once each", async () => {
		const h = harness();
		const outcome = (requestId: string, status: number) => ({
			requestId,
			status,
			errorType: null,
			message: null,
			retryAfter: null,
			accountId: "acct-a",
		});
		h.inner.respond = (_req, ctx) => {
			ctx.onInnerRequestStarted?.("r1");
			ctx.onInnerRequestStarted?.("r1");
			ctx.onInnerOutcome?.(outcome("r1", 529));
			ctx.onInnerOutcome?.(outcome("r1", 529));
			ctx.onInnerRequestStarted?.("r2");
			ctx.onInnerOutcome?.(outcome("r2", 200));
			return new Response("ok");
		};
		const t = await start(h, { messages: [{ role: "user", content: "x" }] });
		await innerCall(t.query);
		// Refused by the listener: no row, so an error and no call.
		expect((await innerCall(t.query, "claude-opus-5")).status).toBe(400);
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		await reply(t.response);
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)?.counters).toMatchObject({
			innerCalls: 2,
			innerErrors: 2,
		});
	});
});

describe("conversation ownership", () => {
	const header = {
		affinityScope: "client_session",
		affinityKey: "own-1",
	} as const;
	const first: Msg = { role: "user", content: "TOOL read" };

	it("a new turn supersedes one of its conversation parked on tool calls", async () => {
		const h = harness({
			timing: {
				headHoldMs: 1_000,
				pingIntervalMs: 100,
				settleWaitMs: 5_000,
				idleTimeoutMs: 5_000,
				exitGraceMs: 50,
			},
		});
		const t = await start(
			h,
			{ tools: [READ_TOOL], messages: [first] },
			{ meta: header },
		);
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{ type: "tool_use", id: "toolu_o", name: "mcp__c__read", input: {} },
			]),
		);
		await reply(t.response);
		const call = t.query.callTool("toolu_o", "read");
		const t0 = Date.now();
		const next = await start(
			h,
			{
				tools: [READ_TOOL],
				messages: [first, { role: "assistant", content: "never mind" }, first],
			},
			{ meta: header },
		);
		// No settle wait: the parked turn gave the conversation up at once.
		expect(Date.now() - t0).toBeLessThan(1_000);
		expect((await call).isError).toBe(true);
		expect(t.query.closed).toBe(true);
		await waitFor(() => h.repo.turns.get(t.plan.turnId)?.status === "aborted");
		expect(String(h.repo.turns.get(t.plan.turnId)?.errorMessage)).toContain(
			"A new turn of this conversation",
		);
		const late = continueTurn(h, t.plan.turnId, {
			tools: [READ_TOOL],
			messages: [
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_o", content: "x" },
					],
				},
			],
		});
		expect((await late.response).status).toBe(409);
		expect(next.query.closed).toBe(false);
	});
});

describe("a turn that fails to start", () => {
	const header = {
		affinityScope: "client_session",
		affinityKey: "setup-1",
	} as const;

	it("gives back its conversation and deletes only its own session files", async () => {
		let failNext = false;
		const sdk = fakeQueryFn();
		const h = harness({
			queryFn: (params) => {
				if (failNext) throw new Error("spawn failed");
				return sdk.fn(params);
			},
		});
		const t = h.bridge.startTurn({
			request: messagesRequest({ messages: [{ role: "user", content: "hi" }] }),
			plan: makePlan(),
			meta: makeMeta(header),
			signal: new AbortController().signal,
		});
		const q1 = await sdk.next();
		const store = q1.options.sessionStore as SessionStore;
		const kept = q1.options.sessionId as string;
		await store.append({ projectKey: "p", sessionId: kept }, [
			{ type: "user", uuid: "u1", sessionId: kept },
		] as never);
		q1.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "hello" }]),
			resultMessage(),
		);
		const r1 = await reply(t);
		await settled(h);

		failNext = true;
		const second = {
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: r1.content },
				{ role: "user", content: "again" },
			],
		};
		await expect(
			h.bridge.startTurn({
				request: messagesRequest(second),
				plan: makePlan(),
				meta: makeMeta(header),
				signal: new AbortController().signal,
			}),
		).rejects.toBeInstanceOf(SdkBridgeUnavailableError);
		// Only the resumable session is left; the failed turn's copy is gone.
		expect(readdirSync(sessionsDir(h))).toEqual([`${kept}.jsonl`]);

		failNext = false;
		const t0 = Date.now();
		const third = h.bridge.startTurn({
			request: messagesRequest(second),
			plan: makePlan(),
			meta: makeMeta(header),
			signal: new AbortController().signal,
		});
		const q3 = await sdk.next();
		expect(Date.now() - t0).toBeLessThan(400);
		expect(q3.options.resume).toBeTruthy();
		void third;
	});

	it("flattens a history too deeply nested for a transcript, rather than failing", async () => {
		const h = harness();
		// Written as text: JSON.stringify itself cannot produce this depth.
		const deep = `${'{"a":'.repeat(100_000)}"leaf"${"}".repeat(100_000)}`;
		const text = JSON.stringify({
			model: MODEL,
			stream: true,
			tools: [READ_TOOL],
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "d1", name: "read", input: {} }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "d1", content: "r" }],
				},
				{ role: "assistant", content: "done" },
				{ role: "user", content: "next" },
			],
		}).replace('"input":{}', `"input":${deep}`);
		const plan = makePlan();
		const response = h.bridge.startTurn({
			request: new Request("http://bridge.test/v1/messages", {
				method: "POST",
				body: text,
			}),
			plan,
			meta: makeMeta(header),
			signal: new AbortController().signal,
		});
		const q = await h.sdk.next();
		await q.nextPrompt();
		const content = q.prompts[0]?.message.content as unknown as Block[];
		expect(String(content[0]?.text)).toContain("[input omitted");
		await waitFor(() => h.repo.turns.has(plan.turnId));
		expect(h.repo.turns.get(plan.turnId)?.historyMode).toBe(
			"rebuild_flattened",
		);
		// No transcript was left behind by the attempt to write one.
		expect(readdirSync(sessionsDir(h))).toEqual([]);
		void response;
	});
});

describe("work directories", () => {
	it("keeps everything under a private directory of its own, removed at dispose", async () => {
		const h = harness();
		const gen = generationDir(h);
		expect(statSync(h.workRoot).mode & 0o777).toBe(0o700);
		expect(statSync(gen).mode & 0o777).toBe(0o700);
		const t = await start(h, { messages: [{ role: "user", content: "hi" }] });
		const store = t.query.options.sessionStore as SessionStore;
		const id = t.query.options.sessionId as string;
		await store.append({ projectKey: "p", sessionId: id }, [
			{ type: "user", uuid: "u1", sessionId: id },
		] as never);
		for (const dir of ["sessions", "claude-config", "tmp", "home", "cwd"])
			expect(statSync(join(gen, dir)).mode & 0o777).toBe(0o700);
		expect(statSync(join(gen, "sessions", `${id}.jsonl`)).mode & 0o777).toBe(
			0o600,
		);
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		await reply(t.response);
		await settled(h);
		await h.bridge.dispose();
		expect(existsSync(gen)).toBe(false);
	});

	it("deletes Claude Code's own transcript of a query once it closes", async () => {
		const h = harness();
		const t = await start(h, { messages: [{ role: "user", content: "hi" }] });
		const id = t.query.options.sessionId as string;
		const project = join(generationDir(h), "claude-config", "projects", "-cwd");
		mkdirSync(join(project, id, "subagents"), { recursive: true });
		writeFileSync(join(project, `${id}.jsonl`), "{}\n");
		writeFileSync(join(project, id, "subagents", "agent-1.jsonl"), "{}\n");
		writeFileSync(join(project, "other-session.jsonl"), "{}\n");
		t.query.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		await reply(t.response);
		await settled(h);
		expect(readdirSync(project)).toEqual(["other-session.jsonl"]);
	});

	it("removes earlier processes' directories at startup, but not a live one's, and follows no symlink", async () => {
		const root = mkdtempSync(join(tmpdir(), "sdk-bridge-gens-"));
		const outside = mkdtempSync(join(tmpdir(), "sdk-bridge-outside-"));
		try {
			writeFileSync(join(outside, "keep.txt"), "keep");
			const dead = join(root, "gen-dead");
			mkdirSync(join(dead, "sessions"), { recursive: true });
			writeFileSync(join(dead, "sessions", "s.jsonl"), "{}\n");
			// A pid that cannot exist.
			writeFileSync(
				join(dead, "owner.json"),
				JSON.stringify({ pid: 2 ** 22 + 7, startTime: null }),
			);
			symlinkSync(outside, join(dead, "sessions", "link"));
			const alive = join(root, "gen-alive");
			mkdirSync(alive);
			writeFileSync(
				join(alive, "owner.json"),
				JSON.stringify({ pid: process.pid, startTime: null }),
			);
			symlinkSync(outside, join(root, "gen-symlinked"));
			harness({ workRoot: root });
			expect(existsSync(dead)).toBe(false);
			expect(existsSync(alive)).toBe(true);
			expect(lstatSync(join(root, "gen-symlinked")).isSymbolicLink()).toBe(
				true,
			);
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
			// The live one, the symlink, and the new bridge's own.
			expect(
				readdirSync(root).filter((n) => n.startsWith("gen-")),
			).toHaveLength(3);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
