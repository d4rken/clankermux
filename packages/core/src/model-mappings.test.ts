import { describe, expect, test } from "bun:test";
import {
	codexAccountFitsRequest,
	codexAccountFitsRequestUnmargined,
	DEFAULT_CODEX_MODEL_BY_FAMILY,
	estimateContextWindowTokens,
	estimateRequestTokens,
	GATE_CHARS_PER_TOKEN,
	GATE_OUTPUT_RESERVE_CAP,
	getAllowedModelsMessage,
	getModelFamily,
	isValidClaudeModel,
	MODEL_CONTEXT_WINDOWS,
	mapModelName,
	parseModelMappings,
	resolveCodexTargetModel,
	resolveModelContextWindow,
	SAFETY_MARGIN,
} from "@clankermux/core";
import type { Account, ContextComposition } from "@clankermux/types";

describe("Model Mapping", () => {
	test("parseModelMappings handles valid JSON", () => {
		const mappings = JSON.stringify({
			sonnet: "gpt-4",
			opus: "gpt-4-turbo",
			haiku: "gpt-3.5-turbo",
		});

		const result = parseModelMappings(mappings);
		expect(result).toEqual({
			sonnet: "gpt-4",
			opus: "gpt-4-turbo",
			haiku: "gpt-3.5-turbo",
		});
	});

	test("parseModelMappings handles invalid JSON", () => {
		const result = parseModelMappings("invalid-json");
		expect(result).toBeNull();
	});

	test("parseModelMappings handles null/empty", () => {
		expect(parseModelMappings(null)).toBeNull();
		expect(parseModelMappings("")).toBeNull();
	});

	test("mapModelName uses direct pattern matching", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: JSON.stringify({
				sonnet: "gpt-4",
				opus: "gpt-4-turbo",
				haiku: "gpt-3.5-turbo",
			}),
			custom_endpoint: null,
		};

		// Test direct pattern matching with realistic mappings
		const result1 = mapModelName("claude-sonnet-4-5-20250929", mockAccount); // Current
		const result2 = mapModelName("claude-haiku-4-5-20251001", mockAccount); // Current
		const result3 = mapModelName("claude-opus-4-1-20250805", mockAccount); // Current

		// Future model versions - demonstrating future-proof behavior
		const result4 = mapModelName("claude-sonnet-4-6-20251129", mockAccount); // Future version
		const result5 = mapModelName("claude-haiku-4-6-20251101", mockAccount); // Future version
		const result6 = mapModelName("claude-opus-4-5-20251105", mockAccount); // Future version

		// Current models
		expect(result1).toBe("gpt-4"); // Matches "sonnet"
		expect(result2).toBe("gpt-3.5-turbo"); // Matches "haiku"
		expect(result3).toBe("gpt-4-turbo"); // Matches "opus"

		// Future models - should still work without any code changes
		expect(result4).toBe("gpt-4"); // Still matches "sonnet"
		expect(result5).toBe("gpt-3.5-turbo"); // Still matches "haiku"
		expect(result6).toBe("gpt-4-turbo"); // Still matches "opus"
	});

	test("real database mappings work correctly", () => {
		// Test with real mappings from the database
		const openrouterMappings =
			'{"opus":"z-ai/glm-4.5-air:free","sonnet":"z-ai/glm-4.5-air:free","haiku":"z-ai/glm-4.5-air:free"}';

		const mockAccount: Account = {
			id: "test",
			name: "openrouter-test",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: openrouterMappings,
			custom_endpoint: null,
		};

		// Test real client model names
		const sonnetRequest = "claude-sonnet-4-5-20250929";
		const haikuRequest = "claude-haiku-4-5-20251001";
		const opusRequest = "claude-opus-4-1-20250805";

		// These should be mapped using the direct pattern matching logic
		const sonnetMapped = mapModelName(sonnetRequest, mockAccount);
		const haikuMapped = mapModelName(haikuRequest, mockAccount);
		const opusMapped = mapModelName(opusRequest, mockAccount);

		expect(sonnetMapped).toBe("z-ai/glm-4.5-air:free"); // matches "sonnet"
		expect(haikuMapped).toBe("z-ai/glm-4.5-air:free"); // matches "haiku"
		expect(opusMapped).toBe("z-ai/glm-4.5-air:free"); // matches "opus"

		// Test future model versions work
		const futureSonnet = mapModelName(
			"claude-sonnet-5-0-20251201",
			mockAccount,
		);
		expect(futureSonnet).toBe("z-ai/glm-4.5-air:free"); // still matches "sonnet"
	});

	test("mapModelName passes through original model when no mappings configured", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: null, // No custom mappings
			custom_endpoint: null,
		};

		// Should return the original model name unchanged
		const result1 = mapModelName("claude-sonnet-4-5-20250929", mockAccount);
		const result2 = mapModelName("claude-haiku-4-5-20251001", mockAccount);
		const result3 = mapModelName("claude-opus-4-1-20250805", mockAccount);

		expect(result1).toBe("claude-sonnet-4-5-20250929");
		expect(result2).toBe("claude-haiku-4-5-20251001");
		expect(result3).toBe("claude-opus-4-1-20250805");
	});

	test("mapModelName handles case insensitive pattern matching correctly", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: JSON.stringify({
				sonnet: "lowercase-gpt-4",
				opus: "lowercase-gpt-4-turbo",
				haiku: "lowercase-gpt-3.5",
			}),
			custom_endpoint: null,
		};

		// Should match using case-insensitive pattern matching
		const sonnetResult = mapModelName(
			"claude-sonnet-4-5-20250929",
			mockAccount,
		);
		const haikuResult = mapModelName("claude-haiku-4-5-20251001", mockAccount);
		const opusResult = mapModelName("claude-opus-4-1-20250805", mockAccount);

		// Should match the lowercase mappings due to case-insensitive pattern matching
		expect(sonnetResult).toBe("lowercase-gpt-4");
		expect(haikuResult).toBe("lowercase-gpt-3.5");
		expect(opusResult).toBe("lowercase-gpt-4-turbo");
	});

	test("mapModelName passes through unmapped model when only sonnet is configured (regression: no implicit sonnet catch-all)", () => {
		// Regression test: previously, if an account had a sonnet mapping but no haiku mapping,
		// requesting a haiku model would silently remap it to the sonnet target.
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: JSON.stringify({
				sonnet: "claude-sonnet-4-6", // Only sonnet is mapped; haiku is NOT
			}),
			custom_endpoint: null,
		};

		// Sonnet should be mapped
		expect(mapModelName("claude-sonnet-4-5", mockAccount)).toBe(
			"claude-sonnet-4-6",
		);

		// Haiku has no mapping — must pass through unchanged, NOT remap to sonnet target
		expect(mapModelName("claude-haiku-4-5", mockAccount)).toBe(
			"claude-haiku-4-5",
		);

		// Opus has no mapping — must also pass through unchanged
		expect(mapModelName("claude-opus-4-5", mockAccount)).toBe(
			"claude-opus-4-5",
		);
	});
});

