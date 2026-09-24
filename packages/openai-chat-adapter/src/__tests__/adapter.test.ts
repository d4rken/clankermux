import { describe, expect, it } from "bun:test";
import { getChatContext } from "@clankermux/types";
import { handleChatCompletionsRequest } from "../handler";
import type { MessagesBody } from "../request";
import { translateChatRequest } from "../request";

type ChatBlock = MessagesBody["messages"][number]["content"][number];

/** The translated tool list, proven present. */
function toolsOf(body: MessagesBody): NonNullable<MessagesBody["tools"]> {
	if (!body.tools)
		throw new Error("expected the translated body to carry tools");
	return body.tools;
}

/** A content block proven to be a `tool_use`. */
function toolUse(block: ChatBlock): Extract<ChatBlock, { type: "tool_use" }> {
	if (block.type !== "tool_use") {
		throw new Error(`expected a tool_use block, got ${block.type}`);
	}
	return block;
}

/** The translated `tool_choice`, proven present. */
function toolChoiceOf(
	body: MessagesBody,
): NonNullable<MessagesBody["tool_choice"]> {
	if (!body.tool_choice) {
		throw new Error("expected the translated body to carry a tool_choice");
	}
	return body.tool_choice;
}

/** Walks a JSON-schema record, which is only typed down to `unknown` values. */
function schemaValue(
	schema: Record<string, unknown>,
	...path: string[]
): unknown {
	let current: unknown = schema;
	for (const key of path) {
		if (current === null || typeof current !== "object") {
			throw new Error(`expected an object before "${key}" in the tool schema`);
		}
		current = Reflect.get(current, key);
	}
	return current;
}

const input = {
	model: "alias",
	messages: [{ role: "user", content: "hello" }],
};
const event = (type: string, extra: object = {}) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const start = (model: string | undefined = "actual-model") =>
	event("message_start", {
		message: {
			model,
			usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 3 },
		},
	});
const end = (reason = "end_turn") =>
	event("message_delta", {
		delta: { stop_reason: reason },
		usage: { output_tokens: 2 },
	}) + event("message_stop");
const text =
	start() +
	event("content_block_start", {
		index: 0,
		content_block: { type: "text", text: "" },
	}) +
	event("content_block_delta", {
		index: 0,
		delta: { type: "text_delta", text: "hello 🌍" },
	}) +
	event("content_block_stop", { index: 0 }) +
	end();
const response = (s: string) =>
	new Response(s, { headers: { "content-type": "text/event-stream" } });
