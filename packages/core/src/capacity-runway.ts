import type {
	RunwayAssumedCredits,
	RunwayBand,
	RunwayCause,
	RunwayOutcome,
	UsageBurnAnchor,
	UsagePrediction,
} from "@clankermux/types";
import {
	isUsablePrediction,
	RESET_JITTER_TOLERANCE_MS,
} from "@clankermux/types";
import { TIME_CONSTANTS } from "./constants";

/**
 * The outcome vocabulary lives in `@clankermux/types` (see `types/runway.ts`)
 * so the `/api/runway` wire types can reference it without making the leaf
 * types package depend on core. Re-exported here so this module stays the one
 * import site for everything runway-shaped on the server and the dashboard.
 */
export type { RunwayAssumedCredits, RunwayBand, RunwayCause, RunwayOutcome };

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
 * windows only. The composition layer excludes paused accounts before passing
 * inputs to this model. Temporary rate-limit cooldowns, usage throttling and
 * overload are not modeled here: quota windows describe when capacity returns.
 */

const HOUR_MS = TIME_CONSTANTS.HOUR;

/** Where a window's exhaustion estimate came from. */
export type WindowExhaustionSource =
	/** Server least-squares fit; `exhaustsAtMs` is SAMPLE-anchored. */
	| "regression"
	/** Legacy lifetime-average fallback; `exhaustsAtMs` is NOW-anchored. */
	| "lifetime-average"
	/**
	 * Lifetime average as the window's PRIMARY estimator rather than a fallback;
	 * `exhaustsAtMs` is OBSERVATION-anchored (see `observedAtMs`). Distinct from
	 * "lifetime-average" in two ways: the caller has declared it the measured best
	 * estimator for this window so it is not capped at amber, and because it may
	 * therefore reach red it is anchored to the reading rather than to `now`.
	 */
	| "lifetime-primary"
	/** Utilization is already at/above 100. */
	| "already-exhausted"
	/** Window is readable, but nothing has been used yet. */
	| "no-usage"
	/**
	 * Readable at 0% AND the structural start coincides with the observation:
	 * the window has not started. Providers slide `resets_at = now + duration`
	 * on every poll until the first request pins the window, so the reset is a
	 * moving placeholder and NOT a deadline. Distinct from `no-usage`, which is
	 * a started window nobody has spent anything in yet.
	 */
	| "unstarted"
	/** No usable evidence at all. */
	| "none";

/**
 * How much the CALLER trusts the lifetime average for one particular window.
 *
 * `"low"` (the default when the field is absent) is the historical behaviour:
 * the lifetime average is a fallback nobody measured, so it is flagged
 * low-confidence and every surface caps its severity at amber.
 *
 * `"full"` says the caller has evidence that the lifetime average is the best
 * estimator available for THAT window, so it should be rendered with the same
 * confidence as a regression. It requires an `observedAtMs` to go with it and
 * DEGRADES to `"low"` without one — see {@link WindowExhaustionInput}.
 *
 * Deliberately caller-supplied and never derived here from window duration or
 * kind: which estimator wins on which horizon is a measured, changeable fact
 * about the data, not a property of the arithmetic in this module.
 */
export type LifetimeConfidence = "low" | "full";

export interface WindowExhaustionInput {
	utilizationPct: number;
	resetsAtMs: number | null;
	/** From `computeWindowStartMs`. */
	windowStartMs: number | null;
	/** Passed UNGATED — the estimator applies `isUsablePrediction` itself. */
	prediction: UsagePrediction | null | undefined;
	/** Absent means `"low"` — see {@link LifetimeConfidence}. */
	lifetimeConfidence?: LifetimeConfidence;
	/**
	 * When the reading in `utilizationPct` was OBSERVED — the live-usage fetch
	 * time, or the sample time of the snapshot it came from. Null/absent when the
	 * source cannot honestly say (a payload-reconstructed reading), which is a
	 * real answer and never `Date.now()` at render time.
	 *
	 * Required by the `lifetimeConfidence: "full"` path, and by ANY anchored
	 * estimate (see `anchor` below) — an anchor only applies to a reading that
	 * can be placed at/after it.
	 * The lifetime ETA is `anchor + ((100 - pct) / pct) · (anchor - windowStart)`,
	 * so anchoring it at `now` moves it later by MORE than a second per second of
	 * wall clock on evidence that has not changed. Amber-capped that is invisible;
	 * on the full-confidence path it walks the reset margin across the red
	 * threshold between two UI ticks. Anchoring at the observation instant makes
	 * the estimate a function of the reading alone, so it holds still until the
	 * next refetch.
	 */
	observedAtMs?: number | null;
	/**
	 * The last mid-window downward revision observed for this window — a
	 * provider "gift" reset or an applied reset credit. When present AND valid
	 * for this window instance (reset identity within jitter tolerance, instant
	 * inside the window span, and a known `observedAtMs` at/after the anchor —
	 * a reading that predates the revision or cannot be placed must not be mixed
	 * with it), BOTH lifetime paths measure elapsed time and
	 * consumed percentage from it instead of from the structural window start:
	 * after such an event the structural start overstates the elapsed time and
	 * the slope collapses (an 11x-optimistic weekly ETA has been observed).
	 * The regression path ignores it — `isFitBoundary` already restarts the fit
	 * on a drop.
	 */
	anchor?: UsageBurnAnchor | null;
}

export interface WindowExhaustion {
	source: WindowExhaustionSource;
	/** %/hour. `null` when there is no evidence — never 0-as-unknown. */
	slopePctPerHour: number | null;
	/** Projected 100% instant, or null when not projected to exhaust. */
	exhaustsAtMs: number | null;
	/**
	 * True on the lifetime-average path and whenever the window or burn anchor
	 * has less than one hour of evidence. Callers cap severity on THIS,
	 * not on which function ran, so the "the fallback projection never renders
	 * red" rule survives the consolidation.
	 */
	lowConfidence: boolean;
	/**
	 * True when a valid {@link WindowExhaustionInput.anchor} re-anchored a
	 * lifetime estimate. Absent/false otherwise. Informational — callers keep
	 * switching tone on `lowConfidence` and copy on `source`.
	 */
	anchored?: boolean;
	/**
	 * How much elapsed time the burn behind this estimate is measured over: from
	 * the burn anchor when one applies, otherwise from the structural window
	 * start, up to the instant the reading is placed at (`observedAtMs` on the
	 * observation-anchored paths, `now` otherwise).
	 *
	 * Present on the three PROJECTING sources only — `regression`,
	 * `lifetime-primary`, `lifetime-average`. `already-exhausted`, `no-usage`,
	 * `unstarted` and `none` measure no burn, so they state no span.
	 *
	 * The single input to {@link isLearningEstimate}. Deliberately separate from
	 * `lowConfidence`, which the low lifetime path raises unconditionally and
	 * which therefore cannot distinguish "little evidence" from "cheap
	 * estimator".
	 */
	evidenceSpanMs?: number;
}