describe("Model Validation Utilities", () => {
	test("getModelFamily detects opus models", () => {
		expect(getModelFamily("claude-opus-4-6")).toBe("opus");
		expect(getModelFamily("claude-opus-4-20250514")).toBe("opus");
		expect(getModelFamily("CLAUDE-OPUS-5-0")).toBe("opus"); // case insensitive
	});

	test("getModelFamily detects sonnet models", () => {
		expect(getModelFamily("claude-sonnet-4-5-20250929")).toBe("sonnet");
		expect(getModelFamily("claude-sonnet-5-0")).toBe("sonnet");
	});

	test("getModelFamily detects haiku models", () => {
		expect(getModelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
		expect(getModelFamily("claude-haiku-5-0")).toBe("haiku");
	});

	test("getModelFamily detects fable models", () => {
		expect(getModelFamily("claude-fable-5")).toBe("fable");
		expect(getModelFamily("CLAUDE-FABLE-5")).toBe("fable"); // case insensitive
	});

	test("getModelFamily maps mythos models to the fable family", () => {
		expect(getModelFamily("claude-mythos-5")).toBe("fable");
		expect(getModelFamily("claude-mythos-preview")).toBe("fable");
	});

	test("getModelFamily returns null for invalid models", () => {
		expect(getModelFamily("gpt-4")).toBeNull();
		expect(getModelFamily("invalid-model")).toBeNull();
		expect(getModelFamily("")).toBeNull();
	});

	test("isValidClaudeModel accepts valid patterns", () => {
		expect(isValidClaudeModel("claude-opus-4-6")).toBe(true);
		expect(isValidClaudeModel("claude-sonnet-4-5-20250929")).toBe(true);
		expect(isValidClaudeModel("claude-haiku-4-5-20251001")).toBe(true);
		expect(isValidClaudeModel("claude-fable-5")).toBe(true);
		expect(isValidClaudeModel("claude-mythos-5")).toBe(true);
		expect(isValidClaudeModel("claude-opus-5-0-future")).toBe(true); // future models
	});

	test("isValidClaudeModel rejects invalid patterns", () => {
		expect(isValidClaudeModel("gpt-4")).toBe(false);
		expect(isValidClaudeModel("invalid-model")).toBe(false);
		expect(isValidClaudeModel("")).toBe(false);
	});

	test("getAllowedModelsMessage returns user-friendly error", () => {
		const message = getAllowedModelsMessage();
		expect(message).toContain("opus");
		expect(message).toContain("sonnet");
		expect(message).toContain("haiku");
		expect(message).toContain("fable");
	});
});

// ── Context-window-aware routing tests ───────────────────────────────────────

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "codex-test",
		provider: "codex",
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		created_at: Date.now(),
		request_count: 0,
		total_requests: 0,
		priority: 20,
		model_mappings: null,
		custom_endpoint: null,
		...overrides,
	};
}

