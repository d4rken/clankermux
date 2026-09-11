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
			return new CodexProvider().processResponse(response);
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
		const r = await new CodexProvider().processResponse(raw);
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
	const name = translateChatRequest({ ...body, tools }).body.tools[0].name;
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
	const name = translateChatRequest({ ...body, tools }).body.tools[0].name;
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
	const name = translateChatRequest({ ...body, tools }).body.tools[0].name;
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
	const name = translateChatRequest({ ...body, tools }).body.tools[0].name;
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
	const name = translateChatRequest({ ...body, tools }).body.tools[0].name;
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
