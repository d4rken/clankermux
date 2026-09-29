import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { Logger } from "@clankermux/logger";
import {
	getNativeResponsesRequestContext,
	markHostedWebSearchServed,
	type NativeResponsesContext,
} from "@clankermux/types";
import { handleResponsesRequest } from "../handler";
import { translateAnthropicResponseToResponses } from "../response-translator";
import { translateAnthropicStreamToResponses } from "../stream-translator";
import type { AnthropicResponse, HandleProxyFn } from "../types";

const MESSAGE = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-sonnet-5",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
};

/** pi-web-search's request for a model it drives over openai-responses. */
const PI_SEARCH = {
	model: "claude-sonnet-5",
	input: "latest bun release",
	tools: [{ type: "web_search" }],
	tool_choice: "required",
	include: ["web_search_call.action.sources", "web_search_call.results"],
	stream: true,
	store: false,
};

interface Forwarded {
	status: number;
	body: Record<string, unknown> | null;
	context: NativeResponsesContext | undefined;
	json: Record<string, unknown> | null;
}

async function send(
	body: Record<string, unknown>,
	opts: { served?: boolean } = {},
): Promise<Forwarded> {
	let forwarded: Request | null = null;
	const handleProxy: HandleProxyFn = async (req) => {
		forwarded = req;
		const context = getNativeResponsesRequestContext(req);
		if (opts.served && context?.hostedWebSearch)
			markHostedWebSearchServed(context);
		return Response.json(MESSAGE);
	};
	const req = new Request("http://localhost/v1/responses", {
		method: "POST",
		body: JSON.stringify({ ...body, stream: false }),
		headers: { "Content-Type": "application/json" },
	});
	const res = await handleResponsesRequest(
		req,
		new URL(req.url),
		handleProxy,
		{},
	);
	const sent = forwarded as Request | null;
	return {
		status: res.status,
		body: sent
			? ((await sent.clone().json()) as Record<string, unknown>)
			: null,
		context: sent ? getNativeResponsesRequestContext(sent) : undefined,
		json: (await res.json().catch(() => null)) as Record<
			string,
			unknown
		> | null,
	};
}

const logged: Array<{ level: string; message: string }> = [];
let spies: Array<{ mockRestore(): void }> = [];
beforeAll(() => {
	spies = (["warn", "info"] as const).map((level) =>
		spyOn(Logger.prototype, level).mockImplementation(function (
			this: Logger,
			message: string,
		) {
			logged.push({ level, message });
		}),
	);
});
afterAll(() => {
	for (const spy of spies) spy.mockRestore();
});
afterEach(() => {
	logged.length = 0;
});

const searchLogs = () =>
	logged.filter((l) => /web_search/.test(l.message)).map((l) => l);

