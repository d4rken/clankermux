import { describe, expect, test } from "bun:test";
import { getNativeResponsesRequestContext } from "@clankermux/types";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";

const validMessage = { type: "message", role: "user", content: "keep me" };
const typelessMessage = { role: "user", content: "no type field" };
// Valid JSON that throws when implicitly coerced to text.
const coercionHostile = { toString: null, valueOf: null };
const functionTool = { type: "function", name: "read", parameters: {} };

async function runRequest(extra: Record<string, unknown>) {
	const body = { model: "test-model", input: [validMessage], ...extra };
	const forwarded: Record<string, unknown>[] = [];
	const nativeBodies: unknown[] = [];
	const proxy: HandleProxyFn = async (req) => {
		forwarded.push(await req.json());
		const context = getNativeResponsesRequestContext(req);
		if (!context) throw new Error("Expected native Responses context");
		nativeBodies.push(JSON.parse(context.nativeBody));
		return Response.json({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "test-model",
			content: [{ type: "text", text: "Hello" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		});
	};
	const req = new Request("http://localhost/v1/responses", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const response = await handleResponsesRequest(
		req,
		new URL(req.url),
		proxy,
		{},
	);
	return {
		status: response.status,
		json: await response.json(),
		forwarded,
		nativeBodies,
		body: JSON.parse(JSON.stringify(body)),
	};
}

async function expectRejected(extra: Record<string, unknown>) {
	const result = await runRequest(extra);
	expect(result.status).toBe(400);
	expect(result.json.error.type).toBe("invalid_request_error");
	expect(result.forwarded).toHaveLength(0);
	expect(result.nativeBodies).toHaveLength(0);
}

// Malformed conversations must be rejected, not partially dispatched.
describe("Responses malformed conversations", () => {
	for (const [label, item] of [
		["null", null],
		["number", 7],
		["boolean", false],
		["string", "junk"],
		["array", []],
		["missing content", { type: "message", role: "user" }],
		["numeric content", { type: "message", role: "user", content: 7 }],
		["object content", { type: "message", role: "user", content: {} }],
	] as const) {
		test(`rejects ${label} without dispatching a partial conversation`, async () => {
			await expectRejected({ input: [item, validMessage] });
		});
	}

	test("rejects an entirely malformed conversation", async () => {
		await expectRejected({ input: [null, { type: "message" }] });
	});

	test("rejects a null message content part", async () => {
		await expectRejected({
			input: [
				{ role: "user", content: [null, { type: "input_text", text: "hi" }] },
			],
		});
	});

	test("rejects a null part inside a tool result", async () => {
		await expectRejected({
			input: [
				{ type: "function_call_output", call_id: "call_1", output: [null] },
			],
		});
	});

	test("preserves typeless messages alongside explicit messages", async () => {
		const result = await runRequest({
			input: [
				typelessMessage,
				{ type: "message", role: "assistant", content: "reply" },
			],
		});
		expect(result.status).toBe(200);
		expect(result.forwarded).toHaveLength(1);
		expect(result.forwarded[0].messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "no type field" }] },
			{ role: "assistant", content: [{ type: "text", text: "reply" }] },
		]);
		expect(result.nativeBodies).toEqual([result.body]);
	});

	test("preserves additional_tools and unknown items in native passthrough", async () => {
		const result = await runRequest({
			input: [
				validMessage,
				{ type: "future_item" },
				{ type: "additional_tools", tools: [functionTool] },
			],
		});
		expect(result.status).toBe(200);
		expect(result.forwarded).toHaveLength(1);
		expect(result.forwarded[0].messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "keep me" }] },
		]);
		expect(result.forwarded[0].tools).toEqual([
			{ name: "read", input_schema: {} },
		]);
		expect(result.nativeBodies).toEqual([result.body]);
	});
});

describe("Responses malformed tool declarations", () => {
	for (const [label, extra] of [
		["null tool", { tools: [null] }],
		["missing namespace tools", { tools: [{ type: "namespace", name: "ns" }] }],
		[
			"null namespace tool",
			{ tools: [{ type: "namespace", name: "ns", tools: [null] }] },
		],
		[
			"null additional tool",
			{ input: [validMessage, { type: "additional_tools", tools: [null] }] },
		],
		["null tool choice", { tools: [functionTool], tool_choice: null }],
	] as const) {
		test(`rejects ${label} before proxy dispatch`, async () => {
			await expectRejected(extra);
		});
	}
});

