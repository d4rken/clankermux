/**
 * Pure, self-contained subscription-renewal date logic. No dependencies so it
 * can be unit-tested with an injected `now`. The dashboard uses this to derive
 * the next renewal occurrence and an urgency level for the per-account renewal
 * status chip; the server uses it to derive due dates for the payments ledger.
 *
 * All date math is done in LOCAL calendar days: anchors are parsed as local
 * midnight and compared against local-midnight "today", so day-granularity
 * results are DST-safe.
 *
 * NOTE: this is a leaf subpath (`@clankermux/core/renewal`) — deliberately not
 * exported from the core barrel index to keep it import-weight-free, mirroring
 * `@clankermux/core/env`.
 */

/** Within this many days of renewal the chip turns amber ("soon"). */
export const RENEWAL_SOON_DAYS = 7;
/** Within this many days of renewal the chip turns red ("imminent"). */
export const RENEWAL_IMMINENT_DAYS = 2;

export type RenewalCadence = "monthly" | "yearly" | "none";
export type RenewalUrgency = "none" | "soon" | "imminent" | "past";

export interface RenewalInfo {
	/** Next occurrence >= today (local), or the literal date for "none". */
	nextDate: Date | null;
	/** Whole local-calendar days from today to nextDate; negative if past. */
	daysLeft: number | null;
	urgency: RenewalUrgency;
}

const MS_PER_DAY = 86_400_000;

const EMPTY_RESULT: RenewalInfo = {
	nextDate: null,
	daysLeft: null,
	urgency: "none",
};

/** Local midnight of the day containing `ms`. */
function localMidnight(ms: number): Date {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Number of days in the given month (monthIndex is 0-based). */
function daysInMonth(year: number, monthIndex: number): number {
	// Day 0 of the next month is the last day of this month.
	return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * Parse a "YYYY-MM-DD" string as a LOCAL midnight date. Returns null for empty
 * input or anything that doesn't parse to that exact calendar date (guards
 * against rollover like "2026-02-31"). NOTE: deliberately avoids
 * `new Date("YYYY-MM-DD")`, which parses as UTC and shifts the day in non-UTC
 * timezones.
 */
export function parseAnchor(
	anchor: string,
): { year: number; month: number; day: number } | null {
	const parts = anchor.split("-");
	if (parts.length !== 3) return null;
	const year = Number(parts[0]);
	const month = Number(parts[1]); // 1-based as written
	const day = Number(parts[2]);
	if (
		!Number.isInteger(year) ||
		!Number.isInteger(month) ||
		!Number.isInteger(day)
	) {
		return null;
	}
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const date = new Date(year, month - 1, day);
	// Reject values that rolled over (e.g. Feb 31 → Mar 3).
	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day ||
		Number.isNaN(date.getTime())
	) {
		return null;
	}
	return { year, month: month - 1, day };
}

function classifyUrgency(daysLeft: number): RenewalUrgency {
	if (daysLeft < 0) return "past";
	if (daysLeft <= RENEWAL_IMMINENT_DAYS) return "imminent";
	if (daysLeft <= RENEWAL_SOON_DAYS) return "soon";
	return "none";
}

/**
 * Next recurring occurrence on or after `today`. `advance` moves the (year,
 * month) cursor one cadence step forward; the day is clamped to the cursor
 * month's length each step (so Jan 31 → Feb 28/29, etc.).
 */
function nextRecurrence(
	startYear: number,
	startMonth: number,
	anchorDay: number,
	today: Date,
	advance: (year: number, month: number) => { year: number; month: number },
): Date {
	let year = startYear;
	let month = startMonth;
	// Bounded so a pathological input can never loop forever (covers any
	// realistic gap between an anchor and "now" by centuries).
	for (let i = 0; i < 100_000; i++) {
		const day = Math.min(anchorDay, daysInMonth(year, month));
		const candidate = new Date(year, month, day);
		if (candidate.getTime() >= today.getTime()) {
			return candidate;
		}
		({ year, month } = advance(year, month));
	}
	// Fallback (unreachable in practice): clamp to the start cursor.
	return new Date(
		startYear,
		startMonth,
		Math.min(anchorDay, daysInMonth(startYear, startMonth)),
	);
}

