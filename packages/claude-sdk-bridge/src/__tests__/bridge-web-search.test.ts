import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { SdkBridgeTurnMeta } from "@clankermux/types";
import {
	capturingLog,
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
	toolResultMessage,
	waitFor,
	webSearchOutput,
} from "./fixtures/fake-sdk";

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

const SEARCH = { required: true, allowedDomains: null } as const;

async function start(
	h: Harness,
	body: Record<string, unknown>,
	meta: Partial<SdkBridgeTurnMeta> = { hostedWebSearch: SEARCH },
	plan: Parameters<typeof makePlan>[0] = {},
) {
	const p = makePlan(plan);
	const m = makeMeta(meta);
	const response = h.bridge.startTurn({
		request: messagesRequest(body),
		plan: p,
		meta: m,
		signal: new AbortController().signal,
	});
	const query = await h.sdk.next();
	return { response, query, plan: p, meta: m };
}

async function reply(response: Promise<Response>) {
	const res = await response;
	const events = parseSse(await res.text());
	return { status: res.status, events, ...foldReply(events) };
}

const ask = { messages: [{ role: "user", content: "latest bun release?" }] };

/** Claude Code's WebSearch call, its result, then its answer. */
function searchThenAnswer(
	query: FakeQuery,
	output: unknown,
	answer = "Bun 2 is out",
	opts: { isError?: boolean } = {},
) {
	query.emit(
		initMessage(),
		...streamedMessage([
			{
				type: "tool_use",
				id: "toolu_ws_1",
				name: "WebSearch",
				input: { query: "latest bun release" },
			},
		]),
		toolResultMessage("toolu_ws_1", output, opts),
		...streamedMessage([{ type: "text", text: answer }]),
	);
}

async function settled(h: Harness) {
	await waitFor(() => h.bridge.status().live === 0);
	await Bun.sleep(10);
}