describe("hosted web_search on the request side", () => {
	test("records a search-only request for the bridge, required by tool_choice", async () => {
		const r = await send(PI_SEARCH);
		expect(r.context?.hostedWebSearch).toEqual({
			required: true,
			allowedDomains: null,
		});
	});

	test("leaves the translated body exactly as without the tool, and the native body whole", async () => {
		const withSearch = await send(PI_SEARCH);
		const { tools: _tools, tool_choice: _choice, ...bare } = PI_SEARCH;
		const without = await send(bare);
		expect(JSON.stringify(withSearch.body)).toBe(JSON.stringify(without.body));
		expect(withSearch.body).not.toHaveProperty("tools");
		expect(withSearch.body).not.toHaveProperty("tool_choice");
		// Codex's native passthrough forwards the client's own body.
		expect(JSON.parse(withSearch.context?.nativeBody ?? "{}").tools).toEqual([
			{ type: "web_search" },
		]);
	});

	test("maps tool_choice: auto and absent enable it, none does not, a named web search requires it", async () => {
		for (const [choice, expected] of [
			[undefined, { required: false, allowedDomains: null }],
			["auto", { required: false, allowedDomains: null }],
			["none", undefined],
			["required", { required: true, allowedDomains: null }],
			[{ type: "web_search" }, { required: true, allowedDomains: null }],
			[
				{ type: "web_search_preview" },
				{ required: true, allowedDomains: null },
			],
		] as const) {
			const r = await send({
				...PI_SEARCH,
				tools: [{ type: "web_search_preview" }],
				...(choice === undefined ? { tool_choice: undefined } : {}),
				...(choice !== undefined ? { tool_choice: choice } : {}),
			});
			expect(r.status).toBe(200);
			expect(r.context?.hostedWebSearch).toEqual(expected);
		}
	});

	test("keeps today's drop for a request that mixes it with client tools, and says so", async () => {
		const r = await send({
			...PI_SEARCH,
			tool_choice: "auto",
			tools: [
				{ type: "web_search" },
				{ type: "function", name: "read", parameters: { type: "object" } },
			],
		});
		expect(r.context?.hostedWebSearch).toBeUndefined();
		expect(
			(r.body?.tools as Array<{ name: string }>).map((t) => t.name),
		).toEqual(["read"]);
		expect(searchLogs()).toEqual([
			{ level: "info", message: "web_search dropped: mixed with client tools" },
		]);
	});

	test("warns about the drop only when no bridged turn served the search", async () => {
		await send(PI_SEARCH, { served: true });
		expect(searchLogs()).toEqual([]);
		await send(PI_SEARCH, { served: false });
		expect(searchLogs()).toEqual([
			{
				level: "warn",
				message: "Skipping unsupported/built-in tool type: web_search",
			},
		]);
	});

	test("normalizes allowed domains and records the hints it does not apply", async () => {
		const r = await send({
			...PI_SEARCH,
			tools: [
				{
					type: "web_search",
					filters: { allowed_domains: ["Docs.Bun.sh", "bun.sh", "bun.sh"] },
					user_location: { type: "approximate", country: "DE" },
					search_context_size: "high",
				},
			],
		});
		expect(r.context?.hostedWebSearch).toEqual({
			required: true,
			allowedDomains: ["docs.bun.sh", "bun.sh"],
		});
		expect(r.context?.translationGaps?.droppedFields).toEqual([
			"web_search.user_location",
			"web_search.search_context_size",
		]);
	});

	test("refuses allowed domains that are not plain hostnames", async () => {
		for (const domains of [
			["https://bun.sh"],
			["bun.sh/docs"],
			["bun"],
			[""],
			[42],
			"bun.sh",
			Array.from({ length: 101 }, (_, i) => `d${i}.example.com`),
		]) {
			const r = await send({
				...PI_SEARCH,
				tools: [{ type: "web_search", filters: { allowed_domains: domains } }],
			});
			expect(r.status).toBe(400);
			expect(r.body).toBeNull();
			expect((r.json as { error: { type: string } }).error.type).toBe(
				"invalid_request_error",
			);
		}
	});
});

// ── response side ─────────────────────────────────────────────────────────

function base(content: unknown[]): AnthropicResponse {
	return {
		...MESSAGE,
		content,
	} as unknown as AnthropicResponse;
}

const SEARCH_USE = {
	type: "server_tool_use",
	id: "toolu_ws_1",
	name: "web_search",
	input: { query: "latest bun release" },
};
const SEARCH_RESULT = {
	type: "web_search_tool_result",
	tool_use_id: "toolu_ws_1",
	content: [
		{
			type: "web_search_result",
			url: "https://bun.sh/blog",
			title: "Bun blog",
		},
		{ type: "web_search_result", url: "https://github.com/oven-sh/bun" },
	],
};

