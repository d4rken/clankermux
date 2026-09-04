import { describe, expect, it } from "bun:test";
import {
	burnRatioTone,
	computeBurnRatio,
	formatBurnRatio,
} from "../burn-ratio";

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A weekly window that started `elapsedDays` ago. */
function weeklyReset(elapsedDays: number): number {
	return NOW + (7 - elapsedDays) * DAY;
}

describe("computeBurnRatio", () => {
	it("reads one day into a weekly window at 30% as burning over twice as fast", () => {
		// An even burn reaches 1/7 = 14.29% by day one, so 30% is 2.1x that.
		const burn = computeBurnRatio(30, weeklyReset(1), "seven_day", NOW);
		expect(burn).not.toBeNull();
		expect(burn?.expectedPct).toBeCloseTo(100 / 7, 6);
		expect(burn?.ratio).toBeCloseTo(2.1, 1);
	});

	it("reads the same day at 14.3% as exactly sustainable", () => {
		const burn = computeBurnRatio(100 / 7, weeklyReset(1), "seven_day", NOW);
		expect(burn?.ratio).toBeCloseTo(1.0, 6);
	});

	it("states nothing without a reset to measure the window against", () => {
		expect(computeBurnRatio(30, null, "seven_day", NOW)).toBeNull();
	});

	it("states nothing for a reset at or behind now", () => {
		// Both would clamp the expected percentage to 100 and make any usage read
		// as at-or-under pace: the most flattering answer from the least
		// trustworthy reading.
		expect(computeBurnRatio(30, NOW, "seven_day", NOW)).toBeNull();
		expect(computeBurnRatio(30, NOW - HOUR, "seven_day", NOW)).toBeNull();
	});

	it("states nothing five minutes into a window", () => {
		// Expected is ~0.06% here, so one percent of real usage would read as 16x
		// sustainable — arithmetically true and useless.
		const burn = computeBurnRatio(
			1,
			NOW + 5 * HOUR - 5 * 60_000,
			"five_hour",
			NOW,
		);
		expect(burn).toBeNull();
	});

	it("still speaks once the window is far enough in to divide by", () => {
		// Halfway through a five-hour window: expected 50%.
		const burn = computeBurnRatio(75, NOW + 2.5 * HOUR, "five_hour", NOW);
		expect(burn?.expectedPct).toBeCloseTo(50, 6);
		expect(burn?.ratio).toBeCloseTo(1.5, 6);
	});
});

describe("burnRatioTone", () => {
	it("treats just-above-even as sustainable", () => {
		// The reading is a quantised whole percent against a continuous clock, so
		// a pool burning exactly evenly oscillates either side of 1.0.
		expect(burnRatioTone({ ratio: 1.04, expectedPct: 50 })).toBe("success");
		expect(burnRatioTone({ ratio: 1.05, expectedPct: 50 })).toBe("warning");
	});

	it("escalates past half again the sustainable pace", () => {
		expect(burnRatioTone({ ratio: 1.49, expectedPct: 50 })).toBe("warning");
		expect(burnRatioTone({ ratio: 1.5, expectedPct: 50 })).toBe("destructive");
	});
});

describe("formatBurnRatio", () => {
	it("states one decimal", () => {
		expect(formatBurnRatio({ ratio: 1.34, expectedPct: 50 })).toBe(
			"1.3× sustainable pace",
		);
	});
});
