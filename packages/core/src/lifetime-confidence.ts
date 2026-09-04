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
