import { expect, it } from "bun:test";
import { oneMillionContextBase } from "./sdk-bridge-transport";

it("names the bare id of a measured 1M-context id, and nothing else", () => {
	expect(oneMillionContextBase("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
	expect(oneMillionContextBase("claude-fable-5-1[1m]")).toBe(
		"claude-fable-5-1",
	);
	expect(oneMillionContextBase("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");
	for (const model of [
		"claude-opus-5-5",
		"claude-opus-5-5[1M]",
		"claude-opus-5-5 [1m]",
		"claude-haiku-4-5[1m]",
		"claude-opus-5[1m]",
		"anthropic/claude-opus-5-5[1m]",
	])
		expect(oneMillionContextBase(model)).toBeNull();
});
