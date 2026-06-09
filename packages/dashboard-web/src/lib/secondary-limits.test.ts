import { describe, expect, it } from "bun:test";
import type { FullUsageData } from "@clankermux/types";
import {
	hasAnthropicSecondaryWindow,
	hasSecondaryWeeklyWindows,
	parseSecondaryLimitIds,
} from "./secondary-limits";

const ISO = "2024-01-03T12:00:00.000Z";

describe("hasSecondaryWeeklyWindows", () => {
	it("is true when seven_day_opus has a numeric utilization and a reset string", () => {
		expect(
			hasSecondaryWeeklyWindows({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				seven_day_opus: { utilization: 30, resets_at: ISO },
			} as unknown as FullUsageData),
		).toBe(true);
	});

	it("is true when seven_day_sonnet has a numeric utilization and a reset string", () => {
		expect(
			hasSecondaryWeeklyWindows({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				seven_day_sonnet: { utilization: 5, resets_at: ISO },
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

	it("is false when seven_day_opus.resets_at is null even if utilization is a number", () => {
		expect(
			hasSecondaryWeeklyWindows({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				seven_day_opus: { utilization: 30, resets_at: null },
			} as unknown as FullUsageData),
		).toBe(false);
	});

	it("is false when seven_day_opus.utilization is null even if resets_at is present", () => {
		expect(
			hasSecondaryWeeklyWindows({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day: { utilization: 20, resets_at: ISO },
				seven_day_opus: { utilization: null, resets_at: ISO },
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

	it("is false when seven_day is absent (mirrors hasAnthropicStyleData — bars would not render)", () => {
		expect(
			hasSecondaryWeeklyWindows({
				five_hour: { utilization: 10, resets_at: ISO },
				seven_day_opus: { utilization: 30, resets_at: ISO },
			} as unknown as FullUsageData),
		).toBe(false);
	});
});

describe("hasAnthropicSecondaryWindow", () => {
	it("is true for a numeric utilization with a non-null reset", () => {
		expect(
			hasAnthropicSecondaryWindow({ utilization: 30, resets_at: ISO }),
		).toBe(true);
	});

	it("is false for null / undefined windows", () => {
		expect(hasAnthropicSecondaryWindow(null)).toBe(false);
		expect(hasAnthropicSecondaryWindow(undefined)).toBe(false);
	});

	it("is false when utilization is null or reset is null", () => {
		expect(
			hasAnthropicSecondaryWindow({ utilization: null, resets_at: ISO }),
		).toBe(false);
		expect(
			hasAnthropicSecondaryWindow({ utilization: 30, resets_at: null }),
		).toBe(false);
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