describe("MODEL_CONTEXT_WINDOWS", () => {
	test("contains expected models with positive window sizes", () => {
		expect(MODEL_CONTEXT_WINDOWS["gpt-5.5"]).toBe(272_000);
		expect(MODEL_CONTEXT_WINDOWS["gpt-5.4"]).toBe(272_000);
		expect(MODEL_CONTEXT_WINDOWS["gpt-5.4-mini"]).toBe(272_000);
		expect(MODEL_CONTEXT_WINDOWS["gpt-5.3-codex-spark"]).toBe(128_000);
	});

	test("omits retired and experimental/compaction models", () => {
		expect(MODEL_CONTEXT_WINDOWS["gpt-5-codex"]).toBeUndefined();
		expect(MODEL_CONTEXT_WINDOWS["gpt-5.3-codex"]).toBeUndefined();
		expect(MODEL_CONTEXT_WINDOWS["gpt-5.2-codex"]).toBeUndefined();
	});
});

describe("resolveModelContextWindow", () => {
	test("returns window for known model", () => {
		expect(resolveModelContextWindow("gpt-5.5")).toBe(272_000);
	});

	test("returns undefined for unknown model", () => {
		expect(resolveModelContextWindow("gpt-5.2-codex")).toBeUndefined();
		expect(resolveModelContextWindow("unknown-model")).toBeUndefined();
	});
});

