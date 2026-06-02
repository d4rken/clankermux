import { computeWindowStartMs } from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";
import {
	extractFiveHour,
	extractSevenDay,
	type PoolWindow,
} from "./pool-usage";

/**
 * Forward usage projection for the Limits-tab sawtooth charts.
 *
 * Mirrors the linear burn-rate model already used by `computePoolUsage`'s
 * `atRisk` calculation: given an account's current utilization `pct` observed
 * `elapsed` ms into its window, assume that same rate continues. The
 * projection is anchored at "now" (so the dashed forecast line meets the solid
 * history line) and runs forward until it stops — at 100% for an account
 * projected to exhaust before reset, or at the window reset / chart horizon
 * otherwise. Pure + recharts-free so it can be unit-tested directly.
 */

/** A single projected point on a forecast line. `pct` is clamped to 0–100. */
export interface ForecastPoint {
	ts: number;
	pct: number;
}

/**
 * A forward (dashed) projection for one account, or for the pool aggregate
 * when `accountId === null`. `bridgePct` is the value at "now" — the chart
 * plots it on both the solid (history) and dashed (forecast) keys so the two
 * lines visually join. `points` are strictly-future samples ending at the
 * stop point.
 */
export interface ForecastSeries {
	accountId: string | null;
	isSafe: boolean;
	exhaustsAtMs: number | null;
	bridgePct: number;
	points: ForecastPoint[];
}

/** Per-account live burn state used to drive the projection. */
interface LiveWindowState {
	accountId: string;
	pct: number; // current utilization, strictly within (0, 100)
	startMs: number; // window start (= now - elapsed)
	resetMs: number; // window reset, strictly in the future
	slopePerMs: number; // utilization-% gained per ms at the current rate
	isSafe: boolean; // false => projected to hit 100% before reset
	exhaustsAtMs: number | null; // projected time to reach 100% (at-risk only)
}

function clampPct(value: number): number {
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

/**
 * Build the live burn state for one account in one window, or null when it
 * can't be projected: paused, in an active rate-limit cooldown, no usage data,
 * window already reset, not actively burning (0%), or already exhausted
 * (>=100%). This deliberately matches the set of accounts `computePoolUsage`
 * treats as actively "contributing".
 */
function deriveLiveState(
	account: AccountResponse,
	window: PoolWindow,
	now: number,
): LiveWindowState | null {
	if (account.paused === true) return null;
	if (account.rateLimitedUntil != null && account.rateLimitedUntil > now) {
		return null;
	}
	if (!account.usageData) return null;

	const extracted =
		window === "five_hour"
			? extractFiveHour(account.usageData)
			: extractSevenDay(account.usageData);
	if (!extracted || extracted.pct == null || extracted.resetMs == null) {
		return null;
	}

	const pct = extracted.pct;
	const resetMs = extracted.resetMs;
	// f must be strictly inside (0, 1): 0% has no rate signal, >=100% is exhausted.
	if (pct <= 0 || pct >= 100) return null;
	if (resetMs <= now) return null;

	const startMs = computeWindowStartMs(resetMs, window);
	if (startMs == null) return null;
	const elapsed = now - startMs;
	if (elapsed <= 0) return null;

	const slopePerMs = pct / elapsed;
	const remainingMs = resetMs - now;
	// Time to climb the remaining (100 - pct) at the current rate — same model
	// as pool-usage.ts atRisk: timeToExhaust = ((1 - f) / f) * elapsed.
	const timeToExhaustMs = ((100 - pct) / pct) * elapsed;
	const isSafe = timeToExhaustMs >= remainingMs;

	return {
		accountId: account.id,
		pct,
		startMs,
		resetMs,
		slopePerMs,
		isSafe,
		exhaustsAtMs: isSafe ? null : now + timeToExhaustMs,
	};
}

/** Projected utilization at an absolute future timestamp (clamped 0–100). */
function projectAt(state: LiveWindowState, ts: number): number {
	// pct(ts) = slope * (ts - startMs); equals `pct` at `now` by construction.
	return clampPct(state.slopePerMs * (ts - state.startMs));
}

/** Where a single account's forecast line stops, capped at the chart horizon. */
function stateEndMs(state: LiveWindowState, horizonMs: number): number {
	const natural = state.isSafe ? state.resetMs : (state.exhaustsAtMs as number);
	return Math.min(natural, horizonMs);
}

/** Cadence samples up to (and including) the exact stop point. */
function buildPoints(
	state: LiveWindowState,
	now: number,
	endMs: number,
	cadenceMs: number,
): ForecastPoint[] {
	const points: ForecastPoint[] = [];
	for (let ts = now + cadenceMs; ts < endMs; ts += cadenceMs) {
		points.push({ ts, pct: projectAt(state, ts) });
	}
	// Always include the exact endpoint for a crisp end: 100% at projected
	// exhaustion, or the projected value at reset / horizon.
	points.push({ ts: endMs, pct: projectAt(state, endMs) });
	return points;
}

/**
 * Compute dashed-forecast series for one window from live account data.
 *
 * @param cadenceMs  spacing between projected samples (use the history bucket size)
 * @param horizonMs  absolute timestamp cap (e.g. now + selected-range span) so a
 *                   7-day projection can't dwarf a short history range
 * @returns one entry per projectable account plus a trailing pool aggregate;
 *          empty when nothing is projectable
 */
export function computeWindowForecast(
	accounts: AccountResponse[],
	window: PoolWindow,
	now: number,
	cadenceMs: number,
	horizonMs: number,
): ForecastSeries[] {
	if (!(cadenceMs > 0) || !(horizonMs > now)) return [];

	const states: LiveWindowState[] = [];
	for (const account of accounts) {
		const state = deriveLiveState(account, window, now);
		if (state) states.push(state);
	}
	if (states.length === 0) return [];

	const series: ForecastSeries[] = states.map((state) => ({
		accountId: state.accountId,
		isSafe: state.isSafe,
		exhaustsAtMs: state.exhaustsAtMs,
		bridgePct: state.pct,
		points: buildPoints(state, now, stateEndMs(state, horizonMs), cadenceMs),
	}));

	// Pool aggregate: mean across all contributing accounts, drawn only up to
	// the first window event (earliest reset/exhaustion) so every account is
	// present for the whole pool line — no confusing step-downs.
	const poolEndMs = Math.min(...states.map((s) => stateEndMs(s, horizonMs)));
	const poolPoints: ForecastPoint[] = [];
	for (let ts = now + cadenceMs; ts < poolEndMs; ts += cadenceMs) {
		poolPoints.push({ ts, pct: meanProjection(states, ts) });
	}
	poolPoints.push({ ts: poolEndMs, pct: meanProjection(states, poolEndMs) });

	series.push({
		accountId: null,
		isSafe: states.every((s) => s.isSafe),
		exhaustsAtMs: null,
		bridgePct: states.reduce((sum, s) => sum + s.pct, 0) / states.length,
		points: poolPoints,
	});

	return series;
}

function meanProjection(states: LiveWindowState[], ts: number): number {
	return states.reduce((sum, s) => sum + projectAt(s, ts), 0) / states.length;
}
