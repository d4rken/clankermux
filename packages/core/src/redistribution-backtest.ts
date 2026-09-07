import type { PredictionPoint, UsageBurnAnchor } from "@clankermux/types";
import {
	computeCapacityRunway,
	estimateWindowExhaustion,
	isLearningEstimate,
	RUNWAY_HORIZON_MS,
	type RunwayAccountInput,
	type RunwayOutcome,
	type RunwayWindowInput,
	type WindowExhaustion,
	type WindowExhaustionSource,
} from "./capacity-runway";
import {
	computeCapacityRunwayScenario,
	equalShareRule,
	observationLagMs,
	proportionalShareRule,
	type RunwayScenarioAccountInput,
	type RunwayScenarioOutcome,
	type ShareCandidate,
	type ShareRule,
} from "./capacity-runway-scenario";
import { servableClassFor } from "./pool-classes";
import {
	type BacktestMetrics,
	type BacktestRecord,
	type BacktestWindowKind,
	bootstrapDelta,
	commonCohort,
	coverageTable,
	deriveOutcome,
	FIVE_HOUR_WINDOW_MS,
	leadTimeTable,
	metricsTable,
	num,
	pct,
	type ReportBootstrapEntry,
	type ReportEstimatorMetrics,
	SEGMENT_COVERAGE_SLACK_MS,
	SEVEN_DAY_WINDOW_MS,
	scoreRecords,
} from "./prediction-backtest";
import { computeWindowStartMs } from "./throttle-utils";
import type { AccountTier } from "./tier-capacity";
import {
	computeUsagePrediction,
	isResetBoundary,
	isRevisionDrop,
	splitSeries,
} from "./usage-prediction";
import {
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
} from "./usage-window-extract";

/**
 * Survivor-conditioned replay of the demand-conserving runway scenario against
 * the model that ships today.
 *
 * PURE: no DB, no clock, no `Math.random` — the same contract as
 * `./prediction-backtest`, whose scoring, cohort, bootstrap and table helpers
 * this module reuses rather than restating. The I/O lives in
 * `scripts/redistribution-backtest.ts`.
 *
 * WHAT IS SCORED, and why it is not what the handover asked for. Section 4 of
 * `docs/handover-demand-redistribution.md` proposed scoring POOL-OUT truth:
 * instants where every account of a servable class was at 100 % or paused. A
 * read-only scan of the whole recorded history (2026-06-02 to 2026-09-06)
 * found NO such instant for any multi-account class, in either window; the only
 * all-out episodes are the one Codex account while it was the only one. A
 * verdict cannot rest on zero positives, so the scoring target is
 * survivor-conditioned instead: at instants inside a transition's 24 h shadow,
 * each account's PER-WINDOW projection from each model is scored against the
 * per-window truth the existing harness already labels (`deriveOutcome`).
 * Pool-level "out within the horizon" is still computed, but only as
 * false-alarm calibration (see {@link PoolCalibrationRow}), never as the
 * verdict basis.
 *
 * WHAT CANNOT BE REPLAYED, stated rather than hidden. `usage_snapshots` rows
 * cascade-delete with their account, so no removed account has history, and
 * `accounts.paused` keeps no history at all. The scenario's
 * `presence: "demand-only"` path — a paused or removed account whose measured
 * burn stays in the class demand — therefore has NO historical evidence here
 * and is covered by its unit tests only. The report says so.
 *
 * SIGN CONVENTION, stated once and used everywhere: the harness's signed ETA
 * error is `predictedEtaMs − outcome.atMs`, so POSITIVE means predicted later
 * than observed, i.e. OPTIMISTIC — the expensive direction.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How old the newest reading may be and still be projected from.
 *
 * Mirrors `USAGE_CACHE_TTL_MS` in `packages/providers/src/usage-fetcher.ts`,
 * the freshness bar routing and projection use in production. Restated as an
 * inline constant because core does not depend on `@clankermux/providers`; the
 * 30-minute bar elsewhere in the codebase is the DISPLAY bar and is deliberately
 * wider than this one.
 */
export const READING_STALE_MS = 10 * MINUTE_MS;

/** How long after a transition an instant is still counted as "at" it. */
export const TRANSITION_WINDOW_MS = 24 * HOUR_MS;

const WINDOW_KINDS: readonly BacktestWindowKind[] = ["five_hour", "seven_day"];

const WINDOW_MS: Record<BacktestWindowKind, number> = {
	five_hour: FIVE_HOUR_WINDOW_MS,
	seven_day: SEVEN_DAY_WINDOW_MS,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One `usage_snapshots` row, exactly as the script reads it. */
export interface RosterSnapshotRow {
	accountId: string;
	provider: string | null;
	sampledAt: number;
	observedAt: number | null;
	fiveHourPct: number | null;
	fiveHourReset: number | null;
	sevenDayPct: number | null;
	sevenDayReset: number | null;
	planTier: string | null;
	rateLimitTier: string | null;
}

/** One `accounts` row. Removed accounts have none — see the module doc. */
export interface RosterAccount {
	accountId: string;
	name: string;
	provider: string;
	createdAtMs: number;
	currentPlanTier: string | null;
	currentRateLimitTier: string | null;
}

/**
 * A name for the report's tables. An account with snapshots or traffic but no
 * row left in `accounts` falls back to its id, which is all the history has.
 */
function accountNameLookup(
	accounts: readonly RosterAccount[],
): (accountId: string) => string {
	const nameByAccount = new Map<string, string>();
	for (const account of accounts) {
		nameByAccount.set(account.accountId, account.name);
	}
	return (accountId: string): string =>
		nameByAccount.get(accountId) ?? accountId;
}

export type TransitionKind =
	| "peer-exhaustion"
	| "add"
	| "upgrade"
	| "gift-reset";

/** Declaration order, and the order tags are reported in. */
const TRANSITION_KINDS: readonly TransitionKind[] = [
	"peer-exhaustion",
	"add",
	"upgrade",
	"gift-reset",
];

export interface TransitionEvent {
	id: number;
	kind: TransitionKind;
	atMs: number;
	endsAtMs: number;
	demandClass: string;
	accountId: string;
	/** The account's display name, so the report's table is readable. */
	accountName: string;
	windowKind: BacktestWindowKind | null;
	detail: string;
}

export type ReplayModel =
	| "current"
	/** The equal split with the observation-lag advance — the PRIOR verdict basis. */
	| "scenario-equal"
	/** The same equal split with the PRE-CORRECTION scan — the prior basis's control. */
	| "scenario-equal-original"
	| "scenario-headroom"
	/** The verdict basis — see {@link VERDICT_BASIS_MODEL}. */
	| "scenario-proportional"
	/** The basis's own PRE-CORRECTION scan — see {@link VERDICT_BASIS_CONTROL_MODEL}. */
	| "scenario-proportional-original";

/** Every scan the replay runs, in the order the report prints them. */
export const REPLAY_MODELS: readonly ReplayModel[] = [
	"current",
	"scenario-equal",
	"scenario-equal-original",
	"scenario-headroom",
	"scenario-proportional",
	"scenario-proportional-original",
];

/**
 * The share rule the VERDICT is computed on, re-declared on 2026-09-07.
 *
 * It was declared as a candidate in v2026.9.19 and scored beside
 * {@link PRIOR_BASIS_MODEL}, the equal split, which had been the basis until
 * then. What re-declared it is the MECHANISM rather than any score: the equal
 * split discards every account's own burn from the first instant, which is
 * where the prior basis's optimism at transitions came from, while the
 * proportional rule reproduces the current model until a death.
 *
 * Nothing in this file reads a coefficient off the tables it is judged on, and
 * {@link VERDICT_RULE} still states no number.
 */
export const VERDICT_BASIS_MODEL =
	"scenario-proportional" as const satisfies ScenarioModel;

/**
 * The basis's own pre-correction control: the SAME share rule with the
 * observation-lag advance switched off, so criterion D can attribute a
 * difference to the advance and to nothing else.
 */
export const VERDICT_BASIS_CONTROL_MODEL =
	"scenario-proportional-original" as const satisfies ScenarioModel;

/**
 * The verdict basis through v2026.9.19, scored BESIDE the basis ever since and
 * never inside the verdict.
 */
export const PRIOR_BASIS_MODEL =
	"scenario-equal" as const satisfies ScenarioModel;

/** The prior basis's own pre-correction control, the object of the lag checks. */
export const PRIOR_BASIS_CONTROL_MODEL =
	"scenario-equal-original" as const satisfies ScenarioModel;

/** The models that are a {@link computeCapacityRunwayScenario} call. */
export type ScenarioModel = Exclude<ReplayModel, "current">;

/**
 * The pre-correction control criterion D judges each model against: the same
 * share rule with the lag advance switched off.
 *
 * A model with no such twin has NO control, and its D is indeterminate rather
 * than judged against another rule's control — a comparison across two share
 * rules and the advance at once cannot attribute a difference to either.
 */
export const CONTROL_MODELS: Partial<Record<ScenarioModel, ScenarioModel>> = {
	[VERDICT_BASIS_MODEL]: VERDICT_BASIS_CONTROL_MODEL,
	[PRIOR_BASIS_MODEL]: PRIOR_BASIS_CONTROL_MODEL,
};

/**
 * The share rules scored beside the basis, in the order the report prints them.
 *
 * None of them enters the verdict: {@link evaluateVerdict} reads nothing from
 * this list, and the report says so where it prints them.
 */
export const BESIDE_BASIS_MODELS: readonly ScenarioModel[] = [
	PRIOR_BASIS_MODEL,
	"scenario-headroom",
];

export interface RedistributionRecord extends BacktestRecord {
	model: ReplayModel;
	/** Stable id of the (account, windowKind, lifecycle) this record belongs to. */
	lifecycleId: string;
	tags: TransitionKind[];
	/** Ids of the transition events active at T for this record (drives episode blocks). */
	eventIds: number[];
	/** True when the CURRENT model withholds this ACCOUNT as learning at T (any window learning). */
	learningAtT: boolean;
	/** For peer-exhaustion-tagged records: T minus the most recent peer death in the class, else null. */
	sinceDeathMs: number | null;
	/**
	 * The CURRENT estimator's fitted burn slope for this window at T, in
	 * percentage points per hour, or null where it has none (learning, no
	 * anchor, already exhausted).
	 *
	 * A property of the (account, window, T) reading rather than of a model, so
	 * every model's record at one instant carries the SAME number: it is the
	 * survivor's own measured burn, which is exactly what
	 * {@link survivorSlopeTrajectory} needs to ask how fast a survivor absorbs
	 * the traffic a dead peer left behind. Read-only capture of
	 * `estimateWindowExhaustion(...).slopePctPerHour`; nothing here changes what
	 * either model projects.
	 */
	slopePctPerHour: number | null;
	/**
	 * `T - observed_at` of the row this record was projected from, or `null`
	 * when the row carries no observation instant (most snapshots before
	 * 2026-08-24 do not). Never `0` for absent — the two are different answers.
	 */
	observationAgeMs: number | null;
	/** `T - sampled_at` of that row. Always known: a row has a sample time. */
	sampleAgeMs: number;
	/**
	 * The window's OWN observation lag, from {@link observationLagMs} — how far
	 * behind `T` the estimator that produced its projection measured. `0` on the
	 * now-anchored paths, which carry none.
	 */
	lagMs: number;
	/** Which estimator answered for this window at `T`. */
	estimatorSource: WindowExhaustionSource;
	/**
	 * True when NO pooled window of this record's class carries a lag at `T`.
	 * The window's own zero lag is not enough: a peer's lag moves the peer's
	 * death and therefore this window's share, and with it its ETA.
	 */
	classLagFree: boolean;
	/** Pooled accounts of this record's class at `T`, as the corrected scan classified them. */
	pooledInClass: number;
	/**
	 * True when the corrected scan's projected exhaustion for this window
	 * precedes any other projected exhaustion still ahead of `T`, and the reset
	 * of any class window already at 100 % at `T`.
	 */
	firstEvent: boolean;
	/**
	 * True when this window is still projecting ahead of `T` in the corrected
	 * scan while ANOTHER window of its class — a peer's, or another window of
	 * its own account — was filled inside its observation lag and so died AT
	 * `T`.
	 *
	 * Such a death is invisible to {@link firstEvent}, which orders events at
	 * `T` and therefore sees nothing standing ahead of this window. It still
	 * re-splits the class from `T` on: this window's share, and with it its
	 * whole projection, is not the one the pre-correction scan gave it, and on a
	 * lone account the dead span until that window's reset is something the
	 * current model does not model at all.
	 */
	peerDiedInLag: boolean;
	/**
	 * True when the window is the first event of BOTH equal-split scans — the
	 * corrected one and the pre-correction one — and `peerDiedInLag` is false.
	 *
	 * One scan is not enough to expect an exact lag shift: a peer the correction
	 * fills inside its own lag dies at `T` in the corrected scan, so it never
	 * stands ahead of this window there, while in the original scan it is alive
	 * at `T` and dies part-way to this window's ETA. The shift is then the
	 * arithmetic of two slopes rather than the window's own lag. A peer that
	 * dies at `T` in BOTH scans is the same story told at one instant: this
	 * window's share doubles from `T` on, so {@link peerDiedInLag} disqualifies
	 * it too.
	 */
	exactShiftEligible: boolean;
	/**
	 * False exactly where the estimator path admits a lag but no anchor could be
	 * derived for it: a `regression` estimate with no ETA or a non-positive
	 * slope (the fit's anchor is recoverable only through its ETA), and a
	 * `lifetime-primary` estimate with no finite observation instant.
	 *
	 * Those records carry `lagMs: 0` because nothing could be derived, which is
	 * not the same statement as a measured zero and must not be medianed beside
	 * one. The now-anchored paths carry no lag at all, so their zero IS derived
	 * and this stays true for them.
	 */
	lagAnchorKnown: boolean;
	/**
	 * True where the BASIS scan ({@link VERDICT_BASIS_MODEL}) projects this
	 * window on its first assignment with every contributor to the class demand
	 * both alive and IN that assignment: no class window is already at 100 % at
	 * `T`, no account whose measured burn joined the class demand was withheld
	 * from the pool it is split over, no class exhaustion of any cycle stands
	 * between `T` and this window's own, and no class window was filled inside
	 * its own observation lag.
	 *
	 * That is exactly the population the proportional rule's identity with the
	 * current model is defined on — with every contributor alive AND pooled the
	 * demand handed back to an account is the burn it contributed, so it burns
	 * at its own measured slope. An account that is dead AT `T` is a contributor
	 * whose demand the survivors already carry from the first assignment, which
	 * is why a class member at 100 % disqualifies the instant rather than only
	 * the events after it; a withheld or demand-only contributor does the same
	 * thing without anything having died at all.
	 *
	 * "Of any cycle" is the second thing a projection list cannot state: it
	 * holds first-cycle deaths only, and a window that resets and fills again
	 * re-splits the class just as its first fill would have.
	 *
	 * Taken from the BASIS's OWN scan: two share rules order a class's events
	 * differently, so another rule's first-event flag is not a statement about
	 * where this scan's first assignment ends.
	 */
	basisFirstAssignment: boolean;
}

export interface ReplayRange {
	label: string;
	fromMs: number;
	toMs: number;
}

// ---------------------------------------------------------------------------
// Share rules
// ---------------------------------------------------------------------------

/**
 * Handover option 2: `w_j = max(0, 100 − maxPct_j) × capacityUnits_j`.
 *
 * Approximates least-used routing — the account with the most room left takes
 * the most load — in capacity units rather than percentages, because a percent
 * of a Max 20x is not a percent of a Pro. `maxPct` is the account's FULLEST
 * window: an account is only as routable as its tightest constraint.
 *
 * Reported as a secondary column and never as the verdict basis (that is
 * {@link VERDICT_BASIS_MODEL}). When every weight is zero — every alive account
 * at 100 % or unmetered-with-no-capacity — it falls back to the equal split:
 * there is nothing left to weight by, and the scan's next event kills them all
 * anyway.
 *
 * Ignores `windowKind`: `maxPct` is an ACCOUNT-wide statement — an account is
 * only as routable as its tightest window — so this rule weights every kind the
 * same way.
 */
export const headroomShareRule: ShareRule = (candidates, windowKind) => {
	const weights = candidates.map((candidate: ShareCandidate) => {
		const units = candidate.capacityUnits;
		if (units == null || !Number.isFinite(units)) return 0;
		const maxPct = candidate.windows.reduce(
			(worst, window) =>
				Number.isFinite(window.utilizationPct)
					? Math.max(worst, window.utilizationPct)
					: worst,
			0,
		);
		return Math.max(0, 100 - maxPct) * units;
	});
	return weights.some((weight) => weight > 0)
		? weights
		: equalShareRule(candidates, windowKind);
};

/** What one scenario model asks {@link computeCapacityRunwayScenario} for. */
export interface ScenarioModelSpec {
	shareRule: ShareRule;
	/** See `RunwayScenarioOptions.observationLag`. */
	observationLag: "advance" | "ignore";
}

/**
 * The scan behind each scenario model.
 *
 * Each `-original` differs from its own rule in ONE argument, which is the
 * whole point of a pair: the share rule is held fixed so the only thing the
 * comparison can attribute a difference to is the observation-lag advance. See
 * {@link CONTROL_MODELS} for which model each control belongs to.
 */
export const SCENARIO_MODELS: Record<ScenarioModel, ScenarioModelSpec> = {
	"scenario-equal": { shareRule: equalShareRule, observationLag: "advance" },
	"scenario-equal-original": {
		shareRule: equalShareRule,
		observationLag: "ignore",
	},
	"scenario-headroom": {
		shareRule: headroomShareRule,
		observationLag: "advance",
	},
	"scenario-proportional": {
		shareRule: proportionalShareRule,
		observationLag: "advance",
	},
	"scenario-proportional-original": {
		shareRule: proportionalShareRule,
		observationLag: "ignore",
	},
};

/** {@link REPLAY_MODELS} without the current model, in the same order. */
export const SCENARIO_MODEL_IDS: readonly ScenarioModel[] =
	REPLAY_MODELS.filter((model): model is ScenarioModel => model !== "current");

// ---------------------------------------------------------------------------
// Series preparation
// ---------------------------------------------------------------------------

export interface SeriesLifecycle {
	id: string;
	/** Index of the first point, inclusive. */
	startIndex: number;
	/** Index of the last point, inclusive. */
	endIndex: number;
	/** The reset the window's FINAL sample carried — GROUND TRUTH only. */
	labelResetAtMs: number | null;
	/** First sample of the NEXT lifecycle, or null at the end of history. */
	nextWindowStartsMs: number | null;
	/**
	 * A codex-style one-sample artefact rather than a window: at most two
	 * samples, never above 0 %. Excluded from scoring and from peer-exhaustion
	 * detection (see `dataQualityNotes` in `scripts/prediction-backtest.ts`).
	 */
	placeholder: boolean;
}

export interface WindowSeries {
	kind: BacktestWindowKind;
	points: PredictionPoint[];
	/** Parallel to `points`: when each reading was observed, or null. */
	observedAt: (number | null)[];
	/** Parallel to `points`. */
	planTier: (string | null)[];
	/** Parallel to `points`. */
	rateLimitTier: (string | null)[];
	lifecycles: SeriesLifecycle[];
	/** Parallel to `points`: which lifecycle each point belongs to. */
	lifecycleIndex: number[];
	/**
	 * Parallel to `points`: the burn anchor in force AT that point, from the
	 * revision drops at or before it inside the same lifecycle. POINT-IN-TIME —
	 * a later drop never reaches back into an earlier index.
	 */
	anchorAtIndex: (UsageBurnAnchor | null)[];
}

export interface AccountSeries {
	accountId: string;
	provider: string;
	/** Every row for this account, ascending by `sampledAt`. */
	rows: RosterSnapshotRow[];
	windows: Record<BacktestWindowKind, WindowSeries>;
	/** Parallel to `rows`: that row's index in each window's `points`, or null. */
	pointIndex: Record<BacktestWindowKind, (number | null)[]>;
	/** Monotone cursor for ascending instant lookups; see `latestRowIndexAt`. */
	cursor: number;
}

const pctOf = (
	row: RosterSnapshotRow,
	kind: BacktestWindowKind,
): number | null => (kind === "five_hour" ? row.fiveHourPct : row.sevenDayPct);

const resetOf = (
	row: RosterSnapshotRow,
	kind: BacktestWindowKind,
): number | null =>
	kind === "five_hour" ? row.fiveHourReset : row.sevenDayReset;

function emptyWindowSeries(kind: BacktestWindowKind): WindowSeries {
	return {
		kind,
		points: [],
		observedAt: [],
		planTier: [],
		rateLimitTier: [],
		lifecycles: [],
		lifecycleIndex: [],
		anchorAtIndex: [],
	};
}

/**
 * Group rows per account and window kind, split each into window lifecycles,
 * and precompute the per-point burn anchors.
 *
 * Done ONCE for the whole run: the replay visits thousands of instants and
 * every one of them needs the same segmentation, so re-deriving it per instant
 * would dominate the runtime.
 */
export function prepareSeries(
	rows: readonly RosterSnapshotRow[],
	accounts: readonly RosterAccount[],
): Map<string, AccountSeries> {
	const providerByAccount = new Map<string, string>();
	for (const account of accounts) {
		providerByAccount.set(account.accountId, account.provider);
	}

	const byAccount = new Map<string, AccountSeries>();
	const sorted = [...rows].sort(
		(a, b) =>
			a.sampledAt - b.sampledAt || a.accountId.localeCompare(b.accountId),
	);
	for (const row of sorted) {
		let series = byAccount.get(row.accountId);
		if (!series) {
			series = {
				accountId: row.accountId,
				// A removed account has no `accounts` row, so the snapshot's own
				// provider column is the only source left.
				provider:
					providerByAccount.get(row.accountId) ?? row.provider ?? "unknown",
				rows: [],
				windows: {
					five_hour: emptyWindowSeries("five_hour"),
					seven_day: emptyWindowSeries("seven_day"),
				},
				pointIndex: { five_hour: [], seven_day: [] },
				cursor: 0,
			};
			byAccount.set(row.accountId, series);
		}
		series.rows.push(row);
		for (const kind of WINDOW_KINDS) {
			const utilization = pctOf(row, kind);
			if (utilization == null) {
				series.pointIndex[kind].push(null);
				continue;
			}
			const window = series.windows[kind];
			series.pointIndex[kind].push(window.points.length);
			window.points.push({
				t: row.sampledAt,
				utilization,
				resetsAt: resetOf(row, kind),
			});
			window.observedAt.push(row.observedAt);
			window.planTier.push(row.planTier);
			window.rateLimitTier.push(row.rateLimitTier);
		}
	}

	for (const series of byAccount.values()) {
		for (const kind of WINDOW_KINDS) {
			buildLifecycles(series.accountId, series.windows[kind]);
			buildAnchors(series.windows[kind]);
		}
	}
	return byAccount;
}

function buildLifecycles(accountId: string, window: WindowSeries): void {
	// `isResetBoundary`, never `isFitBoundary`: a refund drops utilization
	// without ending the quota window, and such a window can still exhaust
	// later. Same rule the per-window harness labels truth with.
	const segments = splitSeries(window.points, isResetBoundary);
	let index = 0;
	segments.forEach((segment, segmentIndex) => {
		const startIndex = index;
		const endIndex = index + segment.length - 1;
		index += segment.length;
		const last = segment[segment.length - 1];
		const next = segments[segmentIndex + 1];
		const maxPct = segment.reduce(
			(worst, point) => Math.max(worst, point.utilization),
			0,
		);
		window.lifecycles.push({
			id: `${accountId}::${window.kind}::${segment[0].t}`,
			startIndex,
			endIndex,
			labelResetAtMs: last.resetsAt ?? null,
			nextWindowStartsMs: next ? next[0].t : null,
			placeholder: segment.length <= 2 && maxPct === 0,
		});
		for (let i = startIndex; i <= endIndex; i++) {
			window.lifecycleIndex[i] = window.lifecycles.length - 1;
		}
	});
}

function buildAnchors(window: WindowSeries): void {
	let current: UsageBurnAnchor | null = null;
	for (let i = 0; i < window.points.length; i++) {
		if (i === 0 || window.lifecycleIndex[i] !== window.lifecycleIndex[i - 1]) {
			current = null;
		} else {
			const prev = window.points[i - 1];
			const cur = window.points[i];
			const observedAt = window.observedAt[i];
			if (
				isRevisionDrop(prev.utilization, cur.utilization) &&
				observedAt != null &&
				cur.resetsAt != null
			) {
				current = {
					anchorMs: observedAt,
					anchorPct: cur.utilization,
					windowResetMs: cur.resetsAt,
				};
			}
		}
		window.anchorAtIndex[i] = current;
	}
}

/**
 * Index of the newest row at or before `T`, or -1.
 *
 * The cursor makes an ascending sweep O(1) amortised per instant; a caller that
 * jumps backwards (the tests do) is still correct, it just pays a rescan.
 */
function latestRowIndexAt(series: AccountSeries, T: number): number {
	if (series.cursor > 0 && series.rows[series.cursor - 1].sampledAt > T) {
		series.cursor = 0;
	}
	while (
		series.cursor < series.rows.length &&
		series.rows[series.cursor].sampledAt <= T
	) {
		series.cursor++;
	}
	return series.cursor - 1;
}

/** First index whose point is at or after `t`. */
function lowerBound(points: readonly PredictionPoint[], t: number): number {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].t < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Every roster transition the recorded history can prove, inside `range`.
 *
 * Pause and removal are absent BY NECESSITY, not by omission: see the module
 * doc. Ids are assigned in `atMs` order so an episode block is identified by a
 * number a reader can look up in the report's event table.
 */
export function detectTransitions(
	series: ReadonlyMap<string, AccountSeries>,
	accounts: readonly RosterAccount[],
	range: ReplayRange,
): TransitionEvent[] {
	const found: Omit<TransitionEvent, "id">[] = [];
	const inRange = (atMs: number): boolean =>
		atMs >= range.fromMs && atMs < range.toMs;
	const nameOf = accountNameLookup(accounts);

	for (const account of accounts) {
		if (!inRange(account.createdAtMs)) continue;
		found.push({
			kind: "add",
			atMs: account.createdAtMs,
			endsAtMs: account.createdAtMs + TRANSITION_WINDOW_MS,
			demandClass: servableClassFor(account.provider).classId,
			accountId: account.accountId,
			accountName: nameOf(account.accountId),
			windowKind: null,
			detail: "created",
		});
	}

	for (const accountSeries of series.values()) {
		const demandClass = servableClassFor(accountSeries.provider).classId;

		// Upgrades: a tier PAIR that changes from one known plan to another. The
		// `(null, null) -> anything` step is the 2026-08-24 column introduction,
		// not an upgrade, and is skipped.
		let prevPlan: string | null = null;
		let prevRateLimit: string | null = null;
		let seenTier = false;
		for (const row of accountSeries.rows) {
			const plan = row.planTier;
			const rateLimit = row.rateLimitTier;
			const changed = plan !== prevPlan || rateLimit !== prevRateLimit;
			if (seenTier && changed && prevPlan != null && plan != null) {
				if (inRange(row.sampledAt)) {
					found.push({
						kind: "upgrade",
						atMs: row.sampledAt,
						endsAtMs: row.sampledAt + TRANSITION_WINDOW_MS,
						demandClass,
						accountId: accountSeries.accountId,
						accountName: nameOf(accountSeries.accountId),
						windowKind: null,
						detail: `${prevPlan}/${prevRateLimit ?? "—"} → ${plan}/${rateLimit ?? "—"}`,
					});
				}
			}
			prevPlan = plan;
			prevRateLimit = rateLimit;
			seenTier = true;
		}

		for (const kind of WINDOW_KINDS) {
			const window = accountSeries.windows[kind];

			// Gift resets: a mid-window revision drop, i.e. one the reset column did
			// NOT move with.
			for (let i = 1; i < window.points.length; i++) {
				const prev = window.points[i - 1];
				const cur = window.points[i];
				if (isResetBoundary(prev, cur)) continue;
				if (!isRevisionDrop(prev.utilization, cur.utilization)) continue;
				if (!inRange(cur.t)) continue;
				found.push({
					kind: "gift-reset",
					atMs: cur.t,
					endsAtMs: cur.t + TRANSITION_WINDOW_MS,
					demandClass,
					accountId: accountSeries.accountId,
					accountName: nameOf(accountSeries.accountId),
					windowKind: kind,
					detail: `drop ${prev.utilization} → ${cur.utilization} pp`,
				});
			}

			// Peer exhaustions: the first 100 % reading of each real window.
			for (const lifecycle of window.lifecycles) {
				if (lifecycle.placeholder) continue;
				let deathAt: number | null = null;
				for (let i = lifecycle.startIndex; i <= lifecycle.endIndex; i++) {
					if (window.points[i].utilization >= 100) {
						deathAt = window.points[i].t;
						break;
					}
				}
				if (deathAt == null || !inRange(deathAt)) continue;
				const reset = lifecycle.labelResetAtMs;
				// The dead span ends at the dying window's own reset: after that the
				// peer is back and the survivors are no longer carrying its load.
				const endsAtMs =
					reset != null
						? Math.min(deathAt + TRANSITION_WINDOW_MS, reset)
						: deathAt + TRANSITION_WINDOW_MS;
				const hours =
					reset != null ? ((reset - deathAt) / HOUR_MS).toFixed(1) : "unknown";
				found.push({
					kind: "peer-exhaustion",
					atMs: deathAt,
					endsAtMs,
					demandClass,
					accountId: accountSeries.accountId,
					accountName: nameOf(accountSeries.accountId),
					windowKind: kind,
					detail: `hit 100 with ${hours} h to reset`,
				});
			}
		}
	}

	return found
		.sort(
			(a, b) =>
				a.atMs - b.atMs ||
				a.accountId.localeCompare(b.accountId) ||
				a.kind.localeCompare(b.kind),
		)
		.map((event, index) => ({ id: index + 1, ...event }));
}

export interface TransitionContext {
	tags: TransitionKind[];
	eventIds: number[];
	sinceDeathMs: number | null;
}

/**
 * Which transitions an account of `demandClass` is living through at `T`.
 *
 * Class-wide, because redistribution is class-wide: a peer's death is the
 * SURVIVORS' transition. The dying account itself is excluded from its own
 * peer-exhaustion event — nothing was redistributed onto it.
 */
export function transitionsAt(
	events: readonly TransitionEvent[],
	T: number,
	accountId: string,
	demandClass: string,
): TransitionContext {
	const kinds = new Set<TransitionKind>();
	const eventIds: number[] = [];
	let lastDeath: number | null = null;
	for (const event of events) {
		// Sorted by `atMs`: nothing further can be active at T.
		if (event.atMs >= T) break;
		if (event.demandClass !== demandClass) continue;
		if (T > event.endsAtMs) continue;
		if (event.kind === "peer-exhaustion" && event.accountId === accountId) {
			continue;
		}
		kinds.add(event.kind);
		eventIds.push(event.id);
		if (event.kind === "peer-exhaustion") {
			lastDeath =
				lastDeath == null ? event.atMs : Math.max(lastDeath, event.atMs);
		}
	}
	return {
		tags: TRANSITION_KINDS.filter((kind) => kinds.has(kind)),
		eventIds: eventIds.sort((a, b) => a - b),
		sinceDeathMs: lastDeath == null ? null : T - lastDeath,
	};
}

// ---------------------------------------------------------------------------
// Window fills: time to first 100 %
// ---------------------------------------------------------------------------

/**
 * How much of a window's start counts as its peer-loss exposure.
 *
 * A FIXED prefix, not "a peer died at some point during the fill". The naive
 * definition is length-biased: a longer fill has more calendar time in which to
 * contain a peer death, so conditioning on it pushes the peer-lost arm toward
 * LONGER fills, which is the opposite of the direction absorption would move
 * them and would make a null result uninterpretable. The prefix is a property
 * of the window, decided before any duration is read.
 *
 * One hour of a five-hour window and 24 hours of a weekly one: the same
 * fraction of each window, roughly, so neither kind's arm is defined over a
 * wider slice of its own life than the other's.
 */
export const PEER_LOSS_PREFIX_MS: Record<BacktestWindowKind, number> = {
	five_hour: HOUR_MS,
	seven_day: 24 * HOUR_MS,
};

/**
 * One window lifecycle's fill, read straight off the recorded samples.
 *
 * MEASUREMENT, not model: nothing here fits, projects or thresholds. It exists
 * because {@link survivorSlopeTrajectory} answers the absorption question
 * through fitted slopes and therefore cannot see absorption at all where the
 * survivor was still learning when its peer died.
 */
export interface WindowFill {
	accountId: string;
	demandClass: string;
	windowKind: BacktestWindowKind;
	lifecycleId: string;
	/** `computeWindowStartMs(labelResetAtMs, kind)`; null when the segment carries no reset. */
	windowStartMs: number | null;
	/** The reset the lifecycle was labelled with; null when it carries none. */
	labelResetAtMs: number | null;
	firstSampleMs: number;
	firstSampleUtilization: number;
	lastSampleMs: number;
	/** First sample of the NEXT lifecycle; null when none was ever observed. */
	nextWindowStartsMs: number | null;
	/** First point in the lifecycle with utilization >= 100; null means censored. */
	firstHundredMs: number | null;
	/** `firstHundredMs` minus the sample before it: the resolution the crossing sits inside. */
	resolutionMs: number | null;
	peerLostInPrefix: boolean;
	peerLostDuringFill: boolean;
	/** The fixed prefix lies inside the replayed range, so its arm is readable. */
	exposureObservable: boolean;
	/**
	 * The whole `[windowStartMs, firstHundredMs ?? lastSampleMs)` span lies
	 * inside the replayed range. The during-fill split reads peer deaths over
	 * that span rather than over the prefix, so the prefix predicate does not
	 * govern it: a fill running past the range would read as `no peer lost`
	 * from missing data alone.
	 */
	duringFillObservable: boolean;
}

export interface WindowFillScan {
	fills: WindowFill[];
	/** Placeholder lifecycles skipped, for the report's reconciliation. */
	placeholderLifecyclesSkipped: number;
}

/**
 * Every non-placeholder window lifecycle, with its fill and its peer-loss
 * exposure.
 *
 * Iterates the lifecycles {@link prepareSeries} already segmented on
 * `isResetBoundary`, so a reset that moves by a window length with a second of
 * rollover jitter splits exactly where the truth labelling splits it. Grouping
 * on the raw reset value instead would merge or split on jitter.
 *
 * The origin is the DERIVED window start, `reset - duration`: measuring from
 * the first sample instead would silently drop however much of the fill
 * happened before the sampler first saw the window.
 */
export function scanWindowFills(
	series: ReadonlyMap<string, AccountSeries>,
	events: readonly TransitionEvent[],
	range: ReplayRange,
): WindowFillScan {
	const deaths = events.filter((event) => event.kind === "peer-exhaustion");
	const fills: WindowFill[] = [];
	let placeholderLifecyclesSkipped = 0;

	for (const accountSeries of series.values()) {
		const demandClass = servableClassFor(accountSeries.provider).classId;
		for (const kind of WINDOW_KINDS) {
			const window = accountSeries.windows[kind];
			const prefixMs = PEER_LOSS_PREFIX_MS[kind];
			for (const lifecycle of window.lifecycles) {
				if (lifecycle.placeholder) {
					placeholderLifecyclesSkipped++;
					continue;
				}
				const windowStartMs =
					lifecycle.labelResetAtMs == null
						? null
						: computeWindowStartMs(lifecycle.labelResetAtMs, kind);

				let firstHundredMs: number | null = null;
				let resolutionMs: number | null = null;
				for (let i = lifecycle.startIndex; i <= lifecycle.endIndex; i++) {
					if (window.points[i].utilization < 100) continue;
					firstHundredMs = window.points[i].t;
					resolutionMs =
						i > lifecycle.startIndex
							? window.points[i].t - window.points[i - 1].t
							: null;
					break;
				}

				const firstSampleMs = window.points[lifecycle.startIndex].t;
				const lastSampleMs = window.points[lifecycle.endIndex].t;
				// A peer death is a death of ANOTHER account of the same demand
				// class, in EITHER of its windows: a five-hour death takes the peer
				// out of routing and so bears on a survivor's weekly window too.
				const peerDied = (fromMs: number, toMs: number): boolean =>
					deaths.some(
						(event) =>
							event.demandClass === demandClass &&
							event.accountId !== accountSeries.accountId &&
							event.atMs >= fromMs &&
							event.atMs < toMs,
					);

				fills.push({
					accountId: accountSeries.accountId,
					demandClass,
					windowKind: kind,
					lifecycleId: lifecycle.id,
					windowStartMs,
					labelResetAtMs: lifecycle.labelResetAtMs,
					firstSampleMs,
					firstSampleUtilization:
						window.points[lifecycle.startIndex].utilization,
					lastSampleMs,
					nextWindowStartsMs: lifecycle.nextWindowStartsMs,
					firstHundredMs,
					resolutionMs,
					peerLostInPrefix:
						windowStartMs != null &&
						peerDied(windowStartMs, windowStartMs + prefixMs),
					peerLostDuringFill:
						windowStartMs != null &&
						peerDied(windowStartMs, firstHundredMs ?? lastSampleMs),
					// `detectTransitions` only finds deaths inside `range`, so a
					// prefix that reaches outside it would read as "no peer lost"
					// purely from missing data.
					exposureObservable:
						windowStartMs != null &&
						windowStartMs >= range.fromMs &&
						windowStartMs + prefixMs <= range.toMs,
					duringFillObservable:
						windowStartMs != null &&
						windowStartMs >= range.fromMs &&
						(firstHundredMs ?? lastSampleMs) <= range.toMs,
				});
			}
		}
	}

	fills.sort(
		(a, b) =>
			a.firstSampleMs - b.firstSampleMs ||
			a.lifecycleId.localeCompare(b.lifecycleId),
	);
	return { fills, placeholderLifecyclesSkipped };
}

export interface WindowFillMetrics {
	/** From the derived window start to the crossing. */
	fillDurationMs: number | null;
	/** From the first sample to the crossing. */
	observedSpanMs: number | null;
	/** From the derived window start to the first sample. */
	unobservedHeadMs: number | null;
}

/** The three durations a fill implies, derived rather than stored twice. */
export function windowFillMetrics(fill: WindowFill): WindowFillMetrics {
	const start = fill.windowStartMs;
	const hundred = fill.firstHundredMs;
	return {
		fillDurationMs: start != null && hundred != null ? hundred - start : null,
		observedSpanMs: hundred != null ? hundred - fill.firstSampleMs : null,
		unobservedHeadMs: start != null ? fill.firstSampleMs - start : null,
	};
}

export type WindowFillScope = BacktestWindowKind | "combined";

const WINDOW_FILL_SCOPES: readonly WindowFillScope[] = [
	"five_hour",
	"seven_day",
	"combined",
];

/** Fills below which a cell prints its raw durations instead of a median. */
export const RAW_FILL_DURATION_LIMIT = 20;

/**
 * Whether a window that never read 100 % was FOLLOWED to its end.
 *
 * BOTH halves of `deriveOutcome`'s rule, not the proximity half alone: the
 * successor window has to have been OBSERVED to start, and this window's
 * sampling has to have run to within {@link SEGMENT_COVERAGE_SLACK_MS} of its
 * end. A last sample two minutes before that end with nothing ever recorded
 * after it is a run that stopped, not a window observed not to fill; proximity
 * alone would label it completed and disagree with the outcome labels the rest
 * of the harness scores against. Read as one `censored` count, a cell whose
 * follow-up simply ended looks like a cell of slow windows.
 *
 * The end is the EARLIER of the reset and the observed start of the successor,
 * the same instant `deriveOutcome` measures to. A window whose successor was
 * seen to start three hours before its own reset ended there, whatever the
 * reset column says; measuring to the reset alone calls that window's follow-up
 * incomplete while the outcome labels call the same window survived.
 */
export function fillCensoring(
	fill: WindowFill,
): "completed-below-hundred" | "follow-up-incomplete" {
	if (fill.labelResetAtMs == null) return "follow-up-incomplete";
	if (fill.nextWindowStartsMs == null) return "follow-up-incomplete";
	const windowEndMs = Math.min(fill.labelResetAtMs, fill.nextWindowStartsMs);
	return windowEndMs - fill.lastSampleMs <= SEGMENT_COVERAGE_SLACK_MS
		? "completed-below-hundred"
		: "follow-up-incomplete";
}

export interface WindowFillRow {
	exposure: string;
	window: WindowFillScope;
	/** Windows of this cell that reached 100 %. */
	fills: number;
	/** Windows of this cell whose last sample was still below 100 %. */
	censored: number;
	/** Of those, the ones observed to within the slack of their own reset. */
	completedBelowHundred: number;
	/** Of those, the ones whose sampling stopped before the window ended. */
	followUpIncomplete: number;
	fillFraction: number | null;
	medianFillHours: number | null;
	medianObservedSpanHours: number | null;
	medianUnobservedHeadMinutes: number | null;
	medianResolutionMinutes: number | null;
	/**
	 * The one column over the CENSORED windows, and over BOTH censored kinds
	 * together: window start to last sample.
	 */
	medianCensoredSpanHours: number | null;
	/** Sorted, in hours; printed under the table below the raw-values limit. */
	fillDurationsHours: number[];
}

export interface WindowFillTally {
	/** The primary, fixed-prefix split, plus the unobservable-exposure row. */
	prefixRows: WindowFillRow[];
	/** The same rows split by the length-biased during-fill definition. */
	duringFillRows: WindowFillRow[];
	filled: number;
	censored: number;
	completedBelowHundred: number;
	followUpIncomplete: number;
	noResetOnSegment: number;
	firstSampleAlreadyFull: number;
}

const HOURS = (ms: number): number => ms / HOUR_MS;
const MINUTES = (ms: number): number => ms / MINUTE_MS;

function windowFillRow(
	exposure: string,
	window: WindowFillScope,
	members: readonly WindowFill[],
): WindowFillRow {
	const scoped =
		window === "combined"
			? members
			: members.filter((fill) => fill.windowKind === window);
	const filled = scoped.filter((fill) => fill.firstHundredMs != null);
	const censored = scoped.filter((fill) => fill.firstHundredMs == null);
	const metrics = filled.map((fill) => windowFillMetrics(fill));
	const durations = metrics
		.map((entry) => entry.fillDurationMs)
		.filter((value): value is number => value != null);
	const denominator = filled.length + censored.length;
	return {
		exposure,
		window,
		fills: filled.length,
		censored: censored.length,
		completedBelowHundred: censored.filter(
			(fill) => fillCensoring(fill) === "completed-below-hundred",
		).length,
		followUpIncomplete: censored.filter(
			(fill) => fillCensoring(fill) === "follow-up-incomplete",
		).length,
		fillFraction: denominator > 0 ? filled.length / denominator : null,
		medianFillHours: percentileOf(durations.map(HOURS), 0.5),
		medianObservedSpanHours: percentileOf(
			metrics
				.map((entry) => entry.observedSpanMs)
				.filter((value): value is number => value != null)
				.map(HOURS),
			0.5,
		),
		medianUnobservedHeadMinutes: percentileOf(
			metrics
				.map((entry) => entry.unobservedHeadMs)
				.filter((value): value is number => value != null)
				.map(MINUTES),
			0.5,
		),
		medianResolutionMinutes: percentileOf(
			filled
				.map((fill) => fill.resolutionMs)
				.filter((value): value is number => value != null)
				.map(MINUTES),
			0.5,
		),
		medianCensoredSpanHours: percentileOf(
			censored
				.map((fill) =>
					fill.windowStartMs == null
						? null
						: fill.lastSampleMs - fill.windowStartMs,
				)
				.filter((value): value is number => value != null)
				.map(HOURS),
			0.5,
		),
		fillDurationsHours: durations.map(HOURS).sort((a, b) => a - b),
	};
}

/**
 * The report's cells, and the counts that reconcile them against every
 * lifecycle scanned.
 *
 * Two populations are counted APART from the arms rather than folded into
 * them: a segment carrying no reset has no derivable window start, and a
 * lifecycle whose first sample already reads 100 % filled before observation
 * began, which is not a fill duration at all. A third, the lifecycles whose
 * exposure prefix reaches outside the replayed range, gets its own row.
 */
export function tallyWindowFills(
	fills: readonly WindowFill[],
): WindowFillTally {
	const measurable = fills.filter(
		(fill) => fill.windowStartMs != null && fill.firstSampleUtilization < 100,
	);
	const observable = measurable.filter((fill) => fill.exposureObservable);
	const unobservable = measurable.filter((fill) => !fill.exposureObservable);
	const duringObservable = measurable.filter(
		(fill) => fill.duringFillObservable,
	);
	const duringUnobservable = measurable.filter(
		(fill) => !fill.duringFillObservable,
	);
	const rowsFor = (
		exposure: string,
		members: readonly WindowFill[],
	): WindowFillRow[] =>
		WINDOW_FILL_SCOPES.map((scope) => windowFillRow(exposure, scope, members));

	return {
		prefixRows: [
			...rowsFor(
				"peer lost in prefix",
				observable.filter((fill) => fill.peerLostInPrefix),
			),
			...rowsFor(
				"no peer lost in prefix",
				observable.filter((fill) => !fill.peerLostInPrefix),
			),
			windowFillRow("exposure unobservable", "combined", unobservable),
		],
		duringFillRows: [
			...rowsFor(
				"peer lost during fill",
				duringObservable.filter((fill) => fill.peerLostDuringFill),
			),
			...rowsFor(
				"no peer lost during fill",
				duringObservable.filter((fill) => !fill.peerLostDuringFill),
			),
			windowFillRow(
				"during-fill exposure unobservable",
				"combined",
				duringUnobservable,
			),
		],
		filled: measurable.filter((fill) => fill.firstHundredMs != null).length,
		censored: measurable.filter((fill) => fill.firstHundredMs == null).length,
		completedBelowHundred: measurable.filter(
			(fill) =>
				fill.firstHundredMs == null &&
				fillCensoring(fill) === "completed-below-hundred",
		).length,
		followUpIncomplete: measurable.filter(
			(fill) =>
				fill.firstHundredMs == null &&
				fillCensoring(fill) === "follow-up-incomplete",
		).length,
		noResetOnSegment: fills.filter((fill) => fill.windowStartMs == null).length,
		firstSampleAlreadyFull: fills.filter(
			(fill) =>
				fill.windowStartMs != null && fill.firstSampleUtilization >= 100,
		).length,
	};
}

// ---------------------------------------------------------------------------
// Request-volume changes around observed exhaustion
// ---------------------------------------------------------------------------

/**
 * The grid the request loader groups on, and the resolution every rate below
 * is computed at. Exported so the SQL in `scripts/redistribution-backtest.ts`
 * and this module cannot disagree about it.
 */
export const REQUEST_BUCKET_MS = 60_000;

/** One minute of one account's traffic, as the loader returns it. */
export interface RequestBucket {
	accountId: string;
	bucketStartMs: number;
	requests: number;
	tokens: number;
}

/** What the run saw of `requests.total_tokens`, for the known-limits line. */
export interface RequestTokenCoverage {
	/** Rows with an `account_used`, inside the loaded span. */
	attributedRows: number;
	/** Of those, the ones whose `total_tokens` is null or zero. */
	zeroOrNullTokenRows: number;
}

// ---------------------------------------------------------------------------
// Observed availability
// ---------------------------------------------------------------------------

/**
 * Whether an account was routable at an instant, as the recorded snapshots
 * show it.
 *
 * THREE states, not two. `unknown` is not `available`: a stretch with no
 * reading inside the staleness bar says nothing about whether the account was
 * taking traffic, and treating it as alive would put an account into a
 * survivor set on the strength of missing data.
 */
export type AvailabilityState = "available" | "exhausted" | "unknown";

/** One state, from `fromMs` until the next segment starts. */
export interface AvailabilitySegment {
	fromMs: number;
	state: AvailabilityState;
}

/**
 * One account's availability over the whole loaded history.
 *
 * Ascending, adjacent segments always differ, and the first one starts at
 * `-Infinity` in state `unknown`, so every instant lands inside exactly one
 * segment.
 */
export interface AvailabilityTimeline {
	accountId: string;
	segments: AvailabilitySegment[];
}

/**
 * Exhausted on EITHER window: an account at 100 % on its weekly window is out
 * of routing whatever its five-hour window reads, and the second window
 * filling afterwards is not a second departure.
 *
 * A NULL window is not a reading of zero. With both windows null the row says
 * nothing about routing at all and the account is `unknown`; with one null the
 * absent window imposes no constraint and the window that has a reading decides
 * — a codex row with no five-hour reading and a weekly one at 40 % is available,
 * and the same row at 100 % is exhausted. Live data (2026-09-07) has 7217 of
 * 31594 codex rows in exactly that shape, the Codex placeholder five-hour
 * window, and no row at all with both null.
 */
const availabilityOfRow = (row: RosterSnapshotRow): AvailabilityState => {
	const readings = WINDOW_KINDS.map((kind) => pctOf(row, kind)).filter(
		(value): value is number => value != null,
	);
	if (readings.length === 0) return "unknown";
	return readings.some((value) => value >= 100) ? "exhausted" : "available";
};

/**
 * Per-account availability, read off the snapshot series rather than off the
 * event list.
 *
 * NOT derived from `TransitionEvent.endsAtMs`: that is `min(death + 24 h,
 * reset)`, or `death + 24 h` when the reset is unknown, i.e. a tagging horizon
 * rather than an instant anything was observed to happen at. A window's reset
 * can sit 66 h out while the tag expires in 24, and some deaths carry no reset
 * at all.
 *
 * The staleness bar is {@link READING_STALE_MS}, the same one
 * {@link buildRosterAtInstant} projects under, measured on the sample time,
 * and INCLUSIVE in the same way: the roster rejects a reading only once its age
 * is strictly greater than the bar, so `unknown` begins one millisecond after
 * it. An exclusive bar here would open a one-millisecond unknown segment
 * between two readings exactly `READING_STALE_MS + 1` apart, and that segment
 * can bound an interval.
 */
export function buildAvailabilityTimelines(
	series: ReadonlyMap<string, AccountSeries>,
): Map<string, AvailabilityTimeline> {
	const out = new Map<string, AvailabilityTimeline>();
	for (const [accountId, accountSeries] of series) {
		const segments: AvailabilitySegment[] = [
			{ fromMs: Number.NEGATIVE_INFINITY, state: "unknown" },
		];
		const push = (fromMs: number, state: AvailabilityState): void => {
			const last = segments[segments.length - 1];
			if (last.state === state) return;
			if (segments.length > 1 && last.fromMs >= fromMs) {
				last.state = state;
				return;
			}
			segments.push({ fromMs, state });
		};
		let staleAtMs: number | null = null;
		for (const row of accountSeries.rows) {
			if (staleAtMs != null && row.sampledAt > staleAtMs) {
				push(staleAtMs, "unknown");
			}
			push(row.sampledAt, availabilityOfRow(row));
			staleAtMs = row.sampledAt + READING_STALE_MS + 1;
		}
		if (staleAtMs != null) push(staleAtMs, "unknown");
		// An overwritten segment can leave two equal states adjacent.
		const merged: AvailabilitySegment[] = [];
		for (const segment of segments) {
			if (
				merged.length > 0 &&
				merged[merged.length - 1].state === segment.state
			) {
				continue;
			}
			merged.push(segment);
		}
		out.set(accountId, { accountId, segments: merged });
	}
	return out;
}

/** Index of the segment holding `atMs`. */
function availabilityIndexAt(
	timeline: AvailabilityTimeline,
	atMs: number,
): number {
	let lo = 0;
	let hi = timeline.segments.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (timeline.segments[mid].fromMs <= atMs) lo = mid + 1;
		else hi = mid;
	}
	return lo - 1;
}

