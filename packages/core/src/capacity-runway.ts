import type {
	RunwayCause,
	RunwayOutcome,
	UsagePrediction,
} from "@clankermux/types";
import { isUsablePrediction } from "@clankermux/types";
import { TIME_CONSTANTS } from "./constants";

/**
 * The outcome vocabulary lives in `@clankermux/types` (see `types/runway.ts`)
 * so the `/api/runway` wire types can reference it without making the leaf
 * types package depend on core. Re-exported here so this module stays the one
 * import site for everything runway-shaped on the server and the dashboard.
 */
export type { RunwayCause, RunwayOutcome };

/**
 * Quota-exhaustion estimation, and the pool-level "runway" built on top of it.
 *
 * Two layers live here because they answer two different questions from the
 * same evidence:
 *
 *  - {@link estimateWindowExhaustion} — when does THIS window hit 100%? It is
 *    the single implementation of the projection the dashboard used to carry in
 *    three verbatim copies (the progress-bar message, the pool at-risk list and
 *    the forecast chart). It returns FACTS ONLY; each caller keeps its own copy
 *    and tone mapping, so consolidating it changes no user-visible text.
 *
 *  - {@link computeCapacityRunway} — how long can the POOL keep going at the
 *    current pace before every account in it is out of quota at the same
 *    instant?
 *
 * Scope of "out of quota" for the runway: the account-wide 5-hour and weekly
 * windows only. Pauses, rate-limit cooldowns, usage throttling and the
 * provider-overload breaker are deliberately IGNORED — runway answers "when
 * does the quota run out", not "what is routable right now", so a paused or
 * cooling account still counts as capacity.
 */

const HOUR_MS = TIME_CONSTANTS.HOUR;

/** Where a window's exhaustion estimate came from. */
export type WindowExhaustionSource =
	/** Server least-squares fit; `exhaustsAtMs` is SAMPLE-anchored. */
	| "regression"
	/** Legacy lifetime-average fallback; `exhaustsAtMs` is NOW-anchored. */
	| "lifetime-average"
	/** Utilization is already at/above 100. */
	| "already-exhausted"
	/** Window is readable, but nothing has been used yet. */
	| "no-usage"
	/** No usable evidence at all. */
	| "none";

export interface WindowExhaustionInput {
	utilizationPct: number;
	resetsAtMs: number | null;
	/** From `computeWindowStartMs`. */
	windowStartMs: number | null;
	/** Passed UNGATED — the estimator applies `isUsablePrediction` itself. */
	prediction: UsagePrediction | null | undefined;
}

export interface WindowExhaustion {
	source: WindowExhaustionSource;
	/** %/hour. `null` when there is no evidence — never 0-as-unknown. */
	slopePctPerHour: number | null;
	/** Projected 100% instant, or null when not projected to exhaust. */
	exhaustsAtMs: number | null;
	/**
	 * True on the lifetime-average path. Callers cap severity on THIS, not on
	 * which function ran, so the "the fallback projection never renders red"
	 * rule survives the consolidation.
	 */
	lowConfidence: boolean;
}

const NO_EVIDENCE: WindowExhaustion = {
	source: "none",
	slopePctPerHour: null,
	exhaustsAtMs: null,
	lowConfidence: false,
};

/**
 * Estimate when one usage window reaches 100%.
 *
 * Branch order reproduces the behaviour the three call sites rendered before
 * they shared this function, and must not be reordered:
 *
 *  1. Already at/above 100 — decided BEFORE the reset guards, because a spent
 *     window with a stale or absent reset is still definitely spent.
 *  2. Structural guards. A reset that has already passed is rejected here, as
 *     all three legacy copies rejected it.
 *  3. A usable server regression owns the slope. `etaExhaustMs` is used
 *     VERBATIM and never recomputed: it is anchored to the newest sample inside
 *     `computeUsagePrediction`, so recomputing it as `now + headroom / slope`
 *     would push projected exhaustion further out on every UI tick between
 *     refetches. A non-positive slope holds flat and must NOT fall through to
 *     the lifetime average.
 *  4. Nothing used yet. Placed AFTER the regression branch because a usable
 *     prediction wins at 0% too.
 *  5. Lifetime average over the elapsed window, anchored at `now`.
 */
