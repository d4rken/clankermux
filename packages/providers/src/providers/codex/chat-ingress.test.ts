import { describe, expect, it } from "bun:test";
import { handleChatCompletionsRequest } from "@clankermux/openai-chat-adapter";
import {
	getChatContext,
	setChatContext,
	transferChatContext,
} from "@clankermux/types";
import { translateChatRequest } from "../../../../openai-chat-adapter/src/request";
import { CodexProvider } from "./provider";

const frame = (type: string, extra: object = {}) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const body = { model: "alias", messages: [{ role: "user", content: "hello" }] };
async function run(
	s: string,
	stream = false,
	contentType = true,
	includeUsage = false,
	extra: object = {},
) {
	const req = new Request("http://proxy/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify({
			...body,
			...extra,
			stream,
			...(includeUsage ? { stream_options: { include_usage: true } } : {}),
		}),
	});
	return handleChatCompletionsRequest(
		req,
		new URL(req.url),
		async (synthetic) => {
			const ctx = getChatContext(synthetic);
			if (!ctx) throw new Error("Missing context");
			ctx.outgoingModel = "gpt-6-astra";
			ctx.provider = "codex";
			const response = new Response(s, {
				headers: {
					"x-clankermux-resolved-model": "gpt-6-astra",
					...(contentType ? { "content-type": "text/event-stream" } : {}),
				},
			});
			transferChatContext(synthetic, response);
			return new CodexProvider().processResponse(response, null);
		},
		{},
	);
}
describe("strict Codex conversion for Chat ingress", () => {
	for (const stream of [false, true])
		it(`never manufactures success on EOF (stream=${stream})`, async () => {
			const r = await run(
				frame("response.created", { response: { id: "resp" } }),
				stream,
			);
			const text = await r.text();
			expect(text).toContain('"error":');
			expect(text).not.toContain("[DONE]");
			expect(r.status).toBe(stream ? 200 : 502);
		});
	it("fails malformed framed events", async () => {
		const r = await run("event: response.created\ndata: {broken}\n\n");
		expect(r.status).toBe(502);
	});
	it("uses a model reported only in the terminal event and does not invent missing usage", async () => {
		const r = await run(
			frame("response.created", { response: { id: "resp" } }) +
				frame("response.completed", {
					response: {
						id: "resp",
						status: "completed",
						model: "gpt-6-astra-reported",
						output: [],
					},
				}),
			false,
			false,
		);
		expect(r.status).toBe(200);
		const b = await r.json();
		expect(b.model).toBe("gpt-6-astra-reported");
		expect(b.usage).toBeUndefined();
	});
	it("keeps an unlabelled Codex body streaming and cancels a silent reader", async () => {
		let canceled = false;
		const raw = new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(
						new TextEncoder().encode(
							frame("response.created", {
								response: { id: "resp", model: "gpt-6-astra" },
							}),
						),
					);
				},
				cancel() {
					canceled = true;
				},
			}),
		);
		setChatContext(raw, {
			requirements: { fields: [] },
			defaultMaxTokens: 8192,
		});
		const r = await new CodexProvider().processResponse(raw, null);
		const reader = r.body?.getReader();
		if (!reader) throw new Error("Missing stream");
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain("message_start");
		await reader.cancel();
		await new Promise((r) => setTimeout(r, 0));
		expect(canceled).toBe(true);
	});
	it("encodes Claude-specific tool names without mutating arguments or adding nudges", async () => {
		const names = ["Read", "WebSearch", "Skill", "StructuredOutput"];
		const input = { pages: "", blocked_domains: ["example.test"] };
		const translated = translateChatRequest({
			...body,
			tools: names.map((name) => ({
				type: "function",
				function: {
					name,
					parameters: {
						type: "object",
						properties: { url: { type: "string", format: "uri" } },
					},
				},
			})),
			messages: [
				{ role: "user", content: "tools" },
				{
					role: "assistant",
					content: null,
					tool_calls: names.map((name, i) => ({
						id: `call${i}`,
						type: "function",
						function: { name, arguments: JSON.stringify(input) },
					})),
				},
				...names.map((_, i) => ({
					role: "tool",
					tool_call_id: `call${i}`,
					content: "result",
				})),
			],
		});
		const request = new Request(
			"https://chatgpt.com/backend-api/codex/responses",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(translated.body),
			},
		);
		const converted = await new CodexProvider().transformRequestBody(request);
		const out = await converted.json();
		expect(out.tool_choice).toBeUndefined();
		expect(
			out.input
				.filter((x: { type?: string }) => x.type === "function_call")
				.map((x: { arguments: string }) => JSON.parse(x.arguments)),
		).toEqual(names.map(() => input));
		expect(out.input).toHaveLength(9);
		expect(JSON.stringify(out)).not.toContain(
			"requested Skill tool has loaded",
		);
		for (const tool of out.tools) {
			expect(names).not.toContain(tool.name);
			expect(tool.parameters.properties.url.format).toBe("uri");
		}
	});
});

