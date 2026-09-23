import { describe, expect, it } from "bun:test";
import type { ModelVariant } from "@clankermux/types";
import {
	describeModelVariant,
	selectEffortVariant,
	variantEffort,
} from "./effort-variants";

// Shapes taken from Devin's GetCliModelConfigs reply: the family label groups
// siblings, one entry carries the effort, the rest are other axes.
const swe2 = (effort: string, order: number) =>
	describeModelVariant("SWE-2", [
		{ key: "Reasoning Effort", name: effort, order },
	]);
const opus = (effort: string, order: number, fast: 0 | 1) =>
	describeModelVariant("Claude Opus 5", [
		{ key: "Effort", name: effort, order },
		{ key: "Thinking", name: "", order: 1 },
		{ key: "Fast Mode", name: "", order: fast },
		{ key: "1M Context", name: "", order: 0 },
	]);
const sol = (effort: string, order: number) =>
	describeModelVariant("GPT-5.6 Sol", [
		{ key: "Reasoning Effort", name: effort, order },
		{ key: "Fast Mode", name: "", order: 0 },
		{ key: "Prompt Cache Retention", name: "24h", order: 1 },
	]);
const catalogue: Record<string, ModelVariant | null> = {
	"swe-2-medium": swe2("Medium", 0),
	"swe-2-high": swe2("High", 1),
	"swe-2-max": swe2("Max", 2),
	"claude-opus-5-low": opus("Low", 0, 0),
	"claude-opus-5-high": opus("High", 2, 0),
	"claude-opus-5-max": opus("Max", 4, 0),
	"claude-opus-5-low-fast": opus("Low", 0, 1),
	"claude-opus-5-max-fast": opus("Max", 4, 1),
	"gpt-5-6-sol-none": sol("None", 0),
	"gpt-5-6-sol-medium": sol("Medium", 2),
	"gpt-5-6-sol-max": sol("Max", 5),
	"swe-1-7": describeModelVariant("", []),
};
const variants = Object.fromEntries(
	Object.entries(catalogue).filter(
		(entry): entry is [string, ModelVariant] => entry[1] !== null,
	),
);

describe("describeModelVariant", () => {
	it("maps Devin's effort names onto the canonical vocabulary", () => {
		expect(variantEffort("XHigh")).toBe("xhigh");
		expect(variantEffort("X-High")).toBe("xhigh");
		expect(variantEffort("None")).toBe("none");
		expect(variantEffort("Turbo")).toBeNull();
	});
	it("describes nothing for a model outside any family", () => {
		expect(catalogue["swe-1-7"]).toBeNull();
	});
	it("keeps the non-effort axes apart from the effort", () => {
		expect(catalogue["claude-opus-5-low"]?.dimensions).not.toBe(
			catalogue["claude-opus-5-low-fast"]?.dimensions,
		);
		expect(catalogue["claude-opus-5-low"]?.dimensions).toBe(
			catalogue["claude-opus-5-max"]?.dimensions,
		);
	});
});

describe("selectEffortVariant", () => {
	it("picks the sibling at the requested effort", () => {
		expect(selectEffortVariant("swe-2-max", "high", variants)).toBe(
			"swe-2-high",
		);
		expect(selectEffortVariant("swe-2-medium", "max", variants)).toBe(
			"swe-2-max",
		);
	});
	it("falls to the nearest lower effort, else the lowest that exists", () => {
		expect(selectEffortVariant("swe-2-max", "xhigh", variants)).toBe(
			"swe-2-high",
		);
		expect(selectEffortVariant("swe-2-max", "low", variants)).toBe(
			"swe-2-medium",
		);
		expect(selectEffortVariant("claude-opus-5-max", "medium", variants)).toBe(
			"claude-opus-5-low",
		);
	});
	it("keeps every other axis of the named variant", () => {
		expect(selectEffortVariant("claude-opus-5-max-fast", "low", variants)).toBe(
			"claude-opus-5-low-fast",
		);
		expect(selectEffortVariant("claude-opus-5-low", "max", variants)).toBe(
			"claude-opus-5-max",
		);
	});
	it("reaches a no-thinking variant only when none is asked for", () => {
		expect(selectEffortVariant("gpt-5-6-sol-max", "low", variants)).toBe(
			"gpt-5-6-sol-medium",
		);
		expect(selectEffortVariant("gpt-5-6-sol-max", "none", variants)).toBe(
			"gpt-5-6-sol-none",
		);
	});
	it("leaves the target alone when nothing can be mapped", () => {
		// No effort, or one outside the vocabulary: the alias target as written.
		expect(selectEffortVariant("swe-2-max", null, variants)).toBe("swe-2-max");
		expect(selectEffortVariant("swe-2-max", "thinking:8000", variants)).toBe(
			"swe-2-max",
		);
		// Not a known variant of anything.
		expect(selectEffortVariant("swe-1-7", "high", variants)).toBe("swe-1-7");
		expect(selectEffortVariant("glm-5.3", "high", variants)).toBe("glm-5.3");
	});
});