/**
 * Evidence span after a window start or burn anchor below which a full-confidence
 * estimate stays amber-capped. Minutes after a gift reset the slope is built
 * on a couple of samples; the arithmetic is corrected immediately, but a red
 * rendered on that little evidence would be noise. One hour ≈ 30 sampler ticks.
 * Inline named constant — NO env var / feature gate.
 */
export const ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS = 60 * 60_000;

/**
 * How far a window's structural start may sit from the reading's observation
 * and still count as "the window has not started".
 *
 * A reading can lag the poll that stamped `resets_at` by one sampling interval
 * (120 s for Codex, 90 s for Anthropic) plus clock skew, so the two instants
 * are never bit-identical in production. Five minutes is more than twice the
 * slowest cadence and matches the reset-match tolerance the weekly burn-slope
 * store already uses. A genuinely started window younger than this reads
 * `unstarted` for one poll and self-corrects on the next.
 * Inline named constant — NO env var / feature gate.
 */
export const UNSTARTED_WINDOW_TOLERANCE_MS = 5 * 60_000;

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
 *  5. Lifetime average over the elapsed window. The caller's
 *     {@link LifetimeConfidence} for this window decides both how loudly it may
 *     be rendered AND what it is anchored to: `"full"` with a usable
 *     `observedAtMs` anchors at the OBSERVATION, `"low"` (or `"full"` with no
 *     observation time, which degrades to `"low"`) anchors at `now`.
 */
export function estimateWindowExhaustion(
	input: WindowExhaustionInput,
	now: number,
): WindowExhaustion {
	const {
		utilizationPct: pct,
		resetsAtMs,
		windowStartMs,
		prediction,
		lifetimeConfidence,
		observedAtMs,
		anchor,
	} = input;

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

	// A valid burn anchor replaces the structural origin on BOTH lifetime paths
	// below: elapsed time and consumed percentage are measured from the last
	// mid-window revision instead of from `windowStartMs` / 0%. Resolve once
	// so regression confidence and lifetime estimates agree.
	//
	// Beyond the window-identity guards, the anchor applies only to a reading
	// KNOWN to have been observed at/after it: a stale reading from BEFORE the
	// revision paired with the post-revision anchor would compute a slope from
	// evidence on opposite sides of the event, and a reading with no observation
	// time cannot be placed relative to the event at all — both degrade to the
	// structural estimate instead.
	const windowAnchor = usableAnchor(anchor, resetsAtMs, windowStartMs);
	const activeAnchor =
		windowAnchor !== null &&
		observedAtMs != null &&
		Number.isFinite(observedAtMs) &&
		observedAtMs >= windowAnchor.anchorMs
			? windowAnchor
			: null;

	if (isUsablePrediction(prediction, resetsAtMs)) {
		const slope = Math.max(0, prediction.slopePerHour);
		const span =
			(observedAtMs ?? now) - (activeAnchor?.anchorMs ?? windowStartMs);
		return {
			source: "regression",
			slopePctPerHour: slope,
			exhaustsAtMs: slope > 0 ? prediction.etaExhaustMs : null,
			lowConfidence: span < ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS,
			evidenceSpanMs: span,
		};
	}

	if (pct <= 0) {
		// A window whose structural start IS the observation has not started: the
		// provider re-stamps `resets_at = now + duration` on every poll until the
		// first request pins it. Safe to test after the regression branch — every
		// poll of a sliding window is an `isResetBoundary`, so no usable
		// prediction can exist for one.
		if (
			isUnstartedWindow({ utilizationPct: pct, windowStartMs, observedAtMs })
		) {
			return {
				source: "unstarted",
				slopePctPerHour: null,
				exhaustsAtMs: null,
				lowConfidence: false,
			};
		}
		return {
			source: "no-usage",
			slopePctPerHour: null,
			exhaustsAtMs: null,
			lowConfidence: false,
		};
	}

	// Full confidence is earned by the pair (policy AND observation time), never
	// by the policy alone: without an instant to anchor to, the only estimate
	// available is the now-anchored one, and that one may not reach red. So a
	// "full" request with no usable observation DEGRADES to the low path rather
	// than borrowing `now` as a stand-in observation — fail-safe, because the
	// borrowed anchor is precisely the drift this guards against.
	if (
		lifetimeConfidence === "full" &&
		observedAtMs != null &&
		Number.isFinite(observedAtMs) &&
		observedAtMs > windowStartMs
	) {
		if (activeAnchor !== null) {
			const anchoredElapsed = observedAtMs - activeAnchor.anchorMs;
			const burned = pct - activeAnchor.anchorPct;
			if (burned <= 0 || anchoredElapsed <= 0) {
				// A refund after the anchor, or the reading AT the anchor itself
				// (zero elapsed): hold flat, no ETA — the regression's
				// non-positive-slope precedent. Never fall back to the structural
				// start, which is exactly the overestimate the anchor removes.
				return {
					source: "lifetime-primary",
					slopePctPerHour: 0,
					exhaustsAtMs: null,
					lowConfidence: anchoredElapsed < ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS,
					anchored: true,
					evidenceSpanMs: anchoredElapsed,
				};
			}
			return {
				source: "lifetime-primary",
				slopePctPerHour: (burned / anchoredElapsed) * HOUR_MS,
				exhaustsAtMs: observedAtMs + ((100 - pct) / burned) * anchoredElapsed,
				// The arithmetic is corrected immediately; the TONE waits for an
				// hour of post-anchor evidence before it may reach red — minutes
				// after a gift the slope stands on a couple of samples.
				lowConfidence: anchoredElapsed < ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS,
				anchored: true,
				evidenceSpanMs: anchoredElapsed,
			};
		}
		const observedElapsed = observedAtMs - windowStartMs;
		return {
			source: "lifetime-primary",
			slopePctPerHour: (pct / observedElapsed) * HOUR_MS,
			exhaustsAtMs: observedAtMs + ((100 - pct) / pct) * observedElapsed,
			lowConfidence: observedElapsed < ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS,
			evidenceSpanMs: observedElapsed,
		};
	}

	if (activeAnchor !== null) {
		const anchoredElapsed = now - activeAnchor.anchorMs;
		const burned = pct - activeAnchor.anchorPct;
		if (burned <= 0 || anchoredElapsed <= 0) {
			return {
				source: "lifetime-average",
				slopePctPerHour: 0,
				exhaustsAtMs: null,
				lowConfidence: true,
				anchored: true,
				evidenceSpanMs: anchoredElapsed,
			};
		}
		return {
			source: "lifetime-average",
			slopePctPerHour: (burned / anchoredElapsed) * HOUR_MS,
			// Now-anchored, like every other low-path estimate: the low path is
			// amber-capped, so the per-tick drift the observation anchor exists to
			// stop cannot cross a red threshold here.
			exhaustsAtMs: now + ((100 - pct) / burned) * anchoredElapsed,
			lowConfidence: true,
			anchored: true,
			evidenceSpanMs: anchoredElapsed,
		};
	}

	const elapsed = now - windowStartMs;
	if (elapsed <= 0) return NO_EVIDENCE;

	return {
		source: "lifetime-average",
		slopePctPerHour: (pct / elapsed) * HOUR_MS,
		exhaustsAtMs: now + ((100 - pct) / pct) * elapsed,
		lowConfidence: true,
		evidenceSpanMs: elapsed,
	};
}

