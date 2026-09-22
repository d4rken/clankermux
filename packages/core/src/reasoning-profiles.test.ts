import { expect, it } from "bun:test";
import {
	ALIAS_ADVERTISED_EFFORTS,
	aliasEffortReachesProvider,
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
		"openai-compatible",
		"qwen",
		"kilo",
		"anthropic",
		"claude-console-api",
		"zai",
		"devin",
	])
		expect(aliasEffortReachesProvider(provider)).toBe(true);
	for (const provider of [
		"openrouter",
		"ollama",
		"minimax",
		"mimo",
		"grok-subscription",
		"anthropic-compatible",
	])
		expect(aliasEffortReachesProvider(provider)).toBe(false);
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