describe("hosted web_search on the non-streamed response", () => {
	test("becomes one completed web_search_call before the answer, sources only when included", () => {
		const content = [
			SEARCH_USE,
			SEARCH_RESULT,
			{ type: "text", text: "Bun 2" },
		];
		const withSources = translateAnthropicResponseToResponses(
			base(content),
			"resp_1",
			"m",
			undefined,
			{ includeSources: true },
		);
		expect(withSources.output).toEqual([
			{
				type: "web_search_call",
				id: "resp_1_ws_0",
				status: "completed",
				action: {
					type: "search",
					query: "latest bun release",
					sources: [
						{ type: "url", url: "https://bun.sh/blog", title: "Bun blog" },
						{ type: "url", url: "https://github.com/oven-sh/bun" },
					],
				},
			},
			{
				type: "message",
				id: "resp_1_msg_1",
				role: "assistant",
				content: [{ type: "output_text", text: "Bun 2" }],
				status: "completed",
			},
		]);
		const without = translateAnthropicResponseToResponses(
			base(content),
			"resp_1",
			"m",
		);
		expect(without.output[0]).toEqual({
			type: "web_search_call",
			id: "resp_1_ws_0",
			status: "completed",
			action: { type: "search", query: "latest bun release" },
		});
	});

	test("fails a search whose result is an error, or that never got one", () => {
		const out = translateAnthropicResponseToResponses(
			base([
				SEARCH_USE,
				{
					type: "web_search_tool_result",
					tool_use_id: "toolu_ws_1",
					content: {
						type: "web_search_tool_result_error",
						error_code: "unavailable",
					},
				},
				{ ...SEARCH_USE, id: "toolu_ws_2", input: { query: "second" } },
				{ type: "text", text: "no luck" },
			]),
			"resp_2",
			"m",
			undefined,
			{ includeSources: true },
		).output as unknown as Array<Record<string, unknown>>;
		expect(out.map((i) => [i.type, i.status])).toEqual([
			["web_search_call", "failed"],
			["web_search_call", "failed"],
			["message", "completed"],
		]);
		expect(out[0]?.action).toEqual({
			type: "search",
			query: "latest bun release",
			sources: [],
		});
	});

	test("turns web search citations into url_citation annotations", () => {
		const out = translateAnthropicResponseToResponses(
			base([
				SEARCH_USE,
				SEARCH_RESULT,
				{
					type: "text",
					text: "Bun 2 is out",
					citations: [
						{
							type: "web_search_result_location",
							url: "https://bun.sh/blog",
							title: "Bun blog",
							cited_text: "Bun 2",
						},
						{ type: "char_location", cited_text: "x" },
					],
				},
			]),
			"resp_3",
			"m",
		).output as unknown as Array<Record<string, unknown>>;
		expect(out[1]?.content).toEqual([
			{
				type: "output_text",
				text: "Bun 2 is out",
				annotations: [
					{
						type: "url_citation",
						url: "https://bun.sh/blog",
						title: "Bun blog",
						start_index: 0,
						end_index: 12,
					},
				],
			},
		]);
	});
});

// ── streamed response ─────────────────────────────────────────────────────

const sse = (type: string, data: Record<string, unknown>) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function block(
	index: number,
	start: Record<string, unknown>,
	deltas: unknown[] = [],
) {
	return [
		sse("content_block_start", { index, content_block: start }),
		...deltas.map((delta) => sse("content_block_delta", { index, delta })),
		sse("content_block_stop", { index }),
	];
}

const searchUse = (index: number, id: string, query: string) =>
	block(index, { type: "server_tool_use", id, name: "web_search", input: {} }, [
		{ type: "input_json_delta", partial_json: JSON.stringify({ query }) },
	]);

const searchResult = (index: number, id: string, urls: string[]) =>
	block(index, {
		type: "web_search_tool_result",
		tool_use_id: id,
		content: urls.map((url) => ({
			type: "web_search_result",
			url,
			title: url,
		})),
	});

const text = (index: number, value: string) =>
	block(index, { type: "text", text: "" }, [
		{ type: "text_delta", text: value },
	]);

function stream(parts: string[][], opts: { includeSources?: boolean } = {}) {
	const body = [
		sse("message_start", {
			message: { model: "claude-sonnet-5", usage: { input_tokens: 1 } },
		}),
		...parts.flat(),
		sse("message_delta", {
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 2 },
		}),
		sse("message_stop", {}),
	].join("");
	return translateAnthropicStreamToResponses(
		new Response(body, { headers: { "content-type": "text/event-stream" } }),
		"resp_s",
		"claude-sonnet-5",
		undefined,
		{ includeSources: opts.includeSources ?? true },
	);
}