describe("hosted web search on a bridged turn", () => {
	it("gives Claude Code its WebSearch tool only when the client asked for web search", async () => {
		const h = harness();
		const on = await start(h, ask);
		expect(on.query.options.tools).toEqual(["WebSearch"]);
		expect(on.query.options.allowedTools).toEqual(["WebSearch"]);
		expect(on.query.options.hooks).toBeUndefined();

		const off = await start(h, { ...ask, tools: [READ_TOOL] }, {});
		expect(off.query.options.tools).toEqual([]);
		expect(off.query.options.allowedTools).toEqual(["mcp__c__read"]);
	});

	it("replies with the search as server_tool_use and web_search_tool_result, never a client tool_use", async () => {
		const h = harness();
		const t = await start(h, ask);
		searchThenAnswer(
			t.query,
			webSearchOutput("latest bun release", [
				["https://bun.sh/blog", "https://github.com/oven-sh/bun"],
				["https://bun.sh/blog", "https://news.test/bun"],
			]),
		);
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.stop).toBe("end_turn");
		expect(r.content).toEqual([
			{
				type: "server_tool_use",
				id: "toolu_ws_1",
				name: "web_search",
				input: { query: "latest bun release" },
			},
			{
				type: "web_search_tool_result",
				tool_use_id: "toolu_ws_1",
				content: [
					{
						type: "web_search_result",
						url: "https://bun.sh/blog",
						title: "title of https://bun.sh/blog",
					},
					{
						type: "web_search_result",
						url: "https://github.com/oven-sh/bun",
						title: "title of https://github.com/oven-sh/bun",
					},
					{
						type: "web_search_result",
						url: "https://news.test/bun",
						title: "title of https://news.test/bun",
					},
				],
			},
			{ type: "text", text: "Bun 2 is out" },
		]);
		expect(r.content.some((b) => b.type === "tool_use")).toBe(false);
		t.query.emit(resultMessage());
		await settled(h);
		expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
			status: "completed",
			httpStatus: 200,
		});
	});

	it("answers stream:false with the search blocks in the JSON message", async () => {
		const h = harness();
		const t = await start(h, { ...ask, stream: false });
		searchThenAnswer(
			t.query,
			webSearchOutput("latest bun release", [["https://bun.sh/blog"]]),
		);
		const res = await t.response;
		const body = (await res.json()) as { content: Array<{ type: string }> };
		expect(body.content.map((b) => b.type)).toEqual([
			"server_tool_use",
			"web_search_tool_result",
			"text",
		]);
		expect(body.content[0]).toMatchObject({
			input: { query: "latest bun release" },
		});
	});

	it("counts a search whose output has no URLs as completed with no sources", async () => {
		const h = harness();
		const t = await start(h, ask);
		searchThenAnswer(t.query, webSearchOutput("q", [[]]));
		const r = await reply(t.response);
		expect(r.status).toBe(200);
		expect(r.errors).toEqual([]);
		expect(r.content[1]).toEqual({
			type: "web_search_tool_result",
			tool_use_id: "toolu_ws_1",
			content: [],
		});
	});

	describe("a search that failed", () => {
		const failedWith = async (
			output: unknown,
			opts: { isError?: boolean } = {},
		) => {
			const h = harness();
			const t = await start(h, ask);
			searchThenAnswer(t.query, output, "sorry", opts);
			return reply(t.response);
		};

		for (const [name, output, code, opts] of [
			["is_error", "Error: blocked", "unavailable", { isError: true }],
			["missing structured output", undefined, "unavailable", {}],
			["invalid structured output", { query: 7 }, "unavailable", {}],
			[
				"the search's own error",
				webSearchOutput("q", [], {
					commentary: ["Web search error: max_uses_exceeded", "no luck"],
					searchCount: 1,
				}),
				"max_uses_exceeded",
				{},
			],
			[
				"commentary only, no search made",
				webSearchOutput("q", [], {
					commentary: ["I know this from memory."],
					searchCount: 0,
				}),
				"unavailable",
				{},
			],
		] as const)
			it(`${name}: carries a web_search_tool_result_error and fails the required search`, async () => {
				const r = await failedWith(output, opts);
				const result = r.content.find(
					(b) => b.type === "web_search_tool_result",
				);
				expect(result?.content).toEqual({
					type: "web_search_tool_result_error",
					error_code: code,
				});
				// The stream was open: the required search ends it with an error.
				expect(r.errors.map((e) => e.data.error)).toEqual([
					expect.objectContaining({ code: "web_search_not_performed" }),
				]);
			});
	});

	describe("a required search the model never made", () => {
		it("fails a streamed answer from memory with an SSE error, not a completed reply", async () => {
			const h = harness();
			const t = await start(h, ask);
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "from memory" }]),
			);
			const r = await reply(t.response);
			expect(r.status).toBe(200);
			expect(r.stop).toBeNull();
			expect(r.errors).toHaveLength(1);
			expect(r.errors[0]?.data.error).toMatchObject({
				type: "api_error",
				code: "web_search_not_performed",
			});
			await settled(h);
			expect(h.repo.turns.get(t.plan.turnId)).toMatchObject({
				status: "failed",
				httpStatus: 502,
			});
		});

		it("answers 502 to a non-streamed request", async () => {
			const h = harness();
			const t = await start(h, { ...ask, stream: false });
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "from memory" }]),
			);
			const res = await t.response;
			expect(res.status).toBe(502);
			expect(
				((await res.json()) as { error: { code: string } }).error.code,
			).toBe("web_search_not_performed");
		});

		it("fails a refusal without a search the same way", async () => {
			const h = harness();
			const t = await start(h, { ...ask, stream: false });
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "I can't" }], {
					stopReason: "refusal",
				}),
			);
			expect((await t.response).status).toBe(502);
		});

		it("lets an answer without a search through when the search was not required", async () => {
			const h = harness();
			const t = await start(h, ask, {
				hostedWebSearch: { required: false, allowedDomains: null },
			});
			t.query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "from memory" }]),
			);
			const r = await reply(t.response);
			expect(r.errors).toEqual([]);
			expect(r.stop).toBe("end_turn");
		});
	});

	it("takes a result once, however often Claude Code reports it", async () => {
		const h = harness();
		const t = await start(h, ask);
		const output = webSearchOutput("q", [["https://a.test"]]);
		t.query.emit(
			initMessage(),
			...streamedMessage([
				{
					type: "tool_use",
					id: "toolu_ws_1",
					name: "WebSearch",
					input: { query: "q" },
				},
			]),
			toolResultMessage("toolu_ws_1", output),
			toolResultMessage(
				"toolu_ws_1",
				webSearchOutput("q", [["https://b.test"]]),
			),
			toolResultMessage("toolu_other", output),
			...streamedMessage([{ type: "text", text: "done" }]),
		);
		const r = await reply(t.response);
		expect(r.content.map((b) => b.type)).toEqual([
			"server_tool_use",
			"web_search_tool_result",
			"text",
		]);
		expect(JSON.stringify(r.content[1])).toContain("https://a.test");
	});

	it("logs the turn's searches: calls made and searches Claude Code ran", async () => {
		const log = capturingLog();
		const h = harness({ log });
		const t = await start(h, ask);
		searchThenAnswer(
			t.query,
			webSearchOutput("q", [["https://a.test"]], { searchCount: 2 }),
		);
		await reply(t.response);
		t.query.emit(resultMessage());
		await settled(h);
		await waitFor(() => log.turns(t.plan.turnId).length > 0);
		expect(log.turns(t.plan.turnId)[0]?.data).toMatchObject({
			webSearchCount: 1,
			webSearchRequests: 2,
		});
	});

	describe("domain filters", () => {
		type Hook = (input: unknown) => Promise<{
			hookSpecificOutput: Record<string, unknown>;
		}>;
		const hookOf = (q: FakeQuery): Hook => {
			const matchers = (q.options.hooks?.PreToolUse ?? []) as unknown as Array<{
				matcher?: string;
				hooks: Hook[];
			}>;
			expect(matchers.map((m) => m.matcher)).toEqual(["WebSearch"]);
			return matchers[0]?.hooks[0] as Hook;
		};
		const call = (tool_input: Record<string, unknown>) => ({
			hook_event_name: "PreToolUse",
			tool_name: "WebSearch",
			tool_input,
			tool_use_id: "toolu_ws_1",
		});

		it("sets the client's filter on a call whose input has none", async () => {
			const h = harness();
			const t = await start(h, ask, {
				hostedWebSearch: { required: true, allowedDomains: ["bun.sh"] },
			});
			const out = await hookOf(t.query)(call({ query: "bun" }));
			expect(out.hookSpecificOutput).toEqual({
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { query: "bun", allowed_domains: ["bun.sh"] },
			});
		});

		it("keeps a narrower filter the model chose and drops its blocked list", async () => {
			const h = harness();
			const t = await start(h, ask, {
				hostedWebSearch: {
					required: true,
					allowedDomains: ["bun.sh", "github.com"],
				},
			});
			const out = await hookOf(t.query)(
				call({
					query: "bun",
					allowed_domains: ["docs.bun.sh"],
					blocked_domains: ["x.test"],
				}),
			);
			expect(out.hookSpecificOutput.updatedInput).toEqual({
				query: "bun",
				allowed_domains: ["docs.bun.sh"],
			});
		});

		it("refuses a call whose domains leave the client's filter", async () => {
			const h = harness();
			const t = await start(h, ask, {
				hostedWebSearch: { required: true, allowedDomains: ["bun.sh"] },
			});
			for (const allowed of [
				["evil.test"],
				["bun.sh", "evil.test"],
				["notbun.sh"],
			]) {
				const out = await hookOf(t.query)(
					call({ query: "bun", allowed_domains: allowed }),
				);
				expect(out.hookSpecificOutput).toMatchObject({
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
				});
				expect(
					String(out.hookSpecificOutput.permissionDecisionReason),
				).toContain("bun.sh");
			}
		});
	});

	describe("the conversation afterwards", () => {
		const header = {
			affinityScope: "client_session",
			affinityKey: "search-sess",
			hostedWebSearch: SEARCH,
		} as const;

		async function searchTurn(h: Harness) {
			const t = await start(h, ask, header);
			const store = t.query.options.sessionStore as SessionStore;
			const sessionId = t.query.options.sessionId as string;
			await store.append({ projectKey: "p", sessionId }, [
				{
					type: "user",
					uuid: "u1",
					sessionId,
					message: { role: "user", content: ask.messages[0]?.content },
				} as never,
			]);
			searchThenAnswer(t.query, webSearchOutput("q", [["https://a.test"]]));
			const r = await reply(t.response);
			t.query.emit(resultMessage());
			await settled(h);
			return r;
		}

		/** The history a Responses client sends next: its search items do not translate. */
		const next = (r: { content: Array<{ type: string }> }) => ({
			messages: [
				ask.messages[0],
				{
					role: "assistant",
					content: r.content.filter((b) => b.type === "text"),
				},
				{ role: "user", content: "and the one before?" },
			],
		});

		it("resumes the stored session on the next user turn", async () => {
			const h = harness();
			const r = await searchTurn(h);
			const t2 = await start(h, next(r), header);
			expect(t2.query.options.resume).toBeTruthy();
			await waitFor(() => h.repo.turns.has(t2.plan.turnId));
			expect(h.repo.turns.get(t2.plan.turnId)).toMatchObject({
				historyMode: "resume",
				rebuildReason: null,
			});
		});

		it("resumes it on another account, recording the change", async () => {
			const h = harness();
			const r = await searchTurn(h);
			const t2 = await start(h, next(r), header, {
				candidates: [
					{ accountId: "acct-b", provider: "anthropic", upstreamModel: MODEL },
				],
				preferredAccountId: "acct-b",
			});
			expect(t2.query.options.resume).toBeTruthy();
			await waitFor(() => h.repo.turns.has(t2.plan.turnId));
			expect(h.repo.turns.get(t2.plan.turnId)).toMatchObject({
				historyMode: "resume",
				rebuildReason: "account_change",
			});
		});
	});
});