/**
 * Whether a window is one the provider has not started yet.
 *
 * True only for a zero reading whose structural start coincides with the
 * instant the reading was observed, within
 * {@link UNSTARTED_WINDOW_TOLERANCE_MS}. That coincidence is the signature of a
 * sliding placeholder: with nothing spent, the provider reports
 * `resets_at = now + duration` on every poll, so the derived start tracks the
 * observation instead of standing still. A reading with no observation time
 * cannot be placed against the start at all and is never called unstarted.
 *
 * The consequence a caller must respect: `resetsAtMs` on such a window is NOT a
 * deadline, so it must never be offered as an earliest reset or a "next reset".
 */
export function isUnstartedWindow(input: {
	utilizationPct: number;
	windowStartMs: number | null | undefined;
	observedAtMs?: number | null;
}): boolean {
	const { utilizationPct, windowStartMs, observedAtMs } = input;
	if (!Number.isFinite(utilizationPct) || utilizationPct > 0) return false;
	if (windowStartMs == null || !Number.isFinite(windowStartMs)) return false;
	if (observedAtMs == null || !Number.isFinite(observedAtMs)) return false;
	return (
		Math.abs(windowStartMs - observedAtMs) <= UNSTARTED_WINDOW_TOLERANCE_MS
	);
}

/**
 * Whether this estimate is still LEARNING the window's burn: readable, but not
 * yet carrying enough evidence to state a run-out.
 *
 * Three ways to be learning, one rule:
 *  - the reading is at or below 0%, whatever the estimator said. Zero usage is
 *    no evidence of burn, and it stays no evidence once three zero readings
 *    have produced a flat regression that would otherwise read as "confidently
 *    never runs out";
 *  - `no-usage` / `unstarted`, the two zero-reading sources;
 *  - a projecting source whose {@link WindowExhaustion.evidenceSpanMs} is under
 *    {@link ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS}. Strict `<`, so exactly one
 *    hour is confident.
 *
 * `already-exhausted` is a fact and `none` is already unreadable, so neither is
 * ever learning. Deliberately NOT keyed on `lowConfidence`: the low lifetime
 * path raises that flag unconditionally, so keying on it would leave every
 * 5-hour window learning forever.
 *
 * A learning window is withheld from projection rather than treated as "no
 * burn" — the difference between "we do not know yet" and "infinite runway".
 */
export function isLearningEstimate(
	estimate: WindowExhaustion,
	utilizationPct: number,
): boolean {
	if (Number.isFinite(utilizationPct) && utilizationPct <= 0) return true;
	if (estimate.source === "no-usage" || estimate.source === "unstarted") {
		return true;
	}
	return (
		estimate.evidenceSpanMs != null &&
		estimate.evidenceSpanMs < ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS
	);
}

/**
 * Whether `anchor` may re-anchor an estimate for the window instance described
 * by `resetsAtMs`/`windowStartMs`. Two independent guards:
 *
 *  - IDENTITY: the anchor's `windowResetMs` must match the projected reading's
 *    reset within the shared jitter tolerance. Real polls report the same reset
 *    instant with ~±1s wobble; a larger difference means the anchor belongs to
 *    another window instance and would poison this one.
 *  - SPAN: the anchor instant must lie inside `(windowStartMs, resetsAtMs)`.
 *    An anchor outside the span cannot describe accumulation within it — and
 *    an anchor at/before the structural start would silently widen the elapsed
 *    time it exists to narrow.
 */
function usableAnchor(
	anchor: UsageBurnAnchor | null | undefined,
	resetsAtMs: number,
	windowStartMs: number,
): UsageBurnAnchor | null {
	if (anchor == null) return null;
	if (!Number.isFinite(anchor.anchorMs)) return null;
	if (!Number.isFinite(anchor.anchorPct)) return null;
	if (!Number.isFinite(anchor.windowResetMs)) return null;
	if (Math.abs(anchor.windowResetMs - resetsAtMs) > RESET_JITTER_TOLERANCE_MS) {
		return null;
	}
	if (anchor.anchorMs <= windowStartMs) return null;
	if (anchor.anchorMs >= resetsAtMs) return null;
	return anchor;
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
	/**
	 * Threaded verbatim to {@link estimateWindowExhaustion}. Absent means
	 * `"low"`; `windowKind` is NOT consulted to derive it, so the policy stays
	 * with the caller that measured it.
	 */
	lifetimeConfidence?: LifetimeConfidence;
	/**
	 * When this window's reading was observed. Threaded verbatim to
	 * {@link WindowExhaustionInput.observedAtMs}, where the `"full"` confidence
	 * path requires it and any anchored estimate uses it to place the reading
	 * relative to the anchor; the credit model's re-exhaustion pace reads it
	 * for the same epoch check.
	 */
	observedAtMs?: number | null;
	/**
	 * Threaded verbatim to {@link WindowExhaustionInput.anchor}; validated
	 * there, not here.
	 */
	anchor?: UsageBurnAnchor | null;
}

/**
 * The banked OpenAI usage-reset credits the runway scan may ASSUME get applied
 * to this account's weekly window, plus the auto-applier opt-ins that govern
 * WHEN the real applier would redeem one:
 *
 *  - `onWeeklyLimitEnabled` — redeems when the weekly window reaches 100%. In
 *    the model, an exhaustion instant consumes a credit and revives the window.
 *  - `onExpiryEnabled` — redeems a credit shortly before it expires. In the
 *    model, a credit whose expiry falls inside a dead span revives the window
 *    AT the expiry instant (a credit expiring while the window is alive just
 *    leaves the bank; the ~10-minute application lead is ignored as noise).
 *
 * The weekly window ONLY, by design: an applied credit does also reset other
 * windows upstream, but ignoring the 5h side is conservative (never lengthens
 * the runway) and the 5h window self-heals within hours anyway.
 */
export interface RunwayResetCreditBank {
	onWeeklyLimitEnabled: boolean;
	onExpiryEnabled: boolean;
	/** Available credits; `expiresAtMs` null = no known expiry. */
	credits: Array<{ expiresAtMs: number | null }>;
}