/**
 * Compute the next renewal occurrence and its urgency for the given anchor and
 * cadence.
 *
 * - `anchor` null/empty → the empty result (no chip).
 * - `"none"` (or null cadence): the literal anchor date; may be in the past.
 * - `"monthly"`: next date on the anchor's day-of-month >= today, clamping the
 *   day to the target month's length (e.g. day 31 → Feb 28/29).
 * - `"yearly"`: next date on the anchor's month/day >= today, clamping Feb 29 →
 *   Feb 28 on non-leap years.
 */
export function computeRenewal(
	anchor: string | null | undefined,
	cadence: "monthly" | "yearly" | "none" | null | undefined,
	now: number = Date.now(),
): RenewalInfo {
	if (!anchor) return EMPTY_RESULT;
	const parsed = parseAnchor(anchor);
	if (!parsed) return EMPTY_RESULT;

	const today = localMidnight(now);
	const effectiveCadence: RenewalCadence = cadence ?? "none";

	let nextDate: Date;

	if (effectiveCadence === "none") {
		nextDate = new Date(parsed.year, parsed.month, parsed.day);
	} else if (effectiveCadence === "monthly") {
		nextDate = nextRecurrence(
			parsed.year,
			parsed.month,
			parsed.day,
			today,
			(year, month) =>
				month === 11
					? { year: year + 1, month: 0 }
					: { year, month: month + 1 },
		);
	} else {
		// yearly
		nextDate = nextRecurrence(
			parsed.year,
			parsed.month,
			parsed.day,
			today,
			(year, month) => ({ year: year + 1, month }),
		);
	}

	const daysLeft = Math.round(
		(nextDate.getTime() - today.getTime()) / MS_PER_DAY,
	);

	return {
		nextDate,
		daysLeft,
		urgency: classifyUrgency(daysLeft),
	};
}

/** Zero-padded local "YYYY-MM-DD" for the given calendar components. */
function formatLocalDate(
	year: number,
	monthIndex: number,
	day: number,
): string {
	const mm = String(monthIndex + 1).padStart(2, "0");
	const dd = String(day).padStart(2, "0");
	return `${year}-${mm}-${dd}`;
}

/**
 * Every due date (YYYY-MM-DD) for a recurring renewal, from the anchor forward,
 * bounded to [fromDate, untilMs-as-local-date], inclusive on both ends.
 * - anchor/cadence invalid or cadence 'none'/null → []
 * - fromDate (YYYY-MM-DD, nullable): occurrences strictly before it are skipped
 *   (lower bound preventing historical auto-backfill)
 * - iteration-capped (same 100_000 bound as nextRecurrence)
 * - day-of-month clamping identical to nextRecurrence (Jan 31 → Feb 28/29)
 */
export function computeAllDueDates(
	anchor: string | null | undefined,
	cadence: "monthly" | "yearly" | "none" | null | undefined,
	fromDate: string | null,
	untilMs: number,
): string[] {
	if (!anchor) return [];
	if (cadence !== "monthly" && cadence !== "yearly") return [];
	const parsed = parseAnchor(anchor);
	if (!parsed) return [];

	const untilTime = localMidnight(untilMs).getTime();
	const parsedFrom = fromDate ? parseAnchor(fromDate) : null;
	const fromTime = parsedFrom
		? new Date(parsedFrom.year, parsedFrom.month, parsedFrom.day).getTime()
		: null;

	const advance: (
		year: number,
		month: number,
	) => { year: number; month: number } =
		cadence === "monthly"
			? (year, month) =>
					month === 11
						? { year: year + 1, month: 0 }
						: { year, month: month + 1 }
			: (year, month) => ({ year: year + 1, month });

	const dueDates: string[] = [];
	let year = parsed.year;
	let month = parsed.month;
	// Bounded so a pathological input can never loop forever (covers any
	// realistic gap between an anchor and "now" by centuries).
	for (let i = 0; i < 100_000; i++) {
		const day = Math.min(parsed.day, daysInMonth(year, month));
		const occurrence = new Date(year, month, day).getTime();
		if (occurrence > untilTime) break;
		if (fromTime === null || occurrence >= fromTime) {
			dueDates.push(formatLocalDate(year, month, day));
		}
		({ year, month } = advance(year, month));
	}
	return dueDates;
}