it("does not label an unknown Codex interruption as an output limit", async () => {
	const r = await run(
		frame("response.created", { response: { id: "r" } }) +
			frame("response.incomplete", {
				response: {
					id: "r",
					status: "incomplete",
					incomplete_details: { reason: "server_shutdown" },
				},
			}),
	);
	expect(r.status).toBe(502);
	expect((await r.json()).error.message).toContain("Codex");
});

it("preserves a failed Codex diagnostic even if its envelope says incomplete", async () => {
	const r = await run(
		frame("response.created", { response: { id: "r" } }) +
			frame("response.failed", {
				response: {
					id: "r",
					status: "incomplete",
					error: { message: "quota exhausted", code: "quota_exceeded" },
				},
			}),
	);
	expect(r.status).toBe(502);
	expect((await r.json()).error.message).toContain("quota exhausted");
});

it("emits null requested streaming usage when Codex reports no counters", async () => {
	const r = await run(
		frame("response.created", { response: { id: "r" } }) +
			frame("response.completed", {
				response: { id: "r", status: "completed", output: [] },
			}),
		true,
		true,
		true,
	);
	const text = await r.text();
	const chunks = text
		.split("\n")
		.filter((x) => x.startsWith("data: {"))
		.map((x) => JSON.parse(x.slice(6)));
	expect(chunks.filter((x) => x.choices?.length === 0)).toHaveLength(1);
	expect(chunks.at(-1).usage).toBeNull();
	expect(text).toContain("[DONE]");
});

it("streams interleaved Codex tool arguments without closing earlier calls", async () => {
	const tools = [
		{
			type: "function",
			function: { name: "f", parameters: { type: "object" } },
		},
	];
	const translatedTool = translateChatRequest({ ...body, tools }).body
		.tools?.[0];
	if (!translatedTool) throw new Error("expected a translated tool");
	const name = translatedTool.name;
	const s =
		frame("response.created", { response: { id: "r" } }) +
		[0, 1]
			.map((output_index) =>
				frame("response.output_item.added", {
					output_index,
					item: {
						type: "function_call",
						call_id: `c${output_index}`,
						name,
						arguments: "",
					},
				}),
			)
			.join("") +
		[1, 0]
			.map((output_index) =>
				frame("response.function_call_arguments.delta", {
					output_index,
					delta: JSON.stringify({ value: output_index }),
				}),
			)
			.join("") +
		[0, 1]
			.map((output_index) =>
				frame("response.output_item.done", {
					output_index,
					item: {
						type: "function_call",
						arguments: JSON.stringify({ value: output_index }),
					},
				}),
			)
			.join("") +
		frame("response.completed", { response: { id: "r", status: "completed" } });
	const r = await run(s, false, true, false, { tools });
	expect(r.status).toBe(200);
	expect((await r.json()).choices[0].message.tool_calls).toEqual(
		[0, 1].map((i) => ({
			id: `c${i}`,
			type: "function",
			function: { name: "f", arguments: JSON.stringify({ value: i }) },
		})),
	);
});
it("bounds streamed Codex arguments before output_item.done", async () => {
	const tools = [
		{
			type: "function",
			function: { name: "f", parameters: { type: "object" } },
		},
	];
	const translatedTool = translateChatRequest({ ...body, tools }).body
		.tools?.[0];
	if (!translatedTool) throw new Error("expected a translated tool");
	const name = translatedTool.name;
	const s =
		frame("response.created", { response: { id: "r" } }) +
		frame("response.output_item.added", {
			output_index: 0,
			item: { type: "function_call", call_id: "c", name, arguments: "" },
		}) +
		[0, 1]
			.map(() =>
				frame("response.function_call_arguments.delta", {
					output_index: 0,
					delta: "x".repeat(600000),
				}),
			)
			.join("");
	const r = await run(s, false, true, false, { tools });
	expect(r.status).toBe(502);
	expect((await r.json()).error.message).toContain("Tool arguments exceeded");
});