async function events(res: Response) {
	return (await res.text())
		.split("\n\n")
		.filter((c) => c.startsWith("event: "))
		.map((c) => {
			const [head, data] = c.split("\n");
			return {
				event: head?.slice(7) ?? "",
				data: JSON.parse(data?.slice(6) ?? "{}") as Record<string, unknown>,
			};
		});
}

/**
 * What pi-web-search takes from the stream (its api.ts reads these fields
 * and nothing else): the searches' queries, statuses and source urls, the
 * text, and whether the response completed.
 */
function piWebSearchReads(
	evs: Array<{ event: string; data: Record<string, unknown> }>,
) {
	const calls = new Map<
		string,
		{ status?: string; queries: string[]; urls: string[] }
	>();
	let text = "";
	let completed = false;
	const collect = (item: Record<string, unknown> | undefined) => {
		if (item?.type !== "web_search_call") return;
		const call = calls.get(String(item.id)) ?? { queries: [], urls: [] };
		const action = (item.action ?? {}) as Record<string, unknown>;
		call.status = String(item.status);
		if (
			typeof action.query === "string" &&
			!call.queries.includes(action.query)
		)
			call.queries.push(action.query);
		for (const s of (action.sources ?? []) as Array<{ url?: string }>)
			if (s?.url && !call.urls.includes(s.url)) call.urls.push(s.url);
		calls.set(String(item.id), call);
	};
	for (const { data } of evs) {
		const type = String(data.type);
		if (type === "error" || type === "response.failed")
			throw new Error("pi: failed");
		if (type === "response.output_text.delta") text += String(data.delta);
		else if (
			type === "response.output_item.added" ||
			type === "response.output_item.done"
		)
			collect(data.item as Record<string, unknown>);
		else if (type === "response.completed") {
			const response = data.response as Record<string, unknown>;
			if (response.status !== "completed") throw new Error("pi: not completed");
			for (const item of response.output as Array<Record<string, unknown>>)
				collect(item);
			completed = true;
		} else if (type.startsWith("response.web_search_call.")) {
			const call = calls.get(String(data.item_id)) ?? { queries: [], urls: [] };
			call.status = type.replace("response.web_search_call.", "");
			calls.set(String(data.item_id), call);
		}
	}
	if (!completed) throw new Error("pi: stream ended without completion");
	if (![...calls.values()].some((c) => c.status === "completed"))
		throw new Error(
			"Native web search unavailable: no completed native web search was returned by the provider",
		);
	return { calls: [...calls.values()], text };
}

