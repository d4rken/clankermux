import type { OutlookTone } from "./pool-usage";
import { computeExpectedPct } from "./throttle-utils";

/**
 * A percentage is a POSITION, not a rate.
 *
 * "48% used" says nothing about whether that is fine: 48% one day into a weekly
 * window is a pool heading for exhaustion on day three, and 48% six days in is a
 * pool that will finish the week with room to spare. The reader was left to do
 * that division in their head against a reset time printed on a different line.
 */
export interface BurnRatio {
	/** Actual utilization over the utilization an even burn would have reached. */
	ratio: number;
	/** Where an even burn would sit right now, 0-100. */
	expectedPct: number;
}

/**
 * A burn averaged over several accounts, carrying how many it could measure.
 *
 * The coverage travels WITH the ratio rather than beside it, because the two are
 * only meaningful together: "2.0x sustainable pace" over three of four accounts
 * and over four of four are different claims, and a caller handed a bare number
 * has no way to tell which one it is holding.
 */
export interface PoolBurnRatio extends BurnRatio {
	/** Accounts that yielded an honest ratio, and so are in the average. */
	measured: number;
	/** Accounts asked, including those with no ratio to give. */
	total: number;
}

/**
 * At/below this the pace is sustainable. Slightly above 1 because the reading is
 * a quantised whole percent against a continuously advancing clock, so a pool
 * burning exactly evenly oscillates a few points either side of 1.0 between
 * polls — a bare `< 1` would flicker amber on a pool doing nothing wrong.
 */
const SUSTAINABLE_RATIO = 1.05;

/** Above this the window runs out well before it resets, at the current pace. */
const HEAVY_RATIO = 1.5;

/**
 * Below this the expected percentage is too small to divide by: one minute into
 * a five-hour window an even burn expects 0.33%, so a single percent of real
 * usage reads as 3x sustainable. That is arithmetically true and useless — one
 * request early in a window is not a crisis — so the ratio is withheld rather
 * than stated.
 *
 * Set at 1 because `pct` arrives quantised to a whole percent. 1% is therefore
 * the smallest non-zero utilization the wire can express, and at this floor an
 * even burn expects exactly that much: the first reading a fresh window can
 * produce comes out at 1.0x — on pace — instead of as an alarm manufactured by
 * rounding. Halving it again would put that same reading at 2.0x, in the
 * destructive band, with no new evidence behind it.
 *
 * Expressed against the expected percentage rather than elapsed time so it
 * scales with the window: it clears 1h41m into a seven-day window and three
 * minutes into a five-hour one, which is the same amount of evidence in both.
 */
const MIN_EXPECTED_PCT = 1;

/**
 * How the observed burn compares with the pace that would exactly consume the
 * window, or null when no honest comparison is available.
 *
 * `expectedPct` comes from `@clankermux/core`, never a local copy: the same
 * function positions the pace tick on the account usage bars and is the baseline
 * the server's proactive throttle compares against, so a fork here would let the
 * dashboard call a pace sustainable that the proxy is actively throttling.
 */
export function computeBurnRatio(
	pct: number,
	resetMs: number | null,
	windowKind: "five_hour" | "seven_day",
	now: number,
): BurnRatio | null {
	if (resetMs == null) return null;
	// A reset at or behind `now` would clamp `expectedPct` to 100 and make any
	// utilization read as at-or-under pace — the most flattering possible answer
	// out of the least trustworthy possible reading.
	if (resetMs <= now) return null;
	const expectedPct = computeExpectedPct(resetMs, windowKind, now);
	if (expectedPct == null) return null;
	if (expectedPct < MIN_EXPECTED_PCT) return null;
	return { ratio: pct / expectedPct, expectedPct };
}

/** The per-account fields {@link poolBurnRatio} reads, as the pool bars carry them. */
export interface BurnRatioSource {
	pct: number | null;
	resetMs: number | null;
	/**
	 * A window the provider has not started. Its reset is a placeholder re-stamped
	 * on every poll, so it is not a deadline and nothing may be divided by it.
	 */
	unstarted?: boolean;
}

/**
 * The mean burn across a pool's accounts, over however many of them can be
 * measured.
 *
 * PARTIAL BY DESIGN. An all-or-nothing average goes dark for the whole pool the
 * moment one account joins, resets or reports nothing — which is exactly when a
 * reader most wants to know how the rest are doing — and it goes dark silently,
 * leaving no way to tell a pool with no evidence from a pool with plenty. Every
 * other partial-knowledge figure on the same cards ("3 of 4 accounts
 * reporting", "1 not yet projectable") already states its shortfall instead.
 *
 * So the accounts that cannot be measured are dropped from the average and
 * COUNTED, and a caller that renders the ratio without {@link formatBurnCoverage}
 * beside it presents a partial reading as the whole pool.
 *
 * An unstarted window is refused outright rather than left to the floor. Its
 * reset slides forward on every poll, so the expected percentage it produces is
 * near zero by construction and happens to fall below the floor today — an
 * accident the floor's value must not be allowed to revoke.
 */
export function poolBurnRatio(
	accounts: readonly BurnRatioSource[],
	windowKind: "five_hour" | "seven_day",
	now: number,
): PoolBurnRatio | null {
	const measured: BurnRatio[] = [];
	for (const account of accounts) {
		if (account.pct == null || account.unstarted) continue;
		const burn = computeBurnRatio(
			account.pct,
			account.resetMs,
			windowKind,
			now,
		);
		if (burn != null) measured.push(burn);
	}
	if (measured.length === 0) return null;
	const mean = (pick: (burn: BurnRatio) => number) =>
		measured.reduce((sum, burn) => sum + pick(burn), 0) / measured.length;
	return {
		ratio: mean((burn) => burn.ratio),
		// The mean of the positions the ratios were taken against. Staggered
		// windows sit at different points in their week, so no single account's
		// expected percentage describes the average above it.
		expectedPct: mean((burn) => burn.expectedPct),
		measured: measured.length,
		total: accounts.length,
	};
}

/** The shortfall behind a pooled ratio, or null when there is none to state. */
export function formatBurnCoverage(burn: PoolBurnRatio): string | null {
	if (burn.measured >= burn.total) return null;
	return `${burn.measured} of ${burn.total} accounts`;
}

/** "1.3× sustainable pace". One decimal: the input is a whole percent. */
export function formatBurnRatio(burn: BurnRatio): string {
	return `${burn.ratio.toFixed(1)}× sustainable pace`;
}

export function burnRatioTone(burn: BurnRatio): OutlookTone {
	if (burn.ratio < SUSTAINABLE_RATIO) return "success";
	if (burn.ratio < HEAVY_RATIO) return "warning";
	return "destructive";
}
