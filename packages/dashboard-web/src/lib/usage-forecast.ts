import type { ModelFamily } from "@clankermux/core";
import {
	computeWindowStartMs,
	estimateWindowExhaustion,
	extractFiveHour,
	extractSevenDay,
	isAnthropicStyleShape,
	normalizeAnthropicUsage,
} from "@clankermux/core";
import type { AccountResponse, AnthropicUsageData } from "@clankermux/types";
import {
	usageObservedAtMs,
	weeklyLifetimeConfidence,
	windowBurnAnchor,
} from "./lifetime-confidence";
import { type PoolWindow, pickBindingScopedLimit } from "./pool-usage";

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
 * line) and runs forward THROUGH the window's reset: it climbs (holding at 100%
 * once an at-risk account is projected to run out), steps down to 0% at the
 * reset the way a recorded roll-over does, and keeps going at the same rate for
 * {@link FORECAST_POST_RESET_TAIL_MS} into the fresh window. Only a reset past
 * the chart horizon clips the line at the horizon instead.
 * Paused / cooldown / exhausted accounts are held flat regardless of any
 * prediction. Pure + recharts-free so it can be unit-tested directly.
 */

/**
 * How far past a window's reset the dashed projection keeps going, per window
 * kind. The point of the tail is that the roll-over itself is visible: a line
 * that stopped AT the reset never showed the drop, only a truncated climb.
 * Product defaults, named here so they are tuned in one place — no env gate.
 */
export const FORECAST_POST_RESET_TAIL_MS = {
	five_hour: 2 * 60 * 60 * 1000, // 2 hours
	seven_day: 2 * 24 * 60 * 60 * 1000, // 2 days
	seven_day_scoped: 2 * 24 * 60 * 60 * 1000, // 2 days
} as const;

/** The window kinds a forecast line can be drawn for. */
type ForecastWindowKind = keyof typeof FORECAST_POST_RESET_TAIL_MS;

/**
 * Which window a forecast is asked for: one of the account-wide windows, or
 * one model family's scoped weekly window (the "Fable weekly window" panel).
 */
export type ForecastWindow =
	| PoolWindow
	| { kind: "family"; family: ModelFamily };

function forecastWindowKind(window: ForecastWindow): ForecastWindowKind {
	return typeof window === "string" ? window : "seven_day_scoped";
}

/**
 * The utilization and reset to project, for whichever window was asked for.
 *
 * A family window reads the account's scoped weekly limits and takes the
 * BINDING one (see pickBindingScopedLimit): an account reporting two limits
 * that fold onto one family gets one line, describing the window that actually
 * constrains it. Only Anthropic-style payloads carry scoped windows at all.
 */
