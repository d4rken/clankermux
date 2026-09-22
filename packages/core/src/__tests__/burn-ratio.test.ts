import { describe, expect, it } from "bun:test";
import {
	burnRatioTone,
	computeBurnRatio,
	formatBurnCoverage,
	formatBurnRatio,
	poolBurnRatio,
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

	it("states nothing one minute into a five-hour window", () => {
		// Expected is 0.33% here, so one percent of real usage would read as 3x
		// sustainable — arithmetically true and useless.
		const burn = computeBurnRatio(1, NOW + 5 * HOUR - 60_000, "five_hour", NOW);
		expect(burn).toBeNull();
	});

	it("still speaks once the window is far enough in to divide by", () => {
		// Halfway through a five-hour window: expected 50%.
		const burn = computeBurnRatio(75, NOW + 2.5 * HOUR, "five_hour", NOW);
		expect(burn?.expectedPct).toBeCloseTo(50, 6);
		expect(burn?.ratio).toBeCloseTo(1.5, 6);
	});
});

describe("the early-window floor", () => {
	/** The instant an even burn reaches the floor, for a 7-day window. */
	const AT_FLOOR_WEEKLY = weeklyReset(7 * 0.01);

	it("speaks 1h41m into a weekly window, where an even burn reaches 1%", () => {
		const burn = computeBurnRatio(3, AT_FLOOR_WEEKLY, "seven_day", NOW);
		expect(burn?.expectedPct).toBeCloseTo(1, 6);
		expect(burn?.ratio).toBeCloseTo(3, 6);
	});

	it("still withholds a weekly window half an hour old", () => {
		expect(
			computeBurnRatio(3, weeklyReset(0.5 / 24), "seven_day", NOW),
		).toBeNull();
	});

	it("reads the smallest expressible usage at the floor as exactly on pace", () => {
		// `pct` arrives as a whole percent, so 1% is the smallest non-zero reading
		// there is. At the floor an even burn expects 1% too, which is why the
		// floor sits there: one unit of quantisation must not read as an alarm.
		const burn = computeBurnRatio(1, AT_FLOOR_WEEKLY, "seven_day", NOW);
		expect(burn?.ratio).toBeCloseTo(1, 6);
		expect(burnRatioTone({ ratio: burn?.ratio ?? 0, expectedPct: 1 })).toBe(
			"success",
		);
	});

	it("speaks three minutes into a five-hour window", () => {
		const burn = computeBurnRatio(
			5,
			NOW + 5 * HOUR - 0.01 * 5 * HOUR,
			"five_hour",
			NOW,
		);
		expect(burn?.expectedPct).toBeCloseTo(1, 6);
	});
});

describe("poolBurnRatio", () => {
	const bar = (pct: number | null, elapsedDays: number) => ({
		pct,
		resetMs: weeklyReset(elapsedDays),
	});

	it("averages the accounts that have an honest ratio and counts the rest", () => {
		// Three days in an even burn expects 42.86%, so 60% is 1.4x and 30% 0.7x.
		const burn = poolBurnRatio(
			[bar(60, 3), bar(30, 3), bar(9, 0.01)],
			"seven_day",
			NOW,
		);
		expect(burn?.measured).toBe(2);
		expect(burn?.total).toBe(3);
		expect(burn?.ratio).toBeCloseTo(1.05, 6);
	});

	it("states nothing when no account can be measured", () => {
		expect(poolBurnRatio([bar(9, 0.01)], "seven_day", NOW)).toBeNull();
		expect(poolBurnRatio([], "seven_day", NOW)).toBeNull();
	});

	it("counts an account with no reading in the total but not the average", () => {
		const burn = poolBurnRatio([bar(60, 3), bar(null, 3)], "seven_day", NOW);
		expect(burn?.measured).toBe(1);
		expect(burn?.total).toBe(2);
		expect(burn?.ratio).toBeCloseTo(1.4, 6);
	});

	it("refuses an unstarted window outright rather than via the floor", () => {
		// An unstarted window's reset is a placeholder the provider re-stamps on
		// every poll, so it is not a deadline and nothing may be measured against
		// it. Asserted at a reset the floor would happily admit, so the exclusion
		// cannot pass by accident when the floor moves.
		expect(
			poolBurnRatio(
				[{ pct: 30, resetMs: weeklyReset(3), unstarted: true }],
				"seven_day",
				NOW,
			),
		).toBeNull();
	});

	it("carries the mean expected position, never a stand-in zero", () => {
		const burn = poolBurnRatio([bar(60, 3), bar(30, 1)], "seven_day", NOW);
		expect(burn?.expectedPct).toBeCloseTo(((100 * 3) / 7 + 100 / 7) / 2, 6);
	});
});

describe("formatBurnCoverage", () => {
	it("says nothing when every account was measured", () => {
		expect(
			formatBurnCoverage({ ratio: 1, expectedPct: 50, measured: 4, total: 4 }),
		).toBeNull();
	});

	it("names the shortfall so a partial average is not read as the whole pool", () => {
		expect(
			formatBurnCoverage({ ratio: 1, expectedPct: 50, measured: 3, total: 4 }),
		).toBe("3 of 4 accounts");
		expect(
			formatBurnCoverage({ ratio: 1, expectedPct: 50, measured: 1, total: 4 }),
		).toBe("1 of 4 accounts");
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
