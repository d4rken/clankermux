import { describe, expect, it } from "bun:test";
import {
	computeRenewal,
	RENEWAL_IMMINENT_DAYS,
	RENEWAL_SOON_DAYS,
} from "./renewal";

// Fixed "now": 2026-06-09 (a Tuesday) at local midnight. Built from local
// components so the assertions are independent of the machine's timezone.
const NOW = new Date(2026, 5, 9).getTime();

/** Convenience: build a local-midnight Date for comparison. */
function localDate(y: number, m: number, d: number): Date {
	return new Date(y, m, d);
}

describe("computeRenewal — empty / invalid anchor", () => {
	it("returns the empty result for a null anchor", () => {
		expect(computeRenewal(null, "monthly", NOW)).toEqual({
			nextDate: null,
			daysLeft: null,
			urgency: "none",
		});
	});

	it("returns the empty result for an empty-string anchor", () => {
		expect(computeRenewal("", "monthly", NOW)).toEqual({
			nextDate: null,
			daysLeft: null,
			urgency: "none",
		});
	});

	it("returns the empty result for an undefined anchor", () => {
		expect(computeRenewal(undefined, "monthly", NOW)).toEqual({
			nextDate: null,
			daysLeft: null,
			urgency: "none",
		});
	});

	it("returns the empty result for a malformed anchor", () => {
		expect(computeRenewal("not-a-date", "monthly", NOW)).toEqual({
			nextDate: null,
			daysLeft: null,
			urgency: "none",
		});
	});

	it("returns the empty result for an impossible calendar date", () => {
		// Feb 31 would roll over to March with naive Date construction.
		expect(computeRenewal("2026-02-31", "monthly", NOW)).toEqual({
			nextDate: null,
			daysLeft: null,
			urgency: "none",
		});
	});
});

describe("computeRenewal — monthly cadence", () => {
	it("picks a future day-of-month in the current month", () => {
		// Anchor day 20; today is the 9th → next is 2026-06-20.
		const result = computeRenewal("2026-06-20", "monthly", NOW);
		expect(result.nextDate).toEqual(localDate(2026, 5, 20));
		expect(result.daysLeft).toBe(11);
		expect(result.urgency).toBe("none");
	});

	it("rolls to next month when the day-of-month already passed", () => {
		// Anchor day 5; today is the 9th → next is 2026-07-05.
		const result = computeRenewal("2026-06-05", "monthly", NOW);
		expect(result.nextDate).toEqual(localDate(2026, 6, 5));
		expect(result.daysLeft).toBe(26);
	});

	it("uses an old anchor's day-of-month, rolling forward to today's frame", () => {
		// Anchor from 2024 on day 15 → next occurrence on or after today is
		// 2026-06-15.
		const result = computeRenewal("2024-01-15", "monthly", NOW);
		expect(result.nextDate).toEqual(localDate(2026, 5, 15));
		expect(result.daysLeft).toBe(6);
		expect(result.urgency).toBe("soon");
	});

	it("clamps a day-31 anchor in a 30-day month (June)", () => {
		// Anchor day 31; today is 2026-06-09. June has 30 days → 2026-06-30.
		const result = computeRenewal("2026-01-31", "monthly", NOW);
		expect(result.nextDate).toEqual(localDate(2026, 5, 30));
	});

	it("clamps a day-31 anchor into February (28 days, non-leap)", () => {
		// now = 2026-02-09 so the next monthly hit lands in Feb.
		const feb = new Date(2026, 1, 9).getTime();
		const result = computeRenewal("2026-01-31", "monthly", feb);
		expect(result.nextDate).toEqual(localDate(2026, 1, 28));
	});
});

describe("computeRenewal — yearly cadence", () => {
	it("picks a future month/day in the current year", () => {
		// Anchor 2020-08-01 → next yearly on/after 2026-06-09 is 2026-08-01.
		const result = computeRenewal("2020-08-01", "yearly", NOW);
		expect(result.nextDate).toEqual(localDate(2026, 7, 1));
	});

	it("rolls to next year when the month/day already passed", () => {
		// Anchor 2020-03-01 → already past June → 2027-03-01.
		const result = computeRenewal("2020-03-01", "yearly", NOW);
		expect(result.nextDate).toEqual(localDate(2027, 2, 1));
	});

	it("clamps a Feb-29 anchor to Feb 28 in a non-leap year", () => {
		// now = 2027-01-15 (2027 is not a leap year). Anchor 2024-02-29 → the
		// next yearly hit is 2027-02-28.
		const jan2027 = new Date(2027, 0, 15).getTime();
		const result = computeRenewal("2024-02-29", "yearly", jan2027);
		expect(result.nextDate).toEqual(localDate(2027, 1, 28));
	});
});

describe("computeRenewal — one-time ('none')", () => {
	it("returns the literal future date with correct daysLeft and urgency", () => {
		const result = computeRenewal("2026-06-14", "none", NOW);
		expect(result.nextDate).toEqual(localDate(2026, 5, 14));
		expect(result.daysLeft).toBe(5);
		expect(result.urgency).toBe("soon");
	});

	it("reports a past one-time date as 'past' with negative daysLeft", () => {
		const result = computeRenewal("2026-06-01", "none", NOW);
		expect(result.nextDate).toEqual(localDate(2026, 5, 1));
		expect(result.daysLeft).toBe(-8);
		expect(result.urgency).toBe("past");
	});

	it("treats a null cadence the same as 'none'", () => {
		const result = computeRenewal("2026-06-14", null, NOW);
		expect(result.nextDate).toEqual(localDate(2026, 5, 14));
		expect(result.daysLeft).toBe(5);
	});
});

describe("computeRenewal — urgency thresholds", () => {
	it("exactly 7 days out is 'soon'", () => {
		const result = computeRenewal("2026-06-16", "none", NOW);
		expect(result.daysLeft).toBe(RENEWAL_SOON_DAYS);
		expect(result.urgency).toBe("soon");
	});

	it("exactly 2 days out is 'imminent'", () => {
		const result = computeRenewal("2026-06-11", "none", NOW);
		expect(result.daysLeft).toBe(RENEWAL_IMMINENT_DAYS);
		expect(result.urgency).toBe("imminent");
	});

	it("today (0 days) is 'imminent'", () => {
		const result = computeRenewal("2026-06-09", "none", NOW);
		expect(result.daysLeft).toBe(0);
		expect(result.urgency).toBe("imminent");
	});

	it("8 days out is 'none'", () => {
		const result = computeRenewal("2026-06-17", "none", NOW);
		expect(result.daysLeft).toBe(8);
		expect(result.urgency).toBe("none");
	});
});
