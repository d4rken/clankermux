import { describe, expect, it } from "bun:test";
import {
	anthropicServerToolType,
	isAnthropicServerTool,
	quotedToolType,
} from "../anthropic-tools";

describe("anthropicServerToolType", () => {
	it("names the first Anthropic-defined tool among custom ones", () => {
		expect(
			anthropicServerToolType({
				tools: [
					{ name: "Read", input_schema: {} },
					{ type: "bash_20250124", name: "bash" },
					{ type: "web_search_20250305", name: "web_search" },
				],
			}),
		).toBe("bash_20250124");
	});

	it("is null for custom tools only, no tools, or no body", () => {
		expect(
			anthropicServerToolType({ tools: [{ type: "custom", name: "Read" }] }),
		).toBeNull();
		expect(anthropicServerToolType({ messages: [] })).toBeNull();
		expect(anthropicServerToolType(null)).toBeNull();
	});
});

describe("quotedToolType", () => {
	it("quotes, escapes and bounds the value", () => {
		expect(quotedToolType("web_search_20250305")).toBe('"web_search_20250305"');
		expect(quotedToolType("a\nb")).toBe('"a\\nb"');
		expect(quotedToolType("x".repeat(100))).toBe(`"${"x".repeat(64)}"`);
	});
});

describe("isAnthropicServerTool", () => {
	for (const [label, tool] of [
		["an untyped tool", { name: "Read", input_schema: {} }],
		["a tool typed custom", { type: "custom", name: "Read", input_schema: {} }],
		["a tool typed null", { type: null, name: "Read", input_schema: {} }],
		["null", null],
		["an array", [{ type: "web_search_20250305" }]],
		["a string", "web_search_20250305"],
	] as const)
		it(`is false for ${label}`, () => {
			expect(isAnthropicServerTool(tool)).toBe(false);
		});

	for (const [label, tool] of [
		["web search", { type: "web_search_20250305", name: "web_search" }],
		["bash", { type: "bash_20250124", name: "bash" }],
		["an empty type", { type: "", name: "x" }],
		["a numeric type", { type: 5, name: "x" }],
	] as const)
		it(`is true for ${label}`, () => {
			expect(isAnthropicServerTool(tool)).toBe(true);
		});
});
