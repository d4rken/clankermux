import { describe, expect, it } from "bun:test";
import {
	WEEKLY_RED_MIN_WINDOW_AGE_MS,
	weeklyLifetimeConfidence,
	weeklyRedEligible,
} from "./lifetime-confidence";

const HOUR = 60 * 60_000;

describe("weeklyRedEligible", () => {
	it("holds the weekly window at amber until it has run the declared floor", () => {
		expect(WEEKLY_RED_MIN_WINDOW_AGE_MS).toBe(72 * HOUR);
		expect(weeklyRedEligible("seven_day", 71 * HOUR)).toBe(false);
		// The floor itself qualifies: strict `<` is what withholds.
		expect(weeklyRedEligible("seven_day", 72 * HOUR)).toBe(true);
		expect(weeklyRedEligible("seven_day", 100 * HOUR)).toBe(true);
	});

	it("constrains no other window kind", () => {
		expect(weeklyRedEligible("five_hour", 2 * HOUR)).toBe(true);
		expect(weeklyRedEligible("weekly_scoped:fable", 2 * HOUR)).toBe(true);
		expect(weeklyRedEligible(null, 0)).toBe(true);
		// A five-hour window with no span is still not this rule's business.
		expect(weeklyRedEligible("five_hour", null)).toBe(true);
	});

	it("treats an unknown window age as not red-eligible", () => {
		// A window whose structural start cannot be derived has no reset to
		// measure a margin against either, so it carries no red to allow.
		expect(weeklyRedEligible("seven_day", null)).toBe(false);
		expect(weeklyRedEligible("seven_day", undefined)).toBe(false);
		expect(weeklyRedEligible("seven_day", Number.NaN)).toBe(false);
	});

	it("measures the window, not the burn anchor behind the estimate", () => {
		// A gift reset restarts the ESTIMATE's evidence span but not the window.
		// Measured against the span, a window with two days left could never go
		// red again after a gift; the first hour after the anchor is already
		// amber-capped by the estimate's own `lowConfidence`.
		expect(weeklyRedEligible("seven_day", 120 * HOUR)).toBe(true);
	});

	it("is the tone rule only — the confidence policy is unchanged", () => {
		// Both halves of the weekly policy still answer as they did: the window
		// keeps its full-confidence lifetime estimate, and only the tone waits.
		expect(weeklyLifetimeConfidence("seven_day")).toBe("full");
		expect(weeklyLifetimeConfidence("five_hour")).toBeUndefined();
	});
});