/** The account's state at `atMs`; `unknown` when there is no timeline at all. */
export function availabilityAt(
	timeline: AvailabilityTimeline | undefined,
	atMs: number,
): AvailabilityState {
	if (timeline == null) return "unknown";
	return timeline.segments[availabilityIndexAt(timeline, atMs)].state;
}

/**
 * Distance to the nearest state change on either side of `atMs`, or null when
 * the account never changes state.
 *
 * `ignoreAtMs` drops a change at exactly that instant, which is how the dying
 * account's own transition is kept from bounding the interval it defines.
 */
export function nearestAvailabilityChangeMs(
	timeline: AvailabilityTimeline | undefined,
	atMs: number,
	options: { ignoreAtMs?: number } = {},
): number | null {
	if (timeline == null) return null;
	const segments = timeline.segments;
	const after = availabilityIndexAt(timeline, atMs) + 1;
	let best: number | null = null;
	// The change at or before `atMs`, the one after it, and one further out
	// either way, so an ignored instant does not hide its neighbour.
	for (const index of [after - 2, after - 1, after, after + 1]) {
		if (index < 1 || index >= segments.length) continue;
		const changeAtMs = segments[index].fromMs;
		if (options.ignoreAtMs != null && changeAtMs === options.ignoreAtMs)
			continue;
		const distance = Math.abs(changeAtMs - atMs);
		if (best == null || distance < best) best = distance;
	}
	return best;
}

/**
 * Distance BACK from `atMs` to the nearest state change strictly before it, or
 * null when the account never changed state before it.
 *
 * Nothing at or after `atMs` is read, which is the whole point: a lookback
 * built on this is computable at `atMs` from data available at `atMs`. The
 * dying account's own transition sits exactly at `atMs` and is therefore
 * already outside this, with no instant to ignore.
 */
export function nearestAvailabilityChangeBeforeMs(
	timeline: AvailabilityTimeline | undefined,
	atMs: number,
): number | null {
	if (timeline == null) return null;
	const segments = timeline.segments;
	for (let index = availabilityIndexAt(timeline, atMs); index >= 1; index--) {
		const changeAtMs = segments[index].fromMs;
		if (changeAtMs >= atMs) continue;
		return atMs - changeAtMs;
	}
	return null;
}

/** The first state change inside `[fromMs, toMs]`, or null when there is none. */
function availabilityChangeInside(
	timeline: AvailabilityTimeline | undefined,
	fromMs: number,
	toMs: number,
): number | null {
	if (timeline == null) return null;
	const segments = timeline.segments;
	for (
		let index = availabilityIndexAt(timeline, fromMs) + 1;
		index < segments.length;
		index++
	) {
		const changeAtMs = segments[index].fromMs;
		if (changeAtMs > toMs) return null;
		if (changeAtMs >= fromMs) return changeAtMs;
	}
	return null;
}

/**
 * The primary half-width. NOT tuned: it is the production regression lookback
 * the replay already reconstructs, fixed before any number was read.
 */
export const ABSORPTION_HALF_WIDTH_MS = 6 * HOUR_MS;

/**
 * The reporting horizon, and the one every headline is read off.
 *
 * Printed beside the six-hour one, never chosen against it: both are computed
 * for every death whose interval is long enough to carry them.
 */
export const ABSORPTION_NARROW_HALF_WIDTH_MS = 60 * MINUTE_MS;

/** Below this much clean interval there is no window worth dividing by. */
export const ABSORPTION_MIN_HALF_WIDTH_MS = 15 * MINUTE_MS;

/** The matched-control offset: same weekday, same hour. */
export const ABSORPTION_CONTROL_OFFSET_MS = 7 * DAY_MS;

/**
 * The two volumes measured. Request count alone is a weak proxy for quota
 * burn — the scenario redistributes capacity units, not requests — so both are
 * computed identically and printed side by side.
 */
export type AbsorptionBasis = "requests" | "tokens";

export const ABSORPTION_BASES: readonly AbsorptionBasis[] = [
	"requests",
	"tokens",
];

export interface AbsorptionInput {
	events: readonly TransitionEvent[];
	accounts: readonly RosterAccount[];
	/** The snapshot history the availability timelines are read off. */
	series: Map<string, AccountSeries>;
	buckets: readonly RequestBucket[];
	range: ReplayRange;
	/** The loaded request span, so an edge death or control is excluded. */
	requestsFromMs: number;
	requestsToMs: number;
}

/** One survivor's rates either side of the instant being measured. */
export interface AbsorptionSurvivorRates {
	accountId: string;
	preRate: number;
	postRate: number;
	delta: number;
	/** `delta / preRateDying`. These sum to alpha. Null with no dying rate. */
	contribution: number | null;
	/**
	 * Share of the survivors' PRE-death rate over the pre-only lookback
	 * `W_pre`, not over `W`. Null when they had none.
	 */
	preShare: number | null;
}

/**
 * One (instant × half-width × basis) measurement.
 *
 * TWO WIDTHS, deliberately. The symmetric `W` is bounded by availability
 * changes on BOTH sides of the instant, so it is chosen with knowledge of the
 * future; every rate COMPARISON is taken over it, because a comparison needs
 * the same clean regime either side. The weights are not: `dyingPreShare`,
 * `preShare` and `equalSplitShare` are taken over the pre-only lookback
 * `W_pre`, which is bounded by the last availability change BEFORE the instant
 * and by the horizon cap, so a deployment standing at the instant could have
 * computed them from what it already had.
 *
 * PRE-INSTANT DERIVATION: `preRate*`, `dyingPreShare`, `preShare` and
 * `equalSplitShare` read no VOLUME at or after the instant either. That
 * prevents leakage into the weights; it does not make any of these numbers
 * causal.
 */
export interface AbsorptionMeasurement {
	basis: AbsorptionBasis;
	/** Whole minutes actually counted, which is never `W` exactly (see the straddle rule). */
	preMinutes: number;
	postMinutes: number;
	/** `W_pre`: the pre-only lookback the weights are taken over. */
	preWeightHalfWidthMs: number;
	/** Whole minutes counted in `[D − W_pre, D)`. */
	preWeightMinutes: number;
	preVolumeDying: number;
	postVolumeDying: number;
	preVolumeSurvivors: number;
	postVolumeSurvivors: number;
	preRateDying: number;
	preRateSurvivors: number;
	postRateSurvivors: number;
	/** The dying account's volume over `[D − W_pre, D)`. */
	preWeightVolumeDying: number;
	/** The survivor set's volume over `[D − W_pre, D)`. */
	preWeightVolumeSurvivors: number;
	/** The dying account's rate over `[D − W_pre, D)`. */
	preWeightRateDying: number;
	/** The survivor set's rate over `[D − W_pre, D)`. */
	preWeightRateSurvivors: number;
	/** The dying account's share of the class rate over `W_pre`; null with no dying account. */
	dyingPreShare: number | null;
	/** `1 / |S|`, the split the scenario assumes. */
	equalSplitShare: number | null;
	/** `(postRateSurv − preRateSurv) / preRateDying`; null when the dying account had no pre-death traffic. */
	alpha: number | null;
	/** `postRateSurv / preRateSurv`; null when the survivors had none. */
	survivorRateRatio: number | null;
	/** `P`: the sum of the positive rate changes. */
	grossPositive: number;
	/** `N`: the sum of the negative rate changes, as a positive number. */
	grossNegative: number;
	/** `G = P − N`: the net rate change over the survivor set. */
	netChange: number;
	/**
	 * The largest single positive change over `P`, i.e. the largest account's
	 * share of the POSITIVE rate increases. Null when `G <= 0`, where a share of
	 * the increases describes nothing about where volume went.
	 */
	largestGainShare: number | null;
	survivors: AbsorptionSurvivorRates[];
}

export type AbsorptionMeasurementSet = Record<
	AbsorptionBasis,
	AbsorptionMeasurement
>;

/** Why a matched control could not be used. Counted, never silently skipped. */
export type AbsorptionControlRejection =
	| "outside-loaded-span"
	| "availability-change-inside";

export interface AbsorptionControl {
	/** `-7 d` or `+7 d`, in the order the report prints them. */
	label: string;
	atMs: number;
	eligible: boolean;
	rejection: AbsorptionControlRejection | null;
	/** Which account, in which state, made it ineligible. */
	rejectionDetail: string | null;
	/** Null when ineligible: an unread interval is not a measured zero. */
	measurements: AbsorptionMeasurementSet | null;
}

/** The two half-widths a death is read at. The 60-minute one is primary. */
export type AbsorptionHorizonLabel = "narrow" | "wide";

/**
 * Which of the three rules shortened `W_pre` to the width it was read at.
 *
 * `availability` is the nearest availability change of a class member before
 * the instant, `cap` the horizon's own ceiling, and `coverage` the near edge of
 * the loaded request span.
 */
export type AbsorptionPreWeightBound = "availability" | "cap" | "coverage";

/** One death read at one half-width, with the controls measured at that width. */
export interface AbsorptionHorizon {
	label: AbsorptionHorizonLabel;
	/** The symmetric half-width `W`, at or below this horizon's cap. */
	halfWidthMs: number;
	/** The pre-only lookback `W_pre` the weights were taken over. */
	preWeightHalfWidthMs: number;
	/** Which rule that width came from. */
	preWeightBoundedBy: AbsorptionPreWeightBound;
	measurements: AbsorptionMeasurementSet;
	controls: AbsorptionControl[];
	controlsEligible: number;
	/** The other servable class over the same interval; null when it has no account yet. */
	placebo: AbsorptionMeasurementSet | null;
}

/** A class member the survivor set could not take, and why. */
export interface AbsorptionExcludedMember {
	accountId: string;
	state: AvailabilityState;
}

/** One analysed death, with everything the per-death table prints. */
export interface AbsorptionDeath {
	eventId: number;
	atMs: number;
	demandClass: string;
	/**
	 * Every window whose first 100 % reading landed on this instant for this
	 * account. Both windows filling in the same sample is ONE departure from
	 * routing, so the events are folded and both kinds recorded here.
	 */
	windowKinds: BacktestWindowKind[];
	dyingAccountId: string;
	dyingAccountName: string;
	survivorIds: string[];
	/**
	 * The display name of every account id this death's block prints: the
	 * survivors, the excluded members and the account that set the availability
	 * bound. An id with no account row is absent here and prints as itself.
	 */
	accountNames: Record<string, string>;
	/** Class members that were exhausted or unknown just before the death. */
	excludedMembers: AbsorptionExcludedMember[];
	/** The nearest availability change of any class member; null when there is none. */
	availabilityBoundMs: number | null;
	/** The account whose change set that bound. */
	availabilityBoundAccountId: string | null;
	narrow: AbsorptionHorizon;
	/** Null when the bound caps the wide horizon down onto the narrow one. */
	wide: AbsorptionHorizon | null;
	wideAbsentReason: string | null;
	placeboAccountIds: string[];
}

export type AbsorptionExclusionReason =
	| "noSurvivors"
	| "alreadyExhausted"
	| "dyingStateUnknown"
	| "intervalTooShort"
	| "outsideLoadedSpan"
	| "noRequestCoverage"
	| "noPreDeathDyingTraffic";

export const ABSORPTION_EXCLUSION_REASONS: readonly AbsorptionExclusionReason[] =
	[
		"noSurvivors",
		"alreadyExhausted",
		"dyingStateUnknown",
		"intervalTooShort",
		"outsideLoadedSpan",
		"noRequestCoverage",
		"noPreDeathDyingTraffic",
	];

/** A death that was not measured, printed rather than dropped. */
export interface AbsorptionExcludedDeath {
	eventId: number;
	atMs: number;
	demandClass: string;
	windowKinds: BacktestWindowKind[];
	dyingAccountId: string;
	dyingAccountName: string;
	reason: AbsorptionExclusionReason;
	/** The availability bound, for an `intervalTooShort`. */
	boundMs: number | null;
	/** What produced the bound, in words. */
	detail: string | null;
}

/**
 * The populations the aggregate table has one row per, times the two bases.
 *
 * Every label states a CAP, not a width: `W ≤ 60 min` and `W ≤ 6 h`. The
 * availability rule pulls most deaths below their horizon's cap, so a label
 * reading `W = 60 min` would name a width most of the population does not
 * have. The per-death table prints each death's own `W` and `W_pre`.
 *
 * `narrowWithWide` is the primary horizon restricted to the deaths that also
 * carry a six-hour measurement, so the two horizons can be read against each
 * other over ONE population rather than two.
 */
export const ABSORPTION_POPULATION_LABELS = {
	narrow: "at death (W ≤ 60 min)",
	wide: "at death (W ≤ 6 h)",
	narrowWithWide: "at death (W ≤ 60 min, deaths also measured at W ≤ 6 h)",
	controlBeforeNarrow: "matched control -7 d (W ≤ 60 min)",
	controlAfterNarrow: "matched control +7 d (W ≤ 60 min)",
	controlBeforeWide: "matched control -7 d (W ≤ 6 h)",
	controlAfterWide: "matched control +7 d (W ≤ 6 h)",
	placeboNarrow: "other class, same interval (W ≤ 60 min)",
	placeboWide: "other class, same interval (W ≤ 6 h)",
} as const;

/** One statistic over a population, with the denominator it was taken over. */
export interface AbsorptionStat {
	/** Measurements where this statistic has a value. */
	n: number;
	median: number | null;
}

export interface AbsorptionGroupRow {
	population: string;
	basis: AbsorptionBasis;
	/** Measurements in this population, whether or not each statistic is defined. */
	measurements: number;
	survivorRateRatio: AbsorptionStat;
	alpha: AbsorptionStat;
	largestGainShare: AbsorptionStat;
	equalSplitShare: AbsorptionStat;
	dyingPreShare: AbsorptionStat;
}

/** The death-minus-control pairing, one row of the aggregate table. */
export interface AbsorptionPairedDelta {
	basis: AbsorptionBasis;
	horizon: AbsorptionHorizonLabel;
	/** Deaths with a defined ratio at the death AND at an eligible control. */
	n: number;
	medianDelta: number | null;
}

export interface AbsorptionChecks {
	deaths: AbsorptionDeath[];
	excludedDeaths: AbsorptionExcludedDeath[];
	excluded: Record<AbsorptionExclusionReason, number>;
	/** Peer-exhaustion events inside the replay range: what the reconciliation adds up to. */
	peerExhaustionEvents: number;
	/**
	 * Events folded into an earlier one because the same account's other window
	 * reached 100 % in the same sample. One departure, one measurement.
	 */
	foldedSimultaneous: number;
	groups: AbsorptionGroupRow[];
	paired: AbsorptionPairedDelta[];
	controlsIneligible: Record<AbsorptionControlRejection, number>;
	halfWidthMs: number;
	narrowHalfWidthMs: number;
	minHalfWidthMs: number;
}

/**
 * Per-account prefix sums over the minute grid, so a range volume is two
 * binary searches rather than a scan.
 *
 * The whole history is ~130 k minutes per account and each death asks for ten
 * ranges, so a linear scan per query would be tens of millions of steps for
 * nothing.
 */
interface BucketIndex {
	starts: number[];
	requests: number[];
	tokens: number[];
}

function indexBuckets(
	buckets: readonly RequestBucket[],
): Map<string, BucketIndex> {
	const byAccount = new Map<string, RequestBucket[]>();
	for (const bucket of buckets) {
		const list = byAccount.get(bucket.accountId);
		if (list) list.push(bucket);
		else byAccount.set(bucket.accountId, [bucket]);
	}
	const index = new Map<string, BucketIndex>();
	for (const [accountId, list] of byAccount) {
		list.sort((a, b) => a.bucketStartMs - b.bucketStartMs);
		const starts: number[] = [];
		const requests: number[] = [0];
		const tokens: number[] = [0];
		for (const bucket of list) {
			starts.push(bucket.bucketStartMs);
			requests.push(requests[requests.length - 1] + bucket.requests);
			tokens.push(tokens[tokens.length - 1] + bucket.tokens);
		}
		index.set(accountId, { starts, requests, tokens });
	}
	return index;
}

