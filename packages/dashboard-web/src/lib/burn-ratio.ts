import { computeExpectedPct } from "@clankermux/core";
import type { OutlookTone } from "./pool-usage";

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
 * At/below this the pace is sustainable. Slightly above 1 because the reading is
 * a quantised whole percent against a continuously advancing clock, so a pool
 * burning exactly evenly oscillates a few points either side of 1.0 between
 * polls — a bare `< 1` would flicker amber on a pool doing nothing wrong.
 */
const SUSTAINABLE_RATIO = 1.05;

/** Above this the window runs out well before it resets, at the current pace. */
const HEAVY_RATIO = 1.5;

/**
 * Below this the expected percentage is too small to divide by: a window five
 * minutes old expects ~0.05%, so a single percent of real usage reads as 20x
 * sustainable. That is arithmetically true and useless — one request early in a
 * window is not a crisis — so the ratio is withheld rather than stated.
 */
const MIN_EXPECTED_PCT = 2;

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

/** "1.3× sustainable pace". One decimal: the input is a whole percent. */
export function formatBurnRatio(burn: BurnRatio): string {
	return `${burn.ratio.toFixed(1)}× sustainable pace`;
}

export function burnRatioTone(burn: BurnRatio): OutlookTone {
	if (burn.ratio < SUSTAINABLE_RATIO) return "success";
	if (burn.ratio < HEAVY_RATIO) return "warning";
	return "destructive";
}
