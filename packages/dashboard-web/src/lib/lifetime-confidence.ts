import type { LifetimeConfidence } from "@clankermux/core";

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
