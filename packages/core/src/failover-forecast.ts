import type {
	RunwayScenarioOutcome,
	RunwayWindowForecast,
} from "@clankermux/types";

/**
 * The ONE rule that would decide whether a window gets a failover run-out line
 * on the dashboard: SCORED, NOT SHIPPED.
 *
 * The demand-conserving scenario (`./capacity-runway-scenario`) projects every
 * pooled window of a servable class together: when one account's window fills,
 * its traffic moves onto the survivors in proportion to their own burn, so a
 * survivor's projected run-out moves EARLIER than the standalone estimate the
 * dashboard already shows (`windowForecast`). Until the first projected death
 * the two coincide by construction.
 *
 * This function turns that scan into a display decision. It is a pure
 * predicate so that the redistribution backtest can score EXACTLY the lines a
 * surface would show (`## Failover line` in
 * `docs/prediction-backtest-redistribution.md`, rule `FAILOVER_LINE_RULE` in
 * `./redistribution-backtest`), and so that a surface, if one ever attaches
 * the result, shows exactly the lines that were scored. Nothing else may
 * decide when the line appears.
 *
 * NOTHING IN PRODUCTION CALLS THIS. The rule was declared, then scored on the
 * 2026-07-01..09-06 history on 2026-09-07, and failed its own criterion 1:
 * the lines it would have added were right 24.1 % of the time (7 of 29
 * lifecycles) against 27.3 % for the standalone lines already shown. That is
 * the declared rule's answer at that sample size, not proof the line is worse.
 * The 56 shown instants that coincided with a dead or dying weekly window in
 * the class were right 0 times; an association the report tags, not a
 * demonstrated cause. So no surface reads it and no wire type carries its
 * result. A future surface needs a re-declared rule, on outcomes not yet
 * inspected, with a paired warning-benefit check beside precision; if it
 * excludes the weekly-associated subset it must do so BEFORE that run.
 *
 * What is emitted, and why only that:
 *
 *  - FIVE-HOUR WINDOWS ONLY. The backtest evidence for the scenario is the
 *    anthropic five-hour verdict (recall 0.771 vs 0.629 for the standalone
 *    estimate). The weekly cohort is 38 lifecycles on which both models are
 *    already 30+ hours early, and the pool-level all-out calibration shows no
 *    gain at all, so neither of those gets a line.
 *  - EARLIER THAN THE STANDALONE LINE, AND BEFORE THE RESET. The scenario can
 *    also project a window LATER (a recipient stalled behind its own dead
 *    weekly window), and "later" is not a failover warning. A projection at or
 *    past the reset is "not this cycle", the same thing the standalone line
 *    says with "on track to reset".
 *  - BY MORE THAN {@link FAILOVER_MIN_EARLIER_MS} (strictly). The two estimates
 *    are the same arithmetic from the same anchor until a death intervenes, so
 *    they can differ by a float hair with nothing moved. A declared minimum
 *    difference below which the two are treated as one statement; it is on
 *    the scale of the minute a surface would render, but it is not display
 *    equivalence (two instants under a minute apart can still round to
 *    different minutes) and it is not fitted to anything.
 *  - ONLY WHERE THE STANDALONE LINE IS A PROJECTION. A learning window shows
 *    "learning"; a window at 100 % shows the observed exhaustion. A scenario
 *    line beside either would contradict what the surface just said about the
 *    evidence.
 *  - NEVER ON AN ASSUMPTION. An outcome the scan reached only by assuming
 *    reset-credit redemptions is withheld rather than disclosed: the line has
 *    no room for the caveat, and an undisclosed assumption is worse than no
 *    line.
 *
 * NO NAMED PEER. `projectedExhaustions` is a sorted list of first-cycle deaths,
 * not a causal record: a weekly death can stop a peer's five-hour burn, an
 * already-exhausted peer contributes demand without appearing in the list at
 * all, and a later-cycle death is not in it. Naming "the earliest entry" as the
 * cause would manufacture causality the scan does not state, so the result
 * carries the instant and nothing else; the surface labels it generically.
 */

/** The only window kind with evidence behind a failover line. */
export const FAILOVER_WINDOW_KIND = "five_hour";

/**
 * How much earlier than the standalone run-out the scenario's has to be before
 * it is a different statement. The surface renders whole minutes; see the
 * module doc. Inline named constant — NO env var / feature gate.
 */
export const FAILOVER_MIN_EARLIER_MS = 60_000;

/** A window's run-out under peer failover: the scenario's first projected 100 % for it inside the current cycle. */
export interface FailoverForecast {
	exhaustsAtMs: number;
}

export interface FailoverForecastInput {
	/** The scenario scan of this account's servable class at `now`, or null when none ran. */
	scenario: RunwayScenarioOutcome | null;
	accountId: string;
	windowKind: string;
	/** The window's reading; null or ≥ 100 emits nothing. */
	utilizationPct: number | null;
	resetsAtMs: number | null;
	/** The standalone per-window forecast the surface shows beside this line. */
	standalone: RunwayWindowForecast | null;
	now: number;
}

/**
 * The failover run-out for one window, or null when there is none to state.
 *
 * `now` is accepted for symmetry with every other projection helper and for
 * callers that gate on it; the decision itself is between three instants that
 * are all relative to the same scan (`scenario`, `standalone`, `resetsAtMs`),
 * so a run-out the scan placed at or before `now` — a window filled inside its
 * own observation lag — is reported as it stands and rendered as reached.
 */
export function failoverForecast(
	input: FailoverForecastInput,
): FailoverForecast | null {
	const { scenario, standalone, resetsAtMs, utilizationPct } = input;
	if (input.windowKind !== FAILOVER_WINDOW_KIND) return null;
	if (standalone == null || standalone.state !== "projected") return null;
	if (utilizationPct == null || !Number.isFinite(utilizationPct)) return null;
	if (utilizationPct >= 100) return null;
	if (resetsAtMs == null || !Number.isFinite(resetsAtMs)) return null;
	if (scenario == null) return null;
	if (scenario.kind === "no-accounts" || scenario.kind === "unknown") {
		return null;
	}
	if (scenario.eventBudgetExhausted === "baseline") return null;
	if (scenario.unprojectableAccountIds.includes(input.accountId)) return null;
	if (scenario.unknownTierAccountIds.includes(input.accountId)) return null;
	if ((scenario.assumedResetCredits?.length ?? 0) > 0) return null;

	const projected = scenario.projectedExhaustions.find(
		(exhaustion) =>
			exhaustion.accountId === input.accountId &&
			exhaustion.windowKind === input.windowKind,
	);
	if (projected == null) return null;
	if (!Number.isFinite(projected.exhaustsAtMs)) return null;
	if (projected.exhaustsAtMs >= resetsAtMs) return null;

	const standaloneAt = standalone.exhaustsAtMs;
	if (
		standaloneAt != null &&
		Number.isFinite(standaloneAt) &&
		standaloneAt - projected.exhaustsAtMs <= FAILOVER_MIN_EARLIER_MS
	) {
		return null;
	}
	return { exhaustsAtMs: projected.exhaustsAtMs };
}
