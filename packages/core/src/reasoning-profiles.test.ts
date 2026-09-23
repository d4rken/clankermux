import { expect, it } from "bun:test";
import {
	ALIAS_ADVERTISED_EFFORTS,
	aliasEffortClampsToClaudeFamily,
	aliasEffortReachesProvider,
	clampEffortToModel,
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
	for (const model of ["gpt-6-sol", "gpt-6-luna"])
		expect(getAliasReasoningEfforts(model, "codex")).toEqual([
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
it("profiles GPT-5.6 with what the backend accepts, not the catalogue's max", () => {
	// The 5.x backend rejects `max` (backend-params.ts), so the published list
	// stops where the request path clamps.
	for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
		expect(getAliasReasoningEfforts(model, "codex")).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
});
it("advertises one fixed range for every alias", () => {
	expect([...ALIAS_ADVERTISED_EFFORTS]).toEqual([
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});
it("forwards an alias effort only to providers that handle it", () => {
	for (const provider of [
		"codex",
		"anthropic",
		"claude-console-api",
		"zai",
		"devin",
	])
		expect(aliasEffortReachesProvider(provider)).toBe(true);
	// Their converter reads only `reasoning.effort`, so an alias request's
	// `output_config.effort` would be dropped without a word.
	for (const provider of [
		"openai-compatible",
		"qwen",
		"kilo",
		"openrouter",
		"ollama",
		"minimax",
		"mimo",
		"grok-subscription",
		"anthropic-compatible",
	])
		expect(aliasEffortReachesProvider(provider)).toBe(false);
});
it("clamps an alias effort to the Claude family only on Claude providers", () => {
	for (const provider of ["anthropic", "claude-console-api"])
		expect(aliasEffortClampsToClaudeFamily(provider)).toBe(true);
	for (const provider of ["anthropic-compatible", "zai", "codex", "devin"])
		expect(aliasEffortClampsToClaudeFamily(provider)).toBe(false);
});
it("clamps an effort to the nearest level the model accepts at or below it", () => {
	expect(clampEffortToModel("claude-haiku-4-5", "high")).toBe("medium");
	expect(clampEffortToModel("claude-haiku-4-5", "max")).toBe("medium");
	expect(clampEffortToModel("claude-haiku-4-5", "low")).toBe("low");
	expect(clampEffortToModel("claude-opus-4-8", "max")).toBe("max");
	// Below the lowest listed level: the lowest one.
	expect(clampEffortToModel("claude-opus-4-8", "minimal")).toBe("low");
	// Unknown model or a value outside the vocabulary: unchanged.
	expect(clampEffortToModel("primary-model", "max")).toBe("max");
	expect(clampEffortToModel("claude-haiku-4-5", "ultra")).toBe("ultra");
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
