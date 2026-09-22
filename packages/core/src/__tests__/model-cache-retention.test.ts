import { describe, expect, it } from "bun:test";
import { type ClientFormat, PROVIDER_NAMES } from "@clankermux/types";
import {
	reduceModelCacheRetentions,
	resolveModelCacheRetention,
} from "../model-cache-retention";

function retention(
	provider: string,
	model: string,
	customEndpoint?: string,
	format: ClientFormat = "anthropic",
) {
	return resolveModelCacheRetention(model, [
		{ provider, customEndpoint, format },
	]);
}

describe("advisory model cache retention", () => {
	it("reduces estimates across fallback models and missing candidates", () => {
		const astra = retention("codex", "gpt-6-astra");
		const backup = retention("openai-compatible", "fast-backup");
		expect(reduceModelCacheRetentions([astra])).toEqual(astra);
		expect(reduceModelCacheRetentions([astra, astra])).toEqual(astra);
		for (const candidates of [
			[],
			[undefined],
			[astra, undefined],
			[astra, backup],
		]) {
			expect(reduceModelCacheRetentions(candidates)).toMatchObject({
				basis: "heuristic",
				retentionMs: 300_000,
				confidence: "low",
			});
		}
		expect(reduceModelCacheRetentions([astra, backup])).toEqual(
			reduceModelCacheRetentions([backup, astra]),
		);
	});
	it("gives every provider and unknown model an explicitly unsourced heuristic", () => {
		for (const provider of [
			...Object.values(PROVIDER_NAMES),
			"future-provider",
		]) {
			expect(retention(provider, "unrecognized-model")).toMatchObject({
				basis: "heuristic",
				retentionMs: 300_000,
				semantics: "heuristic",
				confidence: "low",
				anchorBasis: "assumed",
				refreshBasis: "assumed",
				sources: [],
			});
		}
	});
	it("provides Codex Astra a labelled API inference through every discovery dialect", () => {
		for (const format of ["anthropic", "openai", "codex"] as const) {
			for (const model of [
				"gpt-6-astra",
				"gpt-6-astra-2026-09-03",
				"gpt-6-sol",
				"gpt-6-luna-2026-09-22",
				"gpt-5.6-sol",
			]) {
				const estimate = retention("codex", model, undefined, format);
				expect(estimate).toMatchObject({
					basis: "inferred",
					retentionMs: 1_800_000,
					semantics: "minimum",
					confidence: "low",
					anchorBasis: "assumed",
					refreshBasis: "assumed",
				});
				expect(estimate.note).toContain("subscription");
				expect(estimate.sources[0].url).toBe(
					"https://developers.openai.com/api/docs/guides/prompt-caching",
				);
			}
		}
	});
	it("distinguishes direct API minimum and documented Anthropic request anchor", () => {
		expect(retention("openai-compatible", "gpt-6-astra")).toMatchObject({
			basis: "documented",
			retentionMs: 1_800_000,
			semantics: "minimum",
			anchorBasis: "assumed",
			refreshBasis: "documented",
		});
		expect(retention("anthropic", "claude-sonnet-4")).toMatchObject({
			basis: "documented",
			retentionMs: 300_000,
			anchor: "request_start",
			anchorBasis: "documented",
			refreshBasis: "documented",
		});
	});
	it("keeps typical earlier OpenAI retention separate from guaranteed policy", () => {
		expect(retention("openai-compatible", "gpt-5.5")).toMatchObject({
			basis: "documented",
			semantics: "typical",
			retentionMs: 300_000,
			typicalRangeMs: [300_000, 600_000],
			confidence: "medium",
		});
		expect(retention("codex", "gpt-5.5")).toMatchObject({
			basis: "inferred",
			retentionMs: 300_000,
			confidence: "low",
		});
	});
	it("does not label an older direct API model through Codex as a subscription", () => {
		const value = retention(
			"codex",
			"gpt-5.5",
			"https://api.openai.com/v1/responses",
		);
		expect(value).toMatchObject({
			basis: "documented",
			retentionMs: 300_000,
			semantics: "typical",
			refreshBasis: "documented",
		});
		expect(value.note).not.toContain("subscription");
	});

	it("uses verified explicit defaults and ignores inert endpoint overrides on fixed providers", () => {
		expect(retention("minimax", "MiniMax-M2")).toMatchObject({
			basis: "documented",
			retentionMs: 300_000,
			anchorBasis: "assumed",
		});
		expect(
			retention(
				"openai-compatible",
				"qwen3-coder-plus",
				"https://dashscope.aliyuncs.com/compatible-mode/v1",
			),
		).toMatchObject({ basis: "documented", retentionMs: 300_000 });
		expect(retention("openrouter", "anthropic/claude-sonnet-4")).toMatchObject({
			basis: "documented",
			retentionMs: 300_000,
			anchorBasis: "assumed",
		});
		for (const [provider, model] of [
			["zai", "glm-5.1"],
			["grok", "grok-4"],
			["minimax", "MiniMax-M2.7"],
		]) {
			expect(retention(provider, model, "https://api.openai.com/v1")).toEqual(
				retention(provider, model),
			);
		}
		for (const endpoint of [
			"https://api.openai.com/v1",
			"https://api.groq.com/openai/v1",
		]) {
			expect(retention("minimax", "MiniMax-M2", endpoint)).toEqual(
				retention("minimax", "MiniMax-M2"),
			);
		}
	});
	it("uses documented Groq inactivity and qualifies DeepSeek's vague hours-to-days description", () => {
		expect(
			retention(
				"openai-compatible",
				"openai/gpt-oss-120b",
				"https://api.groq.com/openai/v1",
			),
		).toMatchObject({
			basis: "documented",
			retentionMs: 7_200_000,
			anchorBasis: "assumed",
		});
		expect(
			retention(
				"openai-compatible",
				"llama-3.3-70b-versatile",
				"https://api.groq.com/openai/v1",
			).basis,
		).toBe("heuristic");
		expect(
			retention(
				"openai-compatible",
				"deepseek-chat",
				"https://api.deepseek.com/v1",
			),
		).toMatchObject({
			basis: "inferred",
			retentionMs: 3_600_000,
			confidence: "low",
			semantics: "typical",
		});
	});
	it("borrows Gemini implicit retention from OpenRouter only with an inference label on direct Gemini", () => {
		expect(retention("openrouter", "google/gemini-2.5-pro")).toMatchObject({
			basis: "documented",
			retentionMs: 180_000,
			typicalRangeMs: [180_000, 300_000],
			semantics: "typical",
			refreshBasis: "assumed",
		});
		expect(
			retention(
				"openai-compatible",
				"gemini-2.5-pro",
				"https://generativelanguage.googleapis.com/v1beta/openai",
			),
		).toMatchObject({
			basis: "inferred",
			retentionMs: 180_000,
			confidence: "low",
		});
	});
	it("does not turn custom endpoint or translated explicit cache assumptions into documented policy", () => {
		for (const endpoint of [
			"https://private.example/v1",
			"https://api.openai.com.evil/v1",
			"https://api.openai.com/v1?key=secret",
		]) {
			expect(
				retention("openai-compatible", "gpt-6-astra", endpoint).basis,
			).toBe("heuristic");
		}
		expect(
			retention("anthropic", "claude-sonnet-4", undefined, "openai").basis,
		).toBe("heuristic");
		expect(
			retention("codex", "gpt-6-astra", "https://private.example").basis,
		).toBe("heuristic");
	});
	it("preserves endpoint parsing specific to the actual adapter", () => {
		const endpoint = JSON.stringify({ endpoint: "https://api.openai.com/v1" });
		expect(retention("openai-compatible", "gpt-6-astra", endpoint).basis).toBe(
			"documented",
		);
		expect(retention("codex", "gpt-6-astra", endpoint).basis).toBe("heuristic");
	});
	it("keeps no-route and unresolved-route estimates heuristic and sanitized", () => {
		for (const routes of [
			[],
			[{ provider: "codex", format: "openai" as const }],
		]) {
			expect(
				resolveModelCacheRetention("gpt-6-astra", routes, true),
			).toMatchObject({
				basis: "heuristic",
				retentionMs: 300_000,
				sources: [],
			});
		}
	});
	it("reduces mixed routes conservatively and independently of ordering", () => {
		const direct = { provider: "openai-compatible", format: "openai" as const };
		const codex = { provider: "codex", format: "openai" as const };
		const unknown = {
			provider: "private-provider",
			customEndpoint: "https://secret.example/account-id",
			format: "openai" as const,
		};
		const mixed = resolveModelCacheRetention("gpt-6-astra", [direct, codex]);
		expect(mixed).toMatchObject({
			basis: "inferred",
			retentionMs: 1_800_000,
			confidence: "low",
		});
		expect(mixed).toEqual(
			resolveModelCacheRetention("gpt-6-astra", [codex, direct]),
		);
		const reduced = resolveModelCacheRetention("gpt-6-astra", [
			direct,
			unknown,
		]);
		expect(reduced).toMatchObject({
			basis: "heuristic",
			retentionMs: 300_000,
			confidence: "low",
			semantics: "heuristic",
		});
		expect(JSON.stringify(reduced)).not.toMatch(
			/secret|account-id|private-provider/,
		);
	});
});
