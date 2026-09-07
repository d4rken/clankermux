import type { AccountBurnAnchors, UsageBurnAnchor } from "@clankermux/types";
import type { LifetimeConfidence } from "./capacity-runway";

/**
 * Which windows the dashboard trusts the lifetime average on.
 *
 * `estimateWindowExhaustion` takes this as an input and never derives it, so
 * the policy has to live with the surfaces that render the projection. One
 * definition rather than three `window === "seven_day"` checks, because the
 * progress-bar message, the pool at-risk list and the forecast line must not be
 * able to disagree about how much a projection is worth.
 *
 * Only the ACCOUNT-WIDE weekly window qualifies. An offline backtest over
 * ~12 weeks of stored snapshots measured the lifetime average against the
 * server regression on held-out data and the average won there on every
 * criterion that gates the display (F1, median ETA error, coverage, and the
 * precision of the red rule itself). The five-hour window went the other way,
 * so it keeps the regression and the amber cap.
 *
 * The model-family weekly windows (`seven_day_opus`, `seven_day_sonnet`,
 * `seven_day_scoped`) are deliberately excluded: they were not measured, they
 * carry no server prediction to have been compared against, and they reset on
 * their own schedules.
 */
export function weeklyLifetimeConfidence(
	windowKind: string | null,
): LifetimeConfidence | undefined {
	return windowKind === "seven_day" ? "full" : undefined;
}

/**
 * The other half of the `"full"` policy: WHEN the reading being projected from
 * was sampled, parsed out of `AccountResponse.usageAsOfIso`.
 *
 * Lives beside {@link weeklyLifetimeConfidence} because the two are one input.
 * A full-confidence lifetime estimate may render red, and its ETA is
 * `anchor + ((100 - pct) / pct) · (anchor - windowStart)` — anchored at `now`
 * that slides later by more than a second per second of wall clock, so a
 * projection near the red threshold flips between two 30-second UI ticks on
 * evidence that never changed. Anchored at the observation it is a function of
 * the reading alone and holds still until the next refetch.
 *
 * Null when the server could not say (no live cache entry behind the reading,
 * or a Codex reading rebuilt from a stored payload). That is a real answer:
 * the estimator degrades those windows to the amber-capped now-anchored
 * estimate. NEVER substitute render time — `Date.now()` here is the drift, not
 * a fix for it.
 */
export function usageObservedAtMs(
	usageAsOfIso: string | null | undefined,
): number | null {
	if (!usageAsOfIso) return null;
	const asOfMs = new Date(usageAsOfIso).getTime();
	return Number.isFinite(asOfMs) ? asOfMs : null;
}

/**
 * The third leg of the projection input set, beside
 * {@link weeklyLifetimeConfidence} and {@link usageObservedAtMs}: the burn
 * anchor the server detected for one account-wide window, out of
 * `AccountResponse.burnAnchors`.
 *
 * Lives here for the same reason the other two do: every surface that calls
 * `estimateWindowExhaustion` (progress message, pool at-risk list, forecast
 * line) must map window kind → anchor identically, or two surfaces could
 * project the same reading from two different origins. Only the account-wide
 * windows exist in the registry; any other window kind returns null.
 */
export function windowBurnAnchor(
	burnAnchors: AccountBurnAnchors | null | undefined,
	windowKind: string | null,
): UsageBurnAnchor | null {
	if (!burnAnchors || !windowKind) return null;
	if (windowKind === "five_hour") return burnAnchors.fiveHour ?? null;
	if (windowKind === "seven_day") return burnAnchors.sevenDay ?? null;
	return null;
}

/**
 * How long a weekly window must have been RUNNING before its projection may be
 * rendered RED.
 *
 * DECLARED BEFORE SCORING (2026-09-07), and bounded by two measurements rather
 * than fitted to either: every weekly window observed to run out did so no
 * earlier than 86.7 h into its 168 h cycle (median 110 h, n=9, 2026-07-01 to
 * 2026-09-06), and every red the weekly bar has shown since that red shipped on
 * 2026-08-23 began between 33 h and 36 h into the cycle (n=5, none of which ran
 * out). 72 h sits inside that gap; it is not the value that optimises any
 * score, and the gate in `redistribution-backtest.ts` (`WEEKLY_RED_FLOOR_RULE`)
 * fails the rule outright if any observed run-out would lose its warning.
 *
 * Inline named constant — NO env var / feature gate.
 */
export const WEEKLY_RED_MIN_WINDOW_AGE_MS = 72 * 60 * 60_000;

/**
 * Whether a window's projection may be rendered RED, given how long the window
 * itself has been open.
 *
 * The weekly window is the only one this constrains, and it exists because of
 * an asymmetry the shared one-hour confidence floor cannot express: that floor
 * (`ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS`) is 20 % of a five-hour cycle and 0.6 %
 * of a weekly one, so a burst in the first hours of a week projects a run-out
 * days early at FULL confidence. Measured on the shipped estimator, the five
 * weekly reds since 2026-08-23 each claimed the quota would run out 20 to 117
 * hours before the reset, each stood for 40 to 135 hours, and each sat on a
 * window that ended between 95 % and 96 % without running out.
 *
 * TONE ONLY. Below the floor the projection is unchanged — same instant, same
 * "Runs out X before reset" line, same coverage — it simply may not reach red.
 * Nothing here may gate whether a projection EXISTS: withholding, learning,
 * readiness and the scenario's demand all key on
 * `ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS`, which this deliberately does not touch.
 *
 * `windowAgeMs` is the age of the WINDOW — `now` minus its structural start —
 * and deliberately NOT the estimate's `evidenceSpanMs`, which restarts at a
 * mid-window burn anchor. Measured against the span, a gift reset would hold
 * the window amber for the next three days however fast it then burned, which
 * on a cycle with two days left means it could never go red again. The
 * post-anchor case already has its own guard: the estimate is low-confidence
 * for the first hour after the anchor, which caps it at amber on its own.
 * These two compose — an hour of evidence AND a window that has been running —
 * and neither subsumes the other.
 *
 * An unknown age is not red-eligible: a window whose start cannot be derived
 * has no reset to measure a margin against either.
 */
export function weeklyRedEligible(
	windowKind: string | null,
	windowAgeMs: number | null | undefined,
): boolean {
	if (windowKind !== "seven_day") return true;
	if (windowAgeMs == null || !Number.isFinite(windowAgeMs)) return false;
	return windowAgeMs >= WEEKLY_RED_MIN_WINDOW_AGE_MS;
}