export interface RunwayAccountInput {
	accountId: string;
	/** Provider exposes no account-wide quota window at all (ollama, PayG). */
	unmetered: boolean;
	windows: RunwayWindowInput[];
	/**
	 * Present only for accounts with a fresh credit reading AND at least one
	 * auto-apply opt-in. Absent/null → the scan models no credits (identical to
	 * today's behaviour).
	 */
	codexResetCredits?: RunwayResetCreditBank | null;
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

/**
 * How long a freshly revived weekly window takes to burn back to 100%, or null
 * when no honest pace exists.
 *
 * Preference order mirrors the evidence quality: the estimator's own slope
 * (regression or lifetime); else, for an `already-exhausted` reading (null
 * slope), the time the CURRENT fill observably took — from the anchor when one
 * is valid (scaled by `100/(100 − anchorPct)`, since only that share was burned
 * post-anchor), else from the structural start. Null when even that is unknown;
 * the caller then lets one credit suppress a dead span once without modeling a
 * re-exhaustion, which errs optimistic for at most that one span and is
 * disclosed via `assumedResetCredits`.
 */
function weeklyTimeToFull(
	window: RunwayWindowInput,
	estimate: WindowExhaustion,
	now: number,
	pace = 1,
): number | null {
	if (estimate.slopePctPerHour != null && estimate.slopePctPerHour > 0) {
		// `estimate` arrives already pace-scaled (see `scaleEstimatePace`), so the
		// slope path needs no further scaling.
		return (100 / estimate.slopePctPerHour) * HOUR_MS;
	}
	if (estimate.source !== "already-exhausted") return null;
	// The fill was complete BY the reading's observation, so the elapsed time is
	// measured to that instant when it is known — `now` would count wall-clock
	// that passed after the window was already full and overstate the pace.
	const observedAtMs =
		window.observedAtMs != null && Number.isFinite(window.observedAtMs)
			? window.observedAtMs
			: null;
	const filledByMs = observedAtMs ?? now;
	const anchor =
		window.resetsAtMs != null && window.windowStartMs != null
			? usableAnchor(window.anchor, window.resetsAtMs, window.windowStartMs)
			: null;
	// Same epoch gate as the estimator: the anchor applies only to a reading
	// KNOWN to be at/after it — a pre-anchor or unplaceable 100% reading must
	// not be scaled by the post-revision anchor.
	if (
		anchor !== null &&
		anchor.anchorPct < 100 &&
		observedAtMs !== null &&
		observedAtMs > anchor.anchorMs
	) {
		// Observed elapsed time is historical fact; under a hypothetical pace
		// multiplier the refill completes proportionally sooner.
		return (
			((observedAtMs - anchor.anchorMs) * 100) / (100 - anchor.anchorPct) / pace
		);
	}
	if (window.windowStartMs != null && filledByMs > window.windowStartMs) {
		return (filledByMs - window.windowStartMs) / pace;
	}
	return null;
}

/**
 * Apply an account's modeled reset-credit bank to its weekly dead intervals.
 *
 * Chronological single pass: intervals are processed in ascending start order
 * and credits are consumed earliest-expiring first (unknown expiry last), so an
 * expiring credit is never wasted on an exhaustion a later credit could cover.
 * At each dead-span start, the weekly-limit trigger (when enabled) consumes an
 * applicable credit and revives the window; the window re-exhausts
 * `timeToFullMs` later, leaving a residual dead span that is processed the same
 * way. When only the expiry trigger is enabled, a credit whose expiry falls
 * INSIDE a dead span truncates it there instead.
 *
 * Termination: every loop iteration either consumes a credit or emits a span
 * and moves on, so the pass is bounded by `credits.length + intervals.length`.
 *
 * Returns the surviving dead intervals plus how many credits the model
 * consumed — the count the outcome discloses, because the extended runway is
 * an ASSUMPTION about future redemptions, not a measurement.
 */
function applyResetCreditsToWeeklyIntervals(
	intervals: WindowDeadInterval[],
	timeToFullMs: number | null,
	bank: RunwayResetCreditBank,
): { intervals: WindowDeadInterval[]; consumed: number } {
	if (
		bank.credits.length === 0 ||
		(!bank.onWeeklyLimitEnabled && !bank.onExpiryEnabled)
	) {
		return { intervals, consumed: 0 };
	}

	// Earliest-expiring first; unknown expiry last.
	const credits = [...bank.credits].sort((a, b) => {
		if (a.expiresAtMs == null && b.expiresAtMs == null) return 0;
		if (a.expiresAtMs == null) return 1;
		if (b.expiresAtMs == null) return -1;
		return a.expiresAtMs - b.expiresAtMs;
	});
	const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);

	// First credit applicable at `t` (not yet expired), removed on consumption.
	const takeCreditAt = (t: number): boolean => {
		const idx = credits.findIndex(
			(c) => c.expiresAtMs == null || c.expiresAtMs > t,
		);
		if (idx === -1) return false;
		credits.splice(idx, 1);
		return true;
	};
	// Earliest credit whose expiry lies strictly inside (t0, t1).
	const expiryInside = (t0: number, t1: number): number | null => {
		for (const c of credits) {
			if (c.expiresAtMs != null && c.expiresAtMs > t0 && c.expiresAtMs < t1) {
				return c.expiresAtMs;
			}
		}
		return null;
	};

	const out: WindowDeadInterval[] = [];
	let consumed = 0;
	const modeledReExhaustion = (
		revivedAtMs: number,
		endMs: number,
	): number | null =>
		timeToFullMs != null &&
		timeToFullMs > 0 &&
		revivedAtMs + timeToFullMs < endMs
			? revivedAtMs + timeToFullMs
			: null;

	for (const interval of sorted) {
		let startMs = interval.startMs;
		const endMs = interval.endMs;
		for (;;) {
			if (bank.onWeeklyLimitEnabled && takeCreditAt(startMs)) {
				consumed++;
				const reExhaustsAtMs = modeledReExhaustion(startMs, endMs);
				if (reExhaustsAtMs === null) break; // span fully covered
				startMs = reExhaustsAtMs;
				continue;
			}
			if (bank.onExpiryEnabled) {
				const expiryMs = expiryInside(startMs, endMs);
				if (expiryMs !== null && takeCreditAt(startMs)) {
					// Dead until the near-expiry auto-apply fires, revived there.
					consumed++;
					out.push({ ...interval, startMs, endMs: expiryMs });
					const reExhaustsAtMs = modeledReExhaustion(expiryMs, endMs);
					if (reExhaustsAtMs === null) break;
					startMs = reExhaustsAtMs;
					continue;
				}
			}
			out.push({ ...interval, startMs, endMs });
			break;
		}
	}