export function estimateWindowExhaustion(
	input: WindowExhaustionInput,
	now: number,
): WindowExhaustion {
	const { utilizationPct: pct, resetsAtMs, windowStartMs, prediction } = input;

	if (!Number.isFinite(pct)) return NO_EVIDENCE;

	if (pct >= 100) {
		return {
			source: "already-exhausted",
			slopePctPerHour: null,
			exhaustsAtMs: now,
			lowConfidence: false,
		};
	}

	if (windowStartMs === null || resetsAtMs === null) return NO_EVIDENCE;
	if (!Number.isFinite(windowStartMs) || !Number.isFinite(resetsAtMs)) {
		return NO_EVIDENCE;
	}
	if (resetsAtMs <= now) return NO_EVIDENCE;
	if (windowStartMs >= resetsAtMs) return NO_EVIDENCE;

	if (isUsablePrediction(prediction, resetsAtMs)) {
		const slope = Math.max(0, prediction.slopePerHour);
		return {
			source: "regression",
			slopePctPerHour: slope,
			exhaustsAtMs: slope > 0 ? prediction.etaExhaustMs : null,
			lowConfidence: false,
		};
	}

	if (pct <= 0) {
		return {
			source: "no-usage",
			slopePctPerHour: null,
			exhaustsAtMs: null,
			lowConfidence: false,
		};
	}

	const elapsed = now - windowStartMs;
	if (elapsed <= 0) return NO_EVIDENCE;

	return {
		source: "lifetime-average",
		slopePctPerHour: (pct / elapsed) * HOUR_MS,
		exhaustsAtMs: now + ((100 - pct) / pct) * elapsed,
		lowConfidence: true,
	};
}

/**
 * How far ahead the runway scan models. A STATED MODELLING LIMIT, not a proof
 * of "never": the 5-hour and 7-day cycles only jointly repeat every 35 days, so
 * a staggered pool can have its first all-out instant well past two weeks.
 * `beyond-horizon` therefore carries the horizon it actually checked.
 */
export const RUNWAY_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Safety cap on projected cycles per window. Real windows are 5 hours or
 * longer, so a 14-day horizon needs at most ~67 cycles; the cap only exists so
 * a nonsense sub-second window duration cannot spin the projection loop.
 */
const MAX_PROJECTED_CYCLES = 4096;

export interface RunwayWindowInput {
	/** Opaque window identifier, e.g. "five_hour" | "seven_day". */
	windowKind: string;
	utilizationPct: number;
	resetsAtMs: number | null;
	windowStartMs: number | null;
	prediction: UsagePrediction | null | undefined;
}

export interface RunwayAccountInput {
	accountId: string;
	/** Provider exposes no account-wide quota window at all (ollama, PayG). */
	unmetered: boolean;
	windows: RunwayWindowInput[];
}

/** A half-open [startMs, endMs) span during which something has no quota. */
interface DeadInterval {
	startMs: number;
	endMs: number;
}

interface WindowDeadInterval extends DeadInterval {
	windowKind: string;
}

interface PooledAccount {
	accountId: string;
	/** Pre-union, per-window — used for cause attribution. */
	windowIntervals: WindowDeadInterval[];
	/** Unioned across this account's windows — used for the all-dead test. */
	union: DeadInterval[];
}

/**
 * Dead intervals contributed by one window inside `[now, now + horizonMs)`.
 *
 * A window is "dead" from the moment it is projected to hit 100% until it
 * resets, and again for the same tail of every subsequent cycle it is projected
 * to spend. Without the later cycles, a pool whose 5-hour windows are all spent
 * every cycle but happen not to overlap in the current one would report no
 * run-out at all.
 */
function windowDeadIntervals(
	window: RunwayWindowInput,
	estimate: WindowExhaustion,
	now: number,
	horizonEndMs: number,
): WindowDeadInterval[] {
	const intervals: WindowDeadInterval[] = [];
	const push = (startMs: number, endMs: number): void => {
		const clampedStart = Math.max(startMs, now);
		const clampedEnd = Math.min(endMs, horizonEndMs);
		if (clampedEnd > clampedStart) {
			intervals.push({
				windowKind: window.windowKind,
				startMs: clampedStart,
				endMs: clampedEnd,
			});
		}
	};

	const resetsAtMs = window.resetsAtMs;

	if (estimate.source === "already-exhausted") {
		// Spent right now. When the reset is unknown or stale the recovery time is
		// unknown too — hold it dead for the whole horizon rather than dropping a
		// definite current unavailability.
		if (resetsAtMs != null && resetsAtMs > now) push(now, resetsAtMs);
		else push(now, horizonEndMs);
		return intervals;
	}

	if (estimate.exhaustsAtMs == null) return intervals;
	// Guaranteed by the estimator: anything that projects an exhaustion instant
	// passed the reset/window-start guards.
	if (resetsAtMs == null || window.windowStartMs == null) return intervals;

	if (estimate.exhaustsAtMs < resetsAtMs) {
		push(estimate.exhaustsAtMs, resetsAtMs);
	}

	const slope = estimate.slopePctPerHour;
	if (slope == null || slope <= 0) return intervals;
	const durationMs = resetsAtMs - window.windowStartMs;
	if (durationMs <= 0) return intervals;
	const timeToFullMs = (100 / slope) * HOUR_MS;
	// A window that cannot be spent within a whole cycle is never dead in a later
	// cycle, so it contributes nothing beyond the current one.
	if (!(timeToFullMs < durationMs)) return intervals;

	for (let cycle = 0; cycle < MAX_PROJECTED_CYCLES; cycle++) {
		const cycleStartMs = resetsAtMs + cycle * durationMs;
		const deadFromMs = cycleStartMs + timeToFullMs;
		if (deadFromMs >= horizonEndMs) break;
		push(deadFromMs, cycleStartMs + durationMs);
	}

	return intervals;
}