describe("estimateRequestTokens", () => {
	test("returns 0 for null/undefined body", () => {
		expect(estimateRequestTokens(null)).toBe(0);
		expect(estimateRequestTokens(undefined)).toBe(0);
	});

	test("estimate is monotonically increasing with body size", () => {
		const small = { messages: [{ role: "user", content: "hi" }] };
		const medium = {
			messages: [{ role: "user", content: "a".repeat(1000) }],
		};
		const large = {
			messages: [{ role: "user", content: "a".repeat(100_000) }],
		};

		const estSmall = estimateRequestTokens(small);
		const estMedium = estimateRequestTokens(medium);
		const estLarge = estimateRequestTokens(large);

		expect(estSmall).toBeGreaterThan(0);
		expect(estMedium).toBeGreaterThan(estSmall);
		expect(estLarge).toBeGreaterThan(estMedium);
	});

	test("includes max_tokens reserve", () => {
		const body = { messages: [{ role: "user", content: "hello" }] };
		const bodyWithMax = { ...body, max_tokens: 4096 };

		const estWithout = estimateRequestTokens(body);
		const estWith = estimateRequestTokens(bodyWithMax);

		// Adding max_tokens reserves at least max_tokens extra (the serialized
		// "max_tokens":4096 also adds a few input chars, so it's >= not ==).
		expect(estWith).toBeGreaterThanOrEqual(estWithout + 4096);
	});

	test("ignores non-numeric max_tokens (no reserve added)", () => {
		const bodyWithBadMax = {
			messages: [{ role: "user", content: "hello" }],
			max_tokens: "not a number",
		};
		// A non-numeric max_tokens contributes no output reserve; the estimate
		// is purely the input-char estimate (no +Number jump).
		const est = estimateRequestTokens(
			bodyWithBadMax as unknown as Record<string, unknown>,
		);
		const inputOnly = Math.ceil(JSON.stringify(bodyWithBadMax).length / 3.0);
		expect(est).toBe(inputOnly);
	});

	test("uses composition when provided (chars/4.0), giving a much lower estimate than fallback JSON.stringify/3.0", () => {
		// Simulate a large Claude Code session: lots of newlines and structural
		// JSON overhead inflate the raw JSON far beyond the actual token count.
		const largeContent = "line\n".repeat(200_000); // 200k newlines → inflate when JSON-encoded
		const body = {
			messages: [{ role: "user", content: largeContent }],
			max_tokens: 0,
		};
		const composition: ContextComposition = {
			systemChars: 0,
			toolsChars: 0,
			// context-composition.ts counts text.length (raw chars, not JSON-escaped)
			messagesChars: largeContent.length,
			messageCount: 1,
			toolResultChars: 0,
			largestToolResultChars: 0,
			largestToolName: null,
			toolCount: 0,
		};

		const withComposition = estimateRequestTokens(body, composition);
		const fallback = estimateRequestTokens(body); // old path, no composition

		// Composition path: raw text chars / 4.0 ≈ 250k tokens
		expect(withComposition).toBe(Math.ceil(largeContent.length / 4.0));
		// Fallback path counts JSON-escaped chars (each \n→\\n doubles newlines):
		// should be roughly 2× higher for newline-heavy content
		expect(fallback).toBeGreaterThan(withComposition * 1.5);
	});

	test("composition path includes max_tokens reserve", () => {
		const composition: ContextComposition = {
			systemChars: 4000,
			toolsChars: 0,
			messagesChars: 0,
			messageCount: 0,
			toolResultChars: 0,
			largestToolResultChars: 0,
			largestToolName: null,
			toolCount: 0,
		};
		const body = { messages: [], max_tokens: 8192 };
		const est = estimateRequestTokens(body, composition);
		expect(est).toBe(Math.ceil(4000 / 4.0) + 8192);
	});
});

describe("codexAccountFitsRequest", () => {
	test("returns true when estimate is under window * SAFETY_MARGIN", () => {
		// gpt-5.5: floor(272000 * 0.97) = 263840
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 263_840)).toBe(
			true,
		);
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 100_000)).toBe(
			true,
		);
	});

	test("returns false when estimate exceeds window * SAFETY_MARGIN", () => {
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		// floor(272000 * 0.97) = 263840
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 263_841)).toBe(
			false,
		);
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 500_000)).toBe(
			false,
		);
	});

	test("returns true for unknown model (no false exclusion)", () => {
		// gpt-5.2-codex is intentionally omitted from the table
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.2-codex" }),
		});
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 999_999)).toBe(
			true,
		);
	});

	test("respects stored model mapping over defaults", () => {
		// Stored mapping: opus→gpt-5.3-codex-spark (128K window)
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.3-codex-spark" }),
		});
		// floor(128000 * 0.97) = 124160
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 124_160)).toBe(
			true,
		);
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 124_161)).toBe(
			false,
		);
	});

	test("resolves the family default Codex model when no stored mapping exists", () => {
		// No account mapping → opus resolves to the gpt-5.6-sol family default
		// (353K window, threshold 342410), matching what the provider actually
		// sends, so an oversized request is correctly excluded (not "fits").
		const account = makeCodexAccount({ model_mappings: null });
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 999_999)).toBe(
			false,
		);
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 100_000)).toBe(
			true,
		);
	});

	test("gates a default-config account on the fable family window", () => {
		// fable → gpt-5.6-sol default (353K, threshold 342410).
		const account = makeCodexAccount({ model_mappings: null });
		expect(codexAccountFitsRequest(account, "claude-fable-5", 342_410)).toBe(
			true,
		);
		expect(codexAccountFitsRequest(account, "claude-fable-5", 342_411)).toBe(
			false,
		);
		// mythos resolves to the same fable family default.
		expect(codexAccountFitsRequest(account, "claude-mythos-5", 342_411)).toBe(
			false,
		);
	});
});

