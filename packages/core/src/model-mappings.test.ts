import { describe, expect, test } from "bun:test";
import {
	codexAccountFitsRequest,
	DEFAULT_CODEX_MODEL_BY_FAMILY,
	estimateRequestTokens,
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
import type { Account } from "@clankermux/types";

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
});

describe("codexAccountFitsRequest", () => {
	test("returns true when estimate is under window * SAFETY_MARGIN", () => {
		// gpt-5.5: 272K * 0.85 = 231.2K → floor = 231200
		const account = makeCodexAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 231_200)).toBe(
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
		// 272K * 0.85 = 231200
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 231_201)).toBe(
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
		// 128K * 0.85 = 108800
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 108_800)).toBe(
			true,
		);
		expect(codexAccountFitsRequest(account, "claude-opus-4-7", 108_801)).toBe(
			false,
		);
	});

	test("resolves the family default Codex model when no stored mapping exists", () => {
		// No account mapping → opus resolves to the gpt-5.5 family default
		// (272K window, threshold 231200), matching what the provider actually
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
		// fable → gpt-5.5 default (272K, threshold 231200).
		const account = makeCodexAccount({ model_mappings: null });
		expect(codexAccountFitsRequest(account, "claude-fable-5", 231_200)).toBe(
			true,
		);
		expect(codexAccountFitsRequest(account, "claude-fable-5", 231_201)).toBe(
			false,
		);
		// mythos resolves to the same fable family default.
		expect(codexAccountFitsRequest(account, "claude-mythos-5", 231_201)).toBe(
			false,
		);
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
		expect(resolveCodexTargetModel("claude-opus-4-7", account)).toBe("gpt-5.5");
		expect(resolveCodexTargetModel("claude-sonnet-4-5", account)).toBe(
			"gpt-5.4",
		);
		expect(resolveCodexTargetModel("claude-haiku-4-5", account)).toBe(
			"gpt-5.4-mini",
		);
		expect(resolveCodexTargetModel("claude-fable-5", account)).toBe("gpt-5.5");
		expect(resolveCodexTargetModel("claude-mythos-5", account)).toBe("gpt-5.5");
	});

	test("returns a non-Claude model with no mapping unchanged", () => {
		const account = makeCodexAccount({ model_mappings: null });
		expect(resolveCodexTargetModel("gpt-5.3-codex-spark", account)).toBe(
			"gpt-5.3-codex-spark",
		);
	});

	test("DEFAULT_CODEX_MODEL_BY_FAMILY covers every family", () => {
		expect(DEFAULT_CODEX_MODEL_BY_FAMILY).toEqual({
			opus: "gpt-5.5",
			sonnet: "gpt-5.4",
			haiku: "gpt-5.4-mini",
			fable: "gpt-5.5",
		});
	});

	test("SAFETY_MARGIN is 0.85", () => {
		expect(SAFETY_MARGIN).toBe(0.85);
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
