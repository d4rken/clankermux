import { describe, expect, it } from "bun:test";
import type { FullUsageData } from "@clankermux/types";
import {
	getScopedWeeklyLimits,
	hasSecondaryWeeklyWindows,
	parseSecondaryLimitIds,
} from "./secondary-limits";

const ISO = "2024-01-03T12:00:00.000Z";

const sessionEntry = {
	kind: "session",
	group: "session",
	percent: 0,
	resets_at: ISO,
	scope: null,
	is_active: false,
};

const weeklyAllEntry = {
	kind: "weekly_all",
	group: "weekly",
	percent: 41,
	resets_at: ISO,
	scope: null,
	is_active: false,
};

function scopedEntry(overrides: Record<string, unknown> = {}) {
	return {
		kind: "weekly_scoped",
		group: "weekly",
		percent: 69,
		resets_at: ISO,
		scope: { model: { id: null, display_name: "Fable" }, surface: null },
		is_active: true,
		...overrides,
	};
}

describe("getScopedWeeklyLimits", () => {
	it("returns the scoped weekly window with correct key/label/utilization/resetsAt", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry()],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Fable", label: "Fable", utilization: 69, resetsAt: ISO },
		]);
	});

	it("prefers scope.model.id as the key when present", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [
					scopedEntry({
						scope: {
							model: { id: "model-fable", display_name: "Fable" },
							surface: null,
						},
					}),
				],
			} as unknown as FullUsageData),
		).toEqual([
			{
				key: "model-fable",
				label: "Fable",
				utilization: 69,
				resetsAt: ISO,
			},
		]);
	});

	it("returns multiple scoped entries", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [
					scopedEntry({
						percent: 30,
						scope: { model: { id: null, display_name: "Opus" }, surface: null },
					}),
					scopedEntry({
						percent: 5,
						scope: {
							model: { id: null, display_name: "Sonnet" },
							surface: null,
						},
					}),
				],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Opus", label: "Opus", utilization: 30, resetsAt: ISO },
			{ key: "Sonnet", label: "Sonnet", utilization: 5, resetsAt: ISO },
		]);
	});

	it("excludes entries with missing or null percent", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ percent: null })],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("excludes entries with missing or null resets_at", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ resets_at: null })],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("excludes entries with a missing scope", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ scope: null })],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("excludes entries with a missing scope.model", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ scope: { model: null, surface: null } })],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("excludes entries with a missing scope.model.display_name", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [
					scopedEntry({
						scope: { model: { id: "x", display_name: null }, surface: null },
					}),
				],
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("ignores non-weekly_scoped kinds (session, weekly_all present but not returned)", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [sessionEntry, weeklyAllEntry, scopedEntry()],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Fable", label: "Fable", utilization: 69, resetsAt: ISO },
		]);
	});

	it("still renders a scoped entry with is_active: false (no filtering on is_active)", () => {
		expect(
			getScopedWeeklyLimits({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry({ is_active: false })],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Fable", label: "Fable", utilization: 69, resetsAt: ISO },
		]);
	});

	it("returns [] for non-Anthropic-shaped data", () => {
		expect(
			getScopedWeeklyLimits({
				tokens_limit: {
					used: 0,
					remaining: 0,
					percentage: 0,
					resetAt: null,
					type: "tokens",
				},
				time_limit: null,
			} as unknown as FullUsageData),
		).toEqual([]);
	});

	it("returns [] for null and undefined usageData", () => {
		expect(getScopedWeeklyLimits(null)).toEqual([]);
		expect(getScopedWeeklyLimits(undefined)).toEqual([]);
	});

	it("surfaces scoped windows from a limits[]-only payload (no flat keys)", () => {
		expect(
			getScopedWeeklyLimits({
				limits: [scopedEntry()],
			} as unknown as FullUsageData),
		).toEqual([
			{ key: "Fable", label: "Fable", utilization: 69, resetsAt: ISO },
		]);
	});

	it("returns [] for a non-Anthropic shape even if a scoped-looking entry sneaks in", () => {
		// No flat keys and no `limits[]` → not Anthropic-shaped → [].
		expect(
			getScopedWeeklyLimits({
				tokens_limit: {
					used: 0,
					remaining: 0,
					percentage: 0,
					resetAt: null,
					type: "tokens",
				},
				time_limit: null,
			} as unknown as FullUsageData),
		).toEqual([]);
	});
});

describe("hasSecondaryWeeklyWindows", () => {
	it("is true when a weekly_scoped limit entry would render", () => {
		expect(
			hasSecondaryWeeklyWindows({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [scopedEntry()],
			} as unknown as FullUsageData),
		).toBe(true);
	});

	it("is false when only five_hour / seven_day are present", () => {
		expect(
			hasSecondaryWeeklyWindows({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
			} as unknown as FullUsageData),
		).toBe(false);
	});

	it("is false when limits has no weekly_scoped entries", () => {
		expect(
			hasSecondaryWeeklyWindows({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				limits: [sessionEntry, weeklyAllEntry],
			} as unknown as FullUsageData),
		).toBe(false);
	});

	it("is false for null and undefined usageData", () => {
		expect(hasSecondaryWeeklyWindows(null)).toBe(false);
		expect(hasSecondaryWeeklyWindows(undefined)).toBe(false);
	});

	it("is false for a Zai-shaped object", () => {
		expect(
			hasSecondaryWeeklyWindows({
				tokens_limit: {
					used: 0,
					remaining: 0,
					percentage: 0,
					resetAt: null,
					type: "tokens",
				},
				time_limit: null,
			} as unknown as FullUsageData),
		).toBe(false);
	});

	it("is true from a limits[]-only payload with a scoped window (no flat keys)", () => {
		// The old both-flat-keys guard has been dropped: upstream is moving to a
		// `limits[]`-only payload, so a scoped window there must still be offered.
		expect(
			hasSecondaryWeeklyWindows({
				limits: [scopedEntry()],
			} as unknown as FullUsageData),
		).toBe(true);
	});

	it("is still true when only five_hour + scoped limits are present (partial flat)", () => {
		expect(
			hasSecondaryWeeklyWindows({
				five_hour: { utilization: 10, resets_at: ISO },
				limits: [scopedEntry()],
			} as unknown as FullUsageData),
		).toBe(true);
	});
});

describe("parseSecondaryLimitIds", () => {
	it("parses a valid JSON array of strings", () => {
		expect(parseSecondaryLimitIds('["a","b"]')).toEqual(["a", "b"]);
	});

	it("returns [] for null", () => {
		expect(parseSecondaryLimitIds(null)).toEqual([]);
	});

	it("returns [] for invalid JSON", () => {
		expect(parseSecondaryLimitIds("not json")).toEqual([]);
	});

	it("returns [] for a JSON object (not an array)", () => {
		expect(parseSecondaryLimitIds("{}")).toEqual([]);
	});

	it("returns [] for a JSON number (not an array)", () => {
		expect(parseSecondaryLimitIds("123")).toEqual([]);
	});

	it("de-duplicates while preserving first-seen order", () => {
		expect(parseSecondaryLimitIds('["a","a","b"]')).toEqual(["a", "b"]);
	});

	it("filters out non-string entries", () => {
		expect(parseSecondaryLimitIds('["a", 1, null, "b"]')).toEqual(["a", "b"]);
	});
});
