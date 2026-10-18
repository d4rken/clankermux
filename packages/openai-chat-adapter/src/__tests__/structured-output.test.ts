import { describe, expect, it } from "bun:test";
import { type ChatIngressContext, getChatContext } from "@clankermux/types";
import { ChatError } from "../errors";
import { handleChatCompletionsRequest } from "../handler";
import { translateChatRequest } from "../request";

const input = {
	model: "alias",
	messages: [{ role: "user", content: "hello" }],
};
const schema = {
	type: "object",
	properties: { city: { type: "string" } },
	required: ["city"],
	additionalProperties: false,
};
const jsonSchema = (extra: object = {}) => ({
	type: "json_schema",
	json_schema: { name: "weather", schema, ...extra },
});
const tool = {
	type: "function",
	function: { name: "f", parameters: { type: "object" } },
};

function rejection(patch: object): ChatError {
	try {
		translateChatRequest({ ...input, ...patch });
	} catch (e) {
		if (e instanceof ChatError) return e;
		throw e;
	}
	throw new Error("expected the request to be rejected");
}

describe("Chat response_format", () => {
	it("translates json_schema into output_config.format and keeps the rest in the context", () => {
		const translated = translateChatRequest({
			...input,
			response_format: jsonSchema({
				description: "The forecast",
				strict: true,
			}),
		});
		expect(translated.body.output_config).toEqual({
			format: { type: "json_schema", schema },
		});
		expect(translated.structuredOutput).toEqual({
			name: "weather",
			description: "The forecast",
			strict: true,
		});
		expect(translated.requirements.fields).toEqual(["response_format"]);
	});
	it("resolves an absent strict to false and leaves out an absent description", () => {
		const translated = translateChatRequest({
			...input,
			response_format: jsonSchema(),
		});
		expect(translated.structuredOutput).toEqual({
			name: "weather",
			strict: false,
		});
	});
	it("reads a null strict as false and a null description as none", () => {
		const translated = translateChatRequest({
			...input,
			response_format: jsonSchema({ strict: null, description: null }),
		});
		expect(translated.structuredOutput).toEqual({
			name: "weather",
			strict: false,
		});
	});
	it("keeps text as plain output with nothing recorded", () => {
		const translated = translateChatRequest({
			...input,
			response_format: { type: "text" },
		});
		expect(translated.body.output_config).toBeUndefined();
		expect(translated.structuredOutput).toBeUndefined();
		expect(translated.requirements.fields).toEqual([]);
	});
	it("accepts json_schema next to an empty tool list", () => {
		const translated = translateChatRequest({
			...input,
			tools: [],
			tool_choice: "none",
			response_format: jsonSchema(),
		});
		expect(translated.body.tools).toBeUndefined();
		expect(translated.body.output_config?.format.schema).toEqual(schema);
	});
	for (const [label, patch, param, code] of [
		[
			"json_object",
			{ response_format: { type: "json_object" } },
			"response_format",
			"unsupported_parameter",
		],
		[
			"an unknown type",
			{ response_format: { type: "grammar" } },
			"response_format",
			"unsupported_parameter",
		],
		[
			"json_schema with tools",
			{ tools: [tool], response_format: jsonSchema() },
			"response_format",
			"unsupported_parameter",
		],
		[
			"a missing json_schema object",
			{ response_format: { type: "json_schema" } },
			"response_format.json_schema",
			"invalid_request_error",
		],
		[
			"an unknown response_format key",
			{ response_format: { ...jsonSchema(), extra: 1 } },
			"response_format.extra",
			"unsupported_parameter",
		],
		[
			"an unknown json_schema key",
			{ response_format: jsonSchema({ extra: 1 }) },
			"response_format.json_schema.extra",
			"unsupported_parameter",
		],
		[
			"a missing name",
			{
				response_format: { type: "json_schema", json_schema: { schema } },
			},
			"response_format.json_schema.name",
			"invalid_request_error",
		],
		[
			"a name with a space",
			{ response_format: jsonSchema({ name: "two words" }) },
			"response_format.json_schema.name",
			"invalid_request_error",
		],
		[
			"a 65-character name",
			{ response_format: jsonSchema({ name: "n".repeat(65) }) },
			"response_format.json_schema.name",
			"invalid_request_error",
		],
		[
			"a missing schema",
			{
				response_format: {
					type: "json_schema",
					json_schema: { name: "weather" },
				},
			},
			"response_format.json_schema.schema",
			"invalid_request_error",
		],
		[
			"an array schema",
			{ response_format: jsonSchema({ schema: [] }) },
			"response_format.json_schema.schema",
			"invalid_request_error",
		],
		[
			"a string strict",
			{ response_format: jsonSchema({ strict: "true" }) },
			"response_format.json_schema.strict",
			"invalid_request_error",
		],
		[
			"a numeric description",
			{ response_format: jsonSchema({ description: 5 }) },
			"response_format.json_schema.description",
			"invalid_request_error",
		],
	] as const)
		it(`rejects ${label}`, () => {
			const error = rejection(patch);
			expect(error.status).toBe(400);
			expect(error.param).toBe(param);
			expect(error.code).toBe(code);
		});
	it("accepts a 64-character name of letters, digits, underscores and hyphens", () => {
		const name = `a-_0${"z".repeat(60)}`;
		expect(
			translateChatRequest({ ...input, response_format: jsonSchema({ name }) })
				.structuredOutput?.name,
		).toBe(name);
	});
});

