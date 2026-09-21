import { describe, expect, it } from "bun:test";
import { isModelSubstitution } from "../model-substitution";

describe("isModelSubstitution", () => {
	it("reports the substitution this feature exists for", () => {
		expect(isModelSubstitution("gpt-6-astra", "gpt-5.6-luna")).toBe(true);
		expect(isModelSubstitution("gpt-5.6-luna", "gpt-6-luna")).toBe(true);
	});

	it("accepts the model it asked for", () => {
		expect(isModelSubstitution("gpt-6-astra", "gpt-6-astra")).toBe(false);
		expect(isModelSubstitution("claude-opus-5", "claude-opus-5")).toBe(false);
	});

	it("ignores case and surrounding space", () => {
		expect(isModelSubstitution("GPT-6-Astra", " gpt-6-astra ")).toBe(false);
	});

	// Each of the next three is a class that would otherwise fire on correct
	// behaviour and turn a working response into a client error.

	it("treats a slug the backend resolves as no substitution", () => {
		expect(isModelSubstitution("codex-auto-review", "gpt-5.6-luna")).toBe(
			false,
		);
		expect(isModelSubstitution("coder-model", "qwen3-coder-plus")).toBe(false);
	});

	it("matches a dated snapshot against its base, in both formats", () => {
		// OpenAI/Codex spelling.
		expect(isModelSubstitution("gpt-5.6-sol", "gpt-5.6-sol-2026-05-13")).toBe(
			false,
		);
		expect(isModelSubstitution("gpt-5.6-sol-2026-05-13", "gpt-5.6-sol")).toBe(
			false,
		);
		// Anthropic's separator-less spelling, which core's stripDatedModelSuffix
		// does not recognise.
		expect(
			isModelSubstitution("claude-haiku-4-5", "claude-haiku-4-5-20251001"),
		).toBe(false);
		expect(
			isModelSubstitution("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
		).toBe(false);
	});

	it("matches across an OpenRouter route variant", () => {
		expect(
			isModelSubstitution("qwen/qwen3.6-plus:free", "qwen/qwen3.6-plus"),
		).toBe(false);
		expect(isModelSubstitution("qwen3.6-plus", "qwen3.6-plus:nitro")).toBe(
			false,
		);
		// The variant is not a licence to match unrelated models.
		expect(isModelSubstitution("qwen3.6-plus:free", "glm-5.3:free")).toBe(true);
	});

	// Ollama uses the same separator for identity, not for routing. Stripping
	// any trailing colon suffix would equate two different sets of weights and
	// silently disable detection for every colon-tagged provider.
	it("keeps an Ollama size tag, which is part of the model", () => {
		expect(isModelSubstitution("llama3:8b", "llama3:70b")).toBe(true);
		expect(isModelSubstitution("qwen3:4b", "qwen3:32b")).toBe(true);
		expect(isModelSubstitution("llama3:8b", "llama3:8b")).toBe(false);
		// A bare name answered with a tagged one is still a different model.
		expect(isModelSubstitution("llama3", "llama3:70b")).toBe(true);
	});

	it("matches across a vendor prefix", () => {
		expect(
			isModelSubstitution("anthropic/claude-opus-5", "claude-opus-5"),
		).toBe(false);
		expect(isModelSubstitution("claude-opus-5", "openai/claude-opus-5")).toBe(
			false,
		);
	});

	// The normalisations must not become a way for a real swap to pass.

	it("still separates genuinely different models", () => {
		expect(isModelSubstitution("claude-haiku-4-5", "claude-opus-5")).toBe(true);
		expect(
			isModelSubstitution(
				"claude-haiku-4-5-20251001",
				"claude-opus-5-20251001",
			),
		).toBe(true);
		expect(isModelSubstitution("gpt-5.6-sol", "gpt-5.6-terra")).toBe(true);
		// A different snapshot of a different base is still different.
		expect(
			isModelSubstitution("gpt-5.6-sol-2026-05-13", "gpt-5.6-luna-2026-05-13"),
		).toBe(true);
	});

	it("does not treat an eight-digit model name as a date", () => {
		// `-20251001` strips only when something precedes it.
		expect(isModelSubstitution("20251001", "claude-opus-5")).toBe(true);
	});

	it("says no when either side is empty, rather than guessing", () => {
		expect(isModelSubstitution("", "gpt-5.6-luna")).toBe(false);
		expect(isModelSubstitution("gpt-6-astra", "")).toBe(false);
	});
});