describe("constants are calibrated", () => {
	test("gate constants hold their data-derived values", () => {
		expect(SAFETY_MARGIN).toBe(0.97);
		expect(GATE_CHARS_PER_TOKEN).toBe(3.0);
		expect(GATE_OUTPUT_RESERVE_CAP).toBe(4_000);
	});
});

describe("estimateContextWindowTokens", () => {
	const composition = (
		systemChars: number,
		toolsChars: number,
		messagesChars: number,
	): ContextComposition => ({
		systemChars,
		toolsChars,
		toolCount: 0,
		messagesChars,
		messageCount: 1,
		toolResultChars: 0,
		largestToolResultChars: 0,
		largestToolName: null,
	});

	test("null/undefined body → 0", () => {
		expect(estimateContextWindowTokens(null)).toBe(0);
		expect(estimateContextWindowTokens(undefined)).toBe(0);
	});

	test("composition path divides content chars by GATE_CHARS_PER_TOKEN (3.0)", () => {
		// 30,000 content chars → 10,000 tokens at 3.0; no max_tokens → no reserve.
		const body = { max_tokens: 0 };
		const comp = composition(6_000, 9_000, 15_000); // 30,000 chars
		expect(estimateContextWindowTokens(body, comp)).toBe(10_000);
	});

	test("caps the output reservation at GATE_OUTPUT_RESERVE_CAP (4,000)", () => {
		const comp = composition(0, 0, 30_000); // 10,000 input tokens
		// max_tokens 64,000 → reserve clamped to 4,000.
		expect(estimateContextWindowTokens({ max_tokens: 64_000 }, comp)).toBe(
			14_000,
		);
		// max_tokens 3,000 (< cap) → reserve only 3,000.
		expect(estimateContextWindowTokens({ max_tokens: 3_000 }, comp)).toBe(
			13_000,
		);
	});

	test("the incident request (~675k chars, max_tokens 64k) now fits gpt-5.6-sol", () => {
		// Reproduces the reported 400: old estimate was 232,859 = 675,436/4 + 64,000.
		const comp = composition(6_601, 134_827, 534_008); // 675,436 chars total
		const est = estimateContextWindowTokens({ max_tokens: 64_000 }, comp);
		// 675,436 / 3.0 = 225,146 (ceil) + min(64000, 4000) = 229,146.
		expect(est).toBe(229_146);
		const account = makeCodexAccount({ model_mappings: null });
		// Admitted by the gate (threshold floor(353000 * 0.97) = 342,410).
		expect(codexAccountFitsRequest(account, "claude-opus-4-8", est)).toBe(true);
	});

	test("fallback path (no composition) caps the reserve too", () => {
		const body = { model: "x", max_tokens: 64_000 };
		const jsonLen = JSON.stringify(body).length;
		const expected = Math.ceil(jsonLen / 3.0) + GATE_OUTPUT_RESERVE_CAP;
		expect(estimateContextWindowTokens(body)).toBe(expected);
	});
});

describe("estimateRequestTokens is unchanged (cache-warming promotion regression guard)", () => {
	test("composition path still divides by 4.0 and adds full max_tokens", () => {
		const comp: ContextComposition = {
			systemChars: 0,
			toolsChars: 0,
			toolCount: 0,
			messagesChars: 40_000,
			messageCount: 1,
			toolResultChars: 0,
			largestToolResultChars: 0,
			largestToolName: null,
		};
		// 40,000 / 4.0 = 10,000 + full 64,000 max_tokens = 74,000 (NOT capped).
		expect(estimateRequestTokens({ max_tokens: 64_000 }, comp)).toBe(74_000);
		// The gate estimator for the same input is materially different.
		expect(estimateContextWindowTokens({ max_tokens: 64_000 }, comp)).not.toBe(
			74_000,
		);
	});
});