// Some unfamiliar fields can be carried by native passthrough. These cases
// pin the no-500 guarantee without requiring lossy
// sanitization or treating every unknown extension as an invalid conversation.
describe("Responses adversarial JSON never escapes as a server error", () => {
	const cases: [string, Record<string, unknown>][] = [];
	for (const [label, type] of [
		["null", null],
		["number", 7],
		["boolean", false],
		["array", []],
		["object", {}],
		["coercion-hostile object", coercionHostile],
		["coercion-hostile array", [coercionHostile]],
	] as const) {
		cases.push([`${label} item type`, { input: [{ type }, validMessage] }]);
	}
	for (const [label, output] of [
		["missing", undefined],
		["number", 7],
		["object", {}],
	] as const) {
		cases.push([
			`${label} tool output`,
			{
				input: [
					{ type: "function_call_output", call_id: "call_1", output },
					validMessage,
				],
			},
		]);
	}
	for (const [label, tool] of [
		["number", 7],
		["array", []],
	] as const) {
		cases.push([`${label} tool declaration`, { tools: [tool] }]);
		cases.push([
			`${label} namespace tool`,
			{ tools: [{ type: "namespace", name: "ns", tools: [tool] }] },
		]);
	}
	cases.push(
		[
			"content part type",
			{
				input: [
					{ role: "user", content: [{ type: coercionHostile }] },
					validMessage,
				],
			},
		],
		[
			"content part text",
			{
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: coercionHostile }],
					},
					validMessage,
				],
			},
		],
		[
			"developer text",
			{
				input: [
					{
						role: "developer",
						content: [{ type: "input_text", text: coercionHostile }],
					},
					validMessage,
				],
			},
		],
		[
			"content refusal",
			{
				input: [
					{
						role: "assistant",
						content: [{ type: "refusal", refusal: coercionHostile }],
					},
					validMessage,
				],
			},
		],
		["tool type", { tools: [{ type: coercionHostile }] }],
		[
			"custom tool description",
			{ tools: [{ type: "custom", name: "n", description: coercionHostile }] },
		],
		[
			"namespaced function description",
			{
				tools: [
					{
						type: "function",
						name: "n",
						namespace: "ns",
						description: coercionHostile,
					},
				],
			},
		],
		[
			"namespace description",
			{
				tools: [
					{
						type: "namespace",
						name: "ns",
						description: coercionHostile,
						tools: [functionTool],
					},
				],
			},
		],
		[
			"namespace name",
			{
				tools: [
					{ type: "namespace", name: coercionHostile, tools: [functionTool] },
				],
			},
		],
		[
			"grammar syntax",
			{
				tools: [
					{
						type: "custom",
						name: "n",
						format: {
							type: "grammar",
							syntax: coercionHostile,
							definition: "x",
						},
					},
				],
			},
		],
		[
			"grammar definition",
			{
				tools: [
					{
						type: "custom",
						name: "n",
						format: {
							type: "grammar",
							syntax: "lark",
							definition: coercionHostile,
						},
					},
				],
			},
		],
		["instructions", { instructions: coercionHostile }],
		[
			"tool_choice name",
			{
				tools: [functionTool],
				tool_choice: { type: "function", name: coercionHostile },
			},
		],
		[
			"namespaced tool call name",
			{
				input: [
					{
						type: "function_call",
						call_id: "c",
						name: coercionHostile,
						namespace: "ns",
						arguments: "{}",
					},
					validMessage,
				],
			},
		],
		[
			"numeric namespaced tool call name",
			{
				input: [
					{
						type: "function_call",
						call_id: "c",
						name: 7,
						namespace: "ns",
						arguments: "{}",
					},
					validMessage,
				],
			},
		],
	);

	for (const [label, extra] of cases) {
		test(label, async () => {
			const result = await runRequest(extra);
			expect([200, 400]).toContain(result.status);
			if (result.status === 400) {
				expect(result.json.error.type).toBe("invalid_request_error");
				expect(result.forwarded).toHaveLength(0);
				expect(result.nativeBodies).toHaveLength(0);
			} else {
				expect(result.forwarded).toHaveLength(1);
				expect(result.nativeBodies).toEqual([result.body]);
				expect(result.json.output[0].content[0].text).toBe("Hello");
			}
		});
	}
});
