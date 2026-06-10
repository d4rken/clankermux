import { describe, expect, it } from "bun:test";
import { computeAllDueDates } from "../renewal";

/** Local-midnight ms for a calendar date (timezone-independent assertions). */
function localMs(y: number, m: number, d: number): number {
	return new Date(y, m, d).getTime();
}

describe("computeAllDueDates — degenerate inputs", () => {
	it("returns [] for a null anchor", () => {
		expect(
			computeAllDueDates(null, "monthly", null, localMs(2026, 5, 9)),
		).toEqual([]);
	});

	it("returns [] for an undefined anchor", () => {
		expect(
			computeAllDueDates(undefined, "monthly", null, localMs(2026, 5, 9)),
		).toEqual([]);
	});

	it("returns [] for an invalid anchor (impossible calendar date)", () => {
		expect(
			computeAllDueDates("2026-02-31", "monthly", null, localMs(2026, 5, 9)),
		).toEqual([]);
	});

	it("returns [] for cadence 'none'", () => {
		expect(
			computeAllDueDates("2026-01-15", "none", null, localMs(2026, 5, 9)),
		).toEqual([]);
	});

	it("returns [] for a null cadence", () => {
		expect(
			computeAllDueDates("2026-01-15", null, null, localMs(2026, 5, 9)),
		).toEqual([]);
	});

	it("returns [] for a future anchor", () => {
		expect(
			computeAllDueDates("2026-08-01", "monthly", null, localMs(2026, 5, 9)),
		).toEqual([]);
	});
});

describe("computeAllDueDates — monthly cadence", () => {
	it("returns every occurrence from the anchor through the until-date", () => {
		// Anchor Jan 15, until Apr 20 → Jan, Feb, Mar, Apr 15ths.
		expect(
			computeAllDueDates("2026-01-15", "monthly", null, localMs(2026, 3, 20)),
		).toEqual(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]);
	});

	it("clamps a Jan-31 anchor to Feb 28 in a non-leap year", () => {
		expect(
			computeAllDueDates("2026-01-31", "monthly", null, localMs(2026, 2, 1)),
		).toEqual(["2026-01-31", "2026-02-28"]);
	});

	it("clamps a Jan-31 anchor to Feb 29 in a leap year", () => {
		expect(
			computeAllDueDates("2028-01-31", "monthly", null, localMs(2028, 2, 1)),
		).toEqual(["2028-01-31", "2028-02-29"]);
	});

	it("returns every missed month across a multi-month gap (downtime catch-up)", () => {
		// fromDate in January, until in May → Jan..May occurrences all present.
		expect(
			computeAllDueDates(
				"2025-11-05",
				"monthly",
				"2026-01-01",
				localMs(2026, 4, 10),
			),
		).toEqual([
			"2026-01-05",
			"2026-02-05",
			"2026-03-05",
			"2026-04-05",
			"2026-05-05",
		]);
	});

	it("skips occurrences strictly before fromDate", () => {
		expect(
			computeAllDueDates(
				"2026-01-15",
				"monthly",
				"2026-03-01",
				localMs(2026, 3, 20),
			),
		).toEqual(["2026-03-15", "2026-04-15"]);
	});

	it("includes an occurrence falling exactly on fromDate", () => {
		expect(
			computeAllDueDates(
				"2026-01-15",
				"monthly",
				"2026-03-15",
				localMs(2026, 3, 20),
			),
		).toEqual(["2026-03-15", "2026-04-15"]);
	});

	it("includes the until-day itself when an occurrence is due that day", () => {
		expect(
			computeAllDueDates("2026-01-15", "monthly", null, localMs(2026, 2, 15)),
		).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
	});

	it("excludes an occurrence the day after the until-day", () => {
		expect(
			computeAllDueDates("2026-01-15", "monthly", null, localMs(2026, 2, 14)),
		).toEqual(["2026-01-15", "2026-02-15"]);
	});
});

describe("computeAllDueDates — yearly cadence", () => {
	it("returns one occurrence per year from the anchor forward", () => {
		expect(
			computeAllDueDates("2024-03-10", "yearly", null, localMs(2026, 5, 9)),
		).toEqual(["2024-03-10", "2025-03-10", "2026-03-10"]);
	});

	it("clamps a Feb-29 anchor to Feb 28 in non-leap years", () => {
		expect(
			computeAllDueDates("2024-02-29", "yearly", null, localMs(2028, 5, 1)),
		).toEqual([
			"2024-02-29",
			"2025-02-28",
			"2026-02-28",
			"2027-02-28",
			"2028-02-29",
		]);
	});

	it("respects fromDate for yearly cadence", () => {
		expect(
			computeAllDueDates(
				"2024-03-10",
				"yearly",
				"2026-01-01",
				localMs(2026, 5, 9),
			),
		).toEqual(["2026-03-10"]);
	});
});