describe("codexAccountFitsRequestUnmargined (last-resort, no margin)", () => {
	test("admits up to the FULL window (the margin band is re-admitted)", () => {
		const account = makeCodexAccount({ model_mappings: null }); // opus→gpt-5.6-sol
		// In the (floor(353000*0.97)=342410, 353000] band: margined gate rejects,
		// unmargined admits.
		expect(codexAccountFitsRequest(account, "claude-opus-4-8", 350_000)).toBe(
			false,
		);
		expect(
			codexAccountFitsRequestUnmargined(account, "claude-opus-4-8", 350_000),
		).toBe(true);
		// Exactly at the window: admitted.
		expect(
			codexAccountFitsRequestUnmargined(account, "claude-opus-4-8", 353_000),
		).toBe(true);
	});

	test("rejects beyond the full window", () => {
		const account = makeCodexAccount({ model_mappings: null });
		expect(
			codexAccountFitsRequestUnmargined(account, "claude-opus-4-8", 353_001),
		).toBe(false);
	});

	test("unknown model → fits (no false exclusion), matching the margined gate", () => {
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.2-codex" }),
		});
		expect(
			codexAccountFitsRequestUnmargined(account, "claude-opus-4-8", 9_999_999),
		).toBe(true);
	});

	test("respects the 128k spark window", () => {
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.3-codex-spark" }),
		});
		expect(
			codexAccountFitsRequestUnmargined(account, "claude-opus-4-8", 128_000),
		).toBe(true);
		expect(
			codexAccountFitsRequestUnmargined(account, "claude-opus-4-8", 128_001),
		).toBe(false);
	});
});

describe("resolveCodexTargetModel", () => {
	test("prefers an explicit account mapping over the family default", () => {
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.3-codex-spark" }),
		});
		expect(resolveCodexTargetModel("claude-opus-4-7", account)).toBe(
			"gpt-5.3-codex-spark",
		);
	});

	test("falls back to the family default when no mapping exists", () => {
		const account = makeCodexAccount({ model_mappings: null });
		expect(resolveCodexTargetModel("claude-opus-4-7", account)).toBe(
			"gpt-5.6-sol",
		);
		expect(resolveCodexTargetModel("claude-sonnet-4-5", account)).toBe(
			"gpt-5.6-terra",
		);
		expect(resolveCodexTargetModel("claude-haiku-4-5", account)).toBe(
			"gpt-5.6-luna",
		);
		expect(resolveCodexTargetModel("claude-fable-5", account)).toBe(
			"gpt-5.6-sol",
		);
		expect(resolveCodexTargetModel("claude-mythos-5", account)).toBe(
			"gpt-5.6-sol",
		);
	});

	test("returns a non-Claude model with no mapping unchanged", () => {
		const account = makeCodexAccount({ model_mappings: null });
		expect(resolveCodexTargetModel("gpt-5.3-codex-spark", account)).toBe(
			"gpt-5.3-codex-spark",
		);
	});

	test("DEFAULT_CODEX_MODEL_BY_FAMILY covers every family", () => {
		expect(DEFAULT_CODEX_MODEL_BY_FAMILY).toEqual({
			opus: "gpt-5.6-sol",
			sonnet: "gpt-5.6-terra",
			haiku: "gpt-5.6-luna",
			fable: "gpt-5.6-sol",
		});
	});

	test("SAFETY_MARGIN is 0.97", () => {
		expect(SAFETY_MARGIN).toBe(0.97);
	});

	test("boundary: exactly at floor(window * SAFETY_MARGIN) is accepted", () => {
		// gpt-5.3-codex-spark: 128K * 0.85 = 108800 exactly
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex-spark" }),
		});
		const boundary = Math.floor(128_000 * SAFETY_MARGIN);
		expect(
			codexAccountFitsRequest(account, "claude-sonnet-4-5", boundary),
		).toBe(true);
		expect(
			codexAccountFitsRequest(account, "claude-sonnet-4-5", boundary + 1),
		).toBe(false);
	});
});
