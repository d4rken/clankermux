import { describe, expect, test } from "bun:test";
import { translateRequestToAnthropic } from "../request-translator";
import { translateAnthropicResponseToResponses } from "../response-translator";
import { translateAnthropicStreamToResponses } from "../stream-translator";
import { createToolTranslation } from "../tool-translation";
import type { ResponseItem, ResponsesRequest } from "../types";

const request = (): ResponsesRequest & { input: ResponseItem[] } => ({
	model: "alias",
	tools: [{ type: "function", name: "exec", parameters: { type: "object" } }],
	input: [
		{
			type: "additional_tools",
			role: "developer",
			tools: [
				{
					type: "namespace",
					name: "functions",
					description: "Execution",
					tools: [
						{
							type: "custom",
							name: "exec",
							description: "Run code",
							format: {
								type: "grammar",
								syntax: "lark",
								definition: "start: /[\\s\\S]+/",
							},
						},
						{ type: "function", name: "wait", parameters: { type: "object" } },
					],
				},
			],
		},
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Read fixture" }],
		},
	],
});
describe("modern Responses tools", () => {
	test("collects conversation tools and separates colliding names", () => {
		const req = request(),
			ctx = createToolTranslation(req),
			body = translateRequestToAnthropic(req, ctx);
		expect(body.tools).toHaveLength(3);
		expect(new Set(body.tools?.map((t) => t.name)).size).toBe(3);
		expect(body.tools?.[1].input_schema).toEqual({
			type: "object",
			properties: { input: { type: "string" } },
			required: ["input"],
			additionalProperties: false,
		});
		expect(body.tools?.[1].description).toContain("lark");
		expect(ctx.identity(body.tools?.[1].name)).toEqual({
			type: "custom",
			namespace: "functions",
			name: "exec",
		});
	});
	test("translates raw custom history and forced namespaced choice consistently", () => {
		const req = request();
		req.input.push({
			type: "custom_tool_call",
			namespace: "functions",
			name: "exec",
			call_id: "call",
			input: 'text("hi")',
		});
		req.tool_choice = { type: "custom", namespace: "functions", name: "exec" };
		const ctx = createToolTranslation(req),
			body = translateRequestToAnthropic(req, ctx),
			name = body.tools?.[1].name;
		expect(body.messages[1].content[0]).toEqual({
			type: "tool_use",
			id: "call",
			name,
			input: { input: 'text("hi")' },
		});
		expect(body.tool_choice).toEqual({ type: "tool", name });
	});
	test("restores custom output and actual model in nonstream responses", () => {
		const req = request(),
			ctx = createToolTranslation(req),
			body = translateRequestToAnthropic(req, ctx);
		const result = translateAnthropicResponseToResponses(
			{
				id: "m",
				type: "message",
				role: "assistant",
				model: "deepseek/actual",
				content: [
					{
						type: "tool_use",
						id: "call",
						name: body.tools?.[1].name,
						input: { input: 'text("hi")' },
					},
				],
				stop_reason: "tool_use",
				stop_sequence: null,
				usage: { input_tokens: 2, output_tokens: 3 },
			},
			"resp",
			"alias",
			ctx,
		);
		expect(result.model).toBe("deepseek/actual");
		expect(result.output[0]).toMatchObject({
			type: "custom_tool_call",
			namespace: "functions",
			name: "exec",
			input: 'text("hi")',
			call_id: "call",
		});
		expect(result.output[0]).not.toHaveProperty("arguments");
	});
	test.each([
		"custom",
		"function",
	])("restores %s namespace in added/done/completed SSE", async (type) => {
		const req = request(),
			ctx = createToolTranslation(req),
			body = translateRequestToAnthropic(req, ctx),
			name = body.tools?.[type === "custom" ? 1 : 2].name;
		const args =
			type === "custom" ? { input: 'text("héllo")' } : { cell_id: "1" };
		const events = [
			{
				type: "message_start",
				message: { model: "deepseek/actual", usage: { input_tokens: 2 } },
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call", name, input: {} },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		];
		const upstream = new Response(
			events
				.map((x) => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`)
				.join(""),
		);
		const translated = translateAnthropicStreamToResponses(
			upstream,
			"resp",
			"alias",
			ctx,
		);
		const out = (await translated.text())
			.split("\n")
			.filter((x) => x.startsWith("data: "))
			.map((x) => JSON.parse(x.slice(6)));
		for (const e of out.filter(
			(x) =>
				x.type === "response.output_item.added" ||
				x.type === "response.output_item.done",
		))
			expect(e.item).toMatchObject({
				type: type === "custom" ? "custom_tool_call" : "function_call",
				namespace: "functions",
				name: type === "custom" ? "exec" : "wait",
			});
		const completed = out.find((x) => x.type === "response.completed");
		expect(completed.response.model).toBe("deepseek/actual");
		if (type === "custom") {
			expect(
				out.some((x) => x.type.startsWith("response.function_call_arguments")),
			).toBe(false);
			expect(
				out.find((x) => x.type === "response.custom_tool_call_input.delta")
					.delta,
			).toBe(args.input);
			expect(completed.response.output[0].input).toBe(args.input);
		}
	});
});

describe("tool translation identity and invalid output", () => {
	test("identity survives reordered declarations and history-only resume", () => {
		const req = request(),
			first = createToolTranslation(req),
			name = first.tools[1].name;
		const history: ResponseItem = {
			type: "custom_tool_call",
			call_id: "c",
			name: "exec",
			namespace: "functions",
			input: "text(1)",
		};
		const resumed = createToolTranslation({ model: "alias", input: [history] });
		expect(resumed.identity(name)).toEqual(first.identity(name));
		const reordered = request();
		reordered.input.reverse();
		expect(createToolTranslation(reordered).identity(name)).toEqual(
			first.identity(name),
		);
	});
	test("reserved names and long names are distinct and provider-valid", () => {
		const ctx = createToolTranslation({
			model: "alias",
			input: [],
			tools: [
				{ type: "function", name: "cmux_tool_real" },
				{
					type: "namespace",
					name: "n".repeat(64),
					tools: [{ type: "function", name: "r".repeat(64) }],
				},
			],
		});
		expect(new Set(ctx.tools.map((t) => t.name)).size).toBe(2);
		for (const t of ctx.tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
	});
	test.each([
		'{"input":42}',
		'{"other":"code"}',
		"not json",
	])("malformed custom output fails SSE without completing: %s", async (args) => {
		const req = request(),
			ctx = createToolTranslation(req),
			name = ctx.tools[1].name;
		const events = [
			{ type: "message_start", message: { usage: { input_tokens: 1 } } },
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "c", name, input: {} },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: args },
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "message_stop" },
		];
		const upstream = new Response(
			events
				.map((x) => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`)
				.join(""),
		);
		const out = await translateAnthropicStreamToResponses(
			upstream,
			"resp",
			"alias",
			ctx,
		).text();
		expect(out).toContain("event: response.failed");
		expect(out).not.toContain("event: response.completed");
		expect(out).not.toContain("event: response.custom_tool_call_input.delta");
	});
});

test("nested namespaces fail explicitly instead of losing their parent", () => {
	expect(() =>
		createToolTranslation({
			model: "alias",
			input: [],
			tools: [
				{
					type: "namespace",
					name: "outer",
					tools: [
						{
							type: "namespace",
							name: "inner",
							tools: [{ type: "function", name: "run" }],
						},
					],
				},
			],
		}),
	).toThrow("Nested tool namespaces are not supported");
});
