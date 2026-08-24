import { describe, expect, it } from "bun:test";
import { normalizeModelKey } from "../model-key";

describe("normalizeModelKey", () => {
	it("strips a compact Anthropic date suffix", () => {
		expect(normalizeModelKey("claude-haiku-4-5-20251001")).toBe(
			"claude-haiku-4-5",
		);
	});

	it("strips a dashed OpenAI date suffix", () => {
		// Present in this database. Missing this form fragments dated Codex
		// releases into several sub-threshold keys, each of which then pools into
		// `other` — a rollout-shaped discontinuity manufactured out of nothing.
		expect(normalizeModelKey("gpt-5.4-mini-2026-03-17")).toBe("gpt-5.4-mini");
	});

	it("lowercases", () => {
		expect(normalizeModelKey("Claude-Opus-5")).toBe("claude-opus-5");
	});

	it("leaves a version-like run in the MIDDLE of an id alone", () => {
		expect(normalizeModelKey("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
		expect(normalizeModelKey("gpt-5.6-sol")).toBe("gpt-5.6-sol");
	});

	it("does not strip a date-like run that is not at the end", () => {
		expect(normalizeModelKey("claude-20251001-preview")).toBe(
			"claude-20251001-preview",
		);
	});

	it("keeps generations distinct — the axis the estimator measures", () => {
		// Measured coefficients for these two differ by roughly a factor of two, so
		// collapsing them to a family would confound the quantity being estimated.
		expect(normalizeModelKey("claude-opus-5")).not.toBe(
			normalizeModelKey("claude-opus-4-8"),
		);
	});

	it("returns the empty string for absent input", () => {
		expect(normalizeModelKey(null)).toBe("");
		expect(normalizeModelKey(undefined)).toBe("");
		expect(normalizeModelKey("   ")).toBe("");
	});
});
