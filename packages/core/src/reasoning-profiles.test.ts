import { expect, it } from "bun:test";
import {
	getAliasReasoningEfforts,
	resolveTargetReasoningProfile,
} from "./reasoning-profiles";

it("requires matching adapter and model families", () => {
	expect(getAliasReasoningEfforts("gpt-6-astra", "codex")).toEqual([
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	expect(getAliasReasoningEfforts("gpt-5.4-mini", "openai-compatible")).toEqual(
		["low", "medium"],
	);
	expect(getAliasReasoningEfforts("claude-haiku-4-5", "anthropic")).toBeNull();
	for (const provider of ["unknown", "qwen", "zai", "ollama", "anthropic"])
		expect(getAliasReasoningEfforts("gpt-6-astra", provider)).toBeNull();
	expect(getAliasReasoningEfforts("mystery", "codex")).toBeNull();
	expect(resolveTargetReasoningProfile("gpt-6-astra", "unknown").status).toBe(
		"unknown",
	);
});
it("retains the original verified GPT-5.5 profile", () => {
	expect(getAliasReasoningEfforts("gpt-5.5", "codex")).toEqual([
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	]);
	expect(getAliasReasoningEfforts("gpt-5.5-future", "codex")).toBeNull();
});
it("preserves narrow profiles on dated variants", () => {
	expect(getAliasReasoningEfforts("gpt-5.4-mini-2026-09-01", "codex")).toEqual([
		"low",
		"medium",
	]);
});