function extractWindow(
	account: AccountResponse,
	window: ForecastWindow,
	now: number,
): { pct: number | null; resetMs: number | null } | null {
	if (!account.usageData) return null;
	if (typeof window === "string") {
		return window === "five_hour"
			? extractFiveHour(account.usageData)
			: extractSevenDay(account.usageData);
	}
	if (!isAnthropicStyleShape(account.usageData)) return null;
	const binding = pickBindingScopedLimit(
		normalizeAnthropicUsage(
			account.usageData as AnthropicUsageData,
			now,
		).weeklyScoped.filter((limit) => limit.family === window.family),
	);
	if (binding === null) return null;
	return { pct: binding.percent, resetMs: binding.resetsAtMs };
}

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
	windowKind: ForecastWindowKind; // selects the post-reset tail length
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
	window: ForecastWindow,
	now: number,
): LiveWindowState | null {
	if (!account.usageData) return null;

	const windowKind = forecastWindowKind(window);
	const extracted = extractWindow(account, window, now);
	if (!extracted || extracted.pct == null || extracted.resetMs == null) {
		return null;
	}

	const pct = extracted.pct;
	const resetMs = extracted.resetMs;
	// 0% carries no headroom signal, and a rolled window has nothing to project.
	// KNOWN LIMITATION: this also drops a freshly gifted/credited account from
	// the pool mean until its first non-zero reading, which nudges the pool line
	// up. Deliberate for now — a 0% account genuinely has no burn evidence, and
	// fabricating a slope for it would be worse than a one-tick gap.
	if (pct <= 0) return null;
	if (resetMs <= now) return null;

	// Unavailable accounts aren't burning, but must stay in the pool: hold them
	// flat at their current utilization until the window resets.
	const inCooldown =
		account.rateLimitedUntil != null && account.rateLimitedUntil > now;
	if (account.paused === true || inCooldown || pct >= 100) {
		return {
			accountId: account.id,
			windowKind,
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
	const burnStartMs = computeWindowStartMs(resetMs, windowKind);
	if (burnStartMs == null) return null;
	const elapsed = now - burnStartMs;
	if (elapsed <= 0) return null;

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
	// A family window gets NO regression: the server only fits the ACCOUNT-WIDE
	// series, so its %/hour is in units of a different numerator. Feeding it in
	// would emit a confident-looking projection built on a mismatched
	// denominator — the same reason computeFamilyWeeklyUsage passes null.
	const pred =
		typeof window !== "string"
			? null
			: window === "five_hour"
				? account.prediction?.fiveHour
				: account.prediction?.sevenDay;
	const estimate = estimateWindowExhaustion(
		{
			utilizationPct: pct,
			resetsAtMs: resetMs,
			windowStartMs: burnStartMs,
			prediction: pred,
			// Passed so this line cannot silently drift from the policy the
			// message and the at-risk list apply. The pair matters for the slope
			// too: a full-confidence lifetime slope is `pct` over the elapsed time
			// AT THE OBSERVATION, so the forecast line stops shallowing out
			// between refetches as `now` walks forward.
			// Asked of the shared policy, never assumed: today a scoped window is
			// "low" (unmeasured, and carrying no regression to have been compared
			// against), and the anchor registry holds account-wide windows only, so
			// both return the empty answer for a family. Going through the policy
			// means a future change reaches this line without another edit here.
			lifetimeConfidence: weeklyLifetimeConfidence(windowKind),
			observedAtMs: usageObservedAtMs(account.usageAsOfIso),
			anchor: windowBurnAnchor(account.burnAnchors, windowKind),
		},
		now,
	);
	const slopePerHour = estimate.slopePctPerHour ?? 0;

	let slopePerMs: number;
	let startMs: number;
	let exhaustsAtMs: number | null;
	if (slopePerHour <= 0) {
		// A non-positive recent slope (stable / recently idle / refunded) holds
		// FLAT at the current utilization — it must NOT revert to the
		// lifetime-average burn rate, which is exactly the copy this replaces.
		slopePerMs = 0; // flat hold (projectAt returns `pct` for slope 0)
		startMs = now;
		exhaustsAtMs = null;
	} else {
		// The 100% landing comes from the ESTIMATOR's ETA, never re-derived as
		// `now + (100 - pct) / slope`: for an observation-anchored estimate that
		// re-derivation moves the landing later by the reading's age on every
		// render tick, undoing exactly the drift the observation anchor removes.
		// The line still bridges at (now, pct); only where it reaches 100 is
		// pinned to the shared ETA.
		const eta =
			estimate.exhaustsAtMs ?? now + ((100 - pct) / slopePerHour) * 3_600_000;
		if (eta >= resetMs) {
			// Safe: draw with the estimator's own slope; the line ends at reset.
			slopePerMs = slopePerHour / 3_600_000;
			startMs = now - pct / slopePerMs; // virtual origin so pct(now) === pct
			exhaustsAtMs = null;
		} else if (eta <= now) {
			// The projected landing is already behind the wall clock (an aged
			// reading). Nothing sensible is left to draw as a ramp: hold flat and
			// report the run-out as immediate rather than inventing a slope.
			slopePerMs = 0;
			startMs = now;
			exhaustsAtMs = now;
		} else {
			slopePerMs = (100 - pct) / (eta - now);
			startMs = now - pct / slopePerMs;
			exhaustsAtMs = eta;
		}
	}
	const isSafe = exhaustsAtMs === null;

	return {
		accountId: account.id,
		windowKind,
		pct,
		startMs,
		resetMs,
		slopePerMs,
		isSafe,
		exhaustsAtMs,
		held: false,
	};
}

/** Projected utilization at an absolute future timestamp (clamped 0–100). */
function projectAt(state: LiveWindowState, ts: number): number {
	// Held accounts — and usable-but-stable accounts (slope 0) — are flat at their
	// current value; burning accounts follow pct(ts) = slope * (ts - startMs),
	// which equals `pct` at `now` and clamps at 100 from the projected exhaustion
	// instant onward (that flat-at-100 leg IS the prediction: out of quota until
	// the window rolls).
	if (ts <= state.resetMs) {
		if (state.held || state.slopePerMs === 0) return clampPct(state.pct);
		return clampPct(state.slopePerMs * (ts - state.startMs));
	}
	// Past the reset the window has rolled: everything restarts from 0. A held
	// account stays at 0 (paused/cooling down accounts are not burning, and
	// their pre-reset value was spent quota that no longer exists); a burning
	// account resumes the SAME rate from the reset instant.
	if (state.held || state.slopePerMs === 0) return 0;
	return clampPct(state.slopePerMs * (ts - state.resetMs));
}

/**
 * Where a single account's forecast line stops.
 *
 * If the reset falls inside the chart horizon the line always gets its drop and
 * its post-reset tail, even when that runs past the horizon — otherwise a
 * weekly reset more than two days before the end of the 7-day range would have
 * its roll-over clipped off the right edge, which is the one thing the tail
 * exists to show. The tail itself never exceeds the selected range's span, so a
 * 1-hour view cannot sprout a 2-hour tail. A reset BEYOND the horizon is not
 * reached at all, so the line simply ends at the horizon.
 *
 * `exhaustsAtMs` no longer truncates the line: an at-risk account's flat-at-100
 * leg is drawn up to the reset (see projectAt).
 */
function stateEndMs(
	state: LiveWindowState,
	now: number,
	horizonMs: number,
): number {
	if (state.resetMs > horizonMs) return horizonMs;
	const tailMs = Math.min(
		FORECAST_POST_RESET_TAIL_MS[state.windowKind],
		horizonMs - now,
	);
	return state.resetMs + tailMs;
}

/**
 * Cadence samples up to (and including) the exact stop point, plus the
 * roll-over pair at the reset.
 *
 * Keyed by ts so a cadence tick landing exactly on the reset (or on the
 * endpoint) cannot emit a duplicate x-value: the chart's axis is CATEGORICAL —
 * one equal-width slot per row — so a duplicated timestamp is a duplicated
 * slot. The reset pair is written last and therefore wins any collision.
 */
function buildPoints(
	state: LiveWindowState,
	now: number,
	endMs: number,
	cadenceMs: number,
): ForecastPoint[] {
	const byTs = new Map<number, number>();
	for (let ts = now + cadenceMs; ts < endMs; ts += cadenceMs) {
		byTs.set(ts, projectAt(state, ts));
	}
	// Always include the exact endpoint for a crisp end.
	byTs.set(endMs, projectAt(state, endMs));
	if (state.resetMs < endMs) addResetPair(byTs, state);
	return toSortedPoints(byTs);
}

/**
 * The roll-over: the value the line lands on at the reset, then 0% one
 * millisecond later. On the categorical axis that renders as a one-slot step
 * down — the same shape a recorded reset has between two history buckets.
 */
function addResetPair(byTs: Map<number, number>, state: LiveWindowState): void {
	byTs.set(state.resetMs, projectAt(state, state.resetMs));
	byTs.set(state.resetMs + 1, 0);
}

function toSortedPoints(byTs: Map<number, number>): ForecastPoint[] {
	return [...byTs.entries()]
		.sort(([a], [b]) => a - b)
		.map(([ts, pct]) => ({ ts, pct }));
}

/**
 * Compute dashed-forecast series for one window from live account data.
 *
 * @param cadenceMs  spacing between projected samples (use the history bucket size)
 * @param horizonMs  absolute timestamp cap (e.g. now + selected-range span) so a
 *                   7-day projection can't dwarf a short history range. A line
 *                   whose reset falls inside it still gets its post-reset tail
 *                   (see stateEndMs), so the drawn span can exceed it slightly.
 * @returns one entry per projectable account plus a trailing pool aggregate;
 *          empty when nothing is projectable
 */
export function computeWindowForecast(
	accounts: AccountResponse[],
	window: ForecastWindow,
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
		points: buildPoints(
			state,
			now,
			stateEndMs(state, now, horizonMs),
			cadenceMs,
		),
	}));

	// Pool aggregate: mean across all contributing accounts, drawn up to the
	// point where the FIRST member's own line ends. Every pool point is then a
	// mean over members that are all still drawn — nobody silently drops out of
	// the denominator mid-line. Member resets inside that span DO step the pool
	// line down, which is a real prediction (the member rolls over and its
	// contribution restarts at 0), not a member disappearing. A member whose
	// reset lies past the pool end contributes its pre-reset projection only,
	// and its own roll-over never appears in the pool line.
	const poolEndMs = Math.min(
		...states.map((s) => stateEndMs(s, now, horizonMs)),
	);
	const poolByTs = new Map<number, number>();
	for (let ts = now + cadenceMs; ts < poolEndMs; ts += cadenceMs) {
		poolByTs.set(ts, meanProjection(states, ts));
	}
	poolByTs.set(poolEndMs, meanProjection(states, poolEndMs));
	for (const state of states) {
		if (state.resetMs >= poolEndMs) continue;
		poolByTs.set(state.resetMs, meanProjection(states, state.resetMs));
		poolByTs.set(state.resetMs + 1, meanProjection(states, state.resetMs + 1));
	}

	series.push({
		accountId: null,
		isSafe: states.every((s) => s.isSafe),
		exhaustsAtMs: null,
		bridgePct: states.reduce((sum, s) => sum + s.pct, 0) / states.length,
		points: toSortedPoints(poolByTs),
	});

	return series;
}

function meanProjection(states: LiveWindowState[], ts: number): number {
	return states.reduce((sum, s) => sum + projectAt(s, ts), 0) / states.length;
}