/** First index with `starts[i] >= value`. */
function bucketLowerBound(starts: readonly number[], value: number): number {
	let lo = 0;
	let hi = starts.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (starts[mid] < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** The whole minute slots of `[fromMs, toMs)` that fit entirely inside it. */
interface HalfSlots {
	firstSlot: number;
	lastSlot: number;
	minutes: number;
}

function halfSlots(fromMs: number, toMs: number): HalfSlots {
	const firstSlot = Math.ceil(fromMs / REQUEST_BUCKET_MS) * REQUEST_BUCKET_MS;
	const lastSlot =
		Math.floor((toMs - REQUEST_BUCKET_MS) / REQUEST_BUCKET_MS) *
		REQUEST_BUCKET_MS;
	const minutes =
		lastSlot >= firstSlot ? (lastSlot - firstSlot) / REQUEST_BUCKET_MS + 1 : 0;
	return { firstSlot, lastSlot, minutes };
}

function volumeOf(
	index: ReadonlyMap<string, BucketIndex>,
	accountId: string,
	basis: AbsorptionBasis,
	slots: HalfSlots,
): number {
	if (slots.minutes === 0) return 0;
	const entry = index.get(accountId);
	if (entry == null) return 0;
	const from = bucketLowerBound(entry.starts, slots.firstSlot);
	const to = bucketLowerBound(entry.starts, slots.lastSlot + 1);
	const sums = basis === "requests" ? entry.requests : entry.tokens;
	return sums[to] - sums[from];
}

/** A pre-only lookback and the rule that produced its width. */
interface PreWeightWidth {
	halfWidthMs: number;
	boundedBy: AbsorptionPreWeightBound;
}

/**
 * `W_pre` at `atMs`, and which of its three bounds was the binding one.
 *
 * THE THIRD BOUND IS NOT OPTIONAL. The weights are read off the loaded request
 * buckets, and a bucket that was never loaded is ABSENT rather than empty: a
 * lookback reaching past `requestsFromMs` divides a partly-loaded volume by its
 * whole width and reads the unloaded stretch as no traffic. `W` is checked
 * against the loaded span on both sides already, but `W_pre` is a different
 * width and can exceed it — 30 minutes of loaded prehistory under a 60-minute
 * cap is exactly the case — so it carries its own bound.
 *
 * A tie names the data bound rather than the cap. The cap is the ceiling every
 * lookback starts at, so where a change or the span edge sits exactly on it, the
 * data is what the width is describing.
 */
function preWeightWidth(
	atMs: number,
	capMs: number,
	availabilityBoundMs: number,
	requestsFromMs: number,
): PreWeightWidth {
	const coverageMs = Math.max(0, atMs - requestsFromMs);
	const halfWidthMs = Math.min(capMs, availabilityBoundMs, coverageMs);
	if (availabilityBoundMs <= halfWidthMs) {
		return { halfWidthMs, boundedBy: "availability" };
	}
	if (coverageMs <= halfWidthMs) return { halfWidthMs, boundedBy: "coverage" };
	return { halfWidthMs, boundedBy: "cap" };
}

/**
 * One measurement at `atMs` over the symmetric half-width `W`, with the weights
 * over the pre-only lookback `W_pre`.
 *
 * STRADDLE RULE: a bucket is in pre only if it ends at or before `atMs`, and in
 * post only if it starts at or after it, so the minute containing the instant
 * is in neither half. Rates divide by the minutes actually counted, not by `W`.
 *
 * `dyingAccountId` is null for the other-class reading, which has no dying
 * account: `alpha` and `dyingPreShare` are then null rather than zero.
 */
function measureAbsorption(
	basis: AbsorptionBasis,
	index: ReadonlyMap<string, BucketIndex>,
	dyingAccountId: string | null,
	survivorIds: readonly string[],
	atMs: number,
	halfWidthMs: number,
	preWeightHalfWidthMs: number,
): AbsorptionMeasurement {
	const pre = halfSlots(atMs - halfWidthMs, atMs);
	const post = halfSlots(atMs, atMs + halfWidthMs);
	const preWeight = halfSlots(atMs - preWeightHalfWidthMs, atMs);
	const rate = (volume: number, slots: HalfSlots): number =>
		slots.minutes > 0 ? volume / slots.minutes : 0;

	const preVolumeDying =
		dyingAccountId == null ? 0 : volumeOf(index, dyingAccountId, basis, pre);
	const postVolumeDying =
		dyingAccountId == null ? 0 : volumeOf(index, dyingAccountId, basis, post);
	const preRateDying = rate(preVolumeDying, pre);

	let preVolumeSurvivors = 0;
	let postVolumeSurvivors = 0;
	const rates = survivorIds.map((accountId) => {
		const preVolume = volumeOf(index, accountId, basis, pre);
		const postVolume = volumeOf(index, accountId, basis, post);
		preVolumeSurvivors += preVolume;
		postVolumeSurvivors += postVolume;
		const preRate = rate(preVolume, pre);
		const postRate = rate(postVolume, post);
		return { accountId, preRate, postRate, delta: postRate - preRate };
	});
	const preRateSurvivors = rate(preVolumeSurvivors, pre);
	const postRateSurvivors = rate(postVolumeSurvivors, post);

	// The weights, over the pre-only lookback. Identical to the rates above
	// whenever `W_pre` equals `W`, which is the common case.
	const preWeightVolumeDying =
		dyingAccountId == null
			? 0
			: volumeOf(index, dyingAccountId, basis, preWeight);
	const preWeightRateDying = rate(preWeightVolumeDying, preWeight);
	let preWeightVolumeSurvivors = 0;
	const weightRates = survivorIds.map((accountId) => {
		const volume = volumeOf(index, accountId, basis, preWeight);
		preWeightVolumeSurvivors += volume;
		return rate(volume, preWeight);
	});
	const preWeightRateSurvivors = rate(preWeightVolumeSurvivors, preWeight);

	const survivors: AbsorptionSurvivorRates[] = rates.map((entry, position) => ({
		...entry,
		contribution: preRateDying > 0 ? entry.delta / preRateDying : null,
		preShare:
			preWeightRateSurvivors > 0
				? weightRates[position] / preWeightRateSurvivors
				: null,
	}));

	let grossPositive = 0;
	let grossNegative = 0;
	let largestGain = 0;
	for (const entry of survivors) {
		if (entry.delta > 0) {
			grossPositive += entry.delta;
			if (entry.delta > largestGain) largestGain = entry.delta;
		} else {
			grossNegative += -entry.delta;
		}
	}
	const netChange = grossPositive - grossNegative;
	const preWeightRateTotal = preWeightRateDying + preWeightRateSurvivors;

	return {
		basis,
		preMinutes: pre.minutes,
		postMinutes: post.minutes,
		preWeightHalfWidthMs,
		preWeightMinutes: preWeight.minutes,
		preVolumeDying,
		postVolumeDying,
		preVolumeSurvivors,
		postVolumeSurvivors,
		preRateDying,
		preRateSurvivors,
		postRateSurvivors,
		preWeightVolumeDying,
		preWeightVolumeSurvivors,
		preWeightRateDying,
		preWeightRateSurvivors,
		dyingPreShare:
			dyingAccountId == null || preWeightRateTotal <= 0
				? null
				: preWeightRateDying / preWeightRateTotal,
		equalSplitShare: survivors.length > 0 ? 1 / survivors.length : null,
		alpha:
			preRateDying > 0
				? (postRateSurvivors - preRateSurvivors) / preRateDying
				: null,
		survivorRateRatio:
			preRateSurvivors > 0 ? postRateSurvivors / preRateSurvivors : null,
		grossPositive,
		grossNegative,
		netChange,
		// A structural boundary, not a data threshold: with no net gain there is
		// no gain to hold a share of.
		largestGainShare:
			netChange > 0 && grossPositive > 0 ? largestGain / grossPositive : null,
		survivors,
	};
}

const measureBoth = (
	index: ReadonlyMap<string, BucketIndex>,
	dyingAccountId: string | null,
	survivorIds: readonly string[],
	atMs: number,
	halfWidthMs: number,
	preWeightHalfWidthMs: number,
): AbsorptionMeasurementSet => ({
	requests: measureAbsorption(
		"requests",
		index,
		dyingAccountId,
		survivorIds,
		atMs,
		halfWidthMs,
		preWeightHalfWidthMs,
	),
	tokens: measureAbsorption(
		"tokens",
		index,
		dyingAccountId,
		survivorIds,
		atMs,
		halfWidthMs,
		preWeightHalfWidthMs,
	),
});

/** One statistic's own denominator and median over a population. */
const absorptionStat = (
	members: readonly AbsorptionMeasurement[],
	pick: (entry: AbsorptionMeasurement) => number | null,
): AbsorptionStat => {
	const values = members
		.map(pick)
		.filter(
			(value): value is number => value != null && Number.isFinite(value),
		);
	return { n: values.length, median: percentileOf(values, 0.5) };
};

function absorptionGroupRow(
	population: string,
	basis: AbsorptionBasis,
	members: readonly AbsorptionMeasurement[],
): AbsorptionGroupRow {
	return {
		population,
		basis,
		measurements: members.length,
		survivorRateRatio: absorptionStat(
			members,
			(entry) => entry.survivorRateRatio,
		),
		alpha: absorptionStat(members, (entry) => entry.alpha),
		largestGainShare: absorptionStat(
			members,
			(entry) => entry.largestGainShare,
		),
		equalSplitShare: absorptionStat(members, (entry) => entry.equalSplitShare),
		dyingPreShare: absorptionStat(members, (entry) => entry.dyingPreShare),
	};
}

const absorptionIso = (ms: number): string => new Date(ms).toISOString();

/**
 * What each survivor's own request volume did around an observed exhaustion.
 *
 * Every share and every weight is derived from history STRICTLY BEFORE the
 * instant, so no post-death quantity can enter a denominator. That is a
 * leakage constraint, not a causal claim.
 *
 * THE POPULATION IS SELECTED, and the selection is the point: a death enters
 * only when its own class holds an available peer over a symmetric interval in
 * which no member of the class changes availability state. That preferentially
 * removes rapid cascades, and strong absorption can itself precipitate the next
 * death, so what is measured here is the sufficiently-isolated departures and
 * nothing about cascades follows from it.
 *
 * MEASUREMENT ONLY: nothing here fits, tunes or thresholds anything, and no
 * model, cohort or verdict consumes it.
 */
export function absorptionChecks(input: AbsorptionInput): AbsorptionChecks {
	const index = indexBuckets(input.buckets);
	const timelines = buildAvailabilityTimelines(input.series);
	// Every account this section prints is printed by name: an id is a fallback
	// for an account the roster no longer holds, not the normal rendering.
	const nameOf = accountNameLookup(input.accounts);
	const classOf = new Map<string, string>();
	for (const account of input.accounts) {
		classOf.set(account.accountId, servableClassFor(account.provider).classId);
	}

	const deathsInRange = input.events.filter(
		(event) =>
			event.kind === "peer-exhaustion" &&
			event.atMs >= input.range.fromMs &&
			event.atMs < input.range.toMs,
	);

	// ONE DEPARTURE PER (account, instant). `detectTransitions` emits one event
	// per window, so an account whose five-hour and weekly windows both first
	// read 100 % in the same sample produces two events — and both would see
	// the account available at `D − 1 ms` and ignore its own transition, so the
	// same departure would be measured twice over an identical `S` and `W`.
	// The folded events are counted and reconciled rather than dropped.
	const departures: Array<{
		event: TransitionEvent;
		windowKinds: BacktestWindowKind[];
	}> = [];
	const departureIndex = new Map<string, number>();
	for (const event of deathsInRange) {
		const key = `${event.accountId}::${event.atMs}`;
		const existing = departureIndex.get(key);
		if (existing == null) {
			departureIndex.set(key, departures.length);
			departures.push({
				event,
				windowKinds: event.windowKind == null ? [] : [event.windowKind],
			});
			continue;
		}
		const departure = departures[existing];
		if (
			event.windowKind != null &&
			!departure.windowKinds.includes(event.windowKind)
		) {
			departure.windowKinds.push(event.windowKind);
		}
	}
	for (const departure of departures) {
		departure.windowKinds.sort(
			(a, b) => WINDOW_KINDS.indexOf(a) - WINDOW_KINDS.indexOf(b),
		);
	}
	const foldedSimultaneous = deathsInRange.length - departures.length;

	const deaths: AbsorptionDeath[] = [];
	const excludedDeaths: AbsorptionExcludedDeath[] = [];
	const excluded: Record<AbsorptionExclusionReason, number> = {
		noSurvivors: 0,
		alreadyExhausted: 0,
		dyingStateUnknown: 0,
		intervalTooShort: 0,
		outsideLoadedSpan: 0,
		noRequestCoverage: 0,
		noPreDeathDyingTraffic: 0,
	};
	const controlsIneligible: Record<AbsorptionControlRejection, number> = {
		"outside-loaded-span": 0,
		"availability-change-inside": 0,
	};
	const exclude = (
		departure: { event: TransitionEvent; windowKinds: BacktestWindowKind[] },
		reason: AbsorptionExclusionReason,
		bound: { boundMs?: number | null; detail?: string | null } = {},
	): void => {
		excluded[reason]++;
		excludedDeaths.push({
			eventId: departure.event.id,
			atMs: departure.event.atMs,
			demandClass: departure.event.demandClass,
			windowKinds: departure.windowKinds,
			dyingAccountId: departure.event.accountId,
			dyingAccountName: departure.event.accountName,
			reason,
			boundMs: bound.boundMs ?? null,
			detail: bound.detail ?? null,
		});
	};

	const createdAtOf = new Map<string, number>();
	for (const account of input.accounts) {
		createdAtOf.set(account.accountId, account.createdAtMs);
	}

	for (const departure of departures) {
		const event = departure.event;
		// The WHOLE class, whatever each account's creation time. An account
		// that joins after the death was never a candidate for the traffic that
		// moved — so it stays out of `S` — but its arrival is a regime change
		// like any other, and an interval or a control that spans it is not the
		// clean one the rule asks for.
		const classRoster = input.accounts
			.filter((account) => classOf.get(account.accountId) === event.demandClass)
			.map((account) => account.accountId)
			.sort((a, b) => a.localeCompare(b));
		// Class membership as of the death: the candidates for `S`.
		const members = classRoster.filter(
			(accountId) => (createdAtOf.get(accountId) ?? 0) <= event.atMs,
		);

		// Strictly before the death reading, so the dying account's own 100 %
		// row does not decide anybody's state.
		const justBeforeMs = event.atMs - 1;
		const survivorIds: string[] = [];
		const excludedMembers: AbsorptionExcludedMember[] = [];
		for (const accountId of members) {
			if (accountId === event.accountId) continue;
			const state = availabilityAt(timelines.get(accountId), justBeforeMs);
			if (state === "available") survivorIds.push(accountId);
			else excludedMembers.push({ accountId, state });
		}
		if (survivorIds.length === 0) {
			exclude(departure, "noSurvivors", {
				detail:
					excludedMembers.length > 0
						? `every peer was ${excludedMembers
								.map((entry) => `${nameOf(entry.accountId)} (${entry.state})`)
								.join(", ")}`
						: "the class held no other account",
			});
			continue;
		}

		const dyingState = availabilityAt(
			timelines.get(event.accountId),
			justBeforeMs,
		);
		if (dyingState === "exhausted") {
			// Already out of routing on its other window: this reading is not a
			// departure from routing, so there is nothing for a peer to absorb.
			exclude(departure, "alreadyExhausted", {
				detail: `${nameOf(event.accountId)} already read 100 % on a window before the death`,
			});
			continue;
		}
		if (dyingState === "unknown") {
			exclude(departure, "dyingStateUnknown", {
				detail: `${nameOf(event.accountId)} had no reading inside the staleness bar before the death`,
			});
			continue;
		}

		// The interval carries no other regime change: the nearest availability
		// transition of ANY member of the class bounds it, including the members
		// that are not in `S` and the ones created after the death — a peer
		// reviving into the post window takes traffic back just as surely as a
		// survivor leaving does, and a new account arriving is the same kind of
		// change. An arrival is bounded at its CREATION, not at its first
		// reading: the account was in the class from the moment it existed.
		let availabilityBoundMs: number | null = null;
		let availabilityBoundAccountId: string | null = null;
		const bound = (accountId: string, distance: number | null): void => {
			if (distance == null) return;
			if (availabilityBoundMs == null || distance < availabilityBoundMs) {
				availabilityBoundMs = distance;
				availabilityBoundAccountId = accountId;
			}
		};
		for (const accountId of classRoster) {
			bound(
				accountId,
				nearestAvailabilityChangeMs(
					timelines.get(accountId),
					event.atMs,
					accountId === event.accountId ? { ignoreAtMs: event.atMs } : {},
				),
			);
			// The creation itself, which the snapshot timeline cannot carry: the
			// segments run from absent to `unknown` without changing state, so
			// nothing is pushed at the instant the account joined the class. An
			// account created at `D + 20 min` and first sampled at `D + 40 min`
			// changed the class at 20 min, and one never sampled at all changed it
			// without leaving a single segment behind.
			const createdAtMs = createdAtOf.get(accountId);
			if (createdAtMs == null) continue;
			// The same instant the dying account's own transition sits at is the
			// one change this rule ignores, whichever kind of change it is.
			if (accountId === event.accountId && createdAtMs === event.atMs) continue;
			bound(accountId, Math.abs(createdAtMs - event.atMs));
		}
		const boundMs = availabilityBoundMs ?? Number.POSITIVE_INFINITY;
		// The same rule looking BACKWARDS only, for the weights: `W` is chosen
		// with knowledge of the future, so weights computed over it would not
		// have been computable at the death. This one is.
		let preBoundMs: number | null = null;
		for (const accountId of classRoster) {
			const distance = nearestAvailabilityChangeBeforeMs(
				timelines.get(accountId),
				event.atMs,
			);
			if (distance == null) continue;
			if (preBoundMs == null || distance < preBoundMs) preBoundMs = distance;
		}
		const preBound = preBoundMs ?? Number.POSITIVE_INFINITY;
		const narrowHalfWidthMs = Math.min(
			ABSORPTION_NARROW_HALF_WIDTH_MS,
			boundMs,
		);
		const wideHalfWidthMs = Math.min(ABSORPTION_HALF_WIDTH_MS, boundMs);
		const narrowPreWidth = preWeightWidth(
			event.atMs,
			ABSORPTION_NARROW_HALF_WIDTH_MS,
			preBound,
			input.requestsFromMs,
		);
		const widePreWidth = preWeightWidth(
			event.atMs,
			ABSORPTION_HALF_WIDTH_MS,
			preBound,
			input.requestsFromMs,
		);
		if (narrowHalfWidthMs < ABSORPTION_MIN_HALF_WIDTH_MS) {
			exclude(departure, "intervalTooShort", {
				boundMs: availabilityBoundMs,
				detail: `${
					availabilityBoundAccountId == null
						? "a class member"
						: nameOf(availabilityBoundAccountId)
				} changes availability ${Math.round(
					boundMs / MINUTE_MS,
				)} min from the death`,
			});
			continue;
		}

		// PER HORIZON, not once at the widest. Request coverage that carries a
		// complete primary measurement is a complete primary measurement; the
		// six-hour reading it cannot carry is absent with its reason printed,
		// rather than taking the primary down with it.
		const insideLoadedSpan = (halfWidthMs: number): boolean =>
			event.atMs - halfWidthMs >= input.requestsFromMs &&
			event.atMs + halfWidthMs <= input.requestsToMs;
		const coverageOf = (set: AbsorptionMeasurementSet): number =>
			set.requests.preVolumeDying +
			set.requests.postVolumeDying +
			set.requests.preVolumeSurvivors +
			set.requests.postVolumeSurvivors;

		if (!insideLoadedSpan(narrowHalfWidthMs)) {
			exclude(departure, "outsideLoadedSpan");
			continue;
		}
		const narrowMeasurements = measureBoth(
			index,
			event.accountId,
			survivorIds,
			event.atMs,
			narrowHalfWidthMs,
			narrowPreWidth.halfWidthMs,
		);
		if (coverageOf(narrowMeasurements) === 0) {
			exclude(departure, "noRequestCoverage");
			continue;
		}
		// Explicitly the PRIMARY horizon: the gate asks whether there is a
		// denominator for the measurement that is reported, not for the widest
		// one that might have been.
		if (narrowMeasurements.requests.preRateDying === 0) {
			exclude(departure, "noPreDeathDyingTraffic");
			continue;
		}

		// A wide horizon the bound has pulled down onto the narrow one is the
		// same measurement twice: printed once, with the reason it is not a
		// six-hour reading.
		let wideMeasurements: AbsorptionMeasurementSet | null = null;
		let wideAbsentReason: string | null = null;
		if (wideHalfWidthMs <= narrowHalfWidthMs) {
			wideAbsentReason = `the availability bound of ${Math.round(
				boundMs / MINUTE_MS,
			)} min caps the six-hour horizon at the ${Math.round(
				narrowHalfWidthMs / MINUTE_MS,
			)} min it is already measured over`;
		} else if (!insideLoadedSpan(wideHalfWidthMs)) {
			wideAbsentReason =
				"the six-hour interval leaves the request coverage the run loaded";
		} else {
			const candidate = measureBoth(
				index,
				event.accountId,
				survivorIds,
				event.atMs,
				wideHalfWidthMs,
				widePreWidth.halfWidthMs,
			);
			if (coverageOf(candidate) === 0) {
				wideAbsentReason =
					"the request coverage the run loaded holds no volume over the six-hour interval";
			} else {
				wideMeasurements = candidate;
			}
		}

		const placeboAccountIds = input.accounts
			.filter(
				(account) =>
					classOf.get(account.accountId) !== event.demandClass &&
					account.createdAtMs <= event.atMs,
			)
			.map((account) => account.accountId)
			.sort((a, b) => a.localeCompare(b));
		// Every class member that is neither the dying account nor a survivor,
		// INCLUDING the ones created after the death: a control interval a new
		// account arrives in is not the same regime as the death's.
		const outsideS = classRoster.filter(
			(accountId) =>
				accountId !== event.accountId && !survivorIds.includes(accountId),
		);

		const horizonAt = (
			label: AbsorptionHorizonLabel,
			halfWidthMs: number,
			preWeight: PreWeightWidth,
			measurements: AbsorptionMeasurementSet,
		): AbsorptionHorizon => {
			const controls: AbsorptionControl[] = [];
			for (const offset of [
				-ABSORPTION_CONTROL_OFFSET_MS,
				ABSORPTION_CONTROL_OFFSET_MS,
			]) {
				const atMs = event.atMs + offset;
				const fromMs = atMs - halfWidthMs;
				const toMs = atMs + halfWidthMs;
				let rejection: AbsorptionControlRejection | null = null;
				let rejectionDetail: string | null = null;
				if (fromMs < input.requestsFromMs || toMs > input.requestsToMs) {
					rejection = "outside-loaded-span";
					rejectionDetail =
						"the interval leaves the span the request table was read over";
				}
				// The control has to be the same regime as well as the same
				// weekday and hour: every account of `S` and the dying account
				// available across the whole of it, and no member of the class
				// changing state inside it.
				for (const accountId of [event.accountId, ...survivorIds]) {
					if (rejection != null) break;
					const state = availabilityAt(timelines.get(accountId), fromMs);
					if (state !== "available") {
						rejection = "availability-change-inside";
						rejectionDetail = `${nameOf(accountId)} is ${state} at the start of the interval`;
					}
				}
				for (const accountId of [
					event.accountId,
					...survivorIds,
					...outsideS,
				]) {
					if (rejection != null) break;
					// Creation first, for the same reason the interval bound reads it:
					// an account that joined the class inside the control interval is a
					// regime change there, and it can join without the snapshot series
					// showing a transition anywhere near it.
					const createdAtMs = createdAtOf.get(accountId);
					if (
						createdAtMs != null &&
						createdAtMs >= fromMs &&
						createdAtMs <= toMs
					) {
						rejection = "availability-change-inside";
						rejectionDetail = `${nameOf(accountId)} was created at ${absorptionIso(
							createdAtMs,
						)}`;
						break;
					}
					const changeAtMs = availabilityChangeInside(
						timelines.get(accountId),
						fromMs,
						toMs,
					);
					if (changeAtMs != null) {
						rejection = "availability-change-inside";
						rejectionDetail = `${nameOf(accountId)} changes availability at ${absorptionIso(
							changeAtMs,
						)}`;
					}
				}
				if (rejection != null) controlsIneligible[rejection]++;
				controls.push({
					label: offset < 0 ? "-7 d" : "+7 d",
					atMs,
					eligible: rejection == null,
					rejection,
					rejectionDetail,
					// The identical survivor set and the identical half-width: a
					// control that measured a different set would compare two
					// populations rather than two instants.
					measurements:
						rejection == null
							? measureBoth(
									index,
									event.accountId,
									survivorIds,
									atMs,
									halfWidthMs,
									// The control reads its OWN loaded prehistory: the death's
									// lookback is measured seven days away from here, where the
									// same width can reach past the near edge of the span.
									Math.min(
										preWeight.halfWidthMs,
										Math.max(0, atMs - input.requestsFromMs),
									),
								)
							: null,
				});
			}
			return {
				label,
				halfWidthMs,
				preWeightHalfWidthMs: preWeight.halfWidthMs,
				preWeightBoundedBy: preWeight.boundedBy,
				measurements,
				controls,
				controlsEligible: controls.filter((control) => control.eligible).length,
				placebo:
					placeboAccountIds.length > 0
						? measureBoth(
								index,
								null,
								placeboAccountIds,
								event.atMs,
								halfWidthMs,
								preWeight.halfWidthMs,
							)
						: null,
			};
		};

		const narrow = horizonAt(
			"narrow",
			narrowHalfWidthMs,
			narrowPreWidth,
			narrowMeasurements,
		);

		// The whole class, so the block can name a survivor, an excluded member
		// and whichever member set the availability bound. Every account came
		// out of `input.accounts`, so each of these is a real name.
		const accountNames: Record<string, string> = {};
		for (const accountId of classRoster)
			accountNames[accountId] = nameOf(accountId);

		deaths.push({
			eventId: event.id,
			atMs: event.atMs,
			demandClass: event.demandClass,
			windowKinds: departure.windowKinds,
			dyingAccountId: event.accountId,
			dyingAccountName: event.accountName,
			survivorIds,
			accountNames,
			excludedMembers,
			availabilityBoundMs,
			availabilityBoundAccountId,
			narrow,
			wide:
				wideMeasurements == null
					? null
					: horizonAt("wide", wideHalfWidthMs, widePreWidth, wideMeasurements),
			wideAbsentReason,
			placeboAccountIds,
		});
	}

	// Sorted by the dying account's pre-death share on the primary horizon, so
	// the reader sees the shape rather than a cut point somebody chose. Nulls
	// last.
	deaths.sort((a, b) => {
		const left = a.narrow.measurements.requests.dyingPreShare;
		const right = b.narrow.measurements.requests.dyingPreShare;
		if (left == null && right == null) return a.atMs - b.atMs;
		if (left == null) return 1;
		if (right == null) return -1;
		return left - right || a.atMs - b.atMs;
	});

	const horizonOf = (
		death: AbsorptionDeath,
		horizon: AbsorptionHorizonLabel,
	): AbsorptionHorizon | null =>
		horizon === "narrow" ? death.narrow : death.wide;

	const controlSets = (
		horizon: AbsorptionHorizonLabel,
		label: string,
	): AbsorptionMeasurementSet[] =>
		deaths
			.map(
				(death) =>
					horizonOf(death, horizon)?.controls.find(
						(control) => control.label === label && control.eligible,
					)?.measurements ?? null,
			)
			.filter((set): set is AbsorptionMeasurementSet => set != null);

	const populations: Array<{
		label: string;
		sets: Array<AbsorptionMeasurementSet | null>;
	}> = [
		{
			label: ABSORPTION_POPULATION_LABELS.narrow,
			sets: deaths.map((death) => death.narrow.measurements),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.wide,
			sets: deaths.map((death) => death.wide?.measurements ?? null),
		},
		{
			// The primary horizon over the deaths the wide row is taken over, so
			// the two horizons are comparable on one population rather than on
			// two that differ by whichever deaths the bound or the coverage
			// dropped from the wide one.
			label: ABSORPTION_POPULATION_LABELS.narrowWithWide,
			sets: deaths.map((death) =>
				death.wide == null ? null : death.narrow.measurements,
			),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.controlBeforeNarrow,
			sets: controlSets("narrow", "-7 d"),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.controlAfterNarrow,
			sets: controlSets("narrow", "+7 d"),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.controlBeforeWide,
			sets: controlSets("wide", "-7 d"),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.controlAfterWide,
			sets: controlSets("wide", "+7 d"),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.placeboNarrow,
			sets: deaths.map((death) => death.narrow.placebo),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.placeboWide,
			sets: deaths.map((death) => death.wide?.placebo ?? null),
		},
	];
	const groups: AbsorptionGroupRow[] = [];
	for (const population of populations) {
		for (const basis of ABSORPTION_BASES) {
			groups.push(
				absorptionGroupRow(
					population.label,
					basis,
					population.sets
						.filter((set): set is AbsorptionMeasurementSet => set != null)
						.map((set) => set[basis]),
				),
			);
		}
	}

	// Paired within the death, over the same accounts and the same weekday and
	// hour. One row of the aggregate table, not a headline: it inherits every
	// weakness of the controls it is built on.
	const paired: AbsorptionPairedDelta[] = [];
	for (const horizon of ["narrow", "wide"] as const) {
		for (const basis of ABSORPTION_BASES) {
			const deltas: number[] = [];
			for (const death of deaths) {
				const cell = horizonOf(death, horizon);
				if (cell == null) continue;
				const atDeath = cell.measurements[basis].survivorRateRatio;
				if (atDeath == null) continue;
				const controlRatios = cell.controls
					.filter((control) => control.eligible)
					.map((control) => control.measurements?.[basis].survivorRateRatio)
					.filter((value): value is number => value != null);
				if (controlRatios.length === 0) continue;
				const mean =
					controlRatios.reduce((sum, value) => sum + value, 0) /
					controlRatios.length;
				deltas.push(atDeath - mean);
			}
			paired.push({
				basis,
				horizon,
				n: deltas.length,
				medianDelta: percentileOf(deltas, 0.5),
			});
		}
	}

	return {
		deaths,
		excludedDeaths,
		excluded,
		peerExhaustionEvents: deathsInRange.length,
		foldedSimultaneous,
		groups,
		paired,
		controlsIneligible,
		halfWidthMs: ABSORPTION_HALF_WIDTH_MS,
		narrowHalfWidthMs: ABSORPTION_NARROW_HALF_WIDTH_MS,
		minHalfWidthMs: ABSORPTION_MIN_HALF_WIDTH_MS,
	};
}

// ---------------------------------------------------------------------------
// Roster reconstruction
// ---------------------------------------------------------------------------

export interface RosterWindow {
	kind: BacktestWindowKind;
	/** What BOTH models are fed, byte for byte. */
	input: RunwayWindowInput;
	lifecycleId: string;
	/** The whole lifecycle, for truth only — never for a projection. */
	lifecyclePoints: PredictionPoint[];
	labelResetAtMs: number | null;
	nextWindowStartsMs: number | null;
	placeholder: boolean;
}

export interface RosterEntry {
	accountId: string;
	provider: string;
	demandClass: string;
	unmetered: boolean;
	tier: AccountTier | null;
	sampledAt: number;
	windows: RosterWindow[];
}

export interface RosterInstant {
	T: number;
	accounts: RosterEntry[];
}

/**
 * The roster as a deployment at `T` would have seen it.
 *
 * Point-in-time throughout: the newest reading no older than
 * {@link READING_STALE_MS}, the reset that reading carried, the tier that row
 * was stamped with, and the anchors derivable from drops up to that row.
 * Nothing here may read a row after `T`.
 *
 * A window whose recorded reset has already passed is DROPPED, which is what
 * production's `projectableWindows` does: `estimateWindowExhaustion` answers
 * `already-exhausted` before its reset guards, so a stale 100 % reading would
 * otherwise be held dead for the whole horizon.
 *
 * Windows at 100 % are KEPT: a dead peer's fill demand is exactly how the
 * scenario redistributes. It is the RECORD emission that skips them, not the
 * roster.
 */
export function buildRosterAtInstant(
	T: number,
	series: ReadonlyMap<string, AccountSeries>,
	accounts: readonly RosterAccount[],
): RosterInstant {
	const accountById = new Map<string, RosterAccount>();
	for (const account of accounts) accountById.set(account.accountId, account);

	const entries: RosterEntry[] = [];
	for (const accountSeries of series.values()) {
		const rowIndex = latestRowIndexAt(accountSeries, T);
		if (rowIndex < 0) continue;
		const row = accountSeries.rows[rowIndex];
		if (T - row.sampledAt > READING_STALE_MS) continue;

		const provider = accountSeries.provider;
		const unmetered = !(
			FIVE_HOUR_ELIGIBLE_PROVIDERS.has(provider) ||
			SEVEN_DAY_ELIGIBLE_PROVIDERS.has(provider)
		);

		const windows: RosterWindow[] = [];
		for (const kind of WINDOW_KINDS) {
			const utilizationPct = pctOf(row, kind);
			if (utilizationPct == null) continue;
			const resetsAtMs = resetOf(row, kind);
			if (resetsAtMs != null && resetsAtMs <= T) continue;
			const window = accountSeries.windows[kind];
			const pointIdx = accountSeries.pointIndex[kind][rowIndex];
			if (pointIdx == null) continue;
			const lifecycle = window.lifecycles[window.lifecycleIndex[pointIdx]];

			// The 5h regression as production computes it: a 6 h lookback, no live
			// point (the harness has none), OLS with the module's own segmentation.
			// The weekly window gets NO prediction, because production emits none —
			// the lifetime path is its primary estimator and `estimateWindowExhaustion`
			// checks the regression first.
			const prediction =
				kind === "five_hour"
					? computeUsagePrediction(
							window.points.slice(
								lowerBound(window.points, T - 6 * HOUR_MS),
								pointIdx + 1,
							),
						)
					: null;

			windows.push({
				kind,
				input: {
					windowKind: kind,
					utilizationPct,
					resetsAtMs,
					windowStartMs:
						resetsAtMs == null ? null : computeWindowStartMs(resetsAtMs, kind),
					prediction,
					...(kind === "seven_day"
						? { lifetimeConfidence: "full" as const }
						: {}),
					observedAtMs: row.observedAt,
					anchor: window.anchorAtIndex[pointIdx],
				},
				lifecycleId: lifecycle.id,
				lifecyclePoints: window.points.slice(
					lifecycle.startIndex,
					lifecycle.endIndex + 1,
				),
				labelResetAtMs: lifecycle.labelResetAtMs,
				nextWindowStartsMs: lifecycle.nextWindowStartsMs,
				placeholder: lifecycle.placeholder,
			});
		}

		const account = accountById.get(accountSeries.accountId);
		const tier: AccountTier | null =
			row.planTier != null
				? {
						provider,
						planTier: row.planTier,
						rateLimitTier: row.rateLimitTier,
						provenance: "recorded",
					}
				: account?.currentPlanTier != null
					? {
							provider,
							planTier: account.currentPlanTier,
							rateLimitTier: account.currentRateLimitTier,
							provenance: "assumed",
						}
					: null;

		entries.push({
			accountId: accountSeries.accountId,
			provider,
			demandClass: servableClassFor(provider).classId,
			unmetered,
			tier,
			sampledAt: row.sampledAt,
			windows,
		});
	}
	return { T, accounts: entries };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ClassReplay {
	demandClass: string;
	inputs: RunwayScenarioAccountInput[];
	/** The SAME windows as `inputs`, with the scenario-only fields stripped. */
	currentInputs: RunwayAccountInput[];
	scenarioOutcomes: Map<ScenarioModel, RunwayScenarioOutcome>;
}

export interface InstantReplay {
	records: RedistributionRecord[];
	classes: ClassReplay[];
	placeholderWindowsSkipped: number;
	/**
	 * `${tag}::${demandClass}` → seven-day windows the label horizon dropped
	 * while carrying that tag.
	 */
	pendingWeeklyByTagClass: Map<string, number>;
}

const scenarioInputOf = (entry: RosterEntry): RunwayScenarioAccountInput => ({
	accountId: entry.accountId,
	unmetered: entry.unmetered,
	windows: entry.windows.map((window) => window.input),
	demandClass: entry.demandClass,
	tier: entry.tier,
});

const currentInputOf = (entry: RosterEntry): RunwayAccountInput => ({
	accountId: entry.accountId,
	unmetered: entry.unmetered,
	windows: entry.windows.map((window) => window.input),
});

/**
 * One of the two id lists the outcome union carries on SOME kinds only
 * (`unknown` has no `unprojectableAccountIds`, and `learningAccountIds` is
 * omitted when it would be empty). Absent reads as empty, which is what both
 * absences mean.
 */
const withheldIds = (outcome: RunwayScenarioOutcome): string[] =>
	"learningAccountIds" in outcome ? (outcome.learningAccountIds ?? []) : [];

const unprojectableIds = (outcome: RunwayScenarioOutcome): string[] =>
	"unprojectableAccountIds" in outcome ? outcome.unprojectableAccountIds : [];

/**
 * Every model's per-window verdict at one instant.
 *
 * Each servable class is scanned ON ITS OWN. A joint call would be wrong rather
 * than merely wasteful: the scan recomputes every class's weights at every
 * event, so an unrelated class's reset would re-time this class's assignments
 * under a utilization-dependent share rule.
 */
export interface ReplayInstantOptions {
	/** Overrides {@link SCENARIO_MODELS}' rules. One rule per scenario model. */
	shareRules?: Record<ScenarioModel, ShareRule>;
	/**
	 * Threaded to the scenario scan. A test seam for the budget branches, exactly
	 * as `MAX_SCENARIO_EVENTS` is for the scan itself; the runs that produce a
	 * report never set it.
	 */
	maxEvents?: number;
}

export function replayInstant(
	T: number,
	roster: RosterInstant,
	events: readonly TransitionEvent[],
	range: ReplayRange,
	options?: ReplayInstantOptions,
): InstantReplay {
	const byClass = new Map<string, RosterEntry[]>();
	for (const entry of roster.accounts) {
		const list = byClass.get(entry.demandClass);
		if (list) list.push(entry);
		else byClass.set(entry.demandClass, [entry]);
	}

	const records: RedistributionRecord[] = [];
	const classes: ClassReplay[] = [];
	let placeholderWindowsSkipped = 0;
	const pendingWeeklyByTagClass = new Map<string, number>();

	for (const [demandClass, entries] of byClass) {
		const inputs = entries.map(scenarioInputOf);
		const scenarioOutcomes = new Map<ScenarioModel, RunwayScenarioOutcome>();
		for (const model of SCENARIO_MODEL_IDS) {
			const spec = SCENARIO_MODELS[model];
			scenarioOutcomes.set(
				model,
				computeCapacityRunwayScenario(inputs, T, RUNWAY_HORIZON_MS, {
					shareRule: options?.shareRules?.[model] ?? spec.shareRule,
					observationLag: spec.observationLag,
					probePaceMargin: false,
					...(options?.maxEvents != null
						? { maxEvents: options.maxEvents }
						: {}),
				}),
			);
		}
		classes.push({
			demandClass,
			inputs,
			currentInputs: entries.map(currentInputOf),
			scenarioOutcomes,
		});

		// Reading-level facts, derived ONCE for the whole class: every model's
		// record at one instant carries the same ones, exactly as
		// `slopePctPerHour` does.
		const estimatesByAccount = new Map<string, Map<string, WindowExhaustion>>();
		for (const entry of entries) {
			estimatesByAccount.set(
				entry.accountId,
				new Map(
					entry.windows.map((window) => [
						window.kind,
						estimateWindowExhaustion(window.input, T),
					]),
				),
			);
		}
		const lagOf = (entry: RosterEntry, window: RosterWindow): number => {
			const estimate = estimatesByAccount
				.get(entry.accountId)
				?.get(window.kind);
			return estimate == null ? 0 : observationLagMs(estimate, window.input, T);
		};
		// Whether that zero is a derivation or an absence. Mirrors
		// `observationLagMs`' own guards on the two paths that admit a lag; every
		// other path carries none, so its zero is derived.
		const lagAnchorKnownOf = (
			entry: RosterEntry,
			window: RosterWindow,
		): boolean => {
			const estimate = estimatesByAccount
				.get(entry.accountId)
				?.get(window.kind);
			if (estimate == null) return true;
			if (estimate.source === "regression") {
				const slope = estimate.slopePctPerHour;
				return estimate.exhaustsAtMs != null && slope != null && slope > 0;
			}
			if (estimate.source === "lifetime-primary") {
				const observedAtMs = window.input.observedAtMs;
				return observedAtMs != null && Number.isFinite(observedAtMs);
			}
			return true;
		};
		// Pooled as the CORRECTED scan classified them: everything it did not
		// exclude. An outcome that states no exclusions (an `unknown` from an
		// empty pool) reads as "nothing excluded", which over-counts rather than
		// under-counts and therefore keeps `classLagFree` conservative.
		//
		// The equal pair BY NAME, not the verdict basis: `classLagFree`,
		// `pooledInClass`, `firstEvent`, `peerDiedInLag` and `exactShiftEligible`
		// are what the observation-lag mechanism check is computed on, and that
		// check's subject is the correction measured on the equal split. Moving
		// them to the basis would change what those checks are about without
		// saying so.
		const corrected = scenarioOutcomes.get(PRIOR_BASIS_MODEL);
		const excludedIds = new Set<string>([
			...(corrected == null ? [] : unprojectableIds(corrected)),
			...(corrected?.unknownTierAccountIds ?? []),
		]);
		const pooledEntries = entries.filter(
			(entry) => !excludedIds.has(entry.accountId),
		);
		const pooledInClass = pooledEntries.length;
		const classLagFree = pooledEntries.every((entry) =>
			entry.windows.every((window) => lagOf(entry, window) === 0),
		);
		// A window already at 100 % comes back at its reset, and that revival
		// re-splits the class just as a death does.
		const revivalInstants = entries.flatMap((entry) =>
			entry.windows
				.filter((window) => window.input.utilizationPct >= 100)
				.map((window) => window.input.resetsAtMs)
				.filter(
					(resetsAtMs): resetsAtMs is number =>
						resetsAtMs != null && Number.isFinite(resetsAtMs) && resetsAtMs > T,
				),
		);
		// A window filled inside its lag reports the sub-`T` instant it truly
		// reached 100 %, but the scan applies that death AT `T`, so `T` is where
		// it orders against everything else. Shared by the two predicates below
		// so they agree on that ordering by construction.
		const orderedAt = (exhaustsAtMs: number): number =>
			Math.max(T, exhaustsAtMs);
		const isSameWindow = (
			exhaustion: { accountId: string; windowKind: string },
			accountId: string,
			windowKind: string,
		): boolean =>
			exhaustion.accountId === accountId &&
			exhaustion.windowKind === windowKind;
		/**
		 * First-event eligibility inside ONE scan, from that scan's OWN ordering
		 * of the class's slope-changing events.
		 *
		 * Built per scan because the two scans order those events differently:
		 * the correction can fill a peer inside its observation lag, and that
		 * death lands at `T` here while the same peer is alive at `T` in the
		 * pre-correction scan and dies somewhere ahead of it.
		 */
		const firstEventInScan = (
			model: ScenarioModel,
		): ((accountId: string, windowKind: string) => boolean) => {
			const exhaustions =
				scenarioOutcomes.get(model)?.projectedExhaustions ?? [];
			return (accountId: string, windowKind: string): boolean => {
				const own = exhaustions.find((exhaustion) =>
					isSameWindow(exhaustion, accountId, windowKind),
				)?.exhaustsAtMs;
				if (own == null) return false;
				const ownAt = orderedAt(own);
				for (const other of exhaustions) {
					if (isSameWindow(other, accountId, windowKind)) continue;
					const otherAt = orderedAt(other.exhaustsAtMs);
					// An event at `T` itself is already part of the share this window
					// starts on; only one still ahead of `T` breaks its single slope.
					if (otherAt > T && otherAt <= ownAt) return false;
				}
				return revivalInstants.every((resetsAtMs) => resetsAtMs > ownAt);
			};
		};
		const firstEventCorrected = firstEventInScan(PRIOR_BASIS_MODEL);
		const firstEventOriginal = firstEventInScan(PRIOR_BASIS_CONTROL_MODEL);
		const firstEventBasis = firstEventInScan(VERDICT_BASIS_MODEL);
		// A class member already at 100 % at `T` is a contributor the survivors
		// carry from the first assignment on, so no scan of this instant starts
		// on own-slopes. Read from the READINGS rather than from any scan: it is
		// a property of the instant, and every model sees the same one.
		const classDeadAtT = entries.some((entry) =>
			entry.windows.some((window) => window.input.utilizationPct >= 100),
		);
		const basisScan = scenarioOutcomes.get(VERDICT_BASIS_MODEL);
		/**
		 * True when the BASIS scan kept measured demand OUT of its own
		 * assignments: an account whose burn joined the class demand but which is
		 * not in the pool the demand is split over.
		 *
		 * The identity is not about deaths alone. The scan takes a withheld
		 * account's measured burn into the class demand and then hands it to the
		 * accounts it did pool, so a survivor burns faster than its own reading
		 * from the FIRST assignment on, with nobody exhausted and nothing having
		 * died. Two of the scan's statuses can do that — `withheld` (the strict
		 * unmeasured rule) and `demand-only` (paused or removed) — and both are
		 * disclosed by id. Every other non-pooled status carries no window at all
		 * and therefore no burn to contribute.
		 *
		 * A class-level fact, not a per-account one: the demand is pooled, so one
		 * withheld contributor moves every projection in the class. The withheld
		 * list is not filtered by contribution — the scan does not report which
		 * of a withheld account's windows measured anything — so an account whose
		 * every window is learning disqualifies the instant as well. That only
		 * ever removes records from the population; it can never admit one whose
		 * demand was redistributed.
		 */
		const basisWithholdsDemand =
			basisScan == null ||
			withheldIds(basisScan).length > 0 ||
			basisScan.demandOnlyAccountIds.length > 0;
		/**
		 * True when NO exhaustion of this class stands between `T` and this
		 * window's own projected exhaustion in the BASIS scan — in ANY cycle.
		 *
		 * `firstEventInScan` reads `projectedExhaustions`, which by design holds
		 * first-cycle deaths only, so a window that resets and fills again before
		 * this one's ETA is invisible to it. Such a death re-splits the class
		 * exactly like a first-cycle one: the survivors carry its demand until it
		 * revives, and this window stops burning at its own measured slope.
		 * `firstExhaustionAfterNowByClass` is the scan's own statement that it
		 * happened.
		 *
		 * An instant EQUAL to this window's own exhaustion is its own death (or a
		 * tie with it) and changes nothing before it, which is why the comparison
		 * is not strict.
		 */
		const noClassDeathBeforeBasis = (
			accountId: string,
			windowKind: string,
		): boolean => {
			const own = basisScan?.projectedExhaustions.find((exhaustion) =>
				isSameWindow(exhaustion, accountId, windowKind),
			)?.exhaustsAtMs;
			if (own == null) return false;
			const firstDeath = basisScan?.firstExhaustionAfterNowByClass.find(
				(entry) => entry.demandClass === demandClass,
			)?.atMs;
			return firstDeath == null || firstDeath >= orderedAt(own);
		};
		/**
		 * The death `firstEventInScan` cannot see: another window of the class
		 * that the correction filled inside its own lag, which the scan applies
		 * AT `T` and which therefore never orders ahead of anything.
		 *
		 * It still re-splits the class from `T` on, so a window projecting past
		 * `T` beside one is neither an exact-shift case nor a parity case.
		 */
		const peerDiedInLagOf = (
			accountId: string,
			windowKind: string,
			model: ScenarioModel = PRIOR_BASIS_MODEL,
		): boolean => {
			const exhaustions =
				scenarioOutcomes.get(model)?.projectedExhaustions ?? [];
			const own = exhaustions.find((exhaustion) =>
				isSameWindow(exhaustion, accountId, windowKind),
			)?.exhaustsAtMs;
			if (own == null || orderedAt(own) <= T) return false;
			return exhaustions.some(
				(other) =>
					!isSameWindow(other, accountId, windowKind) &&
					orderedAt(other.exhaustsAtMs) <= T,
			);
		};

		for (const entry of entries) {
			// Account-level learning, the current model's strict rule: ONE learning
			// window makes the WHOLE account unprojectable.
			const estimates =
				estimatesByAccount.get(entry.accountId) ??
				new Map<string, WindowExhaustion>();
			const learningAtT = entry.windows.some((window) => {
				const estimate = estimates.get(window.kind);
				return (
					estimate != null &&
					isLearningEstimate(estimate, window.input.utilizationPct)
				);
			});

			for (const window of entry.windows) {
				if (window.input.utilizationPct >= 100) continue;
				if (window.placeholder) {
					placeholderWindowsSkipped++;
					continue;
				}
				const outcome = deriveOutcome(
					window.lifecyclePoints,
					T,
					window.labelResetAtMs,
					window.nextWindowStartsMs,
				);
				// Tagged BEFORE the horizon drop: a dropped weekly window is what
				// marks a (tag, class) pair still pending at the label horizon.
				const context = transitionsAt(events, T, entry.accountId, demandClass);
				// Label horizon: a window whose truth is still unfolding at the end of
				// the loaded history would be scored on an outcome nobody observed.
				const truthEnd =
					outcome.kind === "exhausted" ? outcome.atMs : window.labelResetAtMs;
				if (truthEnd == null || truthEnd >= range.toMs) {
					if (window.kind === "seven_day") {
						for (const tag of context.tags) {
							const key = `${tag}::${demandClass}`;
							pendingWeeklyByTagClass.set(
								key,
								(pendingWeeklyByTagClass.get(key) ?? 0) + 1,
							);
						}
					}
					continue;
				}
				const estimate = estimates.get(window.kind);
				const observedAtMs =
					window.input.observedAtMs != null &&
					Number.isFinite(window.input.observedAtMs)
						? window.input.observedAtMs
						: null;
				const firstEvent = firstEventCorrected(entry.accountId, window.kind);
				const peerDiedInLag = peerDiedInLagOf(entry.accountId, window.kind);
				const common = {
					T,
					windowKind: window.kind,
					accountId: entry.accountId,
					provider: entry.provider,
					outcome,
					knownResetAtMs: window.input.resetsAtMs,
					labelResetAtMs: window.labelResetAtMs,
					windowMs: WINDOW_MS[window.kind],
					lifecycleId: window.lifecycleId,
					tags: context.tags,
					eventIds: context.eventIds,
					learningAtT,
					sinceDeathMs: context.sinceDeathMs,
					slopePctPerHour: estimate?.slopePctPerHour ?? null,
					observationAgeMs: observedAtMs == null ? null : T - observedAtMs,
					sampleAgeMs: T - entry.sampledAt,
					lagMs: lagOf(entry, window),
					estimatorSource: estimate?.source ?? "none",
					classLagFree,
					pooledInClass,
					firstEvent,
					peerDiedInLag,
					exactShiftEligible:
						firstEvent &&
						!peerDiedInLag &&
						firstEventOriginal(entry.accountId, window.kind),
					basisFirstAssignment:
						!classDeadAtT &&
						!basisWithholdsDemand &&
						firstEventBasis(entry.accountId, window.kind) &&
						!peerDiedInLagOf(
							entry.accountId,
							window.kind,
							VERDICT_BASIS_MODEL,
						) &&
						noClassDeathBeforeBasis(entry.accountId, window.kind),
					lagAnchorKnown: lagAnchorKnownOf(entry, window),
				};

				const currentUsable =
					!learningAtT && estimate != null && estimate.source !== "none";
				// A beyond-reset ETA is "not this cycle", which is the same statement
				// as a scenario's absent projection: every model is held to what it
				// can express about the window in front of it.
				const predictsExhaust =
					currentUsable &&
					estimate?.exhaustsAtMs != null &&
					window.input.resetsAtMs != null &&
					estimate.exhaustsAtMs < window.input.resetsAtMs;
				records.push({
					...common,
					model: "current",
					usable: currentUsable,
					unusableReason: currentUsable
						? null
						: learningAtT
							? "low_confidence"
							: "no_slope",
					predictsExhaust,
					predictedEtaMs: predictsExhaust
						? (estimate?.exhaustsAtMs ?? null)
						: null,
				});

				for (const model of SCENARIO_MODEL_IDS) {
					const scenario = scenarioOutcomes.get(model);
					if (scenario == null) continue;
					const withheld = withheldIds(scenario).includes(entry.accountId);
					const usable =
						scenario.kind !== "unknown" &&
						scenario.eventBudgetExhausted !== "projection" &&
						!unprojectableIds(scenario).includes(entry.accountId) &&
						!withheld &&
						!scenario.unknownTierAccountIds.includes(entry.accountId);
					const projected = scenario.projectedExhaustions.find(
						(exhaustion) =>
							exhaustion.accountId === entry.accountId &&
							exhaustion.windowKind === window.kind,
					);
					records.push({
						...common,
						model,
						usable,
						unusableReason: usable
							? null
							: withheld
								? "low_confidence"
								: "insufficient_data",
						predictsExhaust: usable && projected != null,
						predictedEtaMs: usable ? (projected?.exhaustsAtMs ?? null) : null,
					});
				}
			}
		}
	}

	return {
		records,
		classes,
		placeholderWindowsSkipped,
		pendingWeeklyByTagClass,
	};
}

// ---------------------------------------------------------------------------
// Pool-level calibration
// ---------------------------------------------------------------------------

/** What the truth grid says about a class at one tick. */
type TruthTick = "all-out" | "not-out" | "censored";

/**
 * How much of a horizon may be censored before "no outage" is not sayable.
 *
 * A pool-out is an instant, so a single missing tick can hide one; but with a
 * 14-day horizon and a two-minute sampler, insisting on total coverage would
 * censor nearly every instant. 5 % is the same spirit as the per-window
 * harness's `SEGMENT_COVERAGE_SLACK_MS`. Inline named constant — NO env gate.
 */
export const CENSORED_TICK_TOLERANCE = 0.05;

export interface PoolCalibrationRow {
	demandClass: string;
	model: ReplayModel;
	instants: number;
	abstained: number;
	predictedOut: number;
	observedOut: number;
	observedNonOutage: number;
	censored: number;
	/**
	 * Predicted-out instants followed by a horizon with no observed all-out tick
	 * and at most 5 % of its ticks censored, over the predicted-out instants
	 * whose truth is determinate. `null` with no determinate denominator —
	 * never 0, which would read as "no false alarms".
	 */
	falseAlarmRate: number | null;
}

/** One contiguous run of `"all-out"` ticks on a class's truth grid. */
export interface AllOutInterval {
	demandClass: string;
	/** First all-out tick of the run. */
	fromMs: number;
	/** One step past the run's last all-out tick, so the interval is half-open. */
	toMs: number;
	ticks: number;
}

export interface ReplayResult {
	range: ReplayRange;
	stepMinutes: number;
	seed: number;
	instants: number;
	records: RedistributionRecord[];
	events: TransitionEvent[];
	calibration: PoolCalibrationRow[];
	/**
	 * Every observed all-out episode, per class: the positives behind the
	 * calibration table's `observed out` column, stated rather than asserted
	 * away. Empty for a class the grid never saw all-out.
	 */
	allOutIntervals: AllOutInterval[];
	placeholderWindowsSkipped: number;
	/**
	 * `${tag}::${demandClass}` → seven-day windows the label horizon dropped
	 * over the whole replay, summed from {@link InstantReplay}. Tells an
	 * unlabelled cohort that is merely PENDING apart from one that is
	 * structurally unlabelled in this roster.
	 */
	pendingWeeklyByTagClass: Map<string, number>;
	/** Fraction of instants each transition tag covered, for the report. */
	tagCoverage: Array<{
		tag: TransitionKind;
		events: number;
		instantFraction: number | null;
	}>;
	/**
	 * Every non-placeholder window lifecycle's fill, from
	 * {@link scanWindowFills}. Read by the absorption section only: no model,
	 * cohort or verdict consumes it.
	 */
	fills: WindowFill[];
	/**
	 * Placeholder LIFECYCLES the fill scan skipped. Not
	 * {@link ReplayResult.placeholderWindowsSkipped}, which counts per-instant
	 * window emissions and so scales with the grid rather than with the
	 * history.
	 */
	placeholderLifecyclesSkipped: number;
}

function truthTicksFor(
	entries: readonly AccountSeries[],
	ticks: readonly number[],
): TruthTick[] {
	return ticks.map((tick) => {
		let members = 0;
		let allOut = true;
		let anyStale = false;
		for (const series of entries) {
			if (series.rows.length === 0) continue;
			const first = series.rows[0].sampledAt;
			const last = series.rows[series.rows.length - 1].sampledAt;
			// Membership from the history span: before the first row the account did
			// not exist for us, after the last one it is gone.
			if (tick < first || tick > last) continue;
			members++;
			const index = latestRowIndexAt(series as AccountSeries, tick);
			const row = index >= 0 ? series.rows[index] : null;
			if (row == null || tick - row.sampledAt > READING_STALE_MS) {
				anyStale = true;
				continue;
			}
			const out = WINDOW_KINDS.some((kind) => {
				const utilization = pctOf(row, kind);
				const reset = resetOf(row, kind);
				return utilization != null && utilization >= 100 && reset != null
					? tick < reset
					: false;
			});
			if (!out) allOut = false;
		}
		if (members === 0) return "censored";
		if (anyStale) return "censored";
		return allOut ? "all-out" : "not-out";
	});
}

/**
 * Replay every instant of `range` on the fixed grid, and calibrate each model's
 * pool-level "out within the horizon" claim against what the grid observed.
 */
export function replayRange(
	rows: readonly RosterSnapshotRow[],
	accounts: readonly RosterAccount[],
	range: ReplayRange,
	stepMinutes: number,
	seed: number,
): ReplayResult {
	const series = prepareSeries(rows, accounts);
	const events = detectTransitions(series, accounts, range);
	const fillScan = scanWindowFills(series, events, range);
	const stepMs = stepMinutes * MINUTE_MS;

	const ticks: number[] = [];
	for (let T = range.fromMs; T < range.toMs; T += stepMs) ticks.push(T);

	// Truth grid per class, once. Prefix sums so each instant's horizon is two
	// array reads rather than a 14-day scan.
	const seriesByClass = new Map<string, AccountSeries[]>();
	for (const accountSeries of series.values()) {
		const classId = servableClassFor(accountSeries.provider).classId;
		const list = seriesByClass.get(classId);
		if (list) list.push(accountSeries);
		else seriesByClass.set(classId, [accountSeries]);
	}
	const truthByClass = new Map<
		string,
		{ allOutPrefix: number[]; censoredPrefix: number[] }
	>();
	const allOutIntervals: AllOutInterval[] = [];
	for (const [classId, members] of seriesByClass) {
		const tickStates = truthTicksFor(members, ticks);
		const allOutPrefix = [0];
		const censoredPrefix = [0];
		let runStart: number | null = null;
		for (let i = 0; i < tickStates.length; i++) {
			allOutPrefix.push(
				allOutPrefix[i] + (tickStates[i] === "all-out" ? 1 : 0),
			);
			censoredPrefix.push(
				censoredPrefix[i] + (tickStates[i] === "censored" ? 1 : 0),
			);
			// Contiguous runs of all-out ticks, closed as soon as the run breaks.
			if (tickStates[i] === "all-out") {
				if (runStart == null) runStart = i;
			} else if (runStart != null) {
				allOutIntervals.push({
					demandClass: classId,
					fromMs: ticks[runStart],
					toMs: ticks[i - 1] + stepMs,
					ticks: i - runStart,
				});
				runStart = null;
			}
		}
		if (runStart != null) {
			allOutIntervals.push({
				demandClass: classId,
				fromMs: ticks[runStart],
				toMs: ticks[tickStates.length - 1] + stepMs,
				ticks: tickStates.length - runStart,
			});
		}
		truthByClass.set(classId, { allOutPrefix, censoredPrefix });
	}
	allOutIntervals.sort(
		(a, b) => a.demandClass.localeCompare(b.demandClass) || a.fromMs - b.fromMs,
	);
	const horizonTicks = Math.floor(RUNWAY_HORIZON_MS / stepMs);

	interface CalibrationTally {
		instants: number;
		abstained: number;
		predictedOut: number;
		observedOut: number;
		observedNonOutage: number;
		censored: number;
		falseAlarms: number;
		determinatePredictions: number;
	}
	const tally = new Map<string, CalibrationTally>();
	const tallyFor = (demandClass: string, model: ReplayModel) => {
		const key = `${demandClass}::${model}`;
		let entry = tally.get(key);
		if (!entry) {
			entry = {
				instants: 0,
				abstained: 0,
				predictedOut: 0,
				observedOut: 0,
				observedNonOutage: 0,
				censored: 0,
				falseAlarms: 0,
				determinatePredictions: 0,
			};
			tally.set(key, entry);
		}
		return entry;
	};

	const records: RedistributionRecord[] = [];
	let placeholderWindowsSkipped = 0;
	const pendingWeeklyByTagClass = new Map<string, number>();
	const instantsWithTag = new Map<TransitionKind, number>();

	for (let i = 0; i < ticks.length; i++) {
		const T = ticks[i];
		const roster = buildRosterAtInstant(T, series, accounts);
		const replay = replayInstant(T, roster, events, range);
		records.push(...replay.records);
		placeholderWindowsSkipped += replay.placeholderWindowsSkipped;
		for (const [key, count] of replay.pendingWeeklyByTagClass) {
			pendingWeeklyByTagClass.set(
				key,
				(pendingWeeklyByTagClass.get(key) ?? 0) + count,
			);
		}

		// Coverage of the GRID, not of the records: an instant sits in a tag's
		// shadow whether or not a scorable window happened to exist there, and
		// counting only scored records would understate how much of the run the
		// transitions actually span.
		const tagsHere = new Set<TransitionKind>();
		for (const event of events) {
			if (event.atMs < T && T <= event.endsAtMs) tagsHere.add(event.kind);
		}
		for (const tag of tagsHere) {
			instantsWithTag.set(tag, (instantsWithTag.get(tag) ?? 0) + 1);
		}

		// Calibration needs a full horizon of observed grid AFTER T.
		if (T + RUNWAY_HORIZON_MS >= range.toMs) continue;
		for (const classReplay of replay.classes) {
			const truth = truthByClass.get(classReplay.demandClass);
			if (truth == null) continue;
			const spanFrom = i + 1;
			const spanTo = Math.min(i + horizonTicks, ticks.length - 1);
			if (spanTo < spanFrom) continue;
			const spanTicks = spanTo - spanFrom + 1;
			const allOut =
				truth.allOutPrefix[spanTo + 1] - truth.allOutPrefix[spanFrom];
			const censoredTicks =
				truth.censoredPrefix[spanTo + 1] - truth.censoredPrefix[spanFrom];
			const observed: "out" | "non-outage" | "censored" =
				allOut > 0
					? "out"
					: censoredTicks <= CENSORED_TICK_TOLERANCE * spanTicks
						? "non-outage"
						: "censored";

			const current = computeCapacityRunway(
				classReplay.currentInputs,
				T,
				RUNWAY_HORIZON_MS,
				{ probePaceMargin: false },
			);
			const kinds: Array<[ReplayModel, RunwayOutcome["kind"]]> = [
				["current", current.kind],
				...SCENARIO_MODEL_IDS.map(
					(model): [ReplayModel, RunwayOutcome["kind"]] => [
						model,
						classReplay.scenarioOutcomes.get(model)?.kind ?? "unknown",
					],
				),
			];
			for (const [model, kind] of kinds) {
				const entry = tallyFor(classReplay.demandClass, model);
				entry.instants++;
				const abstains = kind === "unknown" || kind === "no-accounts";
				const predictsOut = kind === "runway" || kind === "out-now";
				if (abstains) entry.abstained++;
				if (predictsOut) entry.predictedOut++;
				if (observed === "out") entry.observedOut++;
				else if (observed === "non-outage") entry.observedNonOutage++;
				else entry.censored++;
				if (predictsOut && observed !== "censored") {
					entry.determinatePredictions++;
					if (observed === "non-outage") entry.falseAlarms++;
				}
			}
		}
	}

	const calibration: PoolCalibrationRow[] = [...tally.entries()]
		.map(([key, entry]) => {
			const [demandClass, model] = key.split("::");
			return {
				demandClass,
				model: model as ReplayModel,
				instants: entry.instants,
				abstained: entry.abstained,
				predictedOut: entry.predictedOut,
				observedOut: entry.observedOut,
				observedNonOutage: entry.observedNonOutage,
				censored: entry.censored,
				falseAlarmRate:
					entry.determinatePredictions > 0
						? entry.falseAlarms / entry.determinatePredictions
						: null,
			};
		})
		.sort(
			(a, b) =>
				a.demandClass.localeCompare(b.demandClass) ||
				REPLAY_MODELS.indexOf(a.model) - REPLAY_MODELS.indexOf(b.model),
		);

	return {
		range,
		stepMinutes,
		seed,
		instants: ticks.length,
		records,
		events,
		calibration,
		allOutIntervals,
		placeholderWindowsSkipped,
		pendingWeeklyByTagClass,
		tagCoverage: TRANSITION_KINDS.map((tag) => ({
			tag,
			events: events.filter((event) => event.kind === tag).length,
			instantFraction:
				ticks.length > 0
					? (instantsWithTag.get(tag) ?? 0) / ticks.length
					: null,
		})),
		fills: fillScan.fills,
		placeholderLifecyclesSkipped: fillScan.placeholderLifecyclesSkipped,
	};
}

// ---------------------------------------------------------------------------
// Cohorts and scoring
// ---------------------------------------------------------------------------

const recordKey = (record: RedistributionRecord): string =>
	`${record.accountId}::${record.windowKind}::${record.T}`;

/** One record per (model, lifecycle): the one at the group's median instant. */
export function lifecycleBalanced(
	records: readonly RedistributionRecord[],
): RedistributionRecord[] {
	const byLifecycle = new Map<string, RedistributionRecord[]>();
	for (const record of records) {
		const key = `${record.model}::${record.lifecycleId}`;
		const list = byLifecycle.get(key);
		if (list) list.push(record);
		else byLifecycle.set(key, [record]);
	}
	const out: RedistributionRecord[] = [];
	for (const list of byLifecycle.values()) {
		const sorted = [...list].sort((a, b) => a.T - b.T);
		// Lower median on even counts, so the pick is deterministic and the same
		// instant is chosen for every model (the cohort's keys are identical).
		out.push(sorted[Math.floor((sorted.length - 1) / 2)]);
	}
	return out.sort(
		(a, b) => a.T - b.T || a.lifecycleId.localeCompare(b.lifecycleId),
	);
}

export interface PairedBias {
	n: number;
	/** Median signed error of the first model, in minutes. Positive = optimistic. */
	medianA: number | null;
	medianB: number | null;
}

/**
 * Median signed ETA error of two models over the instants where BOTH committed
 * to a date and the window was observed to exhaust.
 *
 * Paired on purpose: comparing each model's unconditional bias would compare
 * them on different instants, and the whole question is which one is more
 * optimistic where they both spoke.
 */
export function pairedSignedMedian(
	records: readonly RedistributionRecord[],
	modelA: ReplayModel,
	modelB: ReplayModel,
): PairedBias {
	const errors = pairedEtaErrors(records, modelA, modelB);
	return {
		n: errors.length,
		medianA: medianOf(errors.map(([a]) => a)),
		medianB: medianOf(errors.map(([, b]) => b)),
	};
}

/**
 * Signed ETA error in minutes of both models, over the instants where both
 * committed to a date and the window was observed to exhaust. One row per
 * (account, window, instant), in no particular order.
 */
function pairedEtaErrors(
	records: readonly RedistributionRecord[],
	modelA: ReplayModel,
	modelB: ReplayModel,
): Array<[number, number]> {
	const byKey = new Map<string, Map<ReplayModel, RedistributionRecord>>();
	for (const record of records) {
		const key = recordKey(record);
		let entry = byKey.get(key);
		if (!entry) {
			entry = new Map();
			byKey.set(key, entry);
		}
		entry.set(record.model, record);
	}
	const out: Array<[number, number]> = [];
	for (const entry of byKey.values()) {
		const first = entry.get(modelA);
		const second = entry.get(modelB);
		if (first == null || second == null) continue;
		if (first.predictedEtaMs == null || second.predictedEtaMs == null) continue;
		if (first.outcome.kind !== "exhausted") continue;
		out.push([
			(first.predictedEtaMs - first.outcome.atMs) / MINUTE_MS,
			(second.predictedEtaMs - first.outcome.atMs) / MINUTE_MS,
		]);
	}
	return out;
}

export interface PairedAbsDelta {
	n: number;
	/**
	 * Median of `|error of modelA| - |error of modelB|` in minutes, over the
	 * records both models dated. Negative = `modelA` is the closer one.
	 */
	medianDeltaMinutes: number | null;
}

/**
 * How much CLOSER to the observed instant one model lands than another, paired
 * on the records both dated.
 *
 * The sibling of {@link pairedSignedMedian} for a comparison where direction is
 * not the question: two models can share a median signed error and still
 * differ in how far off they are, and criterion D asks whether the correction moved the
 * ETAs toward the truth, not which side of it they land on.
 */
export function pairedAbsMedian(
	records: readonly RedistributionRecord[],
	modelA: ReplayModel,
	modelB: ReplayModel,
): PairedAbsDelta {
	const errors = pairedEtaErrors(records, modelA, modelB);
	return {
		n: errors.length,
		medianDeltaMinutes: medianOf(
			errors.map(([a, b]) => Math.abs(a) - Math.abs(b)),
		),
	};
}

/**
 * Nearest-rank percentile over an unsorted array; empty reads as null.
 *
 * The LOWER median on even counts, matching {@link lifecycleBalanced}'s
 * instant pick and the harness's own `percentile`, so every median in this
 * module is the same median.
 */
export function percentileOf(
	values: readonly number[],
	p: number,
): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((x, y) => x - y);
	const rank = Math.min(
		sorted.length,
		Math.max(1, Math.ceil(p * sorted.length)),
	);
	return sorted[rank - 1];
}

const medianOf = (values: readonly number[]): number | null =>
	percentileOf(values, 0.5);

export interface CohortScores {
	label: string;
	/** Records per model in the per-record view. */
	records: number;
	lifecycles: number;
	episodes: number;
	balanced: ReportEstimatorMetrics[];
	perRecord: ReportEstimatorMetrics[];
	/**
	 * Every scenario model against the CURRENT model — criterion A's statistic.
	 *
	 * Keyed by model rather than held as one number, because each pair carries
	 * its OWN pairing: a paired median is taken over the records both models of
	 * the pair dated, and which records those are is a property of the pair. The
	 * basis, the prior basis and the headroom rule are all scored on it.
	 */
	biasVsCurrent: Record<ScenarioModel, PairedBias>;
	/**
	 * Every model that has a pre-correction control ({@link CONTROL_MODELS}),
	 * against that control. Absent for a model with no control.
	 */
	biasVsControl: Partial<Record<ScenarioModel, PairedBias>>;
	/**
	 * The same pairs as a change in ABSOLUTE error — criterion D's statistic —
	 * so a model states how much closer to the truth its correction lands than
	 * its own uncorrected scan.
	 */
	absVsControl: Partial<Record<ScenarioModel, PairedAbsDelta>>;
}

const EMPTY_BIAS: PairedBias = { n: 0, medianA: null, medianB: null };
const EMPTY_ABS: PairedAbsDelta = { n: 0, medianDeltaMinutes: null };

/** A model's pair against the current model, never `undefined`. */
export const biasVsCurrentOf = (
	cohort: CohortScores,
	model: ScenarioModel,
): PairedBias => cohort.biasVsCurrent[model] ?? EMPTY_BIAS;

/** A model's pair against its own control, empty where it has none. */
export const biasVsControlOf = (
	cohort: CohortScores,
	model: ScenarioModel,
): PairedBias => cohort.biasVsControl[model] ?? EMPTY_BIAS;

/** A model's absolute-error change against its own control, empty where it has none. */
export const absVsControlOf = (
	cohort: CohortScores,
	model: ScenarioModel,
): PairedAbsDelta => cohort.absVsControl[model] ?? EMPTY_ABS;

function metricsByModel(
	records: readonly RedistributionRecord[],
): ReportEstimatorMetrics[] {
	return REPLAY_MODELS.map((model) => ({
		estimator: model,
		metrics: scoreRecords(records.filter((record) => record.model === model)),
	}));
}

function scoreCohort(
	label: string,
	records: readonly RedistributionRecord[],
): CohortScores {
	const balanced = lifecycleBalanced(records);
	const lifecycles = new Set(records.map((record) => record.lifecycleId));
	const episodes = new Set<number>();
	for (const record of records) {
		for (const id of record.eventIds) episodes.add(id);
	}
	const biasVsCurrent = {} as Record<ScenarioModel, PairedBias>;
	const biasVsControl: Partial<Record<ScenarioModel, PairedBias>> = {};
	const absVsControl: Partial<Record<ScenarioModel, PairedAbsDelta>> = {};
	for (const model of SCENARIO_MODEL_IDS) {
		biasVsCurrent[model] = pairedSignedMedian(balanced, model, "current");
		const control = CONTROL_MODELS[model];
		if (control == null) continue;
		biasVsControl[model] = pairedSignedMedian(balanced, model, control);
		absVsControl[model] = pairedAbsMedian(balanced, model, control);
	}
	return {
		label,
		records: records.filter((record) => record.model === "current").length,
		lifecycles: lifecycles.size,
		episodes: episodes.size,
		balanced: metricsByModel(balanced),
		perRecord: metricsByModel(records),
		biasVsCurrent,
		biasVsControl,
		absVsControl,
	};
}

const metricsOf = (
	rows: readonly ReportEstimatorMetrics[],
	model: ReplayModel,
): BacktestMetrics | null =>
	rows.find((row) => row.estimator === model)?.metrics ?? null;

export interface SinceDeathBucketSpec {
	label: string;
	/** Exclusive upper bound of the bucket, in ms since the death. */
	maxMs: number;
}

/**
 * How long the survivor has been carrying the dead peer's traffic, at the
 * resolution the absorption actually happens on.
 *
 * The five-hour window is only 300 minutes long, so the three coarse buckets
 * this replaced (`<1h`, `1-5h`, `>5h`) put an entire five-hour lifecycle in one
 * or two cells and could not show the survivor's slope catching up inside it.
 * The last bucket is open at the top rather than closed at 24 h so no record
 * can fall out of the table; the transition shadow is
 * {@link TRANSITION_WINDOW_MS} = 24 h, so nothing older reaches it anyway.
 */
export const SINCE_DEATH_BUCKETS: readonly SinceDeathBucketSpec[] = [
	{ label: "0-30m", maxMs: 30 * MINUTE_MS },
	{ label: "30-60m", maxMs: HOUR_MS },
	{ label: "1-2h", maxMs: 2 * HOUR_MS },
	{ label: "2-3h", maxMs: 3 * HOUR_MS },
	{ label: "3-4h", maxMs: 4 * HOUR_MS },
	{ label: "4-6h", maxMs: 6 * HOUR_MS },
	{ label: "6-12h", maxMs: 12 * HOUR_MS },
	{ label: "12-24h", maxMs: Number.POSITIVE_INFINITY },
];

/** Which since-death bucket an age falls in, or -1 when it has none. */
export function sinceDeathBucketIndex(sinceDeathMs: number | null): number {
	if (sinceDeathMs == null || !Number.isFinite(sinceDeathMs)) return -1;
	for (let i = 0; i < SINCE_DEATH_BUCKETS.length; i++) {
		if (sinceDeathMs < SINCE_DEATH_BUCKETS[i].maxMs) return i;
	}
	return SINCE_DEATH_BUCKETS.length - 1;
}

/** `combined` plus each window kind, in the order the report prints them. */
export type SinceDeathScope = "combined" | BacktestWindowKind;

export const SINCE_DEATH_SCOPES: readonly SinceDeathScope[] = [
	"combined",
	"five_hour",
	"seven_day",
];

export interface SinceDeathGroup {
	scope: SinceDeathScope;
	/** One cohort per {@link SINCE_DEATH_BUCKETS} entry, same order. */
	buckets: CohortScores[];
}

const inScope = (
	record: RedistributionRecord,
	scope: SinceDeathScope,
): boolean => scope === "combined" || record.windowKind === scope;

export interface CohortSet {
	overall: CohortScores;
	anyTransition: CohortScores;
	byTag: CohortScores[];
	peerExhaustionBySinceDeath: SinceDeathGroup[];
	/** How the survivor's own slope moves after a death — see {@link survivorSlopeTrajectory}. */
	slopeTrajectory: SlopeRatioRow[];
	/** Instant-to-instant instability of each model — see {@link churnRows}. */
	churn: ChurnRow[];
	byClassAndKind: CohortScores[];
	scenarioExtra: CohortScores;
	bootstrap: RedistributionBootstrapEntry[];
	/** Records common to EVERY model in {@link REPLAY_MODELS}, after `commonCohort`. */
	common: RedistributionRecord[];
}

/**
 * Block-bootstrap the scenario-minus-current delta.
 *
 * `bootstrapDelta` resamples by `accountId`, which is the right block for the
 * per-window harness and the wrong one here: an overall cohort's correlated
 * unit is the WINDOW LIFECYCLE (every instant inside one window shares one
 * outcome), and a transition cohort's is the EPISODE (every instant inside one
 * event's shadow shares one cause). So the records are cloned with the block id
 * in `accountId` before the call — a relabelling, never a mutation of the
 * scored records.
 */
function blockBootstrap(
	label: string,
	model: ScenarioModel,
	scenario: readonly RedistributionRecord[],
	baselineRecords: readonly RedistributionRecord[],
	blockOf: (record: RedistributionRecord) => string,
	seed: number,
	iterations: number,
	baseline: RedistributionBootstrapEntry["baseline"],
): RedistributionBootstrapEntry[] {
	const clone = (records: readonly RedistributionRecord[]): BacktestRecord[] =>
		records.map((record) => ({ ...record, accountId: blockOf(record) }));
	const statistics = [
		"f1",
		"medianAbsErrorMinutes",
		"medianSignedErrorMinutes",
	] as const;
	return statistics.map((statistic) => {
		const ci = bootstrapDelta(clone(scenario), clone(baselineRecords), {
			iterations,
			seed,
			statistic,
		});
		return {
			label,
			scenario: model,
			baseline,
			statistic,
			p2_5: ci.p2_5,
			p50: ci.p50,
			p97_5: ci.p97_5,
			samples: ci.samples,
		};
	});
}

/**
 * A bootstrap CI of `scenario - baseline`, where `scenario` is the verdict
 * basis or a share rule scored beside it, and the baseline is the model that
 * ships or that scenario's own pre-correction control.
 *
 * Both the scenario and the baseline are FIELDS rather than part of the label,
 * so a lookup cannot resolve the wrong entry by prefix: criterion C is defined
 * against the current model, and the same cohort label carries the
 * control-baseline CI and the prior basis's CIs too.
 */
export interface RedistributionBootstrapEntry extends ReportBootstrapEntry {
	scenario: ScenarioModel;
	baseline: ReplayModel;
}

/** Cohort labels of the bootstrap table, shared by the producer and the lookup. */
export const OVERALL_BOOTSTRAP_LABEL = "Overall (block = window lifecycle)";
export const TRANSITION_BOOTSTRAP_LABEL = "Any transition (block = episode)";

export const BOOTSTRAP_ITERATIONS = 1000;

/** Every cohort the report scores, from one replay. */
export function scoreCohorts(result: ReplayResult): CohortSet {
	const byModel = new Map<string, readonly BacktestRecord[]>();
	for (const model of REPLAY_MODELS) {
		byModel.set(
			model,
			result.records.filter((record) => record.model === model),
		);
	}
	const common = commonCohort(byModel);
	const kept = new Set<string>();
	for (const record of common.get("current") ?? []) {
		kept.add(recordKey(record as RedistributionRecord));
	}
	const commonRecords = result.records.filter((record) =>
		kept.has(recordKey(record)),
	);

	const overall = scoreCohort("Overall", commonRecords);
	const transitionRecords = commonRecords.filter(
		(record) => record.tags.length > 0,
	);
	const anyTransition = scoreCohort("Any transition", transitionRecords);
	const byTag = TRANSITION_KINDS.map((tag) =>
		scoreCohort(
			tag,
			commonRecords.filter((record) => record.tags.includes(tag)),
		),
	);
	const peerRecords = commonRecords.filter(
		(record) =>
			record.tags.includes("peer-exhaustion") && record.sinceDeathMs != null,
	);
	const peerExhaustionBySinceDeath: SinceDeathGroup[] = SINCE_DEATH_SCOPES.map(
		(scope) => {
			const scoped = peerRecords.filter((record) => inScope(record, scope));
			return {
				scope,
				buckets: SINCE_DEATH_BUCKETS.map((bucket, index) =>
					scoreCohort(
						bucket.label,
						scoped.filter(
							(record) => sinceDeathBucketIndex(record.sinceDeathMs) === index,
						),
					),
				),
			};
		},
	);
	// Deliberately the RAW peer-exhaustion records, not `peerRecords`: the
	// slope is the survivor's own measured burn, and whether every model
	// happens to be comparable at an instant — or whether the window's fate was
	// ever observed — says nothing about it. Filtering first would move the
	// baseline off the earliest post-death reading the replay actually has.
	const rawPeerRecords = result.records.filter(
		(record) =>
			record.tags.includes("peer-exhaustion") && record.sinceDeathMs != null,
	);
	const slopeTrajectory = survivorSlopeTrajectory(rawPeerRecords, "current");

	const classKinds = new Set<string>();
	for (const record of commonRecords) {
		classKinds.add(
			`${servableClassFor(record.provider ?? "unknown").classId}/${record.windowKind}`,
		);
	}
	const byClassAndKind = [...classKinds].sort().map((key) =>
		scoreCohort(
			key,
			commonRecords.filter(
				(record) =>
					`${servableClassFor(record.provider ?? "unknown").classId}/${record.windowKind}` ===
					key,
			),
		),
	);

	// The accounts the CURRENT model withholds as learning, where a scenario can
	// nonetheless answer — records the common cohort must exclude by
	// construction, and the reason the scenario exists.
	const scenarioKeys = new Set<string>();
	const learningKeys = new Set<string>();
	for (const record of result.records) {
		if (record.model === "current" && record.learningAtT) {
			learningKeys.add(recordKey(record));
		}
	}
	for (const record of result.records) {
		if (record.model === "current") continue;
		if (!record.usable || record.outcome.kind === "censored") continue;
		if (!learningKeys.has(recordKey(record))) continue;
		scenarioKeys.add(recordKey(record));
	}
	const scenarioExtra = scoreCohort(
		"Scenario-only",
		result.records.filter((record) => scenarioKeys.has(recordKey(record))),
	);

	const overallBalanced = lifecycleBalanced(commonRecords);
	const transitionBalanced = lifecycleBalanced(transitionRecords);
	const ofModel = (
		records: readonly RedistributionRecord[],
		model: ReplayModel,
	): RedistributionRecord[] =>
		records.filter((record) => record.model === model);
	const lifecycleBlock = (record: RedistributionRecord): string =>
		record.lifecycleId;
	const episodeBlock = (record: RedistributionRecord): string =>
		record.eventIds.length > 0
			? String(Math.min(...record.eventIds))
			: record.lifecycleId;
	// One pair set per model whose criteria the report states: the verdict basis
	// and the PRIOR basis, each against the current model (criterion C is defined
	// on that delta) and against its OWN pre-correction control. The prior
	// basis's pairs are also the ones the observation-lag mechanism check's
	// subject is built on. The headroom rule carries no pair and no control, so
	// its C and D are indeterminate and the section beside the basis says so
	// rather than borrowing another rule's baseline.
	const bootstrap: RedistributionBootstrapEntry[] = [];
	for (const model of [VERDICT_BASIS_MODEL, PRIOR_BASIS_MODEL]) {
		const control = CONTROL_MODELS[model];
		const baselines: ReplayModel[] =
			control == null ? ["current"] : ["current", control];
		for (const baseline of baselines) {
			bootstrap.push(
				...blockBootstrap(
					OVERALL_BOOTSTRAP_LABEL,
					model,
					ofModel(overallBalanced, model),
					ofModel(overallBalanced, baseline),
					lifecycleBlock,
					result.seed,
					BOOTSTRAP_ITERATIONS,
					baseline,
				),
				...blockBootstrap(
					TRANSITION_BOOTSTRAP_LABEL,
					model,
					ofModel(transitionBalanced, model),
					ofModel(transitionBalanced, baseline),
					episodeBlock,
					result.seed,
					BOOTSTRAP_ITERATIONS,
					baseline,
				),
			);
		}
	}

	// Also the raw records. Churn is a within-model statistic: one model
	// abstaining, or a censored outcome, removes nothing that is needed to see
	// whether ANOTHER model's answer moved between two instants. `churnRows`
	// applies each model's own usability; the tag filter is applied here, on
	// the same raw records, so the transition cohort loses no valid pair
	// either.
	const churn = [
		...churnRows("Overall", result.records, result.stepMinutes),
		...churnRows(
			"Any transition",
			result.records.filter((record) => record.tags.length > 0),
			result.stepMinutes,
		),
	];

	return {
		overall,
		anyTransition,
		byTag,
		peerExhaustionBySinceDeath,
		slopeTrajectory,
		churn,
		byClassAndKind,
		scenarioExtra,
		bootstrap,
		common: commonRecords,
	};
}

// ---------------------------------------------------------------------------
// Survivor slope trajectory
// ---------------------------------------------------------------------------

export interface SlopeRatioCell {
	/** Lifecycles (one per window lifecycle × death) contributing to this cell. */
	lifecycles: number;
	/** Median over lifecycles of that lifecycle's median slope ratio. */
	medianRatio: number | null;
	/** Median over lifecycles of that lifecycle's median absolute slope. */
	medianSlopePctPerHour: number | null;
}

export interface SlopeRatioRow {
	/** A {@link SINCE_DEATH_BUCKETS} label. */
	label: string;
	cells: Record<SinceDeathScope, SlopeRatioCell>;
}

const emptyCell = (): SlopeRatioCell => ({
	lifecycles: 0,
	medianRatio: null,
	medianSlopePctPerHour: null,
});

/**
 * How fast a survivor's OWN fitted slope absorbs the traffic a dead peer left.
 *
 * For each (window lifecycle × death), the first instant after that death is
 * the baseline; every later instant in the same lifecycle is expressed as
 * `slope(t) / slope(t_death+)`.
 *
 * Lifecycle-balanced twice over, like every other number in the report: the
 * median is taken WITHIN a lifecycle-bucket first and only then ACROSS
 * lifecycles, so a lifecycle that happens to be sampled more often does not
 * outvote one that is not.
 *
 * The baseline is the EARLIEST post-death instant that has a fitted slope at
 * all, not the literal first instant: a survivor is very often still learning
 * when its peer dies, and requiring a slope there would discard exactly the
 * lifecycles this table exists to describe. An instant before the death is
 * never the baseline. Instants with no slope contribute to no bucket. A
 * baseline that is zero or negative is dropped outright — 9/0 is not a ratio,
 * and imputing one would invent the absorption being measured. Both facts are
 * stated in the report beside the table.
 *
 * `records` is the RAW peer-exhaustion set, not a comparability-filtered one:
 * the slope is a property of the (account, window, T) reading, so every model's
 * record at an instant carries the same number and reading ONE model's rows is
 * both the dedup per (lifecycle, instant) and the whole selection. Restricting
 * to instants where all models are comparable would silently move the
 * baseline.
 *
 * Grouped per DEATH, not merely per lifecycle: a weekly window can outlive two
 * peer deaths, and `sinceDeathMs` is measured from the most recent one, so the
 * baseline has to be re-taken at each.
 */
export function survivorSlopeTrajectory(
	records: readonly RedistributionRecord[],
	model: ReplayModel = "current",
): SlopeRatioRow[] {
	const groups = new Map<string, RedistributionRecord[]>();
	for (const record of records) {
		if (record.model !== model) continue;
		if (!record.tags.includes("peer-exhaustion")) continue;
		if (record.sinceDeathMs == null) continue;
		if (record.sinceDeathMs < 0) continue;
		if (record.slopePctPerHour == null) continue;
		const deathAtMs = record.T - record.sinceDeathMs;
		const key = `${record.lifecycleId}::${deathAtMs}`;
		const list = groups.get(key);
		if (list) list.push(record);
		else groups.set(key, [record]);
	}

	// `${scope}::${bucket}` -> one sample per group: the group's OWN median in
	// that bucket. Collapsing within a group before collecting is what makes the
	// outer median a median across lifecycles rather than across instants.
	const ratios = new Map<string, number[]>();
	const slopes = new Map<string, number[]>();
	const cellKey = (scope: SinceDeathScope, index: number) =>
		`${scope}::${index}`;
	for (const scope of SINCE_DEATH_SCOPES) {
		for (let i = 0; i < SINCE_DEATH_BUCKETS.length; i++) {
			ratios.set(cellKey(scope, i), []);
			slopes.set(cellKey(scope, i), []);
		}
	}

	for (const group of groups.values()) {
		const sorted = [...group].sort(
			(a, b) => (a.sinceDeathMs ?? 0) - (b.sinceDeathMs ?? 0),
		);
		const baseline = sorted[0]?.slopePctPerHour ?? null;
		if (baseline == null || baseline <= 0) continue;
		const perBucketRatio = new Map<number, number[]>();
		const perBucketSlope = new Map<number, number[]>();
		for (const record of sorted) {
			const slope = record.slopePctPerHour;
			if (slope == null) continue;
			const index = sinceDeathBucketIndex(record.sinceDeathMs);
			if (index < 0) continue;
			const ratioList = perBucketRatio.get(index) ?? [];
			ratioList.push(slope / baseline);
			perBucketRatio.set(index, ratioList);
			const slopeList = perBucketSlope.get(index) ?? [];
			slopeList.push(slope);
			perBucketSlope.set(index, slopeList);
		}
		// A group is window-kind-pure (a lifecycle id names one window), so it
		// contributes to `combined` and to exactly one kind.
		const kind = sorted[0].windowKind;
		for (const scope of SINCE_DEATH_SCOPES) {
			if (scope !== "combined" && scope !== kind) continue;
			for (const [index, values] of perBucketRatio) {
				const cell = ratios.get(cellKey(scope, index));
				const median = medianOf(values);
				if (cell && median != null) cell.push(median);
			}
			for (const [index, values] of perBucketSlope) {
				const cell = slopes.get(cellKey(scope, index));
				const median = medianOf(values);
				if (cell && median != null) cell.push(median);
			}
		}
	}

	return SINCE_DEATH_BUCKETS.map((bucket, index) => {
		const cells = {} as Record<SinceDeathScope, SlopeRatioCell>;
		for (const scope of SINCE_DEATH_SCOPES) {
			const ratioSamples = ratios.get(cellKey(scope, index)) ?? [];
			const slopeSamples = slopes.get(cellKey(scope, index)) ?? [];
			cells[scope] =
				ratioSamples.length === 0
					? emptyCell()
					: {
							lifecycles: ratioSamples.length,
							medianRatio: medianOf(ratioSamples),
							medianSlopePctPerHour: medianOf(slopeSamples),
						};
		}
		return { label: bucket.label, cells };
	});
}

// ---------------------------------------------------------------------------
// Prediction churn
// ---------------------------------------------------------------------------

export interface ChurnRow {
	cohort: string;
	model: ReplayModel;
	/** Lifecycles that produced at least one consecutive usable pair. */
	lifecycles: number;
	/** Consecutive usable pairs behind the flip rate. */
	pairs: number;
	/** Median over lifecycles of that lifecycle's median |ΔETA|, in minutes. */
	medianEtaChangeMinutes: number | null;
	/** Median over lifecycles of that lifecycle's p90 |ΔETA|, in minutes. */
	p90EtaChangeMinutes: number | null;
	/** Median over lifecycles of that lifecycle's yes/no flip rate. */
	medianFlipRate: number | null;
}

/**
 * How much a model's answer MOVES between one instant and the next.
 *
 * Accuracy says nothing about stability, and an operator reads the runway on a
 * dashboard that refreshes: an estimator that oscillates between "out in 40
 * minutes" and "not this cycle" every ten minutes is unusable at any F1. Two
 * numbers, both over consecutive usable instants of one window lifecycle:
 * `|ETA(t+1) − ETA(t)|` where both instants committed to a date, and the
 * fraction of consecutive pairs where the yes/no verdict changes.
 *
 * NOT expressed as a {@link BacktestStatistic}. That vocabulary is consumed by
 * `statisticOf`, which is a function of an unordered BAG of `BacktestRecord`;
 * churn is a function of an ORDERED sequence within a lifecycle, and
 * `BacktestRecord` carries no lifecycle id to group by. Adding it there would
 * mean teaching the shared per-window harness a grouping key it does not have,
 * for one caller. `bootstrapDelta` is likewise the wrong shape here.
 *
 * Two records are a pair only when they are EXACTLY one grid step apart and
 * both usable for this model. Nothing bridges a hole: an instant the sampler
 * skipped, or one this model could not answer, is not the estimator changing
 * its mind, and counting the jump across it would read as instability that
 * never happened. Usability is this model's own — another model abstaining, or
 * an outcome nobody observed, does not make this model's two consecutive
 * answers unmeasurable, so the caller passes the raw replay records.
 */
export function churnRows(
	cohort: string,
	records: readonly RedistributionRecord[],
	stepMinutes: number,
): ChurnRow[] {
	const stepMs = stepMinutes * MINUTE_MS;
	return REPLAY_MODELS.map((model) => {
		const byLifecycle = new Map<string, RedistributionRecord[]>();
		for (const record of records) {
			if (record.model !== model) continue;
			if (!record.usable) continue;
			const list = byLifecycle.get(record.lifecycleId);
			if (list) list.push(record);
			else byLifecycle.set(record.lifecycleId, [record]);
		}
		const perLifecycleMedian: number[] = [];
		const perLifecycleP90: number[] = [];
		const perLifecycleFlip: number[] = [];
		let lifecycles = 0;
		let pairs = 0;
		for (const list of byLifecycle.values()) {
			const sorted = [...list].sort((a, b) => a.T - b.T);
			const deltas: number[] = [];
			let localPairs = 0;
			let flips = 0;
			for (let i = 1; i < sorted.length; i++) {
				const previous = sorted[i - 1];
				const current = sorted[i];
				if (current.T - previous.T !== stepMs) continue;
				localPairs++;
				if (previous.predictsExhaust !== current.predictsExhaust) flips++;
				if (previous.predictedEtaMs != null && current.predictedEtaMs != null) {
					deltas.push(
						Math.abs(current.predictedEtaMs - previous.predictedEtaMs) /
							MINUTE_MS,
					);
				}
			}
			if (localPairs === 0) continue;
			lifecycles++;
			pairs += localPairs;
			perLifecycleFlip.push(flips / localPairs);
			const median = medianOf(deltas);
			if (median != null) perLifecycleMedian.push(median);
			const p90 = percentileOf(deltas, 0.9);
			if (p90 != null) perLifecycleP90.push(p90);
		}
		return {
			cohort,
			model,
			lifecycles,
			pairs,
			medianEtaChangeMinutes: medianOf(perLifecycleMedian),
			p90EtaChangeMinutes: medianOf(perLifecycleP90),
			medianFlipRate: medianOf(perLifecycleFlip),
		};
	});
}

// ---------------------------------------------------------------------------
// Observation-lag mechanism check
// ---------------------------------------------------------------------------

export interface ObservationAgeBucketSpec {
	label: string;
	/** Exclusive upper bound of the bucket, in ms of observation age. */
	maxMs: number;
}

/**
 * How old the reading behind a record was, half-open and contiguous.
 *
 * The first bucket is negative ages: a reading stamped ahead of the instant
 * replaying it is a clock artefact, and folding it into `0-2 min` would hide
 * it. The last is open at the top rather than closed, so no record can fall
 * out of the table; the projection freshness bar is
 * {@link READING_STALE_MS} = 10 min, measured on the SAMPLE time, so an
 * observation age above it is possible whenever the two instants differ.
 */
export const OBSERVATION_AGE_BUCKETS: readonly ObservationAgeBucketSpec[] = [
	{ label: "future (< 0)", maxMs: 0 },
	{ label: "0-2 min", maxMs: 2 * MINUTE_MS },
	{ label: "2-5 min", maxMs: 5 * MINUTE_MS },
	{ label: "5-10 min", maxMs: 10 * MINUTE_MS },
	{ label: ">= 10 min", maxMs: Number.POSITIVE_INFINITY },
];

/** The cohort a record with no observation instant lands in. */
export const UNKNOWN_OBSERVATION_AGE_LABEL = "unknown (null)";

/** Which age bucket an observation age falls in; `-1` when there is none. */
export function observationAgeBucketIndex(ageMs: number | null): number {
	if (ageMs == null || !Number.isFinite(ageMs)) return -1;
	for (let i = 0; i < OBSERVATION_AGE_BUCKETS.length; i++) {
		if (ageMs < OBSERVATION_AGE_BUCKETS[i].maxMs) return i;
	}
	return OBSERVATION_AGE_BUCKETS.length - 1;
}

export interface ObservationAgeGroup {
	scope: SinceDeathScope;
	/** One cohort per {@link OBSERVATION_AGE_BUCKETS} entry, same order. */
	buckets: CohortScores[];
	/** Records whose row carried no observation instant. */
	unknown: CohortScores;
	/**
	 * Records of ONE model in this scope — the denominator the buckets plus the
	 * unknown cohort reconcile to.
	 */
	eligible: number;
}

export interface LagIdentityCheck {
	/** Records whose class-instant carries no pooled lag at all. */
	eligible: number;
	/** Of those, how many the two equal-split models answered differently. */
	differing: number;
	/** Span of the replay the eligible records come from; null when there are none. */
	fromMs: number | null;
	toMs: number | null;
}

/** How far apart two instants may sit and still count as the same answer. */
export const LAG_TOLERANCE_MS = 1000;

export interface LagShiftStats {
	n: number;
	/** Median of `original ETA - corrected ETA`, in minutes. */
	medianShiftMinutes: number | null;
	/** Median of `shift - the record's own lag`, in minutes. */
	medianExcessMinutes: number | null;
	p10ExcessMinutes: number | null;
	p90ExcessMinutes: number | null;
	/** Share of records whose shift is within {@link LAG_TOLERANCE_MS} of their own lag. */
	matchingShare: number | null;
}

export interface LagParityRow {
	/** An estimator source, or `other` for every path that carries no anchor lag. */
	path: string;
	n: number;
	/** Share within {@link LAG_TOLERANCE_MS} of the current model's ETA. */
	withinToleranceShare: number | null;
}

export interface PairedEtaSubsetRow {
	cohort: string;
	model: ReplayModel;
	n: number;
	medianSignedErrorMinutes: number | null;
}

export interface LagPopulationRow {
	path: string;
	records: number;
	/**
	 * Records of this path whose lag anchor could not be derived — see
	 * {@link RedistributionRecord.lagAnchorKnown}. Counted apart, and excluded
	 * from this row's median and p90: their `0` is an absence, not a
	 * measurement.
	 */
	noAnchorRecords: number;
	medianLagMinutes: number | null;
	p90LagMinutes: number | null;
	/** `sampled_at - observed_at`, where the record carries both. */
	medianSampleToObservationMinutes: number | null;
	p90SampleToObservationMinutes: number | null;
	sampleToObservationRecords: number;
}

/**
 * Everything the report says about the observation-lag correction ITSELF,
 * beside what the scores say about its effect.
 *
 * Every check states its own denominator, and an empty eligible set is
 * reported as "no eligible records" rather than as a pass: a mechanism check
 * that silently has nothing to check is worse than one that fails.
 */
export interface ObservationLagChecks {
	ageGroups: ObservationAgeGroup[];
	identity: LagIdentityCheck;
	shift: { firstEvent: LagShiftStats; rest: LagShiftStats };
	parity: LagParityRow[];
	pairedEta: PairedEtaSubsetRow[];
	population: LagPopulationRow[];
}

const shiftStatsOf = (
	rows: ReadonlyArray<{ shiftMs: number; lagMs: number }>,
): LagShiftStats => {
	const shifts = rows.map((row) => row.shiftMs / MINUTE_MS);
	const excess = rows.map((row) => (row.shiftMs - row.lagMs) / MINUTE_MS);
	return {
		n: rows.length,
		medianShiftMinutes: medianOf(shifts),
		medianExcessMinutes: medianOf(excess),
		p10ExcessMinutes: percentileOf(excess, 0.1),
		p90ExcessMinutes: percentileOf(excess, 0.9),
		matchingShare:
			rows.length === 0
				? null
				: rows.filter(
						(row) => Math.abs(row.shiftMs - row.lagMs) <= LAG_TOLERANCE_MS,
					).length / rows.length,
	};
};

/** The estimator paths whose ETA is anchored behind `now` — see `observationLagMs`. */
const ANCHORED_PATHS: readonly string[] = ["regression", "lifetime-primary"];

/** One record per model per (account, window, instant), keyed for pairing. */
function recordsByKey(
	records: readonly RedistributionRecord[],
): Map<string, Map<ReplayModel, RedistributionRecord>> {
	const byKey = new Map<string, Map<ReplayModel, RedistributionRecord>>();
	for (const record of records) {
		const key = recordKey(record);
		let entry = byKey.get(key);
		if (!entry) {
			entry = new Map();
			byKey.set(key, entry);
		}
		entry.set(record.model, record);
	}
	return byKey;
}

/**
 * Compute every observation-lag check the report prints.
 *
 * Every pair below names `scenario-equal` and `scenario-equal-original`
 * LITERALLY rather than through the basis constants, and that is the point: the
 * subject of this section is the lag correction as it was measured on the equal
 * split, which was the verdict basis when the correction shipped. Re-pointing
 * these reads at whatever the basis happens to be would change what the section
 * measures without saying so.
 *
 * What the two share rules DO have in common is the lag duration and the
 * per-path anchor it is derived from, both properties of the reading. The
 * advance is not one of them: the scan assigns each window a share-dependent
 * slope and only then advances the reading by that slope over the lag, so its
 * size, which windows it drives to 100 % inside their own lag, and therefore
 * which records are eligible for the checks below can all differ between the
 * rules. Nothing computed here is a measurement of the proportional basis's own
 * scan.
 */
export function observationLagChecks(
	replay: ReplayResult,
	cohorts: CohortSet,
): ObservationLagChecks {
	// (a) Age cohorts, over the SCORED records — the same common cohort every
	// other score table is built on.
	const ageGroups: ObservationAgeGroup[] = SINCE_DEATH_SCOPES.map((scope) => {
		const scoped = cohorts.common.filter((record) => inScope(record, scope));
		return {
			scope,
			buckets: OBSERVATION_AGE_BUCKETS.map((bucket, index) =>
				scoreCohort(
					bucket.label,
					scoped.filter(
						(record) =>
							observationAgeBucketIndex(record.observationAgeMs) === index,
					),
				),
			),
			unknown: scoreCohort(
				UNKNOWN_OBSERVATION_AGE_LABEL,
				scoped.filter(
					(record) => observationAgeBucketIndex(record.observationAgeMs) === -1,
				),
			),
			eligible: scoped.filter((record) => record.model === "current").length,
		};
	});

	const byKey = recordsByKey(replay.records);

	// (b) Identity where the whole class-instant is lag-free.
	let eligible = 0;
	let differing = 0;
	let fromMs: number | null = null;
	let toMs: number | null = null;
	for (const entry of byKey.values()) {
		const corrected = entry.get("scenario-equal");
		const original = entry.get("scenario-equal-original");
		if (corrected == null || original == null) continue;
		if (!corrected.classLagFree) continue;
		eligible++;
		fromMs = fromMs == null ? corrected.T : Math.min(fromMs, corrected.T);
		toMs = toMs == null ? corrected.T : Math.max(toMs, corrected.T);
		if (
			corrected.predictsExhaust !== original.predictsExhaust ||
			corrected.predictedEtaMs !== original.predictedEtaMs
		) {
			differing++;
		}
	}

	// (c) How far the correction moved each ETA, split on whether ONE slope
	// governs the whole projection in BOTH scans.
	const firstEventShifts: Array<{ shiftMs: number; lagMs: number }> = [];
	const restShifts: Array<{ shiftMs: number; lagMs: number }> = [];
	for (const entry of byKey.values()) {
		const corrected = entry.get("scenario-equal");
		const original = entry.get("scenario-equal-original");
		if (corrected == null || original == null) continue;
		if (corrected.predictedEtaMs == null || original.predictedEtaMs == null) {
			continue;
		}
		if (corrected.lagMs > 0) {
			const row = {
				shiftMs: original.predictedEtaMs - corrected.predictedEtaMs,
				lagMs: corrected.lagMs,
			};
			(corrected.exactShiftEligible ? firstEventShifts : restShifts).push(row);
		}
	}

	// (c2) Parity with the current model where the account is alone in its
	// class. Its own pass, over the corrected and current records ONLY: the
	// original model's ETA is no part of this comparison, and requiring it
	// would drop exactly the records the correction moved from beyond the reset
	// to inside it — the ones where the two models most need to agree.
	//
	// A record whose class lost a window inside its lag is excluded: the
	// correction killed that window AT the instant, so the projection carries a
	// dead span the current model does not model, and parity is not the
	// expectation there.
	const parityByPath = new Map<string, { n: number; within: number }>();
	for (const path of [...ANCHORED_PATHS, "other"]) {
		parityByPath.set(path, { n: 0, within: 0 });
	}
	for (const entry of byKey.values()) {
		const corrected = entry.get("scenario-equal");
		const current = entry.get("current");
		if (corrected == null || current == null) continue;
		if (corrected.predictedEtaMs == null || current.predictedEtaMs == null) {
			continue;
		}
		if (!corrected.firstEvent || corrected.pooledInClass !== 1) continue;
		if (corrected.peerDiedInLag) continue;
		const path = ANCHORED_PATHS.includes(corrected.estimatorSource)
			? corrected.estimatorSource
			: "other";
		const tally = parityByPath.get(path);
		if (tally != null) {
			tally.n++;
			if (
				Math.abs(corrected.predictedEtaMs - current.predictedEtaMs) <=
				LAG_TOLERANCE_MS
			) {
				tally.within++;
			}
		}
	}
	const parity: LagParityRow[] = [...parityByPath.entries()].map(
		([path, tally]) => ({
			path,
			n: tally.n,
			withinToleranceShare: tally.n === 0 ? null : tally.within / tally.n,
		}),
	);

	// (d) The FIXED subset: the same records for every model, so the three
	// medians are comparable without any coverage difference behind them.
	const pairedEta: PairedEtaSubsetRow[] = [];
	// The three models the subset is DEFINED by, and the only ones it reports:
	// a model that did not have to be dated for a record to enter would be
	// medianed over a different set of records than the others.
	const subsetModels: readonly ReplayModel[] = [
		"current",
		"scenario-equal",
		"scenario-equal-original",
	];
	for (const [label, records] of [
		["Overall", cohorts.common],
		[
			"Any transition",
			cohorts.common.filter((record) => record.tags.length > 0),
		],
	] as const) {
		const balanced = recordsByKey(lifecycleBalanced(records));
		const errorsByModel = new Map<ReplayModel, number[]>();
		for (const model of subsetModels) errorsByModel.set(model, []);
		let n = 0;
		for (const entry of balanced.values()) {
			const anchorRecord = entry.get("current");
			if (anchorRecord == null || anchorRecord.outcome.kind !== "exhausted") {
				continue;
			}
			const dated = subsetModels.every(
				(model) => entry.get(model)?.predictedEtaMs != null,
			);
			if (!dated) continue;
			n++;
			const observedAtMs = anchorRecord.outcome.atMs;
			for (const model of subsetModels) {
				const eta = entry.get(model)?.predictedEtaMs;
				if (eta == null) continue;
				errorsByModel.get(model)?.push((eta - observedAtMs) / MINUTE_MS);
			}
		}
		for (const model of subsetModels) {
			pairedEta.push({
				cohort: label,
				model,
				n,
				medianSignedErrorMinutes: medianOf(errorsByModel.get(model) ?? []),
			});
		}
	}

	// (e) Which estimator paths the correction touched, and by how much. One
	// model's records only: the lag is a property of the reading.
	const byPath = new Map<
		string,
		{
			records: number;
			noAnchor: number;
			lags: number[];
			sampleToObservation: number[];
		}
	>();
	for (const record of replay.records) {
		if (record.model !== "current") continue;
		const entry = byPath.get(record.estimatorSource) ?? {
			records: 0,
			noAnchor: 0,
			lags: [],
			sampleToObservation: [],
		};
		entry.records++;
		// A record whose anchor could not be derived carries `0` because nothing
		// was derivable, so it is counted and never medianed.
		if (record.lagAnchorKnown) entry.lags.push(record.lagMs / MINUTE_MS);
		else entry.noAnchor++;
		if (record.observationAgeMs != null) {
			entry.sampleToObservation.push(
				(record.observationAgeMs - record.sampleAgeMs) / MINUTE_MS,
			);
		}
		byPath.set(record.estimatorSource, entry);
	}
	const population: LagPopulationRow[] = [...byPath.entries()]
		.map(([path, entry]) => ({
			path,
			records: entry.records,
			noAnchorRecords: entry.noAnchor,
			medianLagMinutes: medianOf(entry.lags),
			p90LagMinutes: percentileOf(entry.lags, 0.9),
			medianSampleToObservationMinutes: medianOf(entry.sampleToObservation),
			p90SampleToObservationMinutes: percentileOf(
				entry.sampleToObservation,
				0.9,
			),
			sampleToObservationRecords: entry.sampleToObservation.length,
		}))
		.sort((a, b) => a.path.localeCompare(b.path));

	return {
		ageGroups,
		identity: { eligible, differing, fromMs, toMs },
		shift: {
			firstEvent: shiftStatsOf(firstEventShifts),
			rest: shiftStatsOf(restShifts),
		},
		parity,
		pairedEta,
		population,
	};
}

// ---------------------------------------------------------------------------
// Per-record dump
// ---------------------------------------------------------------------------

/**
 * One replay record as a flat JSON object, instants rendered as ISO strings
 * beside their raw epoch milliseconds.
 *
 * Exists so a follow-up analysis of a multi-minute replay does not have to
 * re-run it. Flat rather than nested because the consumer is a JSONL reader
 * (`jq`, a dataframe), and both forms of every instant because the ISO string
 * is what a human reads and the epoch is what arithmetic needs.
 */
export function redistributionRecordToJson(
	record: RedistributionRecord,
): Record<string, unknown> {
	const isoOrNull = (ms: number | null | undefined): string | null =>
		ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
	const outcome = record.outcome;
	const outcomeAtMs = outcome.kind === "exhausted" ? outcome.atMs : null;
	return {
		tMs: record.T,
		tIso: new Date(record.T).toISOString(),
		model: record.model,
		lifecycleId: record.lifecycleId,
		accountId: record.accountId,
		provider: record.provider,
		windowKind: record.windowKind,
		windowMs: record.windowMs,
		tags: record.tags,
		eventIds: record.eventIds,
		learningAtT: record.learningAtT,
		sinceDeathMs: record.sinceDeathMs,
		sinceDeathMinutes:
			record.sinceDeathMs == null ? null : record.sinceDeathMs / MINUTE_MS,
		slopePctPerHour: record.slopePctPerHour,
		observationAgeMs: record.observationAgeMs,
		observationAgeMinutes:
			record.observationAgeMs == null
				? null
				: record.observationAgeMs / MINUTE_MS,
		sampleAgeMs: record.sampleAgeMs,
		sampleAgeMinutes: record.sampleAgeMs / MINUTE_MS,
		lagMs: record.lagMs,
		lagMinutes: record.lagMs / MINUTE_MS,
		estimatorSource: record.estimatorSource,
		classLagFree: record.classLagFree,
		pooledInClass: record.pooledInClass,
		firstEvent: record.firstEvent,
		peerDiedInLag: record.peerDiedInLag,
		exactShiftEligible: record.exactShiftEligible,
		// The KEY is frozen at the name the previous release emitted, whatever the
		// field is called internally: every exported record would otherwise differ
		// from an earlier artifact by this one key, and a run-to-run comparison
		// would read as a change in the data rather than a rename.
		proportionalFirstAssignment: record.basisFirstAssignment,
		lagAnchorKnown: record.lagAnchorKnown,
		usable: record.usable,
		unusableReason: record.unusableReason,
		predictsExhaust: record.predictsExhaust,
		predictedEtaMs: record.predictedEtaMs,
		predictedEtaIso: isoOrNull(record.predictedEtaMs),
		outcomeKind: outcome.kind,
		outcomeAtMs,
		outcomeAtIso: isoOrNull(outcomeAtMs),
		knownResetAtMs: record.knownResetAtMs,
		knownResetIso: isoOrNull(record.knownResetAtMs),
		labelResetAtMs: record.labelResetAtMs,
		labelResetIso: isoOrNull(record.labelResetAtMs),
	};
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** The rule, printed verbatim in the report and evaluated by `evaluateVerdict`. */
export const VERDICT_RULE = [
	"MODELS. `scenario-proportional` is the demand-conserving scan that splits",
	"   each class's demand across the accounts alive at an instant in",
	"   proportion to their own measured burn, and ADVANCES each reading over",
	"   its observation lag; `scenario-proportional-original` is the same",
	"   proportional rule with the pre-correction scan, which schedules every",
	"   window from the instant of the replay however old its reading is. Both",
	"   are scored on the COMMON cohort: every model usable, truth observed.",
	"",
	"A. NOT MORE OPTIMISTIC ON TRANSITIONS. On the any-transition cohort,",
	"   lifecycle-balanced: max(paired median signed error of scenario-",
	"   proportional, 0) <= max(paired median signed error of current, 0), AND",
	"   recall of scenario-proportional >= recall of current. (Positive signed",
	"   error = predicted later than observed = optimistic; a model that is",
	"   EARLY is not rewarded for it, which is why both sides are clamped at 0.)",
	"B. BETTER AT TRANSITIONS. On the same cohort, F1 of scenario-proportional",
	"   >= F1 of current.",
	"C. NO SIGNIFICANT OVERALL LOSS. On the overall cohort, the block-bootstrap",
	"   95% CI of F1(scenario-proportional) - F1(current) is not entirely below",
	"   zero (p97.5 >= 0). Read from the entry whose BASELINE is the current",
	"   model.",
	"D. NOT WORSE THAN THE ORIGINAL SCENARIO. On the any-transition common",
	"   cohort, lifecycle-balanced: F1(scenario-proportional) >= F1(scenario-",
	"   proportional-original), AND the paired median of |error of scenario-",
	"   proportional| - |error of scenario-proportional-original| <= 0 over the",
	"   records both models dated. Recall of both is printed beside D and is NOT",
	"   judged: the correction can change the ORDER of a class's events, and",
	"   with it which windows are dated before their reset at all, in EITHER",
	"   direction.",
	"",
	"replace = A and B and C and D. keep-scenario = any criterion FALSE.",
	"insufficient-evidence = no criterion false, at least one indeterminate.",
	"The verdict basis is the PROPORTIONAL share rule, re-declared on 2026-09-07",
	"after it was scored as a candidate beside the equal split, which had been",
	"the basis through v2026.9.19. The equal split and the headroom rule are",
	"scored beside it and never enter the verdict.",
].join("\n");

export interface VerdictCriterion {
	id: "A" | "B" | "C" | "D";
	label: string;
	/** `null` = indeterminate (a needed value was absent). */
	pass: boolean | null;
	/** `digits` omitted prints three decimals; counts pass 0. */
	values: Array<{ name: string; value: number | null; digits?: number }>;
}

export type VerdictWord = "replace" | "keep-scenario" | "insufficient-evidence";

export interface Verdict {
	verdict: VerdictWord;
	criteria: VerdictCriterion[];
	provisional: boolean;
	/**
	 * `(tag, class)` pairs with no labelled weekly record whose weekly windows
	 * are still unfolding at the end of the replay interval. These alone make a
	 * verdict `provisional`.
	 */
	pendingCohorts: string[];
	/**
	 * `(tag, class)` pairs with no labelled weekly record and none pending
	 * either — the class had no sibling to tag, or every tagged weekly record
	 * was withheld or censored.
	 */
	unlabelledCohorts: string[];
	n: Array<{
		cohort: string;
		records: number;
		lifecycles: number;
		episodes: number;
	}>;
}

/**
 * The one bootstrap CI a criterion is defined on.
 *
 * All four of label, statistic, scenario and baseline are matched EXACTLY: the
 * table carries the same cohort label several times over, once per (scenario,
 * baseline) pair, and a prefix match would resolve whichever happens to come
 * first.
 */
const bootstrapEntry = (
	entries: readonly RedistributionBootstrapEntry[],
	label: string,
	statistic: string,
	scenario: ScenarioModel,
	baseline: RedistributionBootstrapEntry["baseline"],
): RedistributionBootstrapEntry | null =>
	entries.find(
		(entry) =>
			entry.label === label &&
			entry.statistic === statistic &&
			entry.scenario === scenario &&
			entry.baseline === baseline,
	) ?? null;

/**
 * Apply the pre-declared rule. Nothing here reads a number the report does not
 * print, and nothing is decided on a value that is absent — an absent value is
 * INDETERMINATE, never a pass and never a fail.
 */
/** Everything criteria A to D read, for ONE scenario model. */
export interface CriterionInputs {
	/** The model being judged. Every value name states it. */
	model: ScenarioModel;
	/**
	 * `model`'s OWN pre-correction control ({@link CONTROL_MODELS}), or null
	 * where it has none — criterion D is then indeterminate rather than judged
	 * against another rule's control.
	 */
	control: ScenarioModel | null;
	/** `model`'s metrics on the any-transition cohort, lifecycle-balanced. */
	scenario: BacktestMetrics | null;
	/** The current model's, on the same cohort. */
	current: BacktestMetrics | null;
	/** `control`'s metrics on the same cohort — criterion D's comparison. */
	original: BacktestMetrics | null;
	/** `model` against the current model, paired. */
	bias: PairedBias;
	/** `model` against its own control, paired absolute error. */
	absDelta: PairedAbsDelta;
	/** The overall F1-delta CI of `model` against the current model. */
	overallCi: RedistributionBootstrapEntry | null;
}

/**
 * Criteria A to D for one model, from numbers the caller has already computed.
 *
 * ONE implementation for the verdict basis and for every rule scored beside
 * it: the same functions on the same cohorts, and the only thing that varies is
 * which model's records the inputs were taken over. The rule text
 * ({@link VERDICT_RULE}) is written for {@link VERDICT_BASIS_MODEL} and the
 * VERDICT is computed on it alone; nothing here changes that.
 */
export function criteriaFor(inputs: CriterionInputs): VerdictCriterion[] {
	const {
		model,
		control,
		scenario,
		current,
		original,
		bias,
		absDelta,
		overallCi,
	} = inputs;
	// A model with no control has no benchmark for D, and the row says which
	// number is missing rather than printing a bare blank.
	const controlName = control ?? "no pre-correction control";

	const criterionA: VerdictCriterion = {
		id: "A",
		label: "not more optimistic on transitions",
		pass:
			bias.medianA == null ||
			bias.medianB == null ||
			scenario?.recall == null ||
			current?.recall == null
				? null
				: Math.max(bias.medianA, 0) <= Math.max(bias.medianB, 0) &&
					scenario.recall >= current.recall,
		values: [
			{
				name: `paired median signed error, ${model} (min)`,
				value: bias.medianA,
			},
			{
				name: "paired median signed error, current (min)",
				value: bias.medianB,
			},
			{ name: "paired n", value: bias.n, digits: 0 },
			{ name: `recall, ${model}`, value: scenario?.recall ?? null },
			{ name: "recall, current", value: current?.recall ?? null },
		],
	};

	const criterionB: VerdictCriterion = {
		id: "B",
		label: "better at transitions",
		pass:
			scenario?.f1 == null || current?.f1 == null
				? null
				: scenario.f1 >= current.f1,
		values: [
			{ name: `F1, ${model}`, value: scenario?.f1 ?? null },
			{ name: "F1, current", value: current?.f1 ?? null },
		],
	};

	const criterionC: VerdictCriterion = {
		id: "C",
		label: "no significant overall loss",
		pass: overallCi?.p97_5 == null ? null : overallCi.p97_5 >= 0,
		values: [
			{ name: "F1 delta p2.5", value: overallCi?.p2_5 ?? null },
			{ name: "F1 delta p50", value: overallCi?.p50 ?? null },
			{ name: "F1 delta p97.5", value: overallCi?.p97_5 ?? null },
			{ name: "resamples", value: overallCi?.samples ?? null, digits: 0 },
		],
	};

	const criterionD: VerdictCriterion = {
		id: "D",
		label: "not worse than the original scenario",
		pass:
			scenario?.f1 == null ||
			original?.f1 == null ||
			absDelta.medianDeltaMinutes == null
				? null
				: scenario.f1 >= original.f1 && absDelta.medianDeltaMinutes <= 0,
		values: [
			{ name: `F1, ${model}`, value: scenario?.f1 ?? null },
			{
				name: `F1, ${controlName}`,
				value: original?.f1 ?? null,
			},
			{
				name: "paired median |error| change vs own control (min)",
				value: absDelta.medianDeltaMinutes,
			},
			{ name: "paired n", value: absDelta.n, digits: 0 },
			// Printed, never judged — see the rule text.
			{ name: `recall, ${model}`, value: scenario?.recall ?? null },
			{
				name: `recall, ${controlName}`,
				value: original?.recall ?? null,
			},
		],
	};

	return [criterionA, criterionB, criterionC, criterionD];
}

export function evaluateVerdict(
	cohorts: CohortSet,
	replay: ReplayResult,
): Verdict {
	const transition = cohorts.anyTransition;
	const criteria = criteriaFor({
		model: VERDICT_BASIS_MODEL,
		control: VERDICT_BASIS_CONTROL_MODEL,
		scenario: metricsOf(transition.balanced, VERDICT_BASIS_MODEL),
		current: metricsOf(transition.balanced, "current"),
		original: metricsOf(transition.balanced, VERDICT_BASIS_CONTROL_MODEL),
		bias: biasVsCurrentOf(transition, VERDICT_BASIS_MODEL),
		absDelta: absVsControlOf(transition, VERDICT_BASIS_MODEL),
		overallCi: bootstrapEntry(
			cohorts.bootstrap,
			OVERALL_BOOTSTRAP_LABEL,
			"f1",
			VERDICT_BASIS_MODEL,
			"current",
		),
	});
	const verdict: VerdictWord = criteria.some(
		(criterion) => criterion.pass === false,
	)
		? "keep-scenario"
		: criteria.some((criterion) => criterion.pass == null)
			? "insufficient-evidence"
			: "replace";

	// A tag whose events are in the data but which carries NO seven_day record is
	// unlabelled on its weekly half. WHY it is unlabelled decides what to do
	// about it, so the two are separated rather than both prescribing a re-run:
	// a pair whose tagged weekly windows were dropped by the label horizon is
	// PENDING (only that makes the verdict provisional), while a pair with no
	// pending window is not.
	//
	// Per (tag, class), not per tag: a tag labelled in one servable class says
	// nothing about the same tag in another, and taking the tag as labelled
	// would hide the unlabelled half behind the labelled one.
	const pendingCohorts: string[] = [];
	const unlabelledCohorts: string[] = [];
	for (const tag of TRANSITION_KINDS) {
		const classes = [
			...new Set(
				replay.events
					.filter((event) => event.kind === tag)
					.map((event) => event.demandClass),
			),
		].sort((a, b) => a.localeCompare(b));
		for (const demandClass of classes) {
			const labelled = cohorts.common.some(
				(record) =>
					record.windowKind === "seven_day" &&
					record.tags.includes(tag) &&
					servableClassFor(record.provider ?? "unknown").classId ===
						demandClass,
			);
			if (labelled) continue;
			const pending =
				(replay.pendingWeeklyByTagClass.get(`${tag}::${demandClass}`) ?? 0) > 0;
			(pending ? pendingCohorts : unlabelledCohorts).push(
				`${tag} (${demandClass})`,
			);
		}
	}

	return {
		verdict,
		criteria,
		provisional: pendingCohorts.length > 0,
		pendingCohorts,
		unlabelledCohorts,
		n: [
			{
				cohort: cohorts.overall.label,
				records: cohorts.overall.records,
				lifecycles: cohorts.overall.lifecycles,
				episodes: cohorts.overall.episodes,
			},
			{
				cohort: transition.label,
				records: transition.records,
				lifecycles: transition.lifecycles,
				episodes: transition.episodes,
			},
		],
	};
}

/** How far apart two ETAs may sit and still be the same answer, for the identity. */
export const IDENTITY_TOLERANCE_MS = 1;

/**
 * How often the BASIS rule IS the current model where it is constructed to be:
 * on the records its own scan projects from its first assignment with every
 * contributor to the class demand alive and pooled — see
 * {@link RedistributionRecord.basisFirstAssignment} for the population.
 *
 * A property of the verdict basis, printed under the verdict: it is what makes
 * the basis a re-declaration of the current model's arithmetic rather than a
 * different answer everywhere. A mechanism check in the style of the
 * observation-lag section's — it states its population, counts it, and prints
 * the number that falls out. Records either model did not date do not enter: an
 * ETA cannot equal an abstention.
 */
export interface BasisIdentityCheck {
	/** Records in the population, both models dated. */
	eligible: number;
	/** Of those, how many agree within {@link IDENTITY_TOLERANCE_MS}. */
	matching: number;
	/** `matching / eligible`, or null with nothing eligible. */
	share: number | null;
}

export function basisIdentityCheck(replay: ReplayResult): BasisIdentityCheck {
	let eligible = 0;
	let matching = 0;
	for (const entry of recordsByKey(replay.records).values()) {
		const basis = entry.get(VERDICT_BASIS_MODEL);
		const current = entry.get("current");
		if (basis == null || current == null) continue;
		if (!basis.basisFirstAssignment) continue;
		if (basis.predictedEtaMs == null || current.predictedEtaMs == null) {
			continue;
		}
		eligible++;
		if (
			Math.abs(basis.predictedEtaMs - current.predictedEtaMs) <=
			IDENTITY_TOLERANCE_MS
		) {
			matching++;
		}
	}
	return {
		eligible,
		matching,
		share: eligible === 0 ? null : matching / eligible,
	};
}

// ---------------------------------------------------------------------------
// Share rules beside the basis
// ---------------------------------------------------------------------------

/** One criterion of a rule scored beside the basis, with what it is read against. */
export interface BesideBasisCriterionRow {
	id: VerdictCriterion["id"];
	label: string;
	/**
	 * What the model columns hold. A criterion that turns on TWO statistics has
	 * one row per statistic — criterion D can fail on its F1 comparison while
	 * its error comparison passes, and a table that printed one of the two would
	 * state a result no number in the row accounts for. Both rows carry the
	 * criterion's single result.
	 */
	statistic: string;
	/** The scored rule's own number. */
	value: number | null;
	/** The verdict basis's number for the same statistic. */
	verdictBasis: number | null;
	/** The current model's, or null where the statistic is a delta against it. */
	current: number | null;
	/**
	 * The scored rule's OWN pre-correction control for the same statistic — the
	 * benchmark its criterion D judges against — or null on every criterion that
	 * does not read it and on a rule that has no control.
	 */
	control: number | null;
	pass: boolean | null;
}

/**
 * One share rule scored BESIDE the verdict, against the same four criteria.
 *
 * Never part of the verdict: {@link evaluateVerdict} reads nothing from here,
 * and the criteria below are computed by {@link criteriaFor} from this model's
 * own records on the same cohorts.
 */
export interface BesideBasisScores {
	model: ScenarioModel;
	/** What this model is: the prior basis, the headroom rule. Printed as given. */
	role: string;
	/** Its own pre-correction control, or null where it has none. */
	control: ScenarioModel | null;
	/** Criteria A to D applied to {@link model}. */
	criteria: VerdictCriterion[];
	/** The same four, summarised beside the verdict basis and the current model. */
	rows: BesideBasisCriterionRow[];
	/**
	 * Why a criterion of THIS model is indeterminate, stated rather than left as
	 * a bare INDETERMINATE. Empty when every criterion had its numbers.
	 */
	notes: string[];
}

/** What each rule beside the basis is, in the order the report prints them. */
const BESIDE_BASIS_ROLES: Record<string, string> = {
	[PRIOR_BASIS_MODEL]:
		"the PRIOR verdict basis, pre-declared and scored as the basis through v2026.9.19",
	"scenario-headroom":
		"the headroom rule, reported since the first run and never a basis",
};

/**
 * The four criteria for every rule scored beside the basis.
 *
 * Same functions, same lifecycle-balanced cohorts, same comparison models as
 * the verdict — only the model whose records the inputs were taken over
 * differs. A rule with no pre-correction control of its own gets an
 * INDETERMINATE criterion D and a note saying why, rather than a comparison
 * against another rule's control, which would mix two share rules and the lag
 * advance into one number. The same holds for criterion C, which is defined on
 * a bootstrap pair only the basis and the prior basis carry.
 */
export function evaluateBesideBasis(cohorts: CohortSet): BesideBasisScores[] {
	const transition = cohorts.anyTransition;
	const current = metricsOf(transition.balanced, "current");
	const basisMetrics = metricsOf(transition.balanced, VERDICT_BASIS_MODEL);
	const basisCi = bootstrapEntry(
		cohorts.bootstrap,
		OVERALL_BOOTSTRAP_LABEL,
		"f1",
		VERDICT_BASIS_MODEL,
		"current",
	);
	const basisBias = biasVsCurrentOf(transition, VERDICT_BASIS_MODEL);
	const basisAbs = absVsControlOf(transition, VERDICT_BASIS_MODEL);

	return BESIDE_BASIS_MODELS.map((model) => {
		const control = CONTROL_MODELS[model] ?? null;
		const scenario = metricsOf(transition.balanced, model);
		const original =
			control == null ? null : metricsOf(transition.balanced, control);
		const bias = biasVsCurrentOf(transition, model);
		const absDelta = absVsControlOf(transition, model);
		const overallCi = bootstrapEntry(
			cohorts.bootstrap,
			OVERALL_BOOTSTRAP_LABEL,
			"f1",
			model,
			"current",
		);
		const criteria = criteriaFor({
			model,
			control,
			scenario,
			current,
			original,
			bias,
			absDelta,
			overallCi,
		});
		const passOf = (id: VerdictCriterion["id"]): boolean | null =>
			criteria.find((criterion) => criterion.id === id)?.pass ?? null;
		const notes: string[] = [];
		if (overallCi == null) {
			notes.push(
				`C is indeterminate: the replay bootstraps the verdict basis and \`${PRIOR_BASIS_MODEL}\` only, so \`${model}\` has no F1-delta CI against the current model here.`,
			);
		}
		if (control == null) {
			notes.push(
				`D is indeterminate: \`${model}\` has no pre-correction scan of its own in this replay, and judging it against another rule's control would compare two share rules and the lag advance at once.`,
			);
		}
		const rows: BesideBasisCriterionRow[] = [
			{
				id: "A",
				label: "not more optimistic on transitions",
				statistic: "paired median signed error (min)",
				value: bias.medianA,
				verdictBasis: basisBias.medianA,
				// Each model's own pairing, which is why this is not one number: a
				// paired median is taken over the records BOTH models dated.
				current: bias.medianB,
				control: null,
				pass: passOf("A"),
			},
			{
				id: "B",
				label: "better at transitions",
				statistic: "F1 on transitions",
				value: scenario?.f1 ?? null,
				verdictBasis: basisMetrics?.f1 ?? null,
				current: current?.f1 ?? null,
				control: null,
				pass: passOf("B"),
			},
			{
				id: "C",
				label: "no significant overall loss",
				statistic: "overall F1 delta against current, p97.5",
				value: overallCi?.p97_5 ?? null,
				verdictBasis: basisCi?.p97_5 ?? null,
				// The statistic IS a delta against the current model, so the current
				// model has no column of its own here.
				current: null,
				control: null,
				pass: passOf("C"),
			},
			{
				id: "D",
				label: "not worse than the original scenario",
				// Judged against this rule's OWN pre-correction scan, in the last
				// column, not against either of the two middle ones.
				statistic: "F1 on transitions",
				value: scenario?.f1 ?? null,
				verdictBasis: basisMetrics?.f1 ?? null,
				current: current?.f1 ?? null,
				control: original?.f1 ?? null,
				pass: passOf("D"),
			},
			{
				id: "D",
				label: "not worse than the original scenario",
				// Not the value list's `|error|`: a pipe inside a cell would split it.
				statistic:
					"paired median absolute-error change against its own pre-correction scan (min)",
				value: absDelta.medianDeltaMinutes,
				verdictBasis: basisAbs.medianDeltaMinutes,
				// The statistic IS a change against a pre-correction scan, so neither
				// comparison model has a column of its own here.
				current: null,
				control: null,
				pass: passOf("D"),
			},
		];
		return {
			model,
			role: BESIDE_BASIS_ROLES[model] ?? "scored beside the basis",
			control,
			criteria,
			rows,
			notes,
		};
	});
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const EM_DASH = "—";

export interface RedistributionReportInput {
	title: string;
	generatedAtIso: string;
	/** The exact invocation, so the report is reproducible. */
	command: string;
	config: Record<string, string | number | boolean | null>;
	dataset: {
		rows: number;
		accounts: number;
		providers: string[];
		firstSampleIso: string;
		lastSampleIso: string;
	};
	replay: ReplayResult;
	cohorts: CohortSet;
	verdict: Verdict;
	/**
	 * The request-volume measurement around each death, precomputed by the
	 * caller the way
	 * `cohorts` and `verdict` are. Null when the `requests` table could not be
	 * read at all, which the section says rather than printing an empty table.
	 */
	absorption: AbsorptionChecks | null;
	knownLimits: string[];
	notes: string[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

function cohortSection(cohort: CohortScores, heading: string): string[] {
	const out: string[] = [];
	out.push(heading);
	out.push("");
	out.push(
		`n: ${cohort.records} records, ${cohort.lifecycles} window lifecycles, ${cohort.episodes} episodes.`,
	);
	out.push("");
	if (cohort.records === 0) {
		out.push("No records in this cohort.");
		out.push("");
		return out;
	}
	out.push(
		"Lifecycle-balanced (one record per window lifecycle, median instant):",
	);
	out.push("");
	out.push(metricsTable(cohort.balanced));
	out.push("");
	out.push(coverageTable(cohort.balanced));
	out.push("");
	out.push(leadTimeTable(cohort.balanced));
	out.push("");
	out.push("Per record (every scored instant):");
	out.push("");
	out.push(metricsTable(cohort.perRecord));
	out.push("");
	const basisBias = biasVsCurrentOf(cohort, VERDICT_BASIS_MODEL);
	const basisBiasVsControl = biasVsControlOf(cohort, VERDICT_BASIS_MODEL);
	const basisAbsVsControl = absVsControlOf(cohort, VERDICT_BASIS_MODEL);
	out.push(
		`Paired median signed error (n=${basisBias.n}; positive = optimistic): ${VERDICT_BASIS_MODEL} ${num(basisBias.medianA, 1)} min, current ${num(basisBias.medianB, 1)} min.`,
	);
	out.push("");
	out.push(
		`Against its own pre-correction scan (n=${basisBiasVsControl.n}): ${VERDICT_BASIS_MODEL} ${num(basisBiasVsControl.medianA, 1)} min, ${VERDICT_BASIS_CONTROL_MODEL} ${num(basisBiasVsControl.medianB, 1)} min; paired median change in absolute error ${num(basisAbsVsControl.medianDeltaMinutes, 1)} min (n=${basisAbsVsControl.n}, negative = the correction lands closer).`,
	);
	out.push("");
	return out;
}

function slopeTrajectorySection(rows: readonly SlopeRatioRow[]): string[] {
	const out: string[] = [];
	out.push("### Survivor slope trajectory after a death");
	out.push("");
	out.push(
		"The survivor's OWN fitted burn slope, expressed against its slope just after the peer died: `slope(t) / slope(t_death+)`. A ratio above 1 is consistent with the inherited traffic having entered the survivor's lookback, which is the demand the scenario would then be adding a second time; a ratio near 1 is consistent with it not having arrived. The table cannot separate absorbed traffic from any other change in the survivor's own burn, and it cannot see absorption at all where the survivor was still learning when its peer died.",
	);
	out.push("");
	out.push(
		"Median within a (window lifecycle × death) first, then across them, so a lifecycle that happens to be sampled more often does not outvote one that is not. `t_death+` is the earliest instant at or after the death that has a fitted slope at all, not the literal first instant: a survivor is often still learning when its peer dies, and requiring a slope there would discard the lifecycles this table is about. Instants with no slope enter no bucket, and a lifecycle whose baseline slope is zero is dropped rather than imputed.",
	);
	out.push("");
	out.push(
		"Unlike the scored buckets above, this table reads the peer-exhaustion records that survive the replay's label-horizon filtering, not only the ones where every model is comparable and the window's fate was observed. The slope belongs to the survivor's own reading, so a model abstaining or an unobserved outcome is no reason to move the baseline off the earliest post-death reading there is.",
	);
	out.push("");
	out.push(
		"The direct, slope-free measurement of the same question, how long a window takes to fill and whether that changes when the class lost a peer, is under `## Absorption measurements` below.",
	);
	out.push("");
	out.push(
		"| since death | lifecycles | median ratio | median slope (pct/h) | five_hour n | five_hour ratio | seven_day n | seven_day ratio |",
	);
	out.push("|---|---:|---:|---:|---:|---:|---:|---:|");
	for (const row of rows) {
		const combined = row.cells.combined;
		const five = row.cells.five_hour;
		const seven = row.cells.seven_day;
		out.push(
			`| ${row.label} | ${combined.lifecycles} | ${num(combined.medianRatio)} | ${num(combined.medianSlopePctPerHour, 2)} | ${five.lifecycles} | ${num(five.medianRatio)} | ${seven.lifecycles} | ${num(seven.medianRatio)} |`,
		);
	}
	out.push("");
	return out;
}

const FILL_TABLE_HEADER =
	"| exposure | window | fills | completed below 100 % | follow-up incomplete | fill fraction | median fill (h) | median observed span (h) | median unobserved head (min) | median resolution (min) | median censored span, both kinds (h) |";
const FILL_TABLE_ALIGN =
	"|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|";

const fillTableRow = (row: WindowFillRow): string =>
	`| ${row.exposure} | ${row.window} | ${row.fills} | ${row.completedBelowHundred} | ${row.followUpIncomplete} | ${pct(row.fillFraction)} | ${num(row.medianFillHours, 2)} | ${num(row.medianObservedSpanHours, 2)} | ${num(row.medianUnobservedHeadMinutes, 1)} | ${num(row.medianResolutionMinutes, 1)} | ${num(row.medianCensoredSpanHours, 2)} |`;

const fillDurationsLine = (row: WindowFillRow): string =>
	`- \`${row.exposure}\` ${row.window} (${row.fills} fills): ${
		row.fillDurationsHours.length > 0
			? `${row.fillDurationsHours.map((hours) => hours.toFixed(2)).join(", ")} h`
			: EM_DASH
	}`;

/** The slope-free measurement of what a window does when its class loses a peer. */
function absorptionSection(replay: ReplayResult): string[] {
	const tally = tallyWindowFills(replay.fills);
	const out: string[] = [];

	out.push("## Absorption measurements");
	out.push("");
	out.push(
		"Direct measurements of what a survivor's own window does when its demand class loses a peer. Nothing here fits, tunes or thresholds anything, and nothing here feeds a model: each section states what it measures and over which population, and prints what falls out of that population. The populations are small, so an empty cell is ordinary rather than exceptional; an empty cell prints a dash beside its denominator.",
	);
	out.push("");

	out.push("### Time to first 100 %");
	out.push("");
	out.push(
		"How long a window took to reach its first reading at or above 100 %, measured from the window start its reset implies (`reset - window length`, the same derivation the projections use) to that reading. The population is every non-placeholder window lifecycle in the replayed snapshot history, both window kinds, every account the history holds, split by whether the account's demand class lost a peer early in the window. Early is a FIXED prefix of the window: its first hour for a five-hour window, its first 24 hours for a weekly one. A peer's death counts whichever of the peer's own windows filled, because an account at 100 % in either window leaves routing. What this section measures is how fill durations and fill fractions differ between the exposure groups; whether demand moved is not identified here.",
	);
	out.push("");
	out.push(
		"The fill medians are conditional on an observed fill: they describe the windows that reached 100 % and no others. The two censored columns are what to read first, and a larger censored fraction does not by itself establish a larger bias in the conditional median, because the censored windows are not known to be slower ones — the follow-up-incomplete ones are not known to have failed to fill at all.",
	);
	out.push("");
	out.push(
		`\`completed below 100 %\` counts the windows whose sampling ran to within ${SEGMENT_COVERAGE_SLACK_MS / MINUTE_MS} min of the window's own end without ever reading 100 % AND whose successor window was observed to start, which is the same rule the outcome labels use, both halves of it, ending the window at the same instant: the earlier of its reset and its successor's observed start. \`follow-up incomplete\` counts the ones whose samples stopped earlier, that carry no reset to end at, or that nothing was ever recorded after: those windows were not observed to their end and say nothing about whether they filled. Proximity to the reset alone would label a run that simply stopped as a window observed not to fill, and one combined census makes a cell whose follow-up merely ended look like a cell of slow windows.`,
	);
	out.push("");
	out.push(
		"A peer dies because its class is busy, and the same busy period fills a survivor faster, so a shorter fill under peer loss is equally consistent with absorption and with common cause. This section is direct and slope-free; it is not causal.",
	);
	out.push("");
	out.push(
		"Three populations sit outside the two arms rather than inside them. A segment whose reset column is null carries no derivable window start, so it has no fill duration to state. A lifecycle whose first sample already reads 100 % filled before observation began, which is not a fill duration either. And a lifecycle whose exposure span is not wholly inside the replayed range has its own row in each table: peer deaths are only detected inside that range, so such a window would read as `no peer lost` from missing data alone. The span each table checks is its own — the fixed prefix above, the window start to the crossing below — so a window can be readable in one and not the other. The reconciliation line below accounts for all of them.",
	);
	out.push("");
	out.push(
		"`peer lost in prefix` and its complement are exposure labels rather than statements about the focal account: the prefix rule does not require the focal account to have been available when the peer died, and `no peer lost` does not exclude a peer already exhausted at the window start, only one that crossed 100 % inside the prefix.",
	);
	out.push("");
	out.push(
		"The `combined` rows put five-hour and weekly windows in one median. A combined duration median has a composition problem — the two kinds have different lengths and different fill rates, so the combined value moves with the mix — and the per-kind rows are the ones to read.",
	);
	out.push("");
	out.push(
		"`fills` counts the windows of a cell that reached 100 %, the two censored columns the ones whose last sample was still below it. `median fill` runs from the derived window start, `median observed span` from the first sample instead, and `median unobserved head` is the gap between those two origins, i.e. how much of the window had already elapsed when the sampler first saw it. `median resolution` is the gap between the crossing sample and the sample before it. `median censored span, both kinds` is the one column taken over the censored windows, and it pools both censored kinds — completed below 100 % and follow-up incomplete — into one median: window start to last sample.",
	);
	out.push("");
	out.push(FILL_TABLE_HEADER);
	out.push(FILL_TABLE_ALIGN);
	for (const row of tally.prefixRows) out.push(fillTableRow(row));
	out.push("");
	out.push(
		"The same rows again, split instead by whether a same-class peer died anywhere between the window start and the crossing. That definition is length-biased in the direction of longer fills, because a longer fill has more calendar time in which to contain a peer death, and that is why the fixed-prefix split above is the primary one. Both are printed; neither was chosen on its result. This split reads a different span from the prefix one, so it carries its own observability row: a window whose span from its start to its crossing (or to its last sample, uncrossed) leaves the replayed range is `during-fill exposure unobservable` here, whatever the prefix split could say about it.",
	);
	out.push("");
	out.push(FILL_TABLE_HEADER);
	out.push(FILL_TABLE_ALIGN);
	for (const row of tally.duringFillRows) out.push(fillTableRow(row));
	out.push("");
	out.push(
		`Every cell with fewer than ${RAW_FILL_DURATION_LIMIT} fills prints its fill durations, sorted, in hours. At that n the median summarises few observed fills, and the values themselves are what a reader can judge.`,
	);
	out.push("");
	for (const row of [...tally.prefixRows, ...tally.duringFillRows]) {
		if (row.fills < RAW_FILL_DURATION_LIMIT) out.push(fillDurationsLine(row));
	}
	out.push("");
	const lifecycles =
		tally.filled +
		tally.censored +
		tally.noResetOnSegment +
		tally.firstSampleAlreadyFull +
		replay.placeholderLifecyclesSkipped;
	out.push(
		`Reconciliation: ${tally.filled} filled + ${tally.completedBelowHundred} completed below 100 % + ${tally.followUpIncomplete} follow-up incomplete + ${tally.noResetOnSegment} with no reset on the segment + ${tally.firstSampleAlreadyFull} already full at the first sample + ${replay.placeholderLifecyclesSkipped} placeholder lifecycles skipped = ${lifecycles} window lifecycles.`,
	);
	out.push("");
	return out;
}

const ABSORPTION_GROUP_HEADER =
	"| population | basis | measurements in population | ratio n | median survivor rate ratio | alpha n | median alpha | gain-share n | median largest gain share | split n | median equal split 1/S | dying-share n | median dying pre-share |";
const ABSORPTION_GROUP_ALIGN =
	"|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";

const absorptionGroupLine = (row: AbsorptionGroupRow): string =>
	[
		`| ${row.population}`,
		row.basis,
		`${row.measurements}`,
		`${row.survivorRateRatio.n}`,
		num(row.survivorRateRatio.median),
		`${row.alpha.n}`,
		num(row.alpha.median),
		`${row.largestGainShare.n}`,
		pct(row.largestGainShare.median),
		`${row.equalSplitShare.n}`,
		pct(row.equalSplitShare.median),
		`${row.dyingPreShare.n}`,
		`${pct(row.dyingPreShare.median)} |`,
	].join(" | ");

/**
 * Rates and volumes, per basis: a token count is a whole token, so printing it
 * to three decimals states a precision the counter does not have. A request
 * rate keeps its decimals, where a fraction of a request per minute is the
 * whole quantity.
 */
const rateNum = (value: number | null, basis: AbsorptionBasis): string =>
	num(value, basis === "tokens" ? 0 : 3);

/**
 * The pairing prints apart from the aggregate: its median is a difference of
 * two ratios, and putting it in the `ratio n` / `median survivor rate ratio`
 * columns would have those cells hold two different quantities.
 */
const ABSORPTION_PAIRED_HEADER = "| pairing | basis | n | median delta |";
const ABSORPTION_PAIRED_ALIGN = "|---|---|---:|---:|";

const absorptionPairedLine = (entry: AbsorptionPairedDelta): string =>
	`| paired median of (ratio at death − mean ratio at eligible controls), ${
		entry.horizon === "narrow" ? "W ≤ 60 min" : "W ≤ 6 h"
	} | ${entry.basis} | ${entry.n} | ${num(entry.medianDelta)} |`;

/** What shortened a horizon's `W_pre`, in the words the block prints. */
const ABSORPTION_PRE_WEIGHT_BOUND_WORDS: Record<
	AbsorptionPreWeightBound,
	string
> = {
	availability: "the nearest availability change of a class member before it",
	cap: "the horizon's own cap",
	coverage: "the near edge of the loaded request span",
};

const ABSORPTION_DEATH_HEADER =
	"| horizon | basis | W_pre (min) | W_pre vol (dying) | W_pre vol (surv) | pre min | post min | pre vol (dying) | post vol (dying) | pre vol (surv) | post vol (surv) | dying pre-share | alpha | ratio | P | N | G | largest gain share | control -7 d | control +7 d |";
const ABSORPTION_DEATH_ALIGN =
	"|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|";

/** A control's own ratio, or the reason it was not measured. */
const absorptionControlCell = (
	control: AbsorptionControl | undefined,
	basis: AbsorptionBasis,
): string => {
	if (control == null) return EM_DASH;
	if (!control.eligible) {
		return `${control.rejection ?? "ineligible"}: ${
			control.rejectionDetail ?? EM_DASH
		}`;
	}
	return num(control.measurements?.[basis].survivorRateRatio ?? null);
};

function absorptionHorizonRow(
	horizon: AbsorptionHorizon,
	basis: AbsorptionBasis,
): string {
	const cell = horizon.measurements[basis];
	return [
		// The width this death was actually read at, not the horizon's cap.
		`| W = ${num(horizon.halfWidthMs / MINUTE_MS, 0)} min`,
		basis,
		num(horizon.preWeightHalfWidthMs / MINUTE_MS, 0),
		// The weight numerators, so the printed shares can be recomputed: both
		// divide by the same `W_pre` minutes, so the volumes alone give the split.
		num(cell.preWeightVolumeDying, 0),
		num(cell.preWeightVolumeSurvivors, 0),
		`${cell.preMinutes}`,
		`${cell.postMinutes}`,
		num(cell.preVolumeDying, 0),
		num(cell.postVolumeDying, 0),
		num(cell.preVolumeSurvivors, 0),
		num(cell.postVolumeSurvivors, 0),
		pct(cell.dyingPreShare),
		num(cell.alpha),
		num(cell.survivorRateRatio),
		rateNum(cell.grossPositive, basis),
		rateNum(cell.grossNegative, basis),
		rateNum(cell.netChange, basis),
		pct(cell.largestGainShare),
		absorptionControlCell(
			horizon.controls.find((control) => control.label === "-7 d"),
			basis,
		),
		`${absorptionControlCell(
			horizon.controls.find((control) => control.label === "+7 d"),
			basis,
		)} |`,
	].join(" | ");
}

/** One line per survivor, both bases, on the primary horizon. */
function absorptionSurvivorLine(
	horizon: AbsorptionHorizon,
	accountId: string,
	accountName: string,
): string {
	const of = (basis: AbsorptionBasis): string => {
		const entry = horizon.measurements[basis].survivors.find(
			(survivor) => survivor.accountId === accountId,
		);
		if (entry == null) return `${basis} —`;
		return `${basis} pre ${rateNum(entry.preRate, basis)}, post ${rateNum(
			entry.postRate,
			basis,
		)}, delta ${rateNum(entry.delta, basis)}, contribution ${num(
			entry.contribution,
		)}, pre-share ${pct(entry.preShare)}`;
	};
	return `  - \`${accountName}\`: ${of("requests")}; ${of("tokens")}`;
}

/**
 * What the request table says happened around each observed exhaustion.
 *
 * Prose rule for this section, and the reason it reads as flatly as it does:
 * it states what was measured and over which population, and never what a
 * number ought to be, would confirm, or is consistent with.
 */
function requestVolumeChangeSection(
	absorption: AbsorptionChecks | null,
): string[] {
	const out: string[] = [];
	out.push("### Request-volume changes around observed exhaustion");
	out.push("");
	if (absorption == null) {
		out.push(
			"The request table was unreadable in this run — this database has no `requests` — so no traffic share was measured here. Every number this subsection would print comes from that table; none of them is estimated from the snapshot history instead.",
		);
		out.push("");
		return out;
	}

	out.push(
		`What each survivor's own request volume did around the instant a peer of its demand class first read 100 %. The population is every peer-exhaustion event inside the replayed interval, ${absorption.peerExhaustionEvents} of them, reduced by the exclusions reconciled at the end of this subsection. Volumes come from the \`requests\` table on a fixed ${REQUEST_BUCKET_MS / MINUTE_MS}-minute grid, per account, and are turned into rates by dividing by the minutes actually counted.`,
	);
	out.push("");
	out.push(
		"The survivor set `S` is the class members observed AVAILABLE just before the death: their newest snapshot inside the staleness bar reads under 100 % on both windows. A member reading 100 % on either window, or carrying no reading inside the bar, is listed under the death rather than counted as a survivor — an account at 100 % is already out of routing, and an unread stretch is not evidence of being in it. The dying account itself must be available just before the death, so a window filling while its account was already exhausted on the other window is excluded rather than measured as a departure.",
	);
	out.push("");
	out.push(
		`The half-width \`W\` is the largest symmetric width in which NO member of the class changes availability state, capped at ${absorption.narrowHalfWidthMs / MINUTE_MS} min for the primary horizon and ${absorption.halfWidthMs / HOUR_MS} h for the second one. The cap is a cap: most deaths are read at less, and the per-death table prints the width each one was read at. Every member of the class bounds it, including a member that is not in \`S\` and one created after the death — an account arriving is a regime change even though it was never a candidate for the traffic, and it is bounded at the instant it was created rather than at its first reading, which can be an hour later or never come at all. The dying account's own transition at the death is the one change the rule ignores. A death whose clean interval falls under ${absorption.minHalfWidthMs / MINUTE_MS} min is excluded, with the account and the distance that bounded it printed beside it. This selection preferentially removes rapid cascades, and strong absorption can itself precipitate the next death, so the analysed population is the sufficiently-isolated departures and nothing here is a claim about cascades.`,
	);
	out.push("");
	out.push(
		`The weights are read over a different width, \`W_pre\`, and the reason is that \`W\` is bounded on BOTH sides of the death: which width \`W\` takes depends on what happened after \`D\`, so a weight computed over it would not have been computable at \`D\`. \`W_pre\` runs back from \`D\` to the nearest availability change of any class member before \`D\`, capped at the same horizon cap and at the near edge of the loaded request span, and reads nothing at or after \`D\`. That third bound is what keeps the weights over LOADED buckets: a bucket the run never loaded is absent rather than empty, and a lookback reaching past it would divide a partly-loaded volume by its whole width and read the missing stretch as no traffic. Which of the three bounds was the binding one is printed under each death, and each control's weights are shortened to its own loaded prehistory the same way. The dying account's pre-death share, each survivor's pre-death share and the equal split are therefore computable at \`D\` from data available at \`D\`. The rate comparison — alpha, the ratio, each \`delta_s\`, \`P\`, \`N\`, \`G\` and the matched controls — uses the symmetric \`W\` instead, chosen retrospectively so that no availability change sits inside it; a comparison needs the same clean regime on both sides. Both widths are printed for every death.`,
	);
	out.push("");
	out.push(
		"Nothing at or after the death enters any share or weight: they are functions of `[D − W_pre, D)` alone. That prevents post-death volume from leaking into the weights. It does not make any of these numbers a measurement of what the death caused, and none of them is read that way here.",
	);
	out.push("");
	out.push(
		"An account whose five-hour and weekly windows first read 100 % in the SAME sample left routing once, not twice. Those events are folded into one departure, both window kinds are recorded on it, and the folded event is counted in the reconciliation at the end rather than measured a second time over an identical survivor set and interval.",
	);
	out.push("");
	out.push(
		"Request coverage is checked per horizon rather than once at the widest. A death whose loaded request span carries the whole primary interval keeps its primary measurement even where the six-hour interval runs outside that span; the six-hour row is then absent with its reason stated under the death. The gate that excludes a death for having no pre-death traffic reads the PRIMARY horizon, the one the numbers are reported from.",
	);
	out.push("");
	out.push(
		`The bucket containing the death is in neither half — a bucket enters pre only if it ends at or before \`D\`, and post only if it starts at or after it — so up to one minute is uncounted on each side.`,
	);
	out.push("");
	out.push(
		"`requests.timestamp` is stamped when the row is persisted rather than when the request was made, and `D` is the first sampled 100 % reading rather than the instant routing changed, so persistence lag and sampled exhaustion timing misalign these intervals with both request execution and the routing change. The direction and magnitude of the resulting error are unmeasured. The misalignment matters more as `W` shrinks. `D` can be later than the routing interruption, so redistribution can already appear inside the nominal pre window.",
	);
	out.push("");
	out.push(
		"Both bases are reported because request count and token volume answer different questions — the scenario redistributes capacity units, not requests — and where the two disagree, both are printed, and neither is preferred here.",
	);
	out.push("");
	out.push(
		"No confidence interval, bootstrap or p-value is computed here. The blocks are deaths, they cluster on a handful of accounts and in time, and this many correlated blocks cannot support an interval. There is no threshold split of any kind either: a cut point read off the same data it is applied to is a fit rather than a measurement. The per-death table below prints every analysed death, sorted by the dying account's pre-death share, and is the deliverable at this n; the aggregate is a summary of it.",
	);
	out.push("");
	out.push(
		"A window fills because its account was busy, and often its class with it. A class-specific surge that both killed the peer and raised survivor traffic is not removable from observational data, and nothing here removes it.",
	);
	out.push("");

	out.push(
		"Definitions, per basis, over the survivor set `S` and the dying account `d`:",
	);
	out.push("");
	out.push("```");
	out.push(
		"preRate_a          = volume(a, [D-W, D))     / minutes counted in [D-W, D)",
	);
	out.push(
		"postRate_a         = volume(a, [D, D+W))     / minutes counted in [D, D+W)",
	);
	out.push(
		"weightRate_a       = volume(a, [D-W_pre, D)) / minutes counted in [D-W_pre, D)",
	);
	out.push(
		"dyingPreShare      = weightRate_d / (weightRate_d + sum over S of weightRate_s)",
	);
	out.push("survivorPreShare_s = weightRate_s / sum over S of weightRate_s");
	out.push("equalSplitShare    = 1 / |S|");
	out.push("alpha              = (postRateSurv - preRateSurv) / preRateDying");
	out.push("survivorRateRatio  = postRateSurv / preRateSurv");
	out.push("delta_s            = postRate_s - preRate_s");
	out.push(
		"contribution_s     = delta_s / preRateDying      (these sum to alpha)",
	);
	out.push("P                  = sum over S of max(delta_s, 0)");
	out.push("N                  = sum over S of max(-delta_s, 0)");
	out.push("G                  = P - N");
	out.push(
		"largestGainShare   = max_s max(delta_s, 0) / P   (null when G <= 0)",
	);
	out.push("```");
	out.push("");
	out.push(
		"`alpha = (ratio - 1) * preRateSurv / preRateDying`, so the same ratio change is a different normalised gain at a different PRE-DEATH RATE BALANCE OVER `W`: the dying account's share of pre-death rate over `W`, `preRateDying / (preRateDying + preRateSurv)`. That balance is not the `dying pre-share` column, which is measured over `W_pre`; where the two widths differ the two numbers can differ, and both are correct over their own interval. A ratio difference does not measure a fraction of the dying account's demand. The raw rates over `W` and the raw volumes over `W_pre` are printed beside both.",
	);
	out.push("");
	out.push(
		"`largestGainShare` is the largest account's share of positive rate increases. It is not a share of the volume that moved: it divides one account's rise by the sum of the rises and does not see the falls, which is why it has no value where the survivor set's net change `G` is zero or negative.",
	);
	out.push("");
	out.push(
		"A survivor with zero pre-death traffic leaves the ratio and the pre-share without a value. It stays visible in the per-death table with its raw rates rather than being dropped from the pairing, because dropping it would silently change the survivor set the aggregate is taken over.",
	);
	out.push("");
	out.push(
		"A quantity with no value prints a dash and is never coerced to zero: alpha has no value when the dying account had no pre-death traffic, the largest gain share has none when `G <= 0`, and the survivor rate ratio has none when the survivors had no pre-death traffic.",
	);
	out.push("");

	out.push(
		`Matched controls sit at the same instant ±${ABSORPTION_CONTROL_OFFSET_MS / DAY_MS} d, so weekday and hour are both matched, and are measured over the IDENTICAL survivor set at the IDENTICAL half-width. A control is used only when its whole interval lies inside the loaded request span, every account of \`S\` and the dying account is available across the whole of it, and no member of the class changes availability state or is created inside it. Whether the workload repeats at a one-week offset is what the control ratios show, and a control's own interval can be a quiet stretch rather than a matched one; the per-death table prints each control's ratio beside the death's so the reader can see which, and the pairing below is stated apart from the aggregate rather than as a headline. Ineligible controls are counted rather than skipped: ${absorption.controlsIneligible["outside-loaded-span"]} outside the loaded span, ${absorption.controlsIneligible["availability-change-inside"]} with a class member changing availability state or being created inside the interval.`,
	);
	out.push("");
	out.push(
		"The other class's ratio over the same interval is printed as concurrent context, and never enters any subtraction. A single account can supply it, in which case its concentration statistics are mechanically trivial: with one account the equal split is 1 and the largest gain share is 1 or nothing. A developer can substitute between providers, so the other class is not assumed unaffected by the death either.",
	);
	out.push("");

	out.push(ABSORPTION_GROUP_HEADER);
	out.push(ABSORPTION_GROUP_ALIGN);
	for (const row of absorption.groups) out.push(absorptionGroupLine(row));
	out.push("");
	out.push(
		"Each statistic carries its own denominator: a row's `measurements in population` count is every measurement of that population, and the `n` beside a median is the subset of them where that statistic has a value.",
	);
	out.push("");
	out.push(
		"The pairing is a difference of two ratios rather than a ratio, so it is printed in its own table rather than in the columns above. Its `n` is the deaths carrying a ratio at the death AND at an eligible control, and where both control offsets are eligible their ratios are averaged before the difference is taken.",
	);
	out.push("");
	out.push(ABSORPTION_PAIRED_HEADER);
	out.push(ABSORPTION_PAIRED_ALIGN);
	for (const entry of absorption.paired) out.push(absorptionPairedLine(entry));
	out.push("");

	if (absorption.deaths.length === 0) {
		out.push(
			"No death was analysed in this run. The aggregate rows above print their zero counts rather than being omitted, and the reconciliation below states where every death went.",
		);
		out.push("");
	} else {
		out.push(
			"Every analysed death, one block each — requests above tokens on both horizons — with one line per survivor underneath. Volumes are raw counts and raw tokens over the half-window; rates are those divided by the minutes counted.",
		);
		out.push("");
		for (const death of absorption.deaths) {
			const nameOf = (accountId: string): string =>
				death.accountNames[accountId] ?? accountId;
			out.push(
				`**Event ${death.eventId}** — ${iso(death.atMs)} — ${death.demandClass} / ${
					death.windowKinds.join(", ") || EM_DASH
				} — dying \`${death.dyingAccountName}\` — S = ${
					death.survivorIds.map((id) => `\`${nameOf(id)}\``).join(", ") ||
					EM_DASH
				}`,
			);
			out.push("");
			out.push(ABSORPTION_DEATH_HEADER);
			out.push(ABSORPTION_DEATH_ALIGN);
			for (const horizon of [death.narrow, death.wide]) {
				if (horizon == null) continue;
				for (const basis of ABSORPTION_BASES) {
					out.push(absorptionHorizonRow(horizon, basis));
				}
			}
			out.push("");
			if (death.wide == null && death.wideAbsentReason != null) {
				out.push(`- 6 h horizon absent: ${death.wideAbsentReason}.`);
			}
			out.push(
				`- Availability bound: ${
					death.availabilityBoundMs == null
						? "no class member changes state in the loaded history"
						: `${num(death.availabilityBoundMs / MINUTE_MS, 0)} min, set by \`${
								death.availabilityBoundAccountId == null
									? EM_DASH
									: nameOf(death.availabilityBoundAccountId)
							}\``
				}.`,
			);
			for (const horizon of [death.narrow, death.wide]) {
				if (horizon == null) continue;
				out.push(
					`- W_pre at W = ${num(horizon.halfWidthMs / MINUTE_MS, 0)} min: ${num(
						horizon.preWeightHalfWidthMs / MINUTE_MS,
						0,
					)} min, bounded by ${
						ABSORPTION_PRE_WEIGHT_BOUND_WORDS[horizon.preWeightBoundedBy]
					}.`,
				);
			}
			out.push(
				`- Survivors, at W = ${num(
					death.narrow.halfWidthMs / MINUTE_MS,
					0,
				)} min (W_pre = ${num(
					death.narrow.preWeightHalfWidthMs / MINUTE_MS,
					0,
				)} min):`,
			);
			for (const accountId of death.survivorIds) {
				out.push(
					absorptionSurvivorLine(death.narrow, accountId, nameOf(accountId)),
				);
			}
			out.push(
				`- excluded members: ${
					death.excludedMembers.length === 0
						? "none"
						: death.excludedMembers
								.map((entry) => `${nameOf(entry.accountId)} (${entry.state})`)
								.join(", ")
				}`,
			);
			out.push("");
		}
	}

	if (absorption.excludedDeaths.length > 0) {
		out.push("Deaths that were not measured, printed rather than dropped:");
		out.push("");
		out.push(
			"| event | instant | class | window | dying account | excluded by | bound |",
		);
		out.push("|---:|---|---|---|---|---|---|");
		for (const death of absorption.excludedDeaths) {
			out.push(
				`| ${death.eventId} | ${iso(death.atMs)} | ${death.demandClass} | ${
					death.windowKinds.join(", ") || EM_DASH
				} | ${death.dyingAccountName} | ${death.reason} | ${
					death.detail ?? EM_DASH
				} |`,
			);
		}
		out.push("");
	}
	const reconciliation = ABSORPTION_EXCLUSION_REASONS.map(
		(reason) => `${absorption.excluded[reason]} ${reason}`,
	).join(" + ");
	out.push(
		`Reconciliation: ${absorption.deaths.length} analysed + ${reconciliation} + ${absorption.foldedSimultaneous} folded into a simultaneous departure = ${absorption.peerExhaustionEvents} peer-exhaustion events in the replayed interval.`,
	);
	out.push("");
	return out;
}

const shiftRow = (label: string, stats: LagShiftStats): string =>
	`| ${label} | ${stats.n} | ${num(stats.medianShiftMinutes, 2)} | ${num(stats.medianExcessMinutes, 2)} | ${num(stats.p10ExcessMinutes, 2)} | ${num(stats.p90ExcessMinutes, 2)} | ${pct(stats.matchingShare)} |`;

/** The mechanism section: what the correction DID, beside what it scored. */
function observationLagSection(checks: ObservationLagChecks): string[] {
	const out: string[] = [];
	out.push("## Observation-lag mechanism check");
	out.push("");
	out.push(
		"What the correction actually did to the projections, as opposed to what it scored. `scenario-equal` advances each reading over its observation lag; `scenario-equal-original` is the identical equal split with that advance switched off. Every check in this section is measured on THAT pair, which is the equal split — the verdict basis when the correction shipped, and kept as the subject here so the section cannot silently change what it is about. What the proportional rule, the basis since 2026-09-07, shares with it is the lag DURATION and the per-path anchor that duration is derived from, both properties of the reading. The advance itself is not shared: the scan assigns each window a share-dependent slope and only then advances the reading by that slope over the lag, so the size of the advance, which windows it drives to 100 % inside their own lag, and therefore which records are eligible for the checks below can all differ between the two rules. Nothing below is a measurement of the basis's own scan. Each check below states what it measures, which records enter it, which are excluded and by which predicate, and prints the number that falls out of that population. None of them states what the number ought to be; reading it against the mechanism described is the reader's job. An eligible set of zero is reported as such rather than as a pass.",
	);
	out.push("");

	out.push("### Observation age");
	out.push("");
	out.push(
		"The scored cohort split by how old the reading behind each record was. Buckets are half-open and contiguous; a negative age is a reading stamped ahead of the instant replaying it, and `unknown` is a row with no `observed_at` at all — which is most rows before 2026-08-24, and is why the regression path derives its lag from the fit rather than from the observation.",
	);
	out.push("");
	for (const group of checks.ageGroups) {
		out.push(`#### ${group.scope}`);
		out.push("");
		const counts = [
			...group.buckets.map((bucket) => bucket.records),
			group.unknown.records,
		];
		const summed = counts.reduce((total, count) => total + count, 0);
		out.push(
			`Reconciliation: ${counts.join(" + ")} = ${summed} of ${group.eligible} eligible records.`,
		);
		out.push("");
		for (const bucket of group.buckets) {
			out.push(...cohortSection(bucket, `##### age ${bucket.label}`));
		}
		out.push(
			...cohortSection(
				group.unknown,
				`##### age ${UNKNOWN_OBSERVATION_AGE_LABEL}`,
			),
		);
	}

	out.push("### Identity on lag-free class-instants");
	out.push("");
	out.push(
		"Over the records whose whole class-instant is lag-free — no pooled window of the class carries a lag at that instant — this counts how many the two equal-split models answered differently: a different exhausts/does-not-exhaust verdict, or a different ETA instant. Lag-free is a property of the class-instant rather than of the window, because a peer's lag moves the peer's death and with it this window's share and its ETA; a window's own zero lag therefore does not admit it. A window whose anchor sits ahead of the instant carries the zero `observationLagMs` clamps it to, and enters the population like any other zero.",
	);
	out.push("");
	if (checks.identity.eligible === 0) {
		out.push(
			"No eligible records: nothing in this replay entered this population, so the check measures nothing about this run.",
		);
	} else {
		out.push(
			`n=${checks.identity.eligible} eligible records, ${checks.identity.differing} of which the two models answered differently. Eligible records span \`${iso(checks.identity.fromMs ?? 0)}\` to \`${iso(checks.identity.toMs ?? 0)}\`.`,
		);
		out.push("");
		out.push(
			"The population is not filtered by estimator path. The now-anchored paths carry no anchor lag at all, so an instant at which every pooled window of a class reads from one of them is lag-free through them alone.",
		);
	}
	out.push("");

	out.push("### Lag shift");
	out.push("");
	out.push(
		"How far the correction moved each ETA, over the records where both models committed to a date and the record's own window carries a lag. `shift` is `original ETA − corrected ETA`; `excess` is that shift minus the window's own lag.",
	);
	out.push("");
	out.push(
		"The split is a property of the record, decided before any ETA is compared. A record enters the first row when, in BOTH scans, its own projected exhaustion precedes both any other projected exhaustion still ahead of the instant and the reset of any class window already at 100 %, and no other window of its class was filled inside ITS own lag while this window is still projecting past the instant. The exhaustions it compares against are the class's first-cycle projected ones, beside the resets of the windows already at 100 % at the instant. Both halves of that predicate do work. The two-scan half: a peer the correction fills inside its own lag dies at the instant in the corrected scan and is alive at it in the pre-correction one, so a window can be the first event of one scan and not of the other. The died-in-lag half: a death applied AT the instant orders ahead of nothing, so it leaves the first-event flag standing while re-splitting the class from the instant on. The second row is every other record with a positive lag and a date in both scans, over the same columns.",
	);
	out.push("");
	out.push(
		"| split | n | median shift (min) | median excess (min) | p10 excess | p90 excess | within 1 s of own lag |",
	);
	out.push("|---|---:|---:|---:|---:|---:|---:|");
	out.push(
		shiftRow("eligible first events in both scans", checks.shift.firstEvent),
	);
	out.push(shiftRow("every other lagged record", checks.shift.rest));
	out.push("");
	if (checks.shift.firstEvent.n === 0) {
		out.push(
			"No eligible records entered the first row, so it measures nothing about this run.",
		);
		out.push("");
	}

	out.push("### Parity with the current model on lone accounts");
	out.push("");
	out.push(
		"The point of deriving the lag per estimator path. Where an account is the only pooled member of its class, its scenario slope IS its own measured slope, and the lag is derived from the same anchor the current model uses, so wherever that anchor was recoverable and sits behind the replayed instant the two scans project the window from one anchor. The column is the share of records whose corrected ETA sits within 1 s of the current model's, over the first-event records of lone accounts where both models committed to a date, split by the estimator path the reading came from; `other` collects the now-anchored paths, which carry no lag for the correction to advance over. The population also holds the records whose anchor sits AHEAD of the replayed instant: `observationLagMs` clamps those to zero lag, so the corrected scan schedules them from the instant while the current model still anchors its ETA to that future instant.",
	);
	out.push("");
	out.push(
		"One exclusion applies even on a lone account: a record whose OWN corrected exhaustion is still ahead of the instant while another window of its class was filled inside ITS lag. The correction applies that window's death at the instant, so the account is idle until that window's reset and this projection carries a dead span the current model does not model at all. A record whose own exhaustion the correction moved to the instant is not excluded by this predicate: it is not projecting past the instant, so no dead span stands ahead of it.",
	);
	out.push("");
	out.push("| estimator path | n | within 1 s of the current model |");
	out.push("|---|---:|---:|");
	for (const row of checks.parity) {
		out.push(
			`| ${row.path} | ${row.n} | ${row.n === 0 ? "no eligible records" : pct(row.withinToleranceShare)} |`,
		);
	}
	out.push("");

	out.push("### Fixed paired-ETA subset");
	out.push("");
	out.push(
		"Median signed ETA error of the three models on ONE fixed set of records: lifecycle-balanced instants where all three committed to a date and the window's exhaustion was observed. The set is the same for every row, so the rows differ only in which model produced the ETA and not in which records it was medianed over.",
	);
	out.push("");
	out.push("| cohort | model | n | median signed error (min) |");
	out.push("|---|---|---:|---:|");
	for (const row of checks.pairedEta) {
		out.push(
			`| ${row.cohort} | ${row.model} | ${row.n} | ${num(row.medianSignedErrorMinutes, 1)} |`,
		);
	}
	out.push("");

	out.push("### Lag population by estimator path");
	out.push("");
	out.push(
		"Which paths the correction touched and by how much, over one model's records (the lag is a property of the reading, so every model's record at an instant carries the same one). `sample − observation` is the delay between a reading being observed and being stored, on the rows that carry both instants.",
	);
	out.push("");
	out.push(
		"`no anchor` counts the records of a path whose lag could not be derived at all, and the median and p90 beside it are taken over the remaining ones. The regression path anchors its fit by back-solving the ETA it states, so a fit with NO ETA — a flat or falling six-hour fit, which is what an idle account inside a live window produces — has no recoverable anchor. Such a window is scheduled from the replayed instant in BOTH scans and is advanced by nothing, exactly as it was before the correction existed; the column separates that absence from a lag genuinely measured at zero.",
	);
	out.push("");
	out.push(
		"| estimator path | records | no anchor | median lag (min) | p90 lag (min) | rows with both instants | median sample − observation (min) | p90 |",
	);
	out.push("|---|---:|---:|---:|---:|---:|---:|---:|");
	for (const row of checks.population) {
		out.push(
			`| ${row.path} | ${row.records} | ${row.noAnchorRecords} | ${num(row.medianLagMinutes, 2)} | ${num(row.p90LagMinutes, 2)} | ${row.sampleToObservationRecords} | ${num(row.medianSampleToObservationMinutes, 2)} | ${num(row.p90SampleToObservationMinutes, 2)} |`,
		);
	}
	out.push("");
	return out;
}

/** PASS / FAIL / INDETERMINATE, never a blank and never a guess. */
const criterionState = (pass: boolean | null): string =>
	pass === true ? "PASS" : pass === false ? "FAIL" : "INDETERMINATE";

/**
 * One criterion's heading and its value table.
 *
 * Shared by the verdict and the rules scored beside it so the two cannot print
 * the same criterion in two different shapes.
 */
function criterionBlock(criterion: VerdictCriterion): string[] {
	const out: string[] = [];
	out.push(
		`**${criterion.id}. ${criterion.label}: ${criterionState(criterion.pass)}**`,
	);
	out.push("");
	out.push("| value | number |");
	out.push("|---|---:|");
	for (const value of criterion.values) {
		out.push(`| ${value.name} | ${num(value.value, value.digits ?? 3)} |`);
	}
	out.push("");
	return out;
}

/**
 * What criterion D compares for the BASIS, and which of its two legs decided
 * this run, printed beside the criterion instead of left to the rule text.
 *
 * D is the criterion most easily misread as a comparison between share rules,
 * because the basis changed and the prior basis is still scored a section
 * below. It is not one: the comparison is the basis against its own scan with
 * the observation-lag advance switched off, so a difference is the advance's.
 *
 * Every number here is read from the criterion's OWN computed values at render
 * time. {@link VERDICT_RULE} is pre-declared and must carry no number this run
 * produced, so the leg that failed cannot be stated there.
 */
function basisCriterionDNote(criterion: VerdictCriterion): string {
	const computed = (name: string): number | null =>
		criterion.values.find((value) => value.name === name)?.value ?? null;
	const basisF1 = computed(`F1, ${VERDICT_BASIS_MODEL}`);
	const controlF1 = computed(`F1, ${VERDICT_BASIS_CONTROL_MODEL}`);
	const absChange = computed(
		"paired median |error| change vs own control (min)",
	);
	const pairedN = computed("paired n");

	const f1Leg =
		basisF1 == null || controlF1 == null
			? "Its F1 leg has no number this run, so it decides nothing."
			: basisF1 >= controlF1
				? `Its F1 leg holds, at ${num(basisF1)} against the control's ${num(controlF1)} on the lifecycle-balanced any-transition cohort.`
				: `Its F1 leg is the one that FAILED this run: ${num(basisF1)} against the control's ${num(controlF1)} on the lifecycle-balanced any-transition cohort, short by ${num(controlF1 - basisF1)}.`;
	// "too" only when the F1 leg failed as well; an error-only failure must not
	// read as a second failure beside a leg that held.
	const f1Failed = basisF1 != null && controlF1 != null && basisF1 < controlF1;
	const errorLeg =
		absChange == null
			? "Its error leg has no number this run, so it decides nothing."
			: absChange <= 0
				? `Its error leg holds, at ${num(absChange)} min of paired median absolute-error change over the ${num(pairedN, 0)} records both scans dated.`
				: `Its error leg FAILED${f1Failed ? " too" : ""}: the correction landed ${num(absChange)} min further from the truth in paired median absolute error, over the ${num(pairedN, 0)} records both scans dated.`;

	return `D compares \`${VERDICT_BASIS_MODEL}\` with its OWN lag-uncorrected scan, \`${VERDICT_BASIS_CONTROL_MODEL}\` — the same share rule with the observation-lag advance switched off — and with nothing else: it does not compare the proportional rule with the equal split, and no number in it is a statement about \`${PRIOR_BASIS_MODEL}\`. ${f1Leg} ${errorLeg}`;
}

/** The identity block: a property of the basis, printed under the verdict. */
function basisIdentitySection(identity: BasisIdentityCheck): string[] {
	const out: string[] = [];
	out.push("### Identity with the current model on the first assignment");
	out.push("");
	out.push(
		`The identity the basis is constructed to have: while every account whose measured burn is in the class demand is alive AND in the assignment, the demand handed back to an account is the burn it contributed, so it burns at its own measured slope and \`${VERDICT_BASIS_MODEL}\`'s projection IS the current model's. The population is the records whose window the basis's own scan projects entirely on its first assignment — no class window already at 100 % at the instant, no account whose burn joined the class demand withheld from the pool that demand is split over, no class exhaustion of ANY cycle between the instant and this window's own, and no class window filled inside its own observation lag — and where both the basis and the current model committed to a date. The withheld and later-cycle conditions are the two the scan's first-cycle projection list cannot state on its own: one redistributes demand with nothing having died, the other is a death after a reset. Below the tolerance an ETA is the same instant; the column is a count, not a claim about the rest of the replay.`,
	);
	out.push("");
	if (identity.eligible === 0) {
		out.push(
			"No eligible records: nothing in this replay entered this population, so the check measures nothing about this run.",
		);
	} else {
		out.push(
			`n=${identity.eligible} eligible records, ${identity.matching} of which the basis dated within ${IDENTITY_TOLERANCE_MS} ms of the current model (${pct(identity.share)}).`,
		);
	}
	out.push("");
	return out;
}

/** The rules scored beside the basis: the same four criteria, none of them the verdict. */
function besideBasisSection(scored: readonly BesideBasisScores[]): string[] {
	const out: string[] = [];
	out.push("## Share rules beside the basis");
	out.push("");
	out.push(
		`Every other share rule the replay scans, held to the same four criteria as the verdict, computed by the same functions on the same lifecycle-balanced cohorts and against the same comparison models. NONE of it enters the verdict: \`evaluateVerdict\` reads nothing from this section, and the verdict above is the same with or without it. \`${PRIOR_BASIS_MODEL}\` is here because it WAS the verdict basis through v2026.9.19, and is kept scored beside the basis that replaced it so the change of basis can be read rather than taken on trust. Each rule's criterion D is judged against its OWN pre-correction scan; a rule that has none says so instead of borrowing another rule's control.`,
	);
	out.push("");
	out.push(
		`A paired median is taken over the records the pair being compared BOTH dated, so the columns of criterion A are medians over different populations and are not each other's comparators. The scored rule's column and the \`current\` column come from that rule's own pairing with the current model; the \`${VERDICT_BASIS_MODEL}\` column comes from the BASIS's pairing with the current model, and the number the basis is actually judged against — the current model over the basis's own pairing — is under \`## Verdict\` rather than in this table. Each pairing's \`paired n\` is in the value list of the criterion it belongs to: this rule's below the table, the basis's under \`## Verdict\`. A model column is empty where the statistic is already a delta against that model.`,
	);
	out.push("");
	for (const entry of scored) {
		out.push(`### \`${entry.model}\` — ${entry.role}`);
		out.push("");
		out.push(
			`| criterion | statistic | ${entry.model} | ${VERDICT_BASIS_MODEL} | current | ${entry.control ?? "own control"} | result |`,
		);
		out.push("|---|---|---:|---:|---:|---:|---|");
		for (const row of entry.rows) {
			out.push(
				`| ${row.id}. ${row.label} | ${row.statistic} | ${num(row.value)} | ${num(row.verdictBasis)} | ${row.current == null ? EM_DASH : num(row.current)} | ${row.control == null ? EM_DASH : num(row.control)} | ${criterionState(row.pass)} |`,
			);
		}
		out.push("");
		for (const note of entry.notes) {
			out.push(`- ${note}`);
		}
		if (entry.notes.length > 0) out.push("");
		for (const criterion of entry.criteria) {
			out.push(...criterionBlock(criterion));
		}
	}
	return out;
}

/** The report, in the style of the existing `docs/prediction-backtest-*.md`. */
export function formatRedistributionReport(
	input: RedistributionReportInput,
): string {
	const out: string[] = [];
	const { replay, cohorts, verdict } = input;

	out.push(`# ${input.title}`);
	out.push("");
	out.push(`Generated: ${input.generatedAtIso}`);
	out.push("");
	out.push("Reproduce with:");
	out.push("");
	out.push("```");
	out.push(input.command);
	out.push("```");
	out.push("");
	const configKeys = Object.keys(input.config).sort();
	if (configKeys.length > 0) {
		out.push("| config | value |");
		out.push("|---|---|");
		for (const key of configKeys) {
			out.push(`| ${key} | ${input.config[key] ?? EM_DASH} |`);
		}
		out.push("");
	}

	out.push("## Dataset");
	out.push("");
	out.push("| field | value |");
	out.push("|---|---|");
	out.push(`| usage_snapshots rows | ${input.dataset.rows} |`);
	out.push(`| accounts | ${input.dataset.accounts} |`);
	out.push(
		`| providers | ${input.dataset.providers.length ? input.dataset.providers.join(", ") : EM_DASH} |`,
	);
	out.push(`| first sample | ${input.dataset.firstSampleIso} |`);
	out.push(`| last sample | ${input.dataset.lastSampleIso} |`);
	out.push(
		`| replay interval | \`[${iso(replay.range.fromMs)}, ${iso(replay.range.toMs)})\` |`,
	);
	out.push(`| grid instants | ${replay.instants} |`);
	out.push("");

	out.push("## Methodology");
	out.push("");
	out.push(
		"Fixed-grid joint-roster replay. At every instant of the grid the roster is",
	);
	out.push(
		"rebuilt from recorded snapshots and EVERY model is fed the same window",
	);
	out.push("inputs; nothing reads a row after the instant it is replaying.");
	out.push("");
	out.push(
		`- Reading: the newest row per account no older than ${READING_STALE_MS / MINUTE_MS} min (production's projection freshness bar, not the wider display bar). A window whose recorded reset had already passed is dropped, as production's \`projectableWindows\` does.`,
	);
	out.push(
		"- Five-hour prediction: the production OLS over a 6 h lookback, reconstructed WITHOUT the live point (the replay has none). Weekly: no prediction at all, because production emits none — the lifetime average is that window's primary estimator.",
	);
	out.push(
		"- Burn anchors are reconstructed from the revision drops observed up to the instant, and never from later ones. Tiers come from the row's own `plan_tier`/`rate_limit_tier` when it has them (`recorded`), else from today's account row (`assumed`).",
	);
	out.push(
		"- No reset-credit bank is modelled: the credit ledger is not reconstructible per instant, so every model runs without it.",
	);
	out.push(
		"- Truth is PER WINDOW, from the same `deriveOutcome` the per-window backtests use: exhausted at the first observed 100 %, survived only on positive evidence, censored otherwise. Placeholder windows (codex's one-sample 5 h artefacts) are skipped.",
	);
	out.push(
		`- Truth-grid membership at a tick is every account of the class with a loaded snapshot on both sides of it (first loaded row ≤ tick ≤ last loaded row). Outside that loaded span, the account is absent. Inside it, a reading older than ${READING_STALE_MS / MINUTE_MS} minutes censors the tick.`,
	);
	out.push(
		"- Current model: account-level learning, the strict rule that ships — ONE learning window makes the whole account unprojectable.",
	);
	out.push(
		`- Transition tagging: class-wide, ${TRANSITION_WINDOW_MS / HOUR_MS} h after the event, shortened to the dying window's reset for a peer exhaustion when that reset comes sooner. The dying account is excluded from its own event.`,
	);
	out.push(
		"- ETA parity: the current model's beyond-reset ETA is recorded as no prediction, which is the same statement the scenario makes when it projects no exhaustion this cycle.",
	);
	out.push(
		"- Aggregation: the verdict is scored on ONE record per window lifecycle (the median instant), because instants inside one window are not independent draws. Per-record tables are reported beside it.",
	);
	out.push(
		"- Sign convention: signed ETA error is `predicted − observed`, so POSITIVE is predicted-later-than-observed, i.e. OPTIMISTIC.",
	);
	out.push(
		"- Observation lag: `scenario-equal`, `scenario-proportional` and `scenario-headroom` advance each reading over the gap between the instant its estimator measured to and the instant being replayed, at the share slope the first assignment gives it. The lag is taken per estimator path from the same anchor the current model uses: the fit's own last point on the regression path, the observation instant on the observation-anchored lifetime path, and nothing on the now-anchored paths, which carry none. An anchor ahead of the replayed instant clamps to zero lag, while the current model keeps anchoring its own ETA to that future instant, so the two part company there. On a lone account, wherever the anchor was recoverable and sits behind the instant, this projects the window from the same anchor the current model projects it from; a window there can still land elsewhere whenever another window of the class exhausts while this one is still projecting — including a death the correction applies AT the replayed instant — because that suspends the account's burn and the ETA then carries the span it spends dead, which is the scenario's own semantics rather than the redistribution. `scenario-equal-original` is the same equal split with that advance switched off, and `scenario-proportional-original` is the proportional rule with it switched off: each is the control its OWN rule's criterion D is measured against, and the equal pair is additionally the subject of the mechanism checks below.",
	);
	out.push("");
	out.push("Verdict rule, declared before the run:");
	out.push("");
	out.push("```");
	out.push(VERDICT_RULE);
	out.push("```");
	out.push("");

	out.push("## Transition events");
	out.push("");
	if (replay.events.length === 0) {
		out.push("No transitions detected in the replay interval.");
		out.push("");
	} else {
		out.push("| id | kind | at | ends | class | account | window | detail |");
		out.push("|---:|---|---|---|---|---|---|---|");
		for (const event of replay.events) {
			out.push(
				`| ${event.id} | ${event.kind} | ${iso(event.atMs)} | ${iso(event.endsAtMs)} | ${event.demandClass} | ${event.accountName} | ${event.windowKind ?? EM_DASH} | ${event.detail} |`,
			);
		}
		out.push("");
	}
	out.push("| tag | events | share of grid instants |");
	out.push("|---|---:|---:|");
	for (const row of replay.tagCoverage) {
		out.push(`| ${row.tag} | ${row.events} | ${pct(row.instantFraction)} |`);
	}
	out.push("");

	out.push("## Scores");
	out.push("");
	out.push(...cohortSection(cohorts.overall, "### Overall"));
	out.push(...cohortSection(cohorts.anyTransition, "### Any transition"));
	for (const cohort of cohorts.byTag) {
		out.push(...cohortSection(cohort, `### ${cohort.label}`));
	}
	out.push("### Peer exhaustion by time since death");
	out.push("");
	out.push(
		"IF a survivor's own lookback already contains the traffic it absorbed, the scenario would be adding that demand a second time and would read pessimistic the longer the peer has been dead. That is the hypothesis this cohort exists to test, not a property the measurements here establish; the slope table below is what speaks to it. Disclosed, not corrected.",
	);
	out.push("");
	out.push(
		"Buckets are fine (30 min at the start) because a five-hour window is only 300 minutes long: at the three coarse buckets this replaced, one bucket held a whole five-hour lifecycle. Reported combined and split by window kind, because the two kinds absorb a death on completely different timescales.",
	);
	out.push("");
	for (const group of cohorts.peerExhaustionBySinceDeath) {
		out.push(`#### ${group.scope}`);
		out.push("");
		for (const cohort of group.buckets) {
			out.push(...cohortSection(cohort, `##### since death ${cohort.label}`));
		}
	}
	out.push(...slopeTrajectorySection(cohorts.slopeTrajectory));
	out.push("### By class and window");
	out.push("");
	for (const cohort of cohorts.byClassAndKind) {
		out.push(...cohortSection(cohort, `#### ${cohort.label}`));
	}
	out.push(
		...cohortSection(
			cohorts.scenarioExtra,
			"### Scenario-only cohort (instants the current model withholds)",
		),
	);
	out.push("### Bootstrap");
	out.push("");
	out.push(
		"Block bootstrap of `scenario − baseline`, resampling blocks rather than instants (window lifecycles overall, episodes on transitions). For `scenario-proportional`, the verdict basis, the baseline is the current model for criteria A-C and its own pre-correction scan `scenario-proportional-original` for criterion D; both rows are printed for both cohorts. `scenario-equal`, the prior basis scored under `Share rules beside the basis`, carries the same two pairs so its criteria C and D can be read there. The headroom rule carries none, and that section states its C and D as indeterminate rather than resampling it against a baseline that is not its own.",
	);
	out.push("");
	out.push(
		"| cohort | scenario | baseline | statistic | p2.5 | p50 | p97.5 | resamples |",
	);
	out.push("|---|---|---|---|---:|---:|---:|---:|");
	for (const entry of cohorts.bootstrap) {
		out.push(
			`| ${entry.label} | ${entry.scenario} | ${entry.baseline} | ${entry.statistic} | ${num(entry.p2_5)} | ${num(entry.p50)} | ${num(entry.p97_5)} | ${entry.samples} |`,
		);
	}
	out.push("");

	out.push(...absorptionSection(replay));
	out.push(...requestVolumeChangeSection(input.absorption));

	out.push(...observationLagSection(observationLagChecks(replay, cohorts)));

	out.push("## Prediction churn");
	out.push("");
	out.push(
		'How much each model\'s answer MOVES between one instant and the next, over adjacent usable instants of the same window lifecycle. Accuracy says nothing about stability: an estimator that alternates between "out in 40 minutes" and "not this cycle" every grid step is unusable at any F1.',
	);
	out.push("");
	out.push(
		"Lifecycle-balanced the same way the score tables are: the median (and p90) is taken WITHIN a lifecycle first, then across lifecycles. `flip rate` is the fraction of adjacent pairs where the yes/no verdict changed. A pair is two instants EXACTLY one grid step apart, both usable for that model: nothing bridges a skipped instant or one the model could not answer, so a hole in the series does not read as churn.",
	);
	out.push("");
	out.push(
		"Each model is measured on its OWN usable instants, over every replay record rather than the common cohort the score tables use: another model abstaining, or an outcome nobody observed, does not make a model's two consecutive answers unmeasurable. Each row of a cohort is therefore an honest statement about one model, and not a like-for-like comparison the way the scores are.",
	);
	out.push("");
	out.push(
		"Not a `BacktestStatistic`: that vocabulary is a function of an unordered bag of records, churn is a function of an ordered sequence inside a lifecycle, and `BacktestRecord` carries no lifecycle id to group by. There is therefore no bootstrap CI on these numbers.",
	);
	out.push("");
	out.push(
		"| cohort | model | lifecycles | pairs | median abs ETA change (min) | p90 abs ETA change (min) | median flip rate |",
	);
	out.push("|---|---|---:|---:|---:|---:|---:|");
	for (const row of cohorts.churn) {
		out.push(
			`| ${row.cohort} | ${row.model} | ${row.lifecycles} | ${row.pairs} | ${num(row.medianEtaChangeMinutes, 1)} | ${num(row.p90EtaChangeMinutes, 1)} | ${num(row.medianFlipRate)} |`,
		);
	}
	out.push("");

	out.push("## Pool calibration (all-out within 14 d)");
	out.push("");
	out.push(
		"The pool-level claim, scored against the observed grid. What the table can say is how often a predicted pool-out was followed by a horizon with no observed all-out tick and at most 5 % of its ticks censored.",
	);
	out.push("");
	const calibratedClasses = [
		...new Set([
			...replay.calibration.map((row) => row.demandClass),
			...replay.allOutIntervals.map((interval) => interval.demandClass),
		]),
	].sort((a, b) => a.localeCompare(b));
	for (const demandClass of calibratedClasses) {
		const intervals = replay.allOutIntervals.filter(
			(interval) => interval.demandClass === demandClass,
		);
		if (intervals.length === 0) {
			out.push(
				`- \`${demandClass}\`: no all-out tick observed in the interval`,
			);
			continue;
		}
		for (const interval of intervals) {
			out.push(
				`- \`${demandClass}\`: all-out \`${iso(interval.fromMs)}\`–\`${iso(interval.toMs)}\` (\`${interval.ticks}\` ticks)`,
			);
		}
	}
	out.push("");
	out.push(
		"These intervals are the positives behind the `observed out` column; pool-level recall and F1 are not stated here because per-window scores decide the verdict.",
	);
	out.push("");
	out.push(
		"Only instants whose full 14-day horizon fits inside the replay interval are calibrated.",
	);
	out.push("");
	out.push(
		"| class | model | instants | abstained | predicted out | observed out | observed non-outage | censored | false-alarm rate |",
	);
	out.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
	for (const row of replay.calibration) {
		out.push(
			`| ${row.demandClass} | ${row.model} | ${row.instants} | ${row.abstained} | ${row.predictedOut} | ${row.observedOut} | ${row.observedNonOutage} | ${row.censored} | ${num(row.falseAlarmRate)} |`,
		);
	}
	out.push("");

	out.push("## Verdict");
	out.push("");
	out.push("```");
	out.push(VERDICT_RULE);
	out.push("```");
	out.push("");
	for (const criterion of verdict.criteria) {
		out.push(...criterionBlock(criterion));
		if (criterion.id === "D") {
			out.push(basisCriterionDNote(criterion));
			out.push("");
		}
	}
	out.push("| cohort | records | lifecycles | episodes |");
	out.push("|---|---:|---:|---:|");
	for (const entry of verdict.n) {
		out.push(
			`| ${entry.cohort} | ${entry.records} | ${entry.lifecycles} | ${entry.episodes} |`,
		);
	}
	out.push("");
	const usableOf = (model: ReplayModel): number =>
		replay.records.filter((record) => record.model === model && record.usable)
			.length;
	out.push(
		`Coverage of the basis and its control: ${VERDICT_BASIS_MODEL} ${usableOf(VERDICT_BASIS_MODEL)} usable records, ${VERDICT_BASIS_CONTROL_MODEL} ${usableOf(VERDICT_BASIS_CONTROL_MODEL)}.`,
	);
	out.push("");
	out.push(`**Verdict: ${verdict.verdict}**`);
	out.push("");
	if (verdict.pendingCohorts.length > 0) {
		const many = verdict.pendingCohorts.length > 1;
		out.push(
			`PROVISIONAL: the ${verdict.pendingCohorts.join(", ")} ${many ? "pairs hold" : "pair holds"} no usable, uncensored weekly record common to all models, and ${many ? "each carries" : "it carries"} at least one tagged weekly window still pending at the label horizon, so ${many ? "their" : "its"} weekly half is unlabelled. Re-run the reproduce command above with a later \`--to\` once those windows have reset, and re-read the verdict.`,
		);
		out.push("");
	}
	if (verdict.unlabelledCohorts.length > 0) {
		out.push(
			`No usable, uncensored weekly records common to all models for: ${verdict.unlabelledCohorts.join(", ")}. No weekly window of ${verdict.unlabelledCohorts.length > 1 ? "those pairs" : "that pair"} is pending at the label horizon; missing evidence can reflect absent tagged survivors, withheld predictions, or censored truth.`,
		);
		out.push("");
	}
	if (
		verdict.pendingCohorts.length === 0 &&
		verdict.unlabelledCohorts.length === 0
	) {
		out.push(
			"No pending or unlabelled transition tag/class pairs were identified.",
		);
		out.push("");
	}
	out.push("What step 4 does with this:");
	out.push("");
	out.push(
		"- `replace`: the scenario becomes the headline runway, with the current model kept beside it for one release.",
	);
	out.push(
		"- `keep-scenario`: the scenario stays a labelled second line and exclusion keeps the headline.",
	);
	out.push(
		"- `insufficient-evidence`: nothing ships; the run repeats when the missing windows have completed.",
	);
	out.push("");
	out.push(...basisIdentitySection(basisIdentityCheck(replay)));

	out.push(...besideBasisSection(evaluateBesideBasis(cohorts)));

	out.push("## Known limits");
	out.push("");
	for (const limit of input.knownLimits) out.push(`- ${limit}`);
	out.push("");

	out.push("## Notes");
	out.push("");
	out.push(
		`- Placeholder windows skipped: ${replay.placeholderWindowsSkipped}.`,
	);
	for (const note of input.notes) out.push(`- ${note}`);
	out.push("");

	return out.join("\n");
}

/**
 * The share of the common cohort at which the report names the class the
 * records came from, rather than leaving the reader to infer it from the
 * per-class table. The share is counted over RAW records while every headline
 * score is lifecycle-balanced, so a dominant class does not entail that the
 * overall numbers restate that class's.
 */
const DOMINANT_CLASS_SHARE = 0.8;

/** The limits every run of this report has to state, plus what it measured. */
export function knownLimitsFor(
	replay: ReplayResult,
	cohorts: CohortSet,
	verdict: Verdict,
	tokenCoverage: RequestTokenCoverage | null,
): string[] {
	const limits = [
		'Pause and removal cannot be replayed: `usage_snapshots` rows cascade-delete with their account, so no removed account has history, and `accounts.paused` keeps none. The scenario\'s `presence: "demand-only"` path is covered by its unit tests only.',
		"Snapshots before 2026-08-24 carry no `plan_tier`/`rate_limit_tier` and no `observed_at`. Tiers there are today's, marked `assumed`; without an observation instant the weekly full-confidence path is unavailable to BOTH models, so the two are still compared like for like.",
		"No reset-credit bank is modelled, and no live usage point is injected — the replay only has what the sampler stored.",
		"The headroom share rule is reported, never used as the verdict basis. The verdict basis is the proportional share rule, re-declared on 2026-09-07 after it was scored as a candidate beside the equal split, which had been the basis through v2026.9.19; both the equal split and the headroom rule are scored beside it and neither enters the verdict.",
		"The verdict basis weights each account by its OWN measured demand, and that demand is the same fitted slope the current model projects from. Each alive account's share of a kind's class demand is its own measured demand for the kind over the ALIVE accounts' measured demand for it. The denominator is the survivors, not the class: with burns of 80, 20 and 10 and the 80 dead, the two survivors take two thirds and one third of the whole class demand, not 20/110 and 10/110 of it. A window still learning has no accepted measured-demand contribution — the preparation withholds it whatever its fitted slope says — so it carries no weight of its own and takes demand only through the rule's equal-split fallback; where a class's live accounts are all learning for a kind, the basis IS the equal split for that kind.",
		"IF a survivor's own lookback already contains the traffic it absorbed, the scenario would be adding that demand a second time. Whether it does is a hypothesis this replay reports on (the peer-exhaustion cohort and the survivor slope table) rather than a property these measurements establish; nothing here corrects for it.",
		"The observation-lag advance never rewinds the scan clock below the instant being replayed: a window that fills inside its lag dies AT that instant, though the projection it records carries the true, earlier one. Any redistribution such a death causes therefore starts at the instant, not at the fill.",
		"A reading whose row carries no `observed_at` and whose estimator is the now-anchored lifetime average has no derivable lag and is advanced by nothing. That is a real absence, not a measured zero, and the mechanism section reports those records under `unknown` rather than folding them into the fresh bucket.",
		"The absorption section's first reading at or above 100 % is a sampled crossing, not the instant the window filled, so every fill duration there is an upper bound within the sample gap printed beside it in that section's `median resolution` column.",
		"`requests.timestamp` is persistence time, not request time, and the death instant is the first sampled 100 % reading rather than the moment routing changed. Persistence lag and sampled exhaustion timing misalign the request-volume intervals with request execution and with the routing change; the direction and magnitude of the resulting error are unmeasured, and the misalignment matters more as the half-width shrinks.",
		"`requests` has no foreign key to `accounts`, so a deleted account's traffic is unattributed. Such an account also has no snapshots, which cascade-delete with it, so it can appear neither in a survivor set nor in the availability history the survivor set is derived from.",
		"Pause has no history in the database, so an account idle during a matched-control interval cannot be told from one deliberately parked, and no adjustment for that is possible.",
		"A regression fit that states no ETA — a flat or falling six-hour fit, which an idle account inside a live window produces — has no recoverable anchor either: the fit's anchor is back-solved from the ETA. Such a window is scheduled from the replayed instant in BOTH scans, which is pre-existing behaviour and not something the correction introduced, and the lag-population table counts those records apart from the lags it medians.",
	];

	// Measured, never assumed: one model's records only, because every model
	// scores the SAME windows and counting all of them would just multiply
	// every class by `REPLAY_MODELS.length`.
	const classRecords = new Map<string, number>();
	let classTotal = 0;
	for (const record of cohorts.common) {
		if (record.model !== "current") continue;
		const classId = servableClassFor(record.provider ?? "unknown").classId;
		classRecords.set(classId, (classRecords.get(classId) ?? 0) + 1);
		classTotal++;
	}
	const dominant = [...classRecords.entries()].sort((a, b) => b[1] - a[1])[0];
	if (dominant != null && classTotal > 0) {
		const share = dominant[1] / classTotal;
		if (share >= DOMINANT_CLASS_SHARE) {
			limits.push(
				`\`${dominant[0]}\` supplies ${(share * 100).toFixed(1)} % of the overall common-cohort records.`,
			);
		}
	}
	if (verdict.pendingCohorts.length > 0) {
		const many = verdict.pendingCohorts.length > 1;
		limits.push(
			`Pending at this run (tag and servable class): ${verdict.pendingCohorts.join(", ")}. ${many ? "Those pairs hold" : "That pair holds"} no usable, uncensored weekly record common to all models, and ${many ? "each carries" : "it carries"} at least one tagged weekly window still pending at the label horizon, so ${many ? "their" : "its"} weekly half is unlabelled and the verdict is provisional.`,
		);
	}
	if (verdict.unlabelledCohorts.length > 0) {
		limits.push(
			`No usable, uncensored weekly records common to all models for: ${verdict.unlabelledCohorts.join(", ")}. No weekly window of ${verdict.unlabelledCohorts.length > 1 ? "those pairs" : "that pair"} is pending at the label horizon; missing evidence can reflect absent tagged survivors, withheld predictions, or censored truth.`,
		);
	}
	const positives = REPLAY_MODELS.map((model) => {
		const metrics = scoreRecords(
			replay.records.filter((record) => record.model === model),
		);
		return `${model}: ${metrics.confusion.tp + metrics.confusion.fn} actual positives of ${metrics.scored} scored`;
	});
	limits.push(
		`Positive counts (all records, per model) — ${positives.join("; ")}.`,
	);
	limits.push(
		tokenCoverage == null
			? "`total_tokens` is null or zero on a minority of attributed `requests` rows and those contribute zero to the absorption measurement's token basis. This run did not read the table, so it states no count."
			: `\`total_tokens\` is null or zero on ${tokenCoverage.zeroOrNullTokenRows} of ${tokenCoverage.attributedRows} attributed \`requests\` rows in the loaded span (${tokenCoverage.attributedRows > 0 ? ((tokenCoverage.zeroOrNullTokenRows / tokenCoverage.attributedRows) * 100).toFixed(1) : "0.0"} %); those contribute zero to the absorption measurement's token basis.`,
	);
	return limits;
}
