/**
 * The "how many accounts does this pool actually need" surface.
 *
 * Every other capacity surface in the dashboard answers a question about the
 * NEXT request. This one answers a question about the subscription: over a
 * completed weekly cycle, how much of the pool was really consumed?
 *
 * The unit is deliberately account-weeks: the sum, over the accounts of one
 * servable class, of each account's PEAK weekly utilization inside that
 * account's own reset window. Peaks, not averages, because a weekly window is
 * spent once and the high-water mark is what the provider bills against; each
 * account's own window, not a shared calendar week, because the five Anthropic
 * accounts reset on five different weekdays.
 *
 * Tier travels as a LABEL only. It is never a capacity weight: a "Max 20x"
 * account and a "Pro" account both report 0-100%, and multiplying one of them
 * by a factor would invent a common unit that the samples do not contain. The
 * verdict simply refuses to compare account-weeks whose tiers differ.
 *
 * The verdict is ONE-SIDED by construction. Consumption above n - 1
 * account-weeks proves the pool could not have served the same work with one
 * account fewer, so removal is infeasible. Consumption below that proves
 * nothing: the traffic that was served is not the traffic that would have been
 * offered, and no counterfactual is modelled here. Nothing in this payload ever
 * says an account is removable.
 */

/** Headline answer for one row. Never "removable" — see the module docblock. */
export type PoolSizingVerdict =
	/** Some completed cycle consumed more than n - 1 comparable account-weeks. */
	| "removal_infeasible"
	/** Completed cycles exist and none crossed the threshold. Not a green light. */
	| "removal_not_established"
	/** No completed cycle in the retained history yet. */
	| "insufficient_history";

/** Why a cycle did (or did not) prove infeasibility. */
export type PoolSizingVerdictBasis =
	/** Consumed more than n - 1 account-weeks in comparable units. */
	| "above_threshold"
	/** Consumed n - 1 account-weeks or less; the threshold settles it either way. */
	| "at_or_below_threshold"
	/** Accounts of this row report different (or unknown) tiers, so the sum is not a unit. */
	| "tiers_not_comparable"
	/** An account ended more than one window in the cycle, so its peaks were summed. */
	| "multiple_windows"
	/** The cycle has not finished; it is excluded from every verdict. */
	| "in_progress";

/** How windows are bucketed into cycles for one row. */
export type PoolSizingBoundaryRule =
	/**
	 * Anthropic: each account resets on a fixed weekday/hour, so the 7-day grid
	 * is anchored at the widest gap between the pool's reset phases.
	 */
	| "reset_phase_gap"
	/** Everything else: rolling windows, bucketed by ISO week (Monday 00:00 UTC). */
	| "iso_week";

/** One account's contribution to one cycle of one row. */
export interface PoolSizingAccountCycle {
	accountId: string;
	accountName: string;
	/** Sum of the account's window peaks in this cycle (max across scoped series). */
	peakPct: number;
	/** How many windows of this account ended in the cycle. */
	windows: number;
	/** Reset time of the newest contributing window, ms since epoch. */
	resetAt: number;
	/** Where the newest contributing window actually ended, ms since epoch. */
	effectiveEnd: number;
	/** Some contributing window ended before its reset (re-anchored or abandoned). */
	abandoned: boolean;
	sampleCount: number;
	/** Every contributing window was still being sampled when it ended. */
	observedThroughEnd: boolean;
	/** Tier label of the contributing windows: one value, "mixed", or null. */
	tierLabel: string | null;
}

/** One 7-day cycle of one row. */
export interface PoolSizingCycle {
	start: number;
	end: number;
	/** Earliest / latest effective window end among the cycle's members, for the label. */
	resetFrom: number | null;
	resetTo: number | null;
	status: "completed" | "in_progress";
	/** n: accounts of this row that existed during the cycle. */
	accountsInPool: number;
	/** Members of n with sampling evidence inside the cycle span. */
	accountsObserved: number;
	/** Account-weeks consumed: sum of per-account peak percentages / 100. */
	consumed: number;
	/** Part of the cycle was not observed, so `consumed` is a floor. */
	lowerBound: boolean;
	removalInfeasible: boolean;
	verdictBasis: PoolSizingVerdictBasis;
	reserveBandEntered: boolean;
	/** Client-facing refusals attributed to this row in the cycle. */
	terminalStops: number;
	/** Per-account rejections that usually failed over. Never an add signal. */
	rejectedAttempts: number;
	/** Peak simultaneous accounts at 100% of their 5-hour window. Null on family rows. */
	burstPeakAccounts: number | null;
	tierLabel: string | null;
	/** Per-account detail, ordered by account name. */
	accounts: PoolSizingAccountCycle[];
}

/** One servable class, or one Anthropic scoped family inside a class. */
export interface PoolSizingRow {
	kind: "class" | "family";
	classId: string;
	classLabel: string;
	family: string | null;
	familyLabel: string | null;
	boundaryRule: PoolSizingBoundaryRule;
	/** Accounts with at least two windows, i.e. accounts that can vote on the phase. */
	accountsVoting: number;
	/** Accounts whose windows all share one reset phase. */
	accountsLocked: number;
	/** Every account of the row reports the same known tier pair. */
	tierComparable: boolean;
	verdict: PoolSizingVerdict;
	/** Basis of the NEWEST completed cycle, or null when there is none. */
	verdictBasis: PoolSizingVerdictBasis | null;
	/** Completed cycles the headline considered (at most `verdictCycles` of the response). */
	verdictCycles: number;
	reserveBandCycles: number;
	terminalStopCycles: number;
	/** Newest first. */
	cycles: PoolSizingCycle[];
}

/** A stop that is deliberately NOT counted as capacity evidence for any row. */
export interface PoolSizingSeparateStop {
	label: string;
	model: string | null;
	count: number;
	firstAt: number;
	lastAt: number;
}

export interface PoolSizingResponse {
	generatedAt: number;
	/** Start of the fixed lookback the whole payload was computed over. */
	sinceMs: number;
	/** Nominal weekly window length, ms. */
	windowMs: number;
	/** Weekly headroom percentage the add signal treats as reserve capacity. */
	reserveHeadroomPct: number;
	/** How many completed cycles a row headline considers. */
	verdictCycles: number;
	/** How many completed cycles a row emits at most. */
	maxCycles: number;
	rows: PoolSizingRow[];
	separateStops: PoolSizingSeparateStop[];
}
