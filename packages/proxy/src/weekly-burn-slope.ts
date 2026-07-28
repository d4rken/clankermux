/**
 * In-memory store of the per-account WEEKLY burn slope (percent of the weekly
 * window consumed per hour), fitted by the usage-snapshot sampler with the pure
 * least-squares estimator in `@clankermux/core`.
 *
 * The pool-liveness reserve reads it to size its release horizon on the account's
 * ACTUAL burn instead of a single static constant: an account burning fast needs
 * its reserved tail released sooner than one barely spending. Like
 * `protected-family-demand.ts` this is a routing HINT, not persisted state — an
 * empty map after a restart simply makes every gate fall back to the static
 * tier-scaled horizon until the sampler's bootstrap fit lands.
 *
 * Two properties are load-bearing:
 *
 *  - **Freshness is keyed on the EVIDENCE, never on the recomputation time.**
 *    `observedAt` is the newest snapshot that contributed to the fit. Refitting
 *    unchanged history must not make a stale slope look fresh, or a pool whose
 *    usage polling has died would keep steering on a slope from hours ago.
 *  - **A slope only applies to the window it was fitted on.** The fit runs over
 *    the account-wide `seven_day` series; the gate may be bound by a different
 *    weekly window (`seven_day_oauth_apps`, or the same window after a roll).
 *    `resolveEffectiveWeeklySlope` is the ONE place that check lives, shared by
 *    every call site so the validation cannot drift.
 */

import type { CapacitySignal } from "@clankermux/types";

/**
 * How old the newest contributing snapshot may be before the fitted slope stops
 * being applied. 15 minutes ≈ 7 sampler ticks (2 min cadence), so a couple of
 * missed samples are tolerated while a dead sampler / dead usage poller stops
 * steering the gate within minutes.
 */
export const WEEKLY_SLOPE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * How far the fitted window's reset may differ from the gate's BINDING weekly
 * reset and still be considered the same window. 5 minutes: real polls report the
 * same reset instant with ~±1s of jitter, and a genuinely different weekly window
 * (or a rolled one) is many hours away — far outside this band.
 */
export const WEEKLY_SLOPE_RESET_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

/** What the sampler records for one account. */
export interface WeeklyBurnSlopeRecord {
	/** Percent of the weekly window consumed per hour (may be ≤ 0). */
	slopePctPerHour: number;
	/** The estimator's confidence gate — filtered on READ, recorded as-is. */
	lowConfidence: boolean;
	/** Newest contributing snapshot's sample time (epoch ms) — the EVIDENCE age. */
	observedAt: number;
	/** Reset instant (epoch ms) of the weekly window the fit was run on. */
	windowResetMs: number;
}

/** What a reader gets back once the entry has passed the usability filters. */
export interface WeeklyBurnSlopeEntry {
	slopePctPerHour: number;
	windowResetMs: number;
}

const slopes = new Map<string, WeeklyBurnSlopeRecord>();

/**
 * Record `accountId`'s latest weekly burn fit, overwriting any earlier one.
 *
 * `observedAt` MUST be the newest contributing snapshot's sample time, never
 * `Date.now()` at recomputation: freshness is a property of the evidence.
 */
export function recordWeeklyBurnSlope(
	accountId: string,
	record: WeeklyBurnSlopeRecord,
): void {
	slopes.set(accountId, { ...record });
}

/**
 * The usable slope entry for `accountId`, or `null`.
 *
 * Null when the account has no record, the evidence is older than
 * `WEEKLY_SLOPE_MAX_AGE_MS`, the fit was flagged `lowConfidence`, or the slope
 * is not a finite number. The SIGN is deliberately not filtered here: a flat or
 * negative slope is a legitimate observation, and the gate decides what to do
 * with it (it falls back to the static horizon).
 */
export function getWeeklyBurnSlope(
	accountId: string,
	now: number,
): WeeklyBurnSlopeEntry | null {
	const entry = slopes.get(accountId);
	if (!entry) return null;
	if (entry.lowConfidence) return null;
	if (!Number.isFinite(entry.slopePctPerHour)) return null;
	if (!Number.isFinite(entry.observedAt)) return null;
	if (now - entry.observedAt > WEEKLY_SLOPE_MAX_AGE_MS) return null;
	return {
		slopePctPerHour: entry.slopePctPerHour,
		windowResetMs: entry.windowResetMs,
	};
}

/**
 * The slope a routing gate may actually apply to `capacity`, or `null`.
 *
 * On top of `getWeeklyBurnSlope`'s usability filters this enforces the
 * window-identity check: the slope is only applied when the capacity signal has
 * a known BINDING weekly reset and the fitted window's reset matches it within
 * `WEEKLY_SLOPE_RESET_MATCH_TOLERANCE_MS`. A slope fitted on the account-wide
 * `seven_day` series must never steer a gate bound by a different weekly window.
 */
export function resolveEffectiveWeeklySlope(
	accountId: string,
	capacity: CapacitySignal | null,
	now: number,
): number | null {
	if (capacity === null) return null;
	const bindingReset = capacity.bindingWeeklyResetMs;
	if (bindingReset == null || !Number.isFinite(bindingReset)) return null;

	const entry = getWeeklyBurnSlope(accountId, now);
	if (entry === null) return null;
	if (!Number.isFinite(entry.windowResetMs)) return null;
	if (
		Math.abs(entry.windowResetMs - bindingReset) >
		WEEKLY_SLOPE_RESET_MATCH_TOLERANCE_MS
	) {
		return null;
	}
	return entry.slopePctPerHour;
}
