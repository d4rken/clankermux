/**
 * Tests for the pure context-composition walk: per-bucket character counts
 * (system / tool definitions / messages / tool results) computed from the
 * already-parsed /v1/messages body. The walk must never throw — malformed
 * shapes contribute 0 — and a shapeless body (no messages array) yields null
 * (the NULL-column coverage marker).
 */
import { describe, expect, it } from "bun:test";
import { computeContextComposition } from "../context-composition";
import type { RequestJsonBody } from "../request-body-context";

function jsonLen(value: unknown): number {
	return JSON.stringify(value).length;
}

describe("computeContextComposition", () => {
	it("returns null for a null body", () => {
		expect(computeContextComposition(null)).toBeNull();
	});

	it("returns null for shapeless bodies without a messages array", () => {
		expect(computeContextComposition({})).toBeNull();
		expect(computeContextComposition({ messages: "nope" })).toBeNull();
		expect(
			computeContextComposition({ messages: { role: "user" } }),
		).toBeNull();
		expect(computeContextComposition({ model: "claude-opus-4-8" })).toBeNull();
	});

	it("counts a string system prompt by length", () => {
		const result = computeContextComposition({
			system: "You are a helpful assistant.",
			messages: [],
		});
		expect(result).not.toBeNull();
		expect(result?.systemChars).toBe("You are a helpful assistant.".length);
	});

	it("counts a block-array system prompt by summed text lengths, skipping non-text entries", () => {
		const result = computeContextComposition({
			system: [
				{ type: "text", text: "alpha" },
				{ type: "text", text: "beta!" },
				{ type: "image", source: { data: "xxxx" } }, // non-text → 0
				null, // malformed → 0
				{ type: "text", text: 42 }, // non-string text → 0
			],
			messages: [],
		});
		expect(result?.systemChars).toBe("alpha".length + "beta!".length);
	});

	it("reports zero systemChars when system is absent or malformed", () => {
		expect(computeContextComposition({ messages: [] })?.systemChars).toBe(0);
		expect(
			computeContextComposition({ system: 42, messages: [] })?.systemChars,
		).toBe(0);
	});

	it("measures tools as JSON.stringify length with toolCount", () => {
		const tools = [
			{ name: "read_file", input_schema: { type: "object" } },
			{ name: "bash", input_schema: { type: "object" } },
		];
		const result = computeContextComposition({ tools, messages: [] });
		expect(result?.toolsChars).toBe(jsonLen(tools));
		expect(result?.toolCount).toBe(2);
	});

	it("reports 0 (not null) for absent tools", () => {
		const result = computeContextComposition({ messages: [] });
		expect(result?.toolsChars).toBe(0);
		expect(result?.toolCount).toBe(0);
	});

	it("reports 0 for non-array tools", () => {
		const result = computeContextComposition({
			tools: { name: "weird" },
			messages: [],
		});
		expect(result?.toolsChars).toBe(0);
		expect(result?.toolCount).toBe(0);
	});

	it("counts string message content and text blocks via .text.length", () => {
		const result = computeContextComposition({
			messages: [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "hi there" },
						{ type: "text", text: "!" },
					],
				},
			],
		});
		expect(result?.messagesChars).toBe(
			"hello".length + "hi there".length + "!".length,
		);
		expect(result?.messageCount).toBe(2);
		expect(result?.toolResultChars).toBe(0);
		expect(result?.largestToolResultChars).toBe(0);
		expect(result?.largestToolName).toBeNull();
	});

	it("attributes tool_result blocks via tool_use_id and tracks the largest", () => {
		const toolUseSmall = {
			type: "tool_use",
			id: "tu_1",
			name: "small_tool",
			input: { q: 1 },
		};
		const toolUseBig = {
			type: "tool_use",
			id: "tu_2",
			name: "big_tool",
			input: { q: 2 },
		};
		const resultSmall = {
			type: "tool_result",
			tool_use_id: "tu_1",
			content: "ok",
		};
		const resultBig = {
			type: "tool_result",
			tool_use_id: "tu_2",
			content: "x".repeat(500),
		};
		const result = computeContextComposition({
			messages: [
				{ role: "assistant", content: [toolUseSmall, toolUseBig] },
				{ role: "user", content: [resultSmall, resultBig] },
			],
		});
		const expectedToolResultChars = jsonLen(resultSmall) + jsonLen(resultBig);
		expect(result?.toolResultChars).toBe(expectedToolResultChars);
		expect(result?.largestToolResultChars).toBe(jsonLen(resultBig));
		expect(result?.largestToolName).toBe("big_tool");
		// tool_use + tool_result blocks all count into messagesChars too.
		expect(result?.messagesChars).toBe(
			jsonLen(toolUseSmall) + jsonLen(toolUseBig) + expectedToolResultChars,
		);
	});

	it("handles tool_result with array content (whole block stringified)", () => {
		const toolResult = {
			type: "tool_result",
			tool_use_id: "tu_arr",
			content: [
				{ type: "text", text: "line one" },
				{ type: "text", text: "line two" },
			],
		};
		const result = computeContextComposition({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "tu_arr", name: "list_tool", input: {} },
					],
				},
				{ role: "user", content: [toolResult] },
			],
		});
		expect(result?.toolResultChars).toBe(jsonLen(toolResult));
		expect(result?.largestToolResultChars).toBe(jsonLen(toolResult));
		expect(result?.largestToolName).toBe("list_tool");
	});

	it("resolves largestToolName to null for an unknown tool_use_id", () => {
		const orphan = {
			type: "tool_result",
			tool_use_id: "tu_missing",
			content: "orphaned",
		};
		const result = computeContextComposition({
			messages: [{ role: "user", content: [orphan] }],
		});
		expect(result?.largestToolResultChars).toBe(jsonLen(orphan));
		expect(result?.largestToolName).toBeNull();
	});

	it("counts non-text content blocks via JSON.stringify length", () => {
		const imageBlock = {
			type: "image",
			source: { type: "base64", data: "aGVsbG8=" },
		};
		const result = computeContextComposition({
			messages: [{ role: "user", content: [imageBlock] }],
		});
		expect(result?.messagesChars).toBe(jsonLen(imageBlock));
	});

	it("lets weird blocks and malformed messages contribute 0 without throwing", () => {
		const result = computeContextComposition({
			messages: [
				null,
				42,
				"just a string",
				{ role: "user" }, // no content
				{ role: "user", content: 7 }, // non-string/array content
				{ role: "user", content: [null, 42, "str", { type: "text" }] },
			],
		});
		expect(result).not.toBeNull();
		// { type: "text" } has no string text → falls to JSON.stringify length.
		expect(result?.messagesChars).toBe(jsonLen({ type: "text" }));
		expect(result?.messageCount).toBe(6);
		expect(result?.toolResultChars).toBe(0);
	});

	it("never throws on unstringifiable blocks (circular references)", () => {
		const circular: Record<string, unknown> = { type: "tool_result" };
		circular.self = circular;
		const body: RequestJsonBody = {
			messages: [{ role: "user", content: [circular] }],
		};
		expect(() => computeContextComposition(body)).not.toThrow();
		const result = computeContextComposition(body);
		expect(result?.messagesChars).toBe(0);
		expect(result?.toolResultChars).toBe(0);
	});

	it("returns all-zero composition for an empty messages array", () => {
		const result = computeContextComposition({ messages: [] });
		expect(result).toEqual({
			systemChars: 0,
			toolsChars: 0,
			toolCount: 0,
			messagesChars: 0,
			messageCount: 0,
			toolResultChars: 0,
			largestToolResultChars: 0,
			largestToolName: null,
		});
	});
});