const event = (type: string, extra: object = {}) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const textThenRefusal =
	event("message_start", { message: { model: "m", usage: {} } }) +
	event("content_block_start", {
		index: 0,
		content_block: { type: "text", text: "" },
	}) +
	event("content_block_delta", {
		index: 0,
		delta: { type: "text_delta", text: '{"city":' },
	}) +
	event("content_block_stop", { index: 0 }) +
	event("message_delta", { delta: { stop_reason: "refusal" } }) +
	event("message_stop");

async function run(body: object) {
	const calls: { ctx: ChatIngressContext; body: Record<string, unknown> }[] =
		[];
	const req = new Request("http://test/wire/openai/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify(body),
	});
	const res = await handleChatCompletionsRequest(
		req,
		new URL(req.url),
		async (synthetic) => {
			const ctx = getChatContext(synthetic);
			if (!ctx) throw new Error("Missing Chat context");
			calls.push({ ctx, body: await synthetic.clone().json() });
			return new Response(textThenRefusal, {
				headers: { "content-type": "text/event-stream" },
			});
		},
		{},
	);
	const [seen] = calls;
	if (!seen) throw new Error("the proxy was not called");
	return { res, seen };
}

describe("Chat structured output through the handler", () => {
	it("hands the proxy output_config.format and the context the name, description and strict", async () => {
		const { seen } = await run({
			...input,
			response_format: jsonSchema({ strict: true }),
		});
		expect(seen.body.output_config).toEqual({
			format: { type: "json_schema", schema },
		});
		expect(seen.ctx.structuredOutput).toEqual({
			name: "weather",
			strict: true,
		});
		expect(seen.ctx.requirements.fields).toEqual(["response_format"]);
	});
	it("leaves the context without structured output for a plain request", async () => {
		const { seen } = await run(input);
		expect(seen.ctx.structuredOutput).toBeUndefined();
		expect(seen.body.output_config).toBeUndefined();
	});
	it("discards the partial JSON of a refused structured answer", async () => {
		const { res } = await run({ ...input, response_format: jsonSchema() });
		const choice = (await res.json()).choices[0];
		expect(choice.finish_reason).toBe("content_filter");
		expect(choice.message.content).toBe("");
		expect(choice.message.tool_calls).toBeUndefined();
	});
	it("keeps the text of a refused plain answer", async () => {
		const { res } = await run(input);
		const choice = (await res.json()).choices[0];
		expect(choice.finish_reason).toBe("content_filter");
		expect(choice.message.content).toBe('{"city":');
	});
});
