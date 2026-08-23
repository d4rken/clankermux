import {
	computeWindowStartMs,
	estimateWindowExhaustion,
	extractFiveHour,
	extractSevenDay,
} from "@clankermux/core";
import type { AccountResponse } from "@clankermux/types";
import { weeklyLifetimeConfidence } from "./lifetime-confidence";
import type { PoolWindow } from "./pool-usage";

/**
 * Forward usage projection for the Limits-tab sawtooth charts.
 *
 * For an actively-burning account the forward slope comes from
 * `estimateWindowExhaustion`, shared with the progress-bar projection and the
 * pool at-risk list: the server-side regression prediction
 * (`AccountResponse.prediction`) when one is trustworthy for that window,
 * otherwise the lifetime-average burn rate (current utilization `pct` observed
 * `elapsed` ms into the window, assumed to continue). Either way the projection
 * is anchored at "now" (so the dashed forecast line meets the solid history
 * line) and runs forward until it stops — at 100% for an account projected to
 * exhaust before reset, or at the window reset / chart horizon otherwise.
 * Paused / cooldown / exhausted accounts are held flat regardless of any
 * prediction. Pure + recharts-free so it can be unit-tested directly.
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
	pct: number; // current utilization (clamped 0–100)
	startMs: number; // window start (= now - elapsed); `now` for held states
	resetMs: number; // window reset, strictly in the future
	slopePerMs: number; // utilization-% gained per ms at the current rate (0 when held)
	isSafe: boolean; // false => projected to hit / already at 100% before reset
	exhaustsAtMs: number | null; // projected time to reach 100% (at-risk only)
	held: boolean; // true => flat (not burning): paused, in cooldown, or exhausted
}

function clampPct(value: number): number {
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

/**
 * Build the live burn state for one account in one window, or null when there
 * is nothing to plot: no usage data, window already reset, or no value / 0%
 * (no headroom signal). Accounts that are *unavailable but still part of the
 * pool* — paused, in an active rate-limit cooldown, or already exhausted
 * (>=100%) — are NOT dropped: they return a `held` (flat) state so the
 * projected pool average keeps counting them. Dropping a maxed account would
 * make the pool look healthier the instant it got worse.
 */
function deriveLiveState(
	account: AccountResponse,
	window: PoolWindow,
	now: number,
): LiveWindowState | null {
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
	// 0% carries no headroom signal, and a rolled window has nothing to project.
	if (pct <= 0) return null;
	if (resetMs <= now) return null;

	// Unavailable accounts aren't burning, but must stay in the pool: hold them
	// flat at their current utilization until the window resets.
	const inCooldown =
		account.rateLimitedUntil != null && account.rateLimitedUntil > now;
	if (account.paused === true || inCooldown || pct >= 100) {
		return {
			accountId: account.id,
			pct: clampPct(pct),
			startMs: now,
			resetMs,
			slopePerMs: 0,
			isSafe: pct < 100, // already-maxed => not safe; paused-below-100 => safe
			exhaustsAtMs: null,
			held: true,
		};
	}

	// Actively burning: 0 < pct < 100.
	const burnStartMs = computeWindowStartMs(resetMs, window);
	if (burnStartMs == null) return null;
	const elapsed = now - burnStartMs;
	if (elapsed <= 0) return null;

	const remainingMs = resetMs - now;

	// Slope source: the shared estimator, which prefers a trustworthy server-side
	// regression prediction for this window and otherwise falls back to the
	// lifetime-average burn rate. Only the *slope* is taken from it — the
	// flat-hold branch above (paused / cooldown / exhausted) is never reached
	// here, so neither a positive regression slope nor the estimator's
	// "already-exhausted" reading can make a held account burn.
	//
	// The line is anchored at the live utilization `pct` at `now` via a *virtual*
	// window start (`now - pct/slope`), so `projectAt`, `stateEndMs` and
	// `buildPoints` are reused verbatim for both paths: at `now` the line reads
	// `pct`, and it reaches exactly 100 at the recomputed exhaustion time. This
	// anchor is chart rendering, deliberately different from the progress-bar
	// message's anchor, and so stays here rather than moving into the estimator.
	const pred =
		window === "five_hour"
			? account.prediction?.fiveHour
			: account.prediction?.sevenDay;
	const slopePerHour =
		estimateWindowExhaustion(
			{
				utilizationPct: pct,
				resetsAtMs: resetMs,
				windowStartMs: burnStartMs,
				prediction: pred,
				// Only the slope is read here, and the lifetime slope is the same
				// number either way — passed so this line cannot silently drift from
				// the policy the message and the at-risk list apply.
				lifetimeConfidence: weeklyLifetimeConfidence(window),
			},
			now,
		).slopePctPerHour ?? 0;

	let slopePerMs: number;
	let startMs: number;
	let timeToExhaustMs: number;
	if (slopePerHour > 0) {
		slopePerMs = slopePerHour / 3_600_000; // % per hour -> % per ms
		startMs = now - pct / slopePerMs; // virtual origin so pct(now) === pct
		timeToExhaustMs = (100 - pct) / slopePerMs;
	} else {
		// A non-positive recent slope (stable / recently idle / refunded) holds
		// FLAT at the current utilization — it must NOT revert to the
		// lifetime-average burn rate, which is exactly the copy this replaces.
		slopePerMs = 0; // flat hold (projectAt returns `pct` for slope 0)
		startMs = now;
		timeToExhaustMs = Number.POSITIVE_INFINITY;
	}
	const isSafe = timeToExhaustMs >= remainingMs;

	return {
		accountId: account.id,
		pct,
		startMs,
		resetMs,
		slopePerMs,
		isSafe,
		exhaustsAtMs: isSafe ? null : now + timeToExhaustMs,
		held: false,
	};
}

/** Projected utilization at an absolute future timestamp (clamped 0–100). */
function projectAt(state: LiveWindowState, ts: number): number {
	// Held accounts — and usable-but-stable accounts (slope 0) — are flat at their
	// current value; burning accounts follow pct(ts) = slope * (ts - startMs),
	// which equals `pct` at `now`.
	if (state.held || state.slopePerMs === 0) return clampPct(state.pct);
	return clampPct(state.slopePerMs * (ts - state.startMs));
}

/** Where a single account's forecast line stops, capped at the chart horizon. */
function stateEndMs(state: LiveWindowState, horizonMs: number): number {
	// Held states and safe burning states run to the window reset; only an
	// at-risk burning account stops early at its projected exhaustion. The
	// `exhaustsAtMs == null` check covers held states (isSafe false, no
	// exhaustion time) and also narrows the type without a cast.
	const natural =
		state.isSafe || state.exhaustsAtMs == null
			? state.resetMs
			: state.exhaustsAtMs;
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
