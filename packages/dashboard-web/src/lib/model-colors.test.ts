import { describe, expect, it } from "bun:test";
import { CLAUDE_MODEL_IDS, getModelFamily } from "@clankermux/core";
import { CHART_COLORS, COLORS } from "../constants";
import { getModelColor } from "./model-colors";

describe("getModelColor", () => {
	it("gives every model in a family a distinct color", () => {
		// Chart series are grouped per family in practice (an "opus" chart shows
		// several Opus versions at once), so a collision inside a family makes two
		// lines indistinguishable. Across families a repeat is harmless.
		const byFamily = new Map<string, Map<string, string>>();

		Object.values(CLAUDE_MODEL_IDS).forEach((modelId, index) => {
			const family = getModelFamily(modelId);
			expect(family).not.toBeNull();
			const color = getModelColor(modelId, index);
			const seen = byFamily.get(family as string) ?? new Map<string, string>();
			expect(seen.has(color)).toBe(false);
			seen.set(color, modelId);
			byFamily.set(family as string, seen);
		});

		// Sanity: the loop actually covered every family.
		expect([...byFamily.keys()].sort()).toEqual([
			"fable",
			"haiku",
			"opus",
			"sonnet",
		]);
	});

	it("resolves every registered model to an explicit palette color", () => {
		// An explicit entry (matched via the model's short name) must win before
		// the loose substring fallback, which otherwise collapses e.g. every
		// claude-opus-4.x onto claude-opus-4's color.
		const palette = new Set<string>(Object.values(COLORS));
		for (const modelId of Object.values(CLAUDE_MODEL_IDS)) {
			expect(palette.has(getModelColor(modelId, 0))).toBe(true);
		}
	});

	it("keeps Opus 4.5 through 5 off Opus 4's color", () => {
		const opus4 = getModelColor(CLAUDE_MODEL_IDS.OPUS_4, 0);
		for (const modelId of [
			CLAUDE_MODEL_IDS.OPUS_4_5,
			CLAUDE_MODEL_IDS.OPUS_4_6,
			CLAUDE_MODEL_IDS.OPUS_4_7,
			CLAUDE_MODEL_IDS.OPUS_4_8,
			CLAUDE_MODEL_IDS.OPUS_5,
		]) {
			expect(getModelColor(modelId, 0)).not.toBe(opus4);
		}
	});

	it("keeps Sonnet 4.5 off the legacy claude-3.5-sonnet color", () => {
		expect(getModelColor(CLAUDE_MODEL_IDS.SONNET_4_5, 0)).not.toBe(
			getModelColor("claude-3.5-sonnet", 0),
		);
	});

	it("falls back to the chart color sequence for unknown models", () => {
		expect(getModelColor("some-third-party-model", 1)).toBe(CHART_COLORS[1]);
	});

	it("still resolves an unregistered model via substring matching", () => {
		// A derived id that has no explicit entry borrows a base model's color
		// rather than falling through to the index-based sequence. The loop is
		// insertion-ordered and matches the first containing key, which is why
		// every registry model needs its own explicit entry.
		expect(getModelColor("claude-fable-5-preview", 3)).toBe(
			getModelColor(CLAUDE_MODEL_IDS.FABLE_5, 0),
		);
	});
});