describe("hosted web_search on the streamed response", () => {
	test("emits the search item's lifecycle in stream order, and pi's reads find queries and sources", async () => {
		const evs = await events(
			stream([
				searchUse(0, "ws1", "latest bun release"),
				searchResult(1, "ws1", ["https://bun.sh/blog"]),
				text(2, "Bun 2 is out"),
			]),
		);
		const names = evs.map((e) => e.event);
		expect(names).toEqual([
			"response.created",
			"response.in_progress",
			"response.output_item.added",
			"response.web_search_call.in_progress",
			"response.web_search_call.searching",
			"response.web_search_call.completed",
			"response.output_item.done",
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_text.done",
			"response.content_part.done",
			"response.output_item.done",
			"response.completed",
		]);
		const done = evs[6]?.data;
		expect(done).toMatchObject({
			output_index: 0,
			item: {
				type: "web_search_call",
				id: "resp_s_ws_0",
				status: "completed",
				action: {
					type: "search",
					query: "latest bun release",
					sources: [
						{
							type: "url",
							url: "https://bun.sh/blog",
							title: "https://bun.sh/blog",
						},
					],
				},
			},
		});
		expect(piWebSearchReads(evs)).toEqual({
			calls: [
				{
					status: "completed",
					queries: ["latest bun release"],
					urls: ["https://bun.sh/blog"],
				},
			],
			text: "Bun 2 is out",
		});
	});

	test("leaves sources out unless the request included them", async () => {
		const evs = await events(
			stream(
				[searchUse(0, "ws1", "q"), searchResult(1, "ws1", ["https://a.test"])],
				{ includeSources: false },
			),
		);
		const done = evs.find((e) => e.event === "response.output_item.done");
		expect((done?.data.item as { action: unknown }).action).toEqual({
			type: "search",
			query: "q",
		});
	});

	test("fills each search's reserved slot when its result arrives, whatever the order", async () => {
		const evs = await events(
			stream([
				searchUse(0, "ws1", "first"),
				searchUse(1, "ws2", "second"),
				text(2, "thinking aloud"),
				searchResult(3, "ws2", ["https://two.test"]),
				searchResult(4, "ws1", ["https://one.test"]),
				text(5, "answer"),
			]),
		);
		const completed = evs.find((e) => e.event === "response.completed")?.data
			.response as { output: Array<Record<string, unknown>> };
		expect(
			completed.output.map((i) => [
				i.type,
				(i.action as { query?: string } | undefined)?.query ?? null,
				i.status,
			]),
		).toEqual([
			["web_search_call", "first", "completed"],
			["web_search_call", "second", "completed"],
			["message", null, "completed"],
			["message", null, "completed"],
		]);
		const doneOrder = evs
			.filter((e) => e.event === "response.output_item.done")
			.map((e) => e.data.output_index);
		expect(doneOrder).toEqual([2, 1, 0, 3]);
	});

	test("ignores a result for no search or a second one for the same, and fails a search still pending at the end", async () => {
		const warn = logged.length;
		const evs = await events(
			stream([
				searchUse(0, "ws1", "q"),
				searchResult(1, "nope", ["https://x.test"]),
				searchResult(2, "ws1", ["https://a.test"]),
				searchResult(3, "ws1", ["https://b.test"]),
				searchUse(4, "ws2", "never answered"),
				text(5, "answer"),
			]),
		);
		const completed = evs.find((e) => e.event === "response.completed")?.data
			.response as { output: Array<Record<string, unknown>> };
		expect(completed.output.map((i) => [i.type, i.status])).toEqual([
			["web_search_call", "completed"],
			["web_search_call", "failed"],
			["message", "completed"],
		]);
		expect(
			(completed.output[0]?.action as { sources: unknown[] }).sources,
		).toEqual([
			{ type: "url", url: "https://a.test", title: "https://a.test" },
		]);
		expect(logged.length).toBeGreaterThan(warn);
	});

	test("maps an error result to a failed search without a completed event", async () => {
		const evs = await events(
			stream([
				searchUse(0, "ws1", "q"),
				block(1, {
					type: "web_search_tool_result",
					tool_use_id: "ws1",
					content: {
						type: "web_search_tool_result_error",
						error_code: "max_uses_exceeded",
					},
				}),
			]),
		);
		expect(evs.map((e) => e.event)).not.toContain(
			"response.web_search_call.completed",
		);
		const done = evs.find((e) => e.event === "response.output_item.done");
		expect(done?.data.item).toMatchObject({
			type: "web_search_call",
			status: "failed",
		});
		expect(() => piWebSearchReads(evs)).toThrow(
			"no completed native web search",
		);
	});

	test("an SSE error after a search reaches pi as response.failed", async () => {
		const body = [
			sse("message_start", { message: { model: "m", usage: {} } }),
			...text(0, "from memory"),
			sse("error", {
				error: {
					type: "api_error",
					code: "web_search_not_performed",
					message: "The model answered without searching",
				},
			}),
		].join("");
		const evs = await events(
			translateAnthropicStreamToResponses(
				new Response(body),
				"resp_f",
				"m",
				undefined,
				{ includeSources: true },
			),
		);
		const failed = evs.find((e) => e.event === "response.failed");
		expect((failed?.data.response as { error: unknown }).error).toEqual({
			code: "web_search_not_performed",
			message: "The model answered without searching",
		});
		expect(() => piWebSearchReads(evs)).toThrow("pi: failed");
	});
});