it("rejects a successful terminal with an unfinished Codex call", async () => {
	const tools = [
		{
			type: "function",
			function: { name: "f", parameters: { type: "object" } },
		},
	];
	const translatedTool = translateChatRequest({ ...body, tools }).body
		.tools?.[0];
	if (!translatedTool) throw new Error("expected a translated tool");
	const name = translatedTool.name;
	const r = await run(
		frame("response.created", { response: { id: "r" } }) +
			frame("response.output_item.added", {
				output_index: 0,
				item: { type: "function_call", call_id: "c", name, arguments: "" },
			}) +
			frame("response.completed", {
				response: { id: "r", status: "completed" },
			}),
		false,
		true,
		false,
		{ tools },
	);
	expect(r.status).toBe(502);
});

it("rejects a Codex tool start without an output index", async () => {
	const tools = [
		{
			type: "function",
			function: { name: "f", parameters: { type: "object" } },
		},
	];
	const translatedTool = translateChatRequest({ ...body, tools }).body
		.tools?.[0];
	if (!translatedTool) throw new Error("expected a translated tool");
	const name = translatedTool.name;
	const r = await run(
		frame("response.created", { response: { id: "r" } }) +
			frame("response.output_item.added", {
				item: { type: "function_call", call_id: "c", name, arguments: "" },
			}) +
			frame("response.completed", {
				response: { id: "r", status: "completed" },
			}),
		false,
		true,
		false,
		{ tools },
	);
	expect(r.status).toBe(502);
});

it("preserves partial overlapping Codex calls on output-limit termination", async () => {
	const tools = [
		{
			type: "function",
			function: { name: "f", parameters: { type: "object" } },
		},
	];
	const translatedTool = translateChatRequest({ ...body, tools }).body
		.tools?.[0];
	if (!translatedTool) throw new Error("expected a translated tool");
	const name = translatedTool.name;
	const s =
		frame("response.created", { response: { id: "r" } }) +
		[0, 1]
			.map((output_index) =>
				frame("response.output_item.added", {
					output_index,
					item: {
						type: "function_call",
						call_id: `c${output_index}`,
						name,
						arguments: "",
					},
				}),
			)
			.join("") +
		[0, 1]
			.map((output_index) =>
				frame("response.function_call_arguments.delta", {
					output_index,
					delta: '{"value":',
				}),
			)
			.join("") +
		frame("response.incomplete", {
			response: {
				id: "r",
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
			},
		});
	const r = await run(s, false, true, false, { tools });
	expect(r.status).toBe(200);
	const b = await r.json();
	expect(b.choices[0].finish_reason).toBe("length");
	expect(
		b.choices[0].message.tool_calls.map(
			(x: { function: { arguments: string } }) => x.function.arguments,
		),
	).toEqual(['{"value":', '{"value":']);
});