async function run(
	body: object,
	upstream: Response = response(text),
	signal?: AbortSignal,
) {
	const req = new Request("http://test/wire/openai/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify(body),
		signal,
	});
	return handleChatCompletionsRequest(
		req,
		new URL(req.url),
		async (synthetic, url, _ctx, id, name) => {
			expect(url.pathname).toBe("/v1/messages");
			expect(id).toBe("key-id");
			expect(name).toBe("key-name");
			expect(
				synthetic.headers.get("x-clankermux-deny-official-anthropic"),
			).toBeNull();
			expect((await synthetic.clone().json()).stream).toBe(true);
			const ctx = getChatContext(synthetic);
			if (!ctx) throw new Error("Missing Chat context");
			expect(ctx.denyDirectOfficialAnthropic).toBe(true);
			ctx.outgoingModel = "verified-target";
			ctx.provider = "openrouter";
			return upstream;
		},
		{},
		"key-id",
		"key-name",
	);
}
describe("Chat ingress request contract", () => {
	it("keeps requested identity and encodes tool names consistently across replay", () => {
		const translated = translateChatRequest({
			...input,
			tools: [
				{
					type: "function",
					function: {
						name: "Read",
						parameters: {
							type: "object",
							properties: { url: { type: "string", format: "uri" } },
						},
					},
				},
			],
			tool_choice: { type: "function", function: { name: "Read" } },
			messages: [
				{ role: "system", content: "instructions" },
				{ role: "user", content: "read" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "a",
							type: "function",
							function: { name: "Read", arguments: '{"pages":""}' },
						},
						{
							id: "b",
							type: "function",
							function: { name: "Read", arguments: "{}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "a", content: "one" },
				{ role: "tool", tool_call_id: "b", content: "two" },
			],
		});
		const b = translated.body;
		expect(b.model).toBe("alias");
		expect(b.max_tokens).toBeUndefined();
		const tools = toolsOf(b);
		expect(tools[0].name).not.toBe("Read");
		expect(toolUse(b.messages[1].content[0]).name).toBe(tools[0].name);
		expect(toolUse(b.messages[1].content[0]).input).toEqual({ pages: "" });
		expect(
			b.messages[2].content.map((x) =>
				x.type === "tool_result" ? x.tool_use_id : null,
			),
		).toEqual(["a", "b"]);
		expect(toolChoiceOf(b).name).toBe(tools[0].name);
		expect(
			schemaValue(tools[0].input_schema, "properties", "url", "format"),
		).toBe("uri");
	});
	for (const patch of [
		{ n: 2 },
		{ stream: "true" },
		{ max_tokens: 0 },
		{ max_completion_tokens: 12 },
		{ parallel_tool_calls: true },
		{ reasoning_effort: "low" },
		{ response_format: { type: "json_schema" } },
		{ models: ["other"] },
		{ seed: 1 },
		{
			messages: [
				{
					role: "user",
					content: [{ type: "input_audio", input_audio: { data: "AA" } }],
				},
			],
		},
		{
			messages: [
				{ role: "user", content: "one" },
				{ role: "system", content: "late" },
			],
		},
		{ messages: [{ role: "tool", tool_call_id: "missing", content: "one" }] },
		{ tools: [{ type: "function", function: { name: "f", strict: true } }] },
	])
		it(`rejects unsupported/malformed semantics ${JSON.stringify(patch)}`, () =>
			expect(() => translateChatRequest({ ...input, ...patch })).toThrow());
	it("rejects a malformed JSON argument rather than inventing empty input", () => {
		expect(() =>
			translateChatRequest({
				...input,
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "x",
								type: "function",
								function: { name: "f", arguments: "{" },
							},
						],
					},
				],
			}),
		).toThrow();
	});
});
describe("Chat ingress responses", () => {
	for (const stream of [false, true]) {
		it(`preserves cache write evidence and missing reads (stream=${stream})`, async () => {
			for (const reads of [undefined, null, 0, 20, -1, "invalid"]) {
				const upstream =
					event("message_start", {
						message: {
							model: "actual-model",
							usage: {
								input_tokens: 5,
								output_tokens: 0,
								cache_read_input_tokens: null,
								cache_creation_input_tokens: null,
							},
						},
					}) +
					event("message_delta", {
						delta: { stop_reason: "end_turn" },
						usage: {
							output_tokens: 2,
							cache_creation_input_tokens: 10,
							cache_read_input_tokens: reads,
						},
					}) +
					event("message_stop");
				const res = await run(
					{
						...input,
						stream,
						stream_options: stream ? { include_usage: true } : undefined,
					},
					response(upstream),
				);
				const payload = stream
					? (await res.text())
							.split("\n")
							.filter((line) => line.startsWith("data: {"))
							.map((line) => JSON.parse(line.slice(6)))
							.at(-1)
					: await res.json();
				const validRead =
					typeof reads === "number" && reads >= 0 ? reads : undefined;
				expect(payload.usage).toEqual({
					prompt_tokens: 15 + (validRead ?? 0),
					completion_tokens: 2,
					total_tokens: 17 + (validRead ?? 0),
					prompt_tokens_details: {
						cache_write_tokens: 10,
						...(validRead !== undefined ? { cached_tokens: validRead } : {}),
					},
				});
			}
		});
	}
	it("returns JSON text, upstream model, and cache-inclusive usage", async () => {
		const res = await run(input);
		expect(res.status).toBe(200);
		const b = await res.json();
		expect(b.object).toBe("chat.completion");
		expect(b.model).toBe("actual-model");
		expect(b.choices[0].message.content).toBe("hello 🌍");
		expect(b.choices[0].finish_reason).toBe("stop");
		expect(b.usage).toMatchObject({
			prompt_tokens: 10,
			completion_tokens: 2,
			total_tokens: 12,
		});
	});
	it("uses verified outgoing identity when upstream model is absent", async () => {
		const res = await run(
			input,
			response(start().replace('"model":"actual-model",', "") + end()),
		);
		expect((await res.json()).model).toBe("verified-target");
	});
	it("streams valid chunks and exactly one requested usage record then DONE", async () => {
		const res = await run({
			...input,
			stream: true,
			stream_options: { include_usage: true },
		});
		const s = await res.text();
		expect(s).toContain("hello 🌍");
		expect(s.match(/\[DONE\]/g)?.length).toBe(1);
		const chunks = s
			.split("\n")
			.filter((l) => l.startsWith("data: {"))
			.map((l) => JSON.parse(l.slice(6)));
		expect(chunks[0].choices[0].delta.role).toBe("assistant");
		expect(chunks.filter((c) => c.choices.length === 0)).toHaveLength(1);
		expect(chunks.at(-1).usage.total_tokens).toBe(12);
	});
	it("does not emit a usage-only chunk when not requested", async () => {
		const s = await (await run({ ...input, stream: true })).text();
		expect(s).not.toContain('"choices":[]');
	});
	for (const [label, s, status] of [
		[
			"upstream error",
			start() +
				event("error", {
					error: { type: "overloaded_error", message: "try later" },
				}),
			529,
		],
		["missing terminal", start(), 502],
		["missing finish reason", start() + event("message_stop"), 502],
		["malformed event", `${start()}data: {oops}\n\n`, 502],
	] as const) {
		it(`rejects ${label} in JSON mode`, async () => {
			const r = await run(input, response(s));
			expect(r.status).toBe(status);
			expect((await r.json()).error.message).toBeTruthy();
		});
		it(`terminates ${label} honestly in streaming mode`, async () => {
			const r = await run({ ...input, stream: true }, response(s));
			const b = await r.text();
			expect(b).toContain('"error":');
			expect(b).not.toContain("[DONE]");
			expect(b).not.toContain('"finish_reason":"stop"');
		});
	}
	describe("an upstream error event mid-stream", () => {
		const overflow = {
			type: "invalid_request_error",
			message: "prompt is too long: 215012 tokens > 200000 maximum",
			code: "context_length_exceeded",
		};
		const failing = (error: object) =>
			response(
				start() +
					event("content_block_start", {
						index: 0,
						content_block: { type: "text", text: "" },
					}) +
					event("content_block_delta", {
						index: 0,
						delta: { type: "text_delta", text: "partial" },
					}) +
					event("error", { error }),
			);
		const streamedError = (body: string) =>
			JSON.parse(
				body
					.split("\n")
					.filter((l) => l.startsWith("data: {"))
					.at(-1)
					?.slice(6) ?? "null",
			);

		it("keeps its type and code, which may differ, in streaming mode", async () => {
			const r = await run({ ...input, stream: true }, failing(overflow));
			const body = await r.text();
			expect(body).toContain("partial");
			expect(streamedError(body)).toEqual({
				error: { ...overflow, param: null },
			});
			expect(body).not.toContain("[DONE]");
		});

		it("answers JSON mode with the status its type stands for", async () => {
			const r = await run(input, failing(overflow));
			expect(r.status).toBe(400);
			expect(await r.json()).toEqual({ error: { ...overflow, param: null } });
		});

		it("answers an upstream server error in JSON mode as a bad gateway", async () => {
			const r = await run(
				input,
				failing({ type: "api_error", message: "upstream broke" }),
			);
			expect(r.status).toBe(502);
			expect((await r.json()).error).toMatchObject({
				type: "api_error",
				code: "api_error",
			});
		});

		it("uses its type as the code when it has none", async () => {
			const r = await run(
				{ ...input, stream: true },
				failing({ type: "overloaded_error", message: "try later" }),
			);
			expect(streamedError(await r.text())).toEqual({
				error: {
					type: "overloaded_error",
					message: "try later",
					param: null,
					code: "overloaded_error",
				},
			});
		});

		it("still reports invalid upstream data as such", async () => {
			const r = await run(
				{ ...input, stream: true },
				response(`${start()}data: {oops}\n\n`),
			);
			expect(streamedError(await r.text())).toEqual({
				error: {
					type: "api_error",
					message: "Malformed upstream SSE event",
					param: null,
					code: "invalid_upstream_response",
				},
			});
		});
	});
	it("carries an error's own code before the head", async () => {
		const r = await run(
			input,
			Response.json(
				{
					type: "error",
					error: {
						type: "invalid_request_error",
						message: "prompt is too long",
						code: "context_length_exceeded",
					},
				},
				{ status: 400 },
			),
		);
		expect(r.status).toBe(400);
		expect(await r.json()).toEqual({
			error: {
				type: "invalid_request_error",
				message: "prompt is too long",
				param: null,
				code: "context_length_exceeded",
			},
		});
	});
	it("re-envelopes routing errors and retains status", async () => {
		const r = await run(
			input,
			Response.json(
				{
					type: "error",
					error: { type: "routing_policy_rejected", message: "Denied" },
				},
				{ status: 403 },
			),
		);
		expect(r.status).toBe(403);
		expect(await r.json()).toEqual({
			error: {
				type: "routing_policy_rejected",
				message: "Denied",
				param: null,
				code: "routing_policy_rejected",
			},
		});
	});
	it("cancels the upstream reader before any text", async () => {
		let canceled = false;
		const upstream = new Response(
			new ReadableStream({
				cancel() {
					canceled = true;
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
		const r = await run({ ...input, stream: true }, upstream);
		const reader = r.body?.getReader();
		if (!reader) throw new Error("expected a streamed response body");
		const pending = reader.read();
		await reader.cancel();
		await pending;
		expect(canceled).toBe(true);
	});
	it("maps a truncated tool completion to length, never repairs its arguments", async () => {
		const b = translateChatRequest({
			...input,
			tools: [
				{
					type: "function",
					function: { name: "f", parameters: { type: "object" } },
				},
			],
		});
		const name = toolsOf(b.body)[0].name;
		const s =
			start() +
			event("content_block_start", {
				index: 4,
				content_block: { type: "tool_use", id: "call", name, input: {} },
			}) +
			event("content_block_delta", {
				index: 4,
				delta: { type: "input_json_delta", partial_json: '{"x":' },
			}) +
			event("content_block_stop", { index: 4 }) +
			end("max_tokens");
		const r = await run(
			{
				...input,
				tools: [
					{
						type: "function",
						function: { name: "f", parameters: { type: "object" } },
					},
				],
			},
			response(s),
		);
		expect(r.status).toBe(200);
		const out = await r.json();
		expect(out.choices[0].finish_reason).toBe("length");
		expect(out.choices[0].message.tool_calls[0].function.arguments).toBe(
			'{"x":',
		);
	});
});

describe("Chat protocol boundaries", () => {
	it("handles byte-fragmented UTF8 and CRLF frames", async () => {
		const bytes = new TextEncoder().encode(text.replaceAll("\n", "\r\n"));
		let offset = 0;
		const upstream = new Response(
			new ReadableStream({
				pull(c) {
					if (offset === bytes.length) c.close();
					else c.enqueue(bytes.slice(offset, ++offset));
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
		const result = await (await run(input, upstream)).json();
		expect(result.choices[0].message.content).toBe("hello 🌍");
	});
	it("preserves HTTP status and Retry-After when an error body fails", async () => {
		const upstream = new Response(
			new ReadableStream({
				start(c) {
					c.error(new Error("broken error body"));
				},
			}),
			{ status: 429, headers: { "retry-after": "7" } },
		);
		const result = await run(input, upstream);
		expect(result.status).toBe(429);
		expect(result.headers.get("retry-after")).toBe("7");
		expect((await result.json()).error.message).toBeTruthy();
	});
	it("aborts JSON aggregation while upstream is waiting", async () => {
		const aborter = new AbortController();
		let canceled = false;
		const upstream = new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode(start()));
				},
				cancel() {
					canceled = true;
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
		const pending = run(input, upstream, aborter.signal);
		await new Promise((r) => setTimeout(r, 5));
		aborter.abort();
		expect((await pending).status).toBe(499);
		expect(canceled).toBe(true);
	});
	it("rejects an oversized SSE frame", async () => {
		const result = await run(
			input,
			response(`${start()}data: ${"x".repeat(1024 * 1024)}\n\n`),
		);
		expect(result.status).toBe(502);
	});
	it("preserves interleaved tool indices and arguments", async () => {
		const tools = [
			{
				type: "function",
				function: { name: "f", parameters: { type: "object" } },
			},
		];
		const name = toolsOf(translateChatRequest({ ...input, tools }).body)[0]
			.name;
		const s =
			start() +
			[7, 2]
				.map((index) =>
					event("content_block_start", {
						index,
						content_block: {
							type: "tool_use",
							id: `call-${index}`,
							name,
							input: {},
						},
					}),
				)
				.join("") +
			event("content_block_delta", {
				index: 2,
				delta: { type: "input_json_delta", partial_json: '{"b":2}' },
			}) +
			event("content_block_delta", {
				index: 7,
				delta: { type: "input_json_delta", partial_json: '{"a":1}' },
			}) +
			[7, 2].map((index) => event("content_block_stop", { index })).join("") +
			end("tool_use");
		const result = await (await run({ ...input, tools }, response(s))).json();
		expect(result.choices[0].message.tool_calls).toEqual([
			{
				id: "call-7",
				type: "function",
				function: { name: "f", arguments: '{"a":1}' },
			},
			{
				id: "call-2",
				type: "function",
				function: { name: "f", arguments: '{"b":2}' },
			},
		]);
	});
});

it("preserves assistant reasoning replay for compatible destinations", () => {
	const result = translateChatRequest({
		...input,
		messages: [
			{
				role: "assistant",
				content: "answer",
				reasoning_content: "prior thought",
			},
			{ role: "user", content: "continue" },
		],
	});
	expect(result.body.messages[0].content[0]).toEqual({
		type: "thinking",
		thinking: "prior thought",
		signature: "",
	});
	expect(result.requirements.fields).toContain("reasoning_content");
	expect(() =>
		translateChatRequest({
			...input,
			messages: [{ role: "user", content: "hi", reasoning_content: "bad" }],
		}),
	).toThrow();
});

it("keeps a streaming completion model stable when Codex reports its model late", async () => {
	let context: ReturnType<typeof getChatContext>;
	let part = 0;
	const req = new Request("http://proxy/wire/openai/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify({ ...input, stream: true }),
	});
	const result = await handleChatCompletionsRequest(
		req,
		new URL(req.url),
		async (synthetic) => {
			context = getChatContext(synthetic);
			if (!context) throw new Error();
			context.outgoingModel = "fallback";
			return new Response(
				new ReadableStream(
					{
						pull(c) {
							if (part++ === 0)
								c.enqueue(
									new TextEncoder().encode(
										start().replace('"actual-model"', '"fallback"'),
									),
								);
							else if (part === 2) {
								if (context) context.reportedModel = "late-model";
								c.enqueue(new TextEncoder().encode(end()));
							} else c.close();
						},
					},
					{ highWaterMark: 0 },
				),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
		{},
	);
	const chunks = (await result.text())
		.split("\n")
		.filter((x) => x.startsWith("data: {"))
		.map((x) => JSON.parse(x.slice(6)));
	expect(new Set(chunks.map((x) => x.model)).size).toBe(1);
});

it("maps context exhaustion to length and refuses server-tool pause", async () => {
	const limited = await (
		await run(input, response(start() + end("model_context_window_exceeded")))
	).json();
	expect(limited.choices[0].finish_reason).toBe("length");
	const paused = await run(
		{ ...input, stream: true },
		response(start() + end("pause_turn")),
	);
	const output = await paused.text();
	expect(output).toContain('"error"');
	expect(output).not.toContain("[DONE]");
});
it("uses the verified target for an empty upstream model", async () => {
	expect(
		(await (await run(input, response(start("") + end()))).json()).model,
	).toBe("verified-target");
});
for (const encoding of ["gzip", "deflate"] as const)
	it(`accepts bounded ${encoding} JSON requests`, async () => {
		const compressed = await new Response(
			new Blob([JSON.stringify(input)])
				.stream()
				.pipeThrough(new CompressionStream(encoding)),
		).arrayBuffer();
		const req = new Request("http://proxy/wire/openai/v1/chat/completions", {
			method: "POST",
			body: compressed,
			headers: { "content-encoding": encoding },
		});
		const result = await handleChatCompletionsRequest(
			req,
			new URL(req.url),
			async () => response(text),
			{},
		);
		expect(result.status).toBe(200);
		expect((await result.json()).choices[0].message.content).toBe("hello 🌍");
	});
it("rejects unsupported encoding and excessive decoded bodies before proxying", async () => {
	for (const [body, encoding, status] of [
		["{}", "br", 415],
		[JSON.stringify(input).padEnd(16 * 1024 * 1024 + 1, " "), "identity", 413],
	] as const) {
		const req = new Request("http://proxy/wire/openai/v1/chat/completions", {
			method: "POST",
			body,
			headers: { "content-encoding": encoding },
		});
		let sends = 0;
		const result = await handleChatCompletionsRequest(
			req,
			new URL(req.url),
			async () => {
				sends++;
				return response(text);
			},
			{},
		);
		expect(result.status).toBe(status);
		expect(sends).toBe(0);
	}
});
it("accepts a request exactly at the body limit", async () => {
	const req = new Request("http://proxy/wire/openai/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify(input).padEnd(16 * 1024 * 1024, " "),
	});
	expect(
		(
			await handleChatCompletionsRequest(
				req,
				new URL(req.url),
				async () => response(text),
				{},
			)
		).status,
	).toBe(200);
});

/**
 * `x-clankermux-request-id` is the handle a client uses to read its own row
 * back from `/client/v1/requests/{id}`. `forwardToClient` puts it on the
 * response this adapter receives from `handleProxy` — which is what the
 * upstream below models — and both client-facing legs then build a fresh
 * Response that does not carry it.
 */
describe("the client-facing request id survives the Chat adapter", () => {
	const REQUEST_ID = "rid-chat-1";

	/** What `forwardToClient` hands back: the proxy's id is already on it. */
	const forwarded = (sse: string) =>
		new Response(sse, {
			headers: {
				"content-type": "text/event-stream",
				"x-clankermux-request-id": REQUEST_ID,
			},
		});

	it("on the non-streaming JSON leg", async () => {
		const r = await run(input, forwarded(text));

		expect(r.status).toBe(200);
		expect(r.headers.get("x-clankermux-request-id")).toBe(REQUEST_ID);
	});

	it("on the streaming leg", async () => {
		const r = await run({ ...input, stream: true }, forwarded(text));

		expect(r.headers.get("content-type")).toContain("text/event-stream");
		expect(r.headers.get("x-clankermux-request-id")).toBe(REQUEST_ID);
		await r.text();
	});
});