/** Merge overlapping or touching intervals into a minimal ascending set. */
function unionIntervals(intervals: DeadInterval[]): DeadInterval[] {
	if (intervals.length === 0) return [];
	const sorted = intervals
		.map((interval) => ({ startMs: interval.startMs, endMs: interval.endMs }))
		.sort((a, b) => a.startMs - b.startMs);
	const merged: DeadInterval[] = [sorted[0]];
	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i];
		const last = merged[merged.length - 1];
		if (current.startMs <= last.endMs) {
			last.endMs = Math.max(last.endMs, current.endMs);
		} else {
			merged.push(current);
		}
	}
	return merged;
}

function isDeadAt(intervals: DeadInterval[], t: number): boolean {
	return intervals.some(
		(interval) => interval.startMs <= t && t < interval.endMs,
	);
}

/**
 * How long the pool can keep going at the current pace before EVERY account in
 * it is simultaneously out of account-wide quota.
 *
 * Accounts with no readable window are excluded from the pool and reported in
 * `unprojectableAccountIds`. Excluding an account can only SHORTEN the computed
 * runway, so a `runway` result carrying unprojectable accounts is a documented
 * lower bound — never a fabricated zero.
 */
export function computeCapacityRunway(
	accounts: RunwayAccountInput[],
	now: number,
	horizonMs: number = RUNWAY_HORIZON_MS,
): RunwayOutcome {
	if (accounts.length === 0) return { kind: "no-accounts" };

	const horizonEndMs = now + horizonMs;
	const pooled: PooledAccount[] = [];
	const unprojectableAccountIds: string[] = [];

	for (const account of accounts) {
		if (account.unmetered) {
			// No account-wide quota window exists, so this account never runs out on
			// quota grounds. Positively known to be alive, NOT unknown.
			pooled.push({
				accountId: account.accountId,
				windowIntervals: [],
				union: [],
			});
			continue;
		}

		const windowIntervals: WindowDeadInterval[] = [];
		let readable = false;
		for (const window of account.windows) {
			const estimate = estimateWindowExhaustion(
				{
					utilizationPct: window.utilizationPct,
					resetsAtMs: window.resetsAtMs,
					windowStartMs: window.windowStartMs,
					prediction: window.prediction,
				},
				now,
			);
			if (estimate.source === "none") continue;
			// Evidence is tracked separately from intervals on purpose: a readable
			// window that emits NO dead interval is positively known to stay
			// available, which is the opposite of unknown.
			readable = true;
			windowIntervals.push(
				...windowDeadIntervals(window, estimate, now, horizonEndMs),
			);
		}

		if (!readable) {
			unprojectableAccountIds.push(account.accountId);
			continue;
		}

		pooled.push({
			accountId: account.accountId,
			windowIntervals,
			// Unioned per account BEFORE scanning, so an interval that starts while
			// the account is already dead from another window cannot be misreported
			// as the moment the pool ran out.
			union: unionIntervals(windowIntervals),
		});
	}

	if (pooled.length === 0) return { kind: "unknown" };

	// The first all-dead instant is either `now` or a moment at which some
	// account transitions from alive to dead — which is exactly the start of one
	// of its unioned dead intervals. Testing those candidates is therefore
	// complete, not a sampling approximation.
	const candidates = new Set<number>([now]);
	for (const account of pooled) {
		for (const interval of account.union) {
			if (interval.startMs >= now && interval.startMs < horizonEndMs) {
				candidates.add(interval.startMs);
			}
		}
	}

	for (const t of [...candidates].sort((a, b) => a - b)) {
		if (!pooled.every((account) => isDeadAt(account.union, t))) continue;

		const causes: RunwayCause[] = [];
		for (const account of pooled) {
			for (const interval of account.windowIntervals) {
				if (interval.startMs <= t && t < interval.endMs) {
					causes.push({
						accountId: account.accountId,
						windowKind: interval.windowKind,
					});
				}
			}
		}

		if (t === now) return { kind: "out-now", causes, unprojectableAccountIds };
		return {
			kind: "runway",
			exhaustsAtMs: t,
			durationMs: t - now,
			causes,
			unprojectableAccountIds,
		};
	}

	return { kind: "beyond-horizon", horizonMs, unprojectableAccountIds };
}