describe("Chat structured output on Codex", () => {
	const schema = {
		type: "object",
		properties: {
			city: { type: "string" },
			forecast: {
				type: "object",
				properties: { high: { type: "number" } },
			},
		},
	};
	const responseFormat = (extra: object = {}) => ({
		response_format: {
			type: "json_schema",
			json_schema: { name: "weather", schema, ...extra },
		},
	});
	async function converted(chat: object | null) {
		const translated = translateChatRequest({
			...body,
			...(chat ?? responseFormat()),
		});
		const request = new Request(
			"https://chatgpt.com/backend-api/codex/responses",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(translated.body),
			},
		);
		if (chat)
			setChatContext(request, {
				requirements: translated.requirements,
				defaultMaxTokens: 8192,
				...(translated.structuredOutput
					? { structuredOutput: translated.structuredOutput }
					: {}),
			});
		return (await new CodexProvider().transformRequestBody(request)).json();
	}
	it("constrains the answer when the client asked for strict", async () => {
		const out = await converted(
			responseFormat({ strict: true, description: "Today's weather" }),
		);
		expect(out.text).toEqual({
			format: {
				type: "json_schema",
				name: "weather",
				description: "Today's weather",
				schema,
				strict: true,
			},
		});
		expect(out.output_config).toBeUndefined();
	});
	it("sends a non-strict schema as guidance", async () => {
		const out = await converted(responseFormat());
		expect(out.text).toEqual({
			format: { type: "json_schema", name: "weather", schema, strict: false },
		});
	});
	it("names and relaxes a schema that arrived without a Chat context", async () => {
		const out = await converted(null);
		expect(out.text).toEqual({
			format: { type: "json_schema", name: "response", schema, strict: false },
		});
	});
	it("sends no text format for a plain request", async () => {
		expect((await converted({})).text).toBeUndefined();
	});

	const answer = { city: "Zürich ☀", forecast: { high: 21.5, low: 0 } };
	const answerText = JSON.stringify(answer);
	const messageStart = frame("response.output_item.added", {
		output_index: 0,
		item: { type: "message", role: "assistant" },
	});
	const textPart =
		frame("response.content_part.added", {
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		}) +
		frame("response.output_text.delta", {
			delta: answerText.slice(0, 12),
		}) +
		frame("response.output_text.delta", { delta: answerText.slice(12) });
	const refusalPart =
		frame("response.content_part.added", {
			output_index: 0,
			content_index: 1,
			part: { type: "refusal", refusal: "" },
		}) +
		frame("response.refusal.delta", { delta: "I can't help with that." }) +
		frame("response.refusal.done", { refusal: "I can't help with that." }) +
		frame("response.content_part.done", {
			output_index: 0,
			content_index: 1,
			part: { type: "refusal", refusal: "I can't help with that." },
		});
	const completed = (status = "completed", reason?: string) =>
		frame("response.output_item.done", {
			output_index: 0,
			item: { type: "message", role: "assistant" },
		}) +
		frame(
			status === "completed" ? "response.completed" : "response.incomplete",
			{
				response: {
					id: "r",
					status,
					...(reason ? { incomplete_details: { reason } } : {}),
				},
			},
		);
	const stream = (parts: string, status?: string, reason?: string) =>
		frame("response.created", { response: { id: "r" } }) +
		messageStart +
		parts +
		completed(status, reason);
	const chunks = (text: string) =>
		text
			.split("\n")
			.filter((x) => x.startsWith("data: {"))
			.map((x) => JSON.parse(x.slice(6)));
	const streamed = (text: string) =>
		chunks(text)
			.map((c) => c.choices[0]?.delta?.content ?? "")
			.join("");
	const finish = (text: string) =>
		chunks(text).find((c) => c.choices[0]?.finish_reason)?.choices[0]
			.finish_reason;

	it("answers the JSON text as content without tool calls", async () => {
		const r = await run(stream(textPart), false, true, false, responseFormat());
		const choice = (await r.json()).choices[0];
		expect(JSON.parse(choice.message.content)).toEqual(answer);
		expect(choice.message.tool_calls).toBeUndefined();
		expect(choice.finish_reason).toBe("stop");
	});
	it("streams the JSON text as content deltas", async () => {
		const r = await run(stream(textPart), true, true, false, responseFormat());
		const text = await r.text();
		expect(JSON.parse(streamed(text))).toEqual(answer);
		expect(text).not.toContain("tool_calls");
		expect(finish(text)).toBe("stop");
		expect(text).toContain("[DONE]");
	});
	for (const streaming of [false, true])
		it(`reports a token-limit stop as length (stream=${streaming})`, async () => {
			const r = await run(
				stream(textPart, "incomplete", "max_output_tokens"),
				streaming,
				true,
				false,
				responseFormat(),
			);
			if (streaming) expect(finish(await r.text())).toBe("length");
			else expect((await r.json()).choices[0].finish_reason).toBe("length");
		});
	for (const [label, parts] of [
		["a refusal", refusalPart],
		["a refusal after partial JSON", textPart + refusalPart],
	] as const) {
		it(`answers ${label} as content_filter with no content`, async () => {
			const r = await run(stream(parts), false, true, false, responseFormat());
			const choice = (await r.json()).choices[0];
			expect(choice.finish_reason).toBe("content_filter");
			expect(choice.message.content).toBe("");
		});
		it(`streams ${label} as content_filter without the refusal text`, async () => {
			const r = await run(stream(parts), true, true, false, responseFormat());
			const text = await r.text();
			expect(finish(text)).toBe("content_filter");
			expect(text).not.toContain("can't help");
			// Text already sent before a late refusal cannot be retracted.
			expect(streamed(text)).toBe(parts === refusalPart ? "" : answerText);
		});
	}
});