	return { intervals: out, consumed };
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
 * A window-exhaustion estimate under a hypothetical uniform burn-pace
 * multiplier, for the {@link probePaceMargin} counterfactual only.
 *
 * The scaled ETA is re-anchored at the instant the burn is measured from: the
 * reading's observation for an observation-anchored estimate
 * (`lifetime-primary`), `now` otherwise. `now` is exact for the low lifetime
 * path and an approximation for a regression's newest-sample anchor — which is
 * fine, because regressions only exist for routing-fresh readings (minutes
 * old at most). The observation anchor is NOT an approximation the same way:
 * the scan legitimately serves persisted Codex readings that are hours or
 * days old after a restart, and anchoring those at `now` would move the
 * scaled ETA by a third of the reading's age at the probe cap. An
 * `already-exhausted` estimate is untouched: being spent now does not depend
 * on pace.
 */
function scaleEstimatePace(
	estimate: WindowExhaustion,
	pace: number,
	now: number,
	observedAtMs: number | null | undefined,
): WindowExhaustion {
	if (pace === 1) return estimate;
	const slope = estimate.slopePctPerHour;
	let exhaustsAtMs = estimate.exhaustsAtMs;
	if (estimate.source !== "already-exhausted" && exhaustsAtMs != null) {
		const anchorMs =
			estimate.source === "lifetime-primary" &&
			observedAtMs != null &&
			Number.isFinite(observedAtMs)
				? observedAtMs
				: now;
		if (exhaustsAtMs > anchorMs) {
			exhaustsAtMs = anchorMs + (exhaustsAtMs - anchorMs) / pace;
		}
	}
	return {
		...estimate,
		slopePctPerHour: slope != null && slope > 0 ? slope * pace : slope,
		exhaustsAtMs,
	};
}

/** Everything the pool scan derives from the account inputs, per pace. */
interface PoolBuild {
	pooled: PooledAccount[];
	unprojectableAccountIds: string[];
	/** Subset of `unprojectableAccountIds` withheld for lack of evidence. */
	learningAccountIds: string[];
	assumedCredits: RunwayAssumedCredits[];
}

/** The first instant every pooled account is dead at once, or null. */
interface AllOutHit {
	t: number;
	causes: RunwayCause[];
}

/**
 * How long the pool can keep going at the current pace before EVERY account in
 * it is simultaneously out of account-wide quota.
 *
 * Accounts with no readable window are excluded from the pool and reported in
 * `unprojectableAccountIds`. So are accounts with a readable but still LEARNING
 * window (see {@link isLearningEstimate}), which are additionally named in
 * `learningAccountIds` — a subset of the unprojectable list — because their
 * exclusion is temporary and a reader can be told what it is waiting for.
 * Excluding an account can only SHORTEN the computed runway, so a `runway`
 * result carrying unprojectable accounts is a documented lower bound — never a
 * fabricated zero. When EVERY eligible account is learning the outcome is
 * `unknown` carrying the same list: insufficient evidence, not infinity.
 *
 * Outcomes additionally carry a PACE PROBE, the two halves of one signed
 * "how much load can this pool take" figure: `beyond-horizon` carries
 * `paceMargin` when the verdict is knife-edge (see {@link probePaceMargin}),
 * and `runway` carries `paceDeficit`, the least slowdown that clears the
 * horizon (see {@link probePaceDeficit}). An outcome is one or the other and
 * never both, so a scan runs at most one probe.
 *
 * `out-now` carries neither, on the same grounds `computeCapacityRunwayBand`
 * refuses it: the pool is out at this instant, and an instant that has already
 * arrived is not a projection with a pace assumption to vary.
 */
export function computeCapacityRunway(
	accounts: RunwayAccountInput[],
	now: number,
	horizonMs: number = RUNWAY_HORIZON_MS,
	options?: {
		/**
		 * Whether the result should carry its pace probe — `paceMargin` on a
		 * `beyond-horizon`, `paceDeficit` on a `runway`. One flag for both: they
		 * are the two halves of one signed figure, they cost the same, and a
		 * caller that cannot afford one cannot afford the other. Default true, so
		 * every existing caller is unchanged.
		 *
		 * A probe costs up to 50 pool rebuilds, which is fine once per served
		 * response and is not fine inside a caller that runs the whole scan twice
		 * — {@link computeCapacityRunwayBand} does, and it discards both figures
		 * anyway.
		 */
		probePaceMargin?: boolean;
		/**
		 * Which window kinds the PROBE varies. Omitted (the default) paces every
		 * window, which is the uniform "the whole workload moves together"
		 * counterfactual the pool-level figure states.
		 *
		 * A narrower set expresses a SCOPED counterfactual — one model family's
		 * load changing while the rest of the account's load does not. That is a
		 * bound rather than a measurement, because the share of account-wide burn
		 * belonging to the scoped workload is not derivable from recorded data
		 * (`docs/ledger-burn-feasibility.md`); see `workload-headroom.ts`, which is
		 * the only caller that passes it and carries the argument for which end of
		 * the share range each side must assume.
		 *
		 * The BASELINE scan is unaffected either way: it runs at pace 1, where no
		 * window is scaled and the set cannot change the outcome.
		 */
		pacedWindowKinds?: ReadonlySet<string> | null;
	},
): RunwayOutcome {
	if (accounts.length === 0) return { kind: "no-accounts" };

	const horizonEndMs = now + horizonMs;
	const {
		pooled,
		unprojectableAccountIds,
		learningAccountIds,
		assumedCredits,
	} = buildPool(accounts, now, horizonEndMs, 1);

	// Every eligible account still learning is "we do not know yet", not
	// "forever": the same `unknown` every other insufficient-evidence pool
	// reports, now carrying who it is waiting on.
	if (pooled.length === 0) {
		return {
			kind: "unknown",
			...(learningAccountIds.length > 0 ? { learningAccountIds } : {}),
		};
	}

	const hit = firstAllOut(pooled, now, horizonEndMs);
	if (hit !== null) {
		if (hit.t === now) {
			return {
				kind: "out-now",
				causes: hit.causes,
				unprojectableAccountIds,
				...(learningAccountIds.length > 0 ? { learningAccountIds } : {}),
				...(assumedCredits.length > 0
					? { assumedResetCredits: assumedCredits }
					: {}),
			};
		}
		const paceDeficit =
			options?.probePaceMargin === false
				? null
				: probePaceDeficit(
						accounts,
						now,
						horizonEndMs,
						options?.pacedWindowKinds,
					);
		return {
			kind: "runway",
			exhaustsAtMs: hit.t,
			durationMs: hit.t - now,
			causes: hit.causes,
			unprojectableAccountIds,
			...(learningAccountIds.length > 0 ? { learningAccountIds } : {}),
			...(assumedCredits.length > 0
				? { assumedResetCredits: assumedCredits }
				: {}),
			...(paceDeficit !== null ? { paceDeficit } : {}),
		};
	}

	const paceMargin =
		options?.probePaceMargin === false
			? null
			: probePaceMargin(accounts, now, horizonEndMs, options?.pacedWindowKinds);
	return {
		kind: "beyond-horizon",
		horizonMs,
		unprojectableAccountIds,
		...(learningAccountIds.length > 0 ? { learningAccountIds } : {}),
		...(assumedCredits.length > 0
			? { assumedResetCredits: assumedCredits }
			: {}),
		...(paceMargin !== null ? { paceMargin } : {}),
	};
}

/**
 * How far a whole-percent reading is perturbed in each direction, in percentage
 * points. A provider reporting "20%" means [19.5, 20.5), so half a percent is
 * the full extent of the quantisation error — not a chosen tolerance.
 */
const RUNWAY_BAND_HALF_WIDTH_PCT = 0.5;

/** The run-out instant an outcome states, or null when it states none. */
function outcomeInstant(outcome: RunwayOutcome, now: number): number | null {
	if (outcome.kind === "runway") return outcome.exhaustsAtMs;
	if (outcome.kind === "out-now") return now;
	return null;
}

/**
 * The pool's signed pace headroom: how much more load it can take, or how much
 * it has to shed, as a whole percentage of the CURRENTLY MEASURED pace.
 *
 * The single figure a "more agents or fewer agents" reading is built from, and
 * the reason both probes exist. `margin` means the scan finds no run-out and
 * would need the pace to rise by `pct` before it did; `deficit` means it finds
 * one and the pace has to fall by `pct` to clear the horizon. Callers render
 * the sign; this decides the magnitude, so the dashboard, the management API
 * and the widget wire cannot round it differently.
 *
 * Null in three DIFFERENT situations that a renderer must not collapse into a
 * zero or a blank:
 *  - `no-accounts` / `unknown` — nothing was measured.
 *  - `out-now` — the pool is out at this instant; there is no pace assumption
 *    left to vary.
 *  - Either probe came back empty. On the margin side that is the GOOD end: no
 *    probed increase up to the cap flips the verdict, so the headroom is at
 *    least the cap. On the deficit side it is the BAD end: no probed slowdown
 *    down to the floor clears the horizon. Same absent field, opposite meanings,
 *    which is why `outcome.kind` has to be read alongside it.
 *
 * Rounded AWAY FROM ZERO in both directions, so the figure always understates
 * the pool's comfort: a margin is the increase the pool is known to survive, a
 * deficit is a cut the probe proved sufficient. Rounding a deficit down would
 * advise a cut that the grid step above it demonstrably failed at.
 */
export function runwayPaceHeadroom(
	outcome: RunwayOutcome,
): { pct: number; direction: "margin" | "deficit" } | null {
	// Micro-round before the ceil in both branches: the grid multipliers are
	// exact hundredths whose float representation can land a hair off the true
	// value ((1.12 - 1) * 100 === 12.000000000000004), and ceiling that raw
	// product would overstate the grid point by a full percent.
	const wholePct = (value: number): number =>
		Math.ceil(Math.round(value * 100 * 1e6) / 1e6);

	if (outcome.kind === "beyond-horizon") {
		const margin = outcome.paceMargin;
		if (!margin || margin.multiplier <= 1) return null;
		return { pct: wholePct(margin.multiplier - 1), direction: "margin" };
	}
	if (outcome.kind === "runway") {
		const deficit = outcome.paceDeficit;
		if (!deficit || deficit.multiplier >= 1) return null;
		return { pct: wholePct(1 - deficit.multiplier), direction: "deficit" };
	}
	return null;
}

/**
 * The interval the run-out actually lies in, given that the readings behind it
 * are whole percents.
 *
 * The scan divides by a utilization to get a pace, so its error is proportional
 * to the runway: half a percent of reading error on a window at 20% one day in
 * is about six hours of run-out, while the same half percent deep into a window
 * is minutes. Reporting one instant states a precision the input never had, and
 * the figure visibly swinging by a day between polls is the same fact seen from
 * the outside.
 *
 * Nothing about the estimator is touched. This runs the SAME scan twice against
 * perturbed copies of the inputs and reports the two answers, so the band can
 * never disagree with the point estimate it brackets.
 *
 * Null — no band stated — in four cases, each because the two probes would not
 * bound anything:
 *
 *  - The baseline consumed modeled reset credits. Burn under credits is
 *    documented non-monotonic (see {@link probePaceMargin}): a faster burn can
 *    move a dead span back inside a credit's expiry and REVIVE the window, so
 *    the perturbed answers do not straddle the baseline.
 *  - The baseline is `out-now`. The pool is out at this instant, and an instant
 *    that has already arrived is not a projection with an error bar on it.
 *  - No weekly window was perturbed. Every weekly reading was already
 *    fractional or already exhausted, so quantisation is not what is limiting
 *    the precision here.
 *  - Both probes state no run-out. There is nothing to bracket.
 *
 * FIVE-HOUR WINDOWS ARE NEVER PERTURBED, and the band says nothing about them.
 * The 5-hour fallback is `now`-anchored and drifts between polls, so the
 * interval a probe on it would trace is not the quantisation interval this
 * function claims to be reporting — it would widen the band by an amount that
 * has nothing to do with the reading's precision, on the window whose reading
 * moves fastest.
 *
 * A regression-backed weekly window is perturbed like any other and simply does
 * not move: `estimateWindowExhaustion`'s regression branch projects from the server
 * slope and never reads the percentage. The two ends then come back equal,
 * which the display renders as no band. That is disclosure of what the model
 * does, not a claim that the figure is exact.
 */
export function computeCapacityRunwayBand(
	accounts: RunwayAccountInput[],
	now: number,
	baseline: RunwayOutcome,
	horizonMs: number = RUNWAY_HORIZON_MS,
): RunwayBand | null {
	if (
		"assumedResetCredits" in baseline &&
		(baseline.assumedResetCredits?.length ?? 0) > 0
	) {
		return null;
	}

	// A pool that is ALREADY out states no future instant, so there is nothing
	// for two probes to bracket. Without this, a window reading exactly 100 is
	// perturbed down to 99.5 — a reading the estimator no longer treats as
	// exhausted — and the low probe hands back a run-out minutes from now, so an
	// "Out now" headline would ship a band that puts the run-out in the future.
	if (baseline.kind === "out-now") return null;

	// Accounts the BASELINE withheld for lack of evidence stay out of both
	// probes. The ±0.5 pp perturbation would turn a mature 0% learner into a
	// projectable 0.5% account, which can push a probe past the horizon and
	// place the band's own start before or after a baseline the learner never
	// took part in.
	const learningAccountIds = new Set(
		"learningAccountIds" in baseline ? (baseline.learningAccountIds ?? []) : [],
	);
	const probeAccounts =
		learningAccountIds.size === 0
			? accounts
			: accounts.filter(
					(account) => !learningAccountIds.has(account.accountId),
				);

	let perturbed = false;
	const shift = (delta: number): RunwayAccountInput[] =>
		probeAccounts.map((account) => ({
			...account,
			windows: account.windows.map((window) => {
				// The WEEKLY window only, and only a WHOLE-percent reading of it that
				// is not already exhausted. A fractional reading came from somewhere
				// that already knows better, and nudging it would invent an
				// uncertainty it does not have; a reading at 100 is a STATE the
				// provider reports — the window is spent — not a measurement rounded
				// to the nearest percent, so pushing it to 99.5 would un-exhaust it.
				if (
					window.windowKind !== "seven_day" ||
					!Number.isInteger(window.utilizationPct) ||
					window.utilizationPct >= 100
				) {
					return window;
				}
				perturbed = true;
				return {
					...window,
					utilizationPct: Math.min(
						100,
						Math.max(0, window.utilizationPct + delta),
					),
				};
			}),
		}));

	const lowInputs = shift(-RUNWAY_BAND_HALF_WIDTH_PCT);
	const highInputs = shift(RUNWAY_BAND_HALF_WIDTH_PCT);
	if (!perturbed) return null;

	// `probePaceMargin: false` on both: the walk costs up to 50 pool rebuilds
	// per call and nothing here reads its result.
	const low = computeCapacityRunway(lowInputs, now, horizonMs, {
		probePaceMargin: false,
	});
	const high = computeCapacityRunway(highInputs, now, horizonMs, {
		probePaceMargin: false,
	});

	// Which probe lands earlier is NOT assumed. Less utilization usually means a
	// longer runway, but a pool's all-out instant is the intersection of several
	// accounts' dead spans, and shifting them all can move that intersection
	// either way.
	const instants = [outcomeInstant(low, now), outcomeInstant(high, now)].filter(
		(t): t is number => t !== null,
	);
	if (instants.length === 0) return null;

	return {
		// A probe that found no run-out inside the horizon leaves its side OPEN:
		// null is "at least this", not "equal to the other end".
		earliestExhaustsAtMs:
			instants.length === 2 ? Math.min(...instants) : instants[0],
		latestExhaustsAtMs: instants.length === 2 ? Math.max(...instants) : null,
		halfWidthPct: RUNWAY_BAND_HALF_WIDTH_PCT,
	};
}

/**
 * Dead intervals and pool membership for every account, under a burn-pace
 * multiplier (`pace: 1` is the real scan; the probe passes hypotheticals).
 */
function buildPool(
	accounts: RunwayAccountInput[],
	now: number,
	horizonEndMs: number,
	pace: number,
	pacedWindowKinds?: ReadonlySet<string> | null,
): PoolBuild {
	const pooled: PooledAccount[] = [];
	const unprojectableAccountIds: string[] = [];
	const learningAccountIds: string[] = [];
	const assumedCredits: RunwayAssumedCredits[] = [];

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
		// Weekly intervals are held aside when the account has a modeled credit
		// bank: applying the bank must see ALL of that window's dead spans (the
		// current one and the projected later cycles) in chronological order.
		const weeklyIntervals: WindowDeadInterval[] = [];
		let weeklyTimeToFullMs: number | null = null;
		const bank = account.codexResetCredits ?? null;
		let readable = false;
		let learning = false;
		for (const window of account.windows) {
			// A window outside the paced set is held at its measured burn. That is
			// what makes a SCOPED counterfactual expressible: varying one model
			// family's load moves that family's window and leaves the account-wide
			// ones where they are. With no set given every window is paced, which is
			// the uniform scan every existing caller asks for.
			const windowPace =
				pacedWindowKinds == null || pacedWindowKinds.has(window.windowKind)
					? pace
					: 1;
			const estimate = scaleEstimatePace(
				estimateWindowExhaustion(
					{
						utilizationPct: window.utilizationPct,
						resetsAtMs: window.resetsAtMs,
						windowStartMs: window.windowStartMs,
						prediction: window.prediction,
						lifetimeConfidence: window.lifetimeConfidence,
						observedAtMs: window.observedAtMs,
						anchor: window.anchor,
					},
					now,
				),
				windowPace,
				now,
				window.observedAtMs,
			);
			if (estimate.source === "none") continue;
			// Evidence is tracked separately from intervals on purpose: a readable
			// window that emits NO dead interval is positively known to stay
			// available, which is the opposite of unknown.
			readable = true;
			// Unknown burn, NOT zero burn. Emitting no dead interval here would
			// claim the window stays available, which is the optimistic direction.
			// ONE learning window makes the WHOLE account unprojectable: pooling it
			// on its confident windows alone applies half its constraints and can
			// only lengthen the pool runway.
			if (isLearningEstimate(estimate, window.utilizationPct)) {
				learning = true;
				continue;
			}
			const intervals = windowDeadIntervals(
				window,
				estimate,
				now,
				horizonEndMs,
			);
			if (bank !== null && window.windowKind === "seven_day") {
				weeklyIntervals.push(...intervals);
				weeklyTimeToFullMs = weeklyTimeToFull(
					window,
					estimate,
					now,
					windowPace,
				);
			} else {
				windowIntervals.push(...intervals);
			}
		}

		if (!readable) {
			unprojectableAccountIds.push(account.accountId);
			continue;
		}

		// The intervals collected from this account's CONFIDENT windows are
		// discarded along with it — a partial constraint set is not a bound.
		if (learning) {
			unprojectableAccountIds.push(account.accountId);
			learningAccountIds.push(account.accountId);
			continue;
		}

		if (bank !== null && weeklyIntervals.length > 0) {
			const applied = applyResetCreditsToWeeklyIntervals(
				weeklyIntervals,
				weeklyTimeToFullMs,
				bank,
			);
			windowIntervals.push(...applied.intervals);
			if (applied.consumed > 0) {
				assumedCredits.push({
					accountId: account.accountId,
					count: applied.consumed,
				});
			}
		} else {
			windowIntervals.push(...weeklyIntervals);
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

	return {
		pooled,
		unprojectableAccountIds,
		learningAccountIds,
		assumedCredits,
	};
}

/**
 * The first instant at which every pooled account is dead at once, with the
 * window intervals covering it, or null when no such instant exists inside the
 * horizon.
 *
 * The first all-dead instant is either `now` or a moment at which some
 * account transitions from alive to dead — which is exactly the start of one
 * of its unioned dead intervals. Testing those candidates is therefore
 * complete, not a sampling approximation.
 */
function firstAllOut(
	pooled: PooledAccount[],
	now: number,
	horizonEndMs: number,
): AllOutHit | null {
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
		return { t, causes };
	}

	return null;
}

/**
 * Largest uniform burn-pace multiplier the probe checks. A `beyond-horizon`
 * that survives every account burning half again as fast is not knife-edge,
 * and there is nothing useful to disclose about it. Inline named constant —
 * NO env var / feature gate.
 */
export const PACE_MARGIN_PROBE_MAX = 1.5;

/** Grid step at which the probe walks candidate multipliers. */
const PACE_MARGIN_PRECISION = 0.01;

/**
 * How fragile a `beyond-horizon` verdict is: the smallest probed uniform
 * burn-pace multiplier (up to {@link PACE_MARGIN_PROBE_MAX}) at which the same
 * pool scans FINITE, or null when none does.
 *
 * Exists because the all-out test is binary in a way small evidence changes
 * can flip: a window projected to fill even slightly slower than its own
 * length contributes NO dead time to any projected cycle (see
 * `windowDeadIntervals`), so one account's slope easing across `100%/duration`
 * — a night of idle diluting a lifetime average is enough — teleports the pool
 * outcome between a finite runway and `beyond-horizon`. The model cannot be
 * smoothed (a sub-sustainable pace genuinely never exhausts), so the honest
 * fix is disclosure: quantify how close the verdict is to flipping back.
 *
 * A GRID WALK from the bottom, deliberately not a bisection: "finite at pace
 * m" is NOT monotone in m once reset credits are modeled. Dead-time itself
 * only grows with pace, but a faster pace moves a dead span's start earlier,
 * which can put it back inside a banked credit's expiry — the credit then
 * revives the window and the scan turns beyond-horizon AGAIN at the higher
 * pace. A bisection seeded by a probe at the cap would read such a pool as
 * robust and miss a real low flip. Walking every grid step finds the smallest
 * flipping multiplier by construction, at a bounded cost of 50 pool rebuilds
 * over a handful of accounts, only on the beyond-horizon path.
 *
 * The finite scan a probe step finds may itself consume modeled credits; they
 * are not itemized separately because the entire figure is already a
 * disclosed counterfactual, not a measurement.
 *
 * A GRID claim, not a continuous one: a modeled credit whose expiry sits just
 * past a dead span's start can in principle carve a finite island narrower
 * than one grid step, which this walk passes over. Deliberate — such an
 * island flips back to beyond-horizon a fraction of a percent higher, so it
 * carries no usable fragility signal, and no finite grid could rule the shape
 * out anyway. The wire type documents the same grid semantics.
 *
 * Runs on the same learning-excluded pool the baseline scan used: the learning
 * predicate is pace-independent, so no probed multiplier can re-admit an
 * account the baseline withheld. `pooled.length === 0` can therefore mean every
 * eligible account is learning, which is the same "nothing to probe" the walk
 * already returns null for.
 */
function probePaceMargin(
	accounts: RunwayAccountInput[],
	now: number,
	horizonEndMs: number,
	pacedWindowKinds?: ReadonlySet<string> | null,
): { multiplier: number; exhaustsAtMs: number } | null {
	// An unmetered account is never out of quota at ANY pace, so the pool can
	// never be all-out and every probe step would rebuild it for nothing.
	if (accounts.some((account) => account.unmetered)) return null;
	const steps = Math.round((PACE_MARGIN_PROBE_MAX - 1) / PACE_MARGIN_PRECISION);
	for (let step = 1; step <= steps; step++) {
		// Recomputed from the integer step so accumulation error cannot drift
		// the grid.
		const pace = 1 + step * PACE_MARGIN_PRECISION;
		const { pooled } = buildPool(
			accounts,
			now,
			horizonEndMs,
			pace,
			pacedWindowKinds,
		);
		if (pooled.length === 0) return null;
		const hit = firstAllOut(pooled, now, horizonEndMs);
		if (hit !== null) return { multiplier: pace, exhaustsAtMs: hit.t };
	}
	return null;
}

/**
 * Smallest floor the deficit probe walks down to. Below half the measured pace
 * the advice has stopped being "ease off" and become "stop", which no
 * percentage renders usefully. Inline named constant — NO env var / feature
 * gate.
 */
export const PACE_DEFICIT_PROBE_MIN = 0.5;

/**
 * The least slowdown a reader can act on: the largest probed multiplier such
 * that it AND EVERY PROBED MULTIPLIER BELOW IT scans beyond-horizon, or null
 * when the floor itself still runs out.
 *
 * The mirror of {@link probePaceMargin}, and it exists for the same reason read
 * from the other side. That probe quantifies how close a "no run-out" is to
 * flipping finite; this one says how much load has to come off a finite runway.
 * Together they are one signed figure — how much this pool can take, positive
 * or negative — and a reader deciding whether to add or shed work needs the
 * negative half most, because that is the half that arrives when something has
 * to change.
 *
 * WHY THE WHOLE TAIL AND NOT THE FIRST HIT. Returning the first clearing
 * multiplier walking down would be the largest qualifying one, and it would be
 * WRONG to publish, because "finite at pace m" is genuinely not monotone in m
 * once reset credits are modeled — a fact this comment previously denied. The
 * mechanism is the same one {@link probePaceMargin} documents, read downward: a
 * credit revives a window when the dead span starts before the credit expires,
 * and slowing the burn pushes that span LATER, so a slower pace can move the
 * span past the expiry, lose the revival, and go finite again. A pool can
 * therefore be safe at 0.71 and unsafe at 0.60.
 *
 * That makes the first hit a SAMPLED SAFE POINT rather than a threshold, and
 * nobody can act on a sampled point: told to cut 29%, a reader cuts 35% and
 * lands back in trouble. So the walk continues to the floor and reports only
 * the contiguous safe tail, which supports the sentence a widget actually
 * renders — "cut by at least this much".
 *
 * A GRID WALK, deliberately not a bisection, for that same non-monotonicity: a
 * bisection cannot find the boundary of a region it assumes is contiguous.
 *
 * Cost is the same 50 pool rebuilds the margin probe has, and the budget is
 * unchanged rather than doubled: an outcome is finite or beyond-horizon and
 * never both, so exactly one of the two probes runs per scan. Walking the full
 * grid rather than stopping early costs nothing against that ceiling.
 *
 * Null carries a MEANING and must not be rendered as zero — see the field doc
 * on `paceDeficit`. It says no pace in range clears the horizon and stays
 * clear, which is strictly worse than any figure the probe could return.
 *
 * Runs on the same learning-excluded pool as the baseline scan, for the reason
 * {@link probePaceMargin} states.
 */
function probePaceDeficit(
	accounts: RunwayAccountInput[],
	now: number,
	horizonEndMs: number,
	pacedWindowKinds?: ReadonlySet<string> | null,
): { multiplier: number } | null {
	// Same short-circuit as the margin probe, for the opposite reason: with an
	// unmetered account in the pool the scan can never be all-out, so it would
	// not have reached this branch at all.
	if (accounts.some((account) => account.unmetered)) return null;
	const steps = Math.round(
		(1 - PACE_DEFICIT_PROBE_MIN) / PACE_MARGIN_PRECISION,
	);
	// Ascending from the floor, so the loop can stop at the first pace that runs
	// out and everything it already accepted is known to be below that point.
	let safest: number | null = null;
	for (let step = steps; step >= 1; step--) {
		// From the integer step, so accumulated float error cannot drift the grid.
		const pace = 1 - step * PACE_MARGIN_PRECISION;
		const { pooled } = buildPool(
			accounts,
			now,
			horizonEndMs,
			pace,
			pacedWindowKinds,
		);
		if (pooled.length === 0) return null;
		if (firstAllOut(pooled, now, horizonEndMs) !== null) break;
		safest = pace;
	}
	return safest === null ? null : { multiplier: safest };
}
