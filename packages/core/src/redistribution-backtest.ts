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
	/** The demand-conserving scan as it ships, with the observation-lag advance. */
	| "scenario-equal"
	/** The same equal split with the PRE-CORRECTION scan — the lag-parity control. */
	| "scenario-equal-original"
	| "scenario-headroom";

/** Every scan the replay runs, in the order the report prints them. */
export const REPLAY_MODELS: readonly ReplayModel[] = [
	"current",
	"scenario-equal",
	"scenario-equal-original",
	"scenario-headroom",
];

/** The models that are a {@link computeCapacityRunwayScenario} call. */
export type ScenarioModel = Exclude<ReplayModel, "current">;

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
 * Reported as a secondary column and never as the verdict basis (that is the
 * equal split, pre-declared). When every weight is zero — every alive account
 * at 100 % or unmetered-with-no-capacity — it falls back to the equal split:
 * there is nothing left to weight by, and the scan's next event kills them all
 * anyway.
 */
export const headroomShareRule: ShareRule = (candidates) => {
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
		: equalShareRule(candidates);
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
 * `scenario-equal` and `scenario-equal-original` differ in ONE argument, which
 * is the whole point of the pair: the equal split is held fixed so the only
 * thing the comparison can attribute a difference to is the observation-lag
 * advance. `scenario-equal` stays the pre-declared verdict basis.
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
	// A name for the report's table. An account with snapshots but no row left
	// in `accounts` falls back to its id, which is all the history has.
	const nameByAccount = new Map<string, string>();
	for (const account of accounts) {
		nameByAccount.set(account.accountId, account.name);
	}
	const nameOf = (accountId: string): string =>
		nameByAccount.get(accountId) ?? accountId;

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
	firstSampleMs: number;
	firstSampleUtilization: number;
	lastSampleMs: number;
	/** First point in the lifecycle with utilization >= 100; null means censored. */
	firstHundredMs: number | null;
	/** `firstHundredMs` minus the sample before it: the resolution the crossing sits inside. */
	resolutionMs: number | null;
	peerLostInPrefix: boolean;
	peerLostDuringFill: boolean;
	exposureObservable: boolean;
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
					firstSampleMs,
					firstSampleUtilization:
						window.points[lifecycle.startIndex].utilization,
					lastSampleMs,
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

export interface WindowFillRow {
	exposure: string;
	window: WindowFillScope;
	/** Windows of this cell that reached 100 %. */
	fills: number;
	/** Windows of this cell whose last sample was still below 100 %. */
	censored: number;
	fillFraction: number | null;
	medianFillHours: number | null;
	medianObservedSpanHours: number | null;
	medianUnobservedHeadMinutes: number | null;
	medianResolutionMinutes: number | null;
	/** The one column over the CENSORED windows: window start to last sample. */
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
				observable.filter((fill) => fill.peerLostDuringFill),
			),
			...rowsFor(
				"no peer lost during fill",
				observable.filter((fill) => !fill.peerLostDuringFill),
			),
		],
		filled: measurable.filter((fill) => fill.firstHundredMs != null).length,
		censored: measurable.filter((fill) => fill.firstHundredMs == null).length,
		noResetOnSegment: fills.filter((fill) => fill.windowStartMs == null).length,
		firstSampleAlreadyFull: fills.filter(
			(fill) =>
				fill.windowStartMs != null && fill.firstSampleUtilization >= 100,
		).length,
	};
}

// ---------------------------------------------------------------------------
// Causal absorption shares around a death
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

/**
 * The primary half-width. NOT tuned: it is the production regression lookback
 * the replay already reconstructs, fixed before any number was read.
 */
export const ABSORPTION_HALF_WIDTH_MS = 6 * HOUR_MS;

/** The second, always-computed half-width. Printed beside the first, never chosen against it. */
export const ABSORPTION_NARROW_HALF_WIDTH_MS = 60 * MINUTE_MS;

/** Below this much dead span there is no post window worth dividing by. */
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
	/** For the control's "no account of the class at 100 %" test. */
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
	/** Share of the survivors' PRE-death rate. Null when they had none. */
	preShare: number | null;
}

/**
 * One (instant × half-width × basis) measurement.
 *
 * CAUSAL CONSTRAINT: `preRate*`, `dyingPreShare`, `survivorPreShare` and
 * `equalSplitShare` read nothing at or after the instant. The moved-volume
 * split (`movedPositive`, `topMovedShare`) is necessarily observed after it —
 * it IS the moved volume — and that is what is being split, not what is
 * weighting it.
 */
export interface AbsorptionMeasurement {
	basis: AbsorptionBasis;
	/** Whole minutes actually counted, which is never `W` exactly (see the straddle rule). */
	preMinutes: number;
	postMinutes: number;
	preVolumeDying: number;
	postVolumeDying: number;
	preVolumeSurvivors: number;
	postVolumeSurvivors: number;
	preRateDying: number;
	preRateSurvivors: number;
	postRateSurvivors: number;
	/** `preRateDying / (preRateDying + preRateSurvivors)`; null for the placebo, which has no dying account. */
	dyingPreShare: number | null;
	/** `1 / |S|`, the split the scenario assumes. */
	equalSplitShare: number | null;
	/** `(postRateSurvivors − preRateSurvivors) / preRateDying`; null when the dying account had no pre-death traffic. */
	alpha: number | null;
	/** `postRateSurvivors / preRateSurvivors`; null when the survivors had none. */
	survivorRateRatio: number | null;
	/** `sum over S of max(delta, 0)`. */
	movedPositive: number;
	topMoverAccountId: string | null;
	/** The largest positive delta over `movedPositive`; null when nothing moved. */
	topMovedShare: number | null;
	/** That same account's PRE-death share of the survivors' rate. */
	topMoverPreShare: number | null;
	survivors: AbsorptionSurvivorRates[];
}

export type AbsorptionMeasurementSet = Record<
	AbsorptionBasis,
	AbsorptionMeasurement
>;

/** Why a matched control could not be used. Counted, never silently skipped. */
export type AbsorptionControlRejection =
	| "outside-loaded-span"
	| "peer-exhaustion-inside"
	| "class-at-hundred";

export interface AbsorptionControl {
	/** `-7 d` or `+7 d`, in the order the report prints them. */
	label: string;
	atMs: number;
	eligible: boolean;
	rejection: AbsorptionControlRejection | null;
	/** Null when ineligible: an unread interval is not a measured zero. */
	measurements: AbsorptionMeasurementSet | null;
}

/** One analysed death, with everything the per-death table prints. */
export interface AbsorptionDeath {
	eventId: number;
	atMs: number;
	demandClass: string;
	windowKind: BacktestWindowKind | null;
	dyingAccountId: string;
	dyingAccountName: string;
	survivorIds: string[];
	halfWidthMs: number;
	narrowHalfWidthMs: number;
	wide: AbsorptionMeasurementSet;
	narrow: AbsorptionMeasurementSet;
	controls: AbsorptionControl[];
	controlsEligible: number;
	/** The other servable class over the same interval; null when it has no account yet. */
	placebo: AbsorptionMeasurementSet | null;
	placeboAccountIds: string[];
}

export type AbsorptionExclusionReason =
	| "noRequestCoverage"
	| "postWindowTooShort"
	| "noPreDeathDyingTraffic"
	| "noSurvivors"
	| "outsideLoadedSpan";

const ABSORPTION_EXCLUSION_REASONS: readonly AbsorptionExclusionReason[] = [
	"noRequestCoverage",
	"postWindowTooShort",
	"noPreDeathDyingTraffic",
	"noSurvivors",
	"outsideLoadedSpan",
];

/** A death that was not measured, printed rather than dropped. */
export interface AbsorptionExcludedDeath {
	eventId: number;
	atMs: number;
	demandClass: string;
	windowKind: BacktestWindowKind | null;
	dyingAccountId: string;
	dyingAccountName: string;
	reason: AbsorptionExclusionReason;
}

/** The populations the aggregate table has one row per, times the two bases. */
export const ABSORPTION_POPULATION_LABELS = {
	wide: "at death (W = min(6 h, dead span))",
	narrow: "at death (W = min(60 min, dead span))",
	controlBefore: "matched control -7 d",
	controlAfter: "matched control +7 d",
	placebo: "other-class placebo at death",
} as const;

export interface AbsorptionGroupRow {
	population: string;
	basis: AbsorptionBasis;
	/** Measurements in this population, whether or not each statistic is defined. */
	n: number;
	medianSurvivorRateRatio: number | null;
	medianAlpha: number | null;
	medianTopMovedShare: number | null;
	medianEqualSplitShare: number | null;
	medianTopMoverPreShare: number | null;
}

/** The headline: paired within a death, so the level confound cancels. */
export interface AbsorptionPairedDelta {
	basis: AbsorptionBasis;
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
	groups: AbsorptionGroupRow[];
	paired: AbsorptionPairedDelta[];
	controlsIneligible: Record<AbsorptionControlRejection, number>;
	halfWidthMs: number;
	narrowHalfWidthMs: number;
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

/**
 * One measurement at `atMs` over half-width `W`.
 *
 * STRADDLE RULE: a bucket is in pre only if it ends at or before `atMs`, and in
 * post only if it starts at or after it, so the minute containing the instant
 * is in neither half. Rates divide by the minutes actually counted, not by `W`.
 *
 * `dyingAccountId` is null for the other-class placebo, which has no dying
 * account: `alpha` and `dyingPreShare` are then null rather than zero.
 */
function measureAbsorption(
	basis: AbsorptionBasis,
	index: ReadonlyMap<string, BucketIndex>,
	dyingAccountId: string | null,
	survivorIds: readonly string[],
	atMs: number,
	halfWidthMs: number,
): AbsorptionMeasurement {
	const pre = halfSlots(atMs - halfWidthMs, atMs);
	const post = halfSlots(atMs, atMs + halfWidthMs);
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

	const survivors: AbsorptionSurvivorRates[] = rates.map((entry) => ({
		...entry,
		preShare: preRateSurvivors > 0 ? entry.preRate / preRateSurvivors : null,
	}));

	const movedPositive = survivors.reduce(
		(sum, entry) => sum + Math.max(entry.delta, 0),
		0,
	);
	let top: AbsorptionSurvivorRates | null = null;
	for (const entry of survivors) {
		if (entry.delta <= 0) continue;
		if (top == null || entry.delta > top.delta) top = entry;
	}
	const preRateTotal = preRateDying + preRateSurvivors;

	return {
		basis,
		preMinutes: pre.minutes,
		postMinutes: post.minutes,
		preVolumeDying,
		postVolumeDying,
		preVolumeSurvivors,
		postVolumeSurvivors,
		preRateDying,
		preRateSurvivors,
		postRateSurvivors,
		dyingPreShare:
			dyingAccountId == null || preRateTotal <= 0
				? null
				: preRateDying / preRateTotal,
		equalSplitShare: survivors.length > 0 ? 1 / survivors.length : null,
		alpha:
			preRateDying > 0
				? (postRateSurvivors - preRateSurvivors) / preRateDying
				: null,
		survivorRateRatio:
			preRateSurvivors > 0 ? postRateSurvivors / preRateSurvivors : null,
		movedPositive,
		topMoverAccountId: top?.accountId ?? null,
		topMovedShare:
			top != null && movedPositive > 0 ? top.delta / movedPositive : null,
		topMoverPreShare: top?.preShare ?? null,
		survivors,
	};
}

const measureBoth = (
	index: ReadonlyMap<string, BucketIndex>,
	dyingAccountId: string | null,
	survivorIds: readonly string[],
	atMs: number,
	halfWidthMs: number,
): AbsorptionMeasurementSet => ({
	requests: measureAbsorption(
		"requests",
		index,
		dyingAccountId,
		survivorIds,
		atMs,
		halfWidthMs,
	),
	tokens: measureAbsorption(
		"tokens",
		index,
		dyingAccountId,
		survivorIds,
		atMs,
		halfWidthMs,
	),
});

function absorptionGroupRow(
	population: string,
	basis: AbsorptionBasis,
	members: readonly AbsorptionMeasurement[],
): AbsorptionGroupRow {
	const defined = (
		pick: (entry: AbsorptionMeasurement) => number | null,
	): number[] =>
		members
			.map(pick)
			.filter(
				(value): value is number => value != null && Number.isFinite(value),
			);
	return {
		population,
		basis,
		n: members.length,
		medianSurvivorRateRatio: percentileOf(
			defined((entry) => entry.survivorRateRatio),
			0.5,
		),
		medianAlpha: percentileOf(
			defined((entry) => entry.alpha),
			0.5,
		),
		medianTopMovedShare: percentileOf(
			defined((entry) => entry.topMovedShare),
			0.5,
		),
		medianEqualSplitShare: percentileOf(
			defined((entry) => entry.equalSplitShare),
			0.5,
		),
		medianTopMoverPreShare: percentileOf(
			defined((entry) => entry.topMoverPreShare),
			0.5,
		),
	};
}

/**
 * Causal absorption shares around each peer death.
 *
 * Every share and every weight is derived from history STRICTLY BEFORE the
 * death instant. Deriving a share from the whole run and then using it to build
 * a share rule would tune the rule on the run that judges it; that is the flaw
 * this measurement exists to remove, and
 * `absorptionChecks` never reads a bucket at or after `D` into one.
 *
 * MEASUREMENT ONLY: nothing here fits, tunes or thresholds anything, and no
 * model, cohort or verdict consumes it. In particular there is no split of the
 * deaths on any cut point read off these same numbers.
 */
export function absorptionChecks(input: AbsorptionInput): AbsorptionChecks {
	const index = indexBuckets(input.buckets);
	const classOf = new Map<string, string>();
	for (const account of input.accounts) {
		classOf.set(account.accountId, servableClassFor(account.provider).classId);
	}

	const allDeaths = input.events.filter(
		(event) => event.kind === "peer-exhaustion",
	);
	const deathsInRange = allDeaths.filter(
		(event) =>
			event.atMs >= input.range.fromMs && event.atMs < input.range.toMs,
	);

	const deaths: AbsorptionDeath[] = [];
	const excludedDeaths: AbsorptionExcludedDeath[] = [];
	const excluded: Record<AbsorptionExclusionReason, number> = {
		noRequestCoverage: 0,
		postWindowTooShort: 0,
		noPreDeathDyingTraffic: 0,
		noSurvivors: 0,
		outsideLoadedSpan: 0,
	};
	const controlsIneligible: Record<AbsorptionControlRejection, number> = {
		"outside-loaded-span": 0,
		"peer-exhaustion-inside": 0,
		"class-at-hundred": 0,
	};
	const exclude = (
		event: TransitionEvent,
		reason: AbsorptionExclusionReason,
	): void => {
		excluded[reason]++;
		excludedDeaths.push({
			eventId: event.id,
			atMs: event.atMs,
			demandClass: event.demandClass,
			windowKind: event.windowKind,
			dyingAccountId: event.accountId,
			dyingAccountName: event.accountName,
			reason,
		});
	};

	for (const event of deathsInRange) {
		// Class membership as of the death: an account that joins the class
		// afterwards was never a candidate for the traffic that moved.
		const members = input.accounts
			.filter(
				(account) =>
					classOf.get(account.accountId) === event.demandClass &&
					account.createdAtMs <= event.atMs,
			)
			.map((account) => account.accountId)
			.sort((a, b) => a.localeCompare(b));
		const survivorIds = members.filter(
			(accountId) => accountId !== event.accountId,
		);
		if (survivorIds.length === 0) {
			exclude(event, "noSurvivors");
			continue;
		}

		const deadSpanMs = event.endsAtMs - event.atMs;
		if (deadSpanMs < ABSORPTION_MIN_HALF_WIDTH_MS) {
			exclude(event, "postWindowTooShort");
			continue;
		}
		const halfWidthMs = Math.min(ABSORPTION_HALF_WIDTH_MS, deadSpanMs);
		const narrowHalfWidthMs = Math.min(
			ABSORPTION_NARROW_HALF_WIDTH_MS,
			deadSpanMs,
		);
		if (
			event.atMs - halfWidthMs < input.requestsFromMs ||
			event.atMs + halfWidthMs > input.requestsToMs
		) {
			exclude(event, "outsideLoadedSpan");
			continue;
		}

		const wide = measureBoth(
			index,
			event.accountId,
			survivorIds,
			event.atMs,
			halfWidthMs,
		);
		const coverage =
			wide.requests.preVolumeDying +
			wide.requests.postVolumeDying +
			wide.requests.preVolumeSurvivors +
			wide.requests.postVolumeSurvivors;
		if (coverage === 0) {
			exclude(event, "noRequestCoverage");
			continue;
		}
		if (wide.requests.preRateDying === 0) {
			exclude(event, "noPreDeathDyingTraffic");
			continue;
		}

		const controls: AbsorptionControl[] = [];
		for (const offset of [
			-ABSORPTION_CONTROL_OFFSET_MS,
			ABSORPTION_CONTROL_OFFSET_MS,
		]) {
			const atMs = event.atMs + offset;
			const fromMs = atMs - halfWidthMs;
			const toMs = atMs + halfWidthMs;
			let rejection: AbsorptionControlRejection | null = null;
			if (fromMs < input.requestsFromMs || toMs > input.requestsToMs) {
				rejection = "outside-loaded-span";
			} else if (
				allDeaths.some(
					(other) =>
						other.demandClass === event.demandClass &&
						other.atMs >= fromMs &&
						other.atMs <= toMs,
				)
			) {
				rejection = "peer-exhaustion-inside";
			} else if (
				members.some((accountId) =>
					(input.series.get(accountId)?.rows ?? []).some(
						(row) =>
							row.sampledAt >= fromMs &&
							row.sampledAt <= toMs &&
							WINDOW_KINDS.some((kind) => (pctOf(row, kind) ?? 0) >= 100),
					),
				)
			) {
				rejection = "class-at-hundred";
			}
			if (rejection != null) controlsIneligible[rejection]++;
			controls.push({
				label: offset < 0 ? "-7 d" : "+7 d",
				atMs,
				eligible: rejection == null,
				rejection,
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
							)
						: null,
			});
		}

		const placeboAccountIds = input.accounts
			.filter(
				(account) =>
					classOf.get(account.accountId) !== event.demandClass &&
					account.createdAtMs <= event.atMs,
			)
			.map((account) => account.accountId)
			.sort((a, b) => a.localeCompare(b));

		deaths.push({
			eventId: event.id,
			atMs: event.atMs,
			demandClass: event.demandClass,
			windowKind: event.windowKind,
			dyingAccountId: event.accountId,
			dyingAccountName: event.accountName,
			survivorIds,
			halfWidthMs,
			narrowHalfWidthMs,
			wide,
			narrow: measureBoth(
				index,
				event.accountId,
				survivorIds,
				event.atMs,
				narrowHalfWidthMs,
			),
			controls,
			controlsEligible: controls.filter((control) => control.eligible).length,
			placebo:
				placeboAccountIds.length > 0
					? measureBoth(index, null, placeboAccountIds, event.atMs, halfWidthMs)
					: null,
			placeboAccountIds,
		});
	}

	// Sorted by the dying account's pre-death share, so the reader sees the
	// shape rather than a cut point somebody chose. Nulls last.
	deaths.sort((a, b) => {
		const left = a.wide.requests.dyingPreShare;
		const right = b.wide.requests.dyingPreShare;
		if (left == null && right == null) return a.atMs - b.atMs;
		if (left == null) return 1;
		if (right == null) return -1;
		return left - right || a.atMs - b.atMs;
	});

	const controlAt = (label: string): AbsorptionControl[] =>
		deaths
			.map((death) =>
				death.controls.find(
					(control) => control.label === label && control.eligible,
				),
			)
			.filter((control): control is AbsorptionControl => control != null);

	const populations: Array<{
		label: string;
		sets: Array<AbsorptionMeasurementSet | null>;
	}> = [
		{
			label: ABSORPTION_POPULATION_LABELS.wide,
			sets: deaths.map((death) => death.wide),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.narrow,
			sets: deaths.map((death) => death.narrow),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.controlBefore,
			sets: controlAt("-7 d").map((control) => control.measurements),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.controlAfter,
			sets: controlAt("+7 d").map((control) => control.measurements),
		},
		{
			label: ABSORPTION_POPULATION_LABELS.placebo,
			sets: deaths.map((death) => death.placebo),
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
	// hour: two unpaired medians would leave the seasonal level in.
	const paired: AbsorptionPairedDelta[] = ABSORPTION_BASES.map((basis) => {
		const deltas: number[] = [];
		for (const death of deaths) {
			const atDeath = death.wide[basis].survivorRateRatio;
			if (atDeath == null) continue;
			const controlRatios = death.controls
				.filter((control) => control.eligible)
				.map((control) => control.measurements?.[basis].survivorRateRatio)
				.filter((value): value is number => value != null);
			if (controlRatios.length === 0) continue;
			const mean =
				controlRatios.reduce((sum, value) => sum + value, 0) /
				controlRatios.length;
			deltas.push(atDeath - mean);
		}
		return { basis, n: deltas.length, medianDelta: percentileOf(deltas, 0.5) };
	});

	return {
		deaths,
		excludedDeaths,
		excluded,
		peerExhaustionEvents: deathsInRange.length,
		groups,
		paired,
		controlsIneligible,
		halfWidthMs: ABSORPTION_HALF_WIDTH_MS,
		narrowHalfWidthMs: ABSORPTION_NARROW_HALF_WIDTH_MS,
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
		const corrected = scenarioOutcomes.get("scenario-equal");
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
		const firstEventCorrected = firstEventInScan("scenario-equal");
		const firstEventOriginal = firstEventInScan("scenario-equal-original");
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
		): boolean => {
			const exhaustions =
				scenarioOutcomes.get("scenario-equal")?.projectedExhaustions ?? [];
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
	/** `scenario-equal` against the CURRENT model. */
	pairedBias: PairedBias;
	/** `scenario-equal` against the PRE-CORRECTION scan. */
	pairedBiasVsOriginal: PairedBias;
	/** How much closer to the truth the correction lands than the original scan. */
	pairedAbsVsOriginal: PairedAbsDelta;
}

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
	return {
		label,
		records: records.filter((record) => record.model === "current").length,
		lifecycles: lifecycles.size,
		episodes: episodes.size,
		balanced: metricsByModel(balanced),
		perRecord: metricsByModel(records),
		pairedBias: pairedSignedMedian(balanced, "scenario-equal", "current"),
		pairedBiasVsOriginal: pairedSignedMedian(
			balanced,
			"scenario-equal",
			"scenario-equal-original",
		),
		pairedAbsVsOriginal: pairedAbsMedian(
			balanced,
			"scenario-equal",
			"scenario-equal-original",
		),
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
 * A bootstrap CI of `scenario-equal - baseline`, where the baseline is either
 * the model that ships or the pre-correction scan.
 *
 * The baseline is a FIELD rather than part of the label so a lookup cannot
 * resolve the wrong entry by prefix: criterion C is defined against the
 * current model, and the original-scan CI sits in the same table under the
 * same cohort label.
 */
export interface RedistributionBootstrapEntry extends ReportBootstrapEntry {
	baseline: "current" | "scenario-equal-original";
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
	const bootstrap: RedistributionBootstrapEntry[] = [
		...blockBootstrap(
			OVERALL_BOOTSTRAP_LABEL,
			ofModel(overallBalanced, "scenario-equal"),
			ofModel(overallBalanced, "current"),
			lifecycleBlock,
			result.seed,
			BOOTSTRAP_ITERATIONS,
			"current",
		),
		...blockBootstrap(
			TRANSITION_BOOTSTRAP_LABEL,
			ofModel(transitionBalanced, "scenario-equal"),
			ofModel(transitionBalanced, "current"),
			episodeBlock,
			result.seed,
			BOOTSTRAP_ITERATIONS,
			"current",
		),
		...blockBootstrap(
			OVERALL_BOOTSTRAP_LABEL,
			ofModel(overallBalanced, "scenario-equal"),
			ofModel(overallBalanced, "scenario-equal-original"),
			lifecycleBlock,
			result.seed,
			BOOTSTRAP_ITERATIONS,
			"scenario-equal-original",
		),
		...blockBootstrap(
			TRANSITION_BOOTSTRAP_LABEL,
			ofModel(transitionBalanced, "scenario-equal"),
			ofModel(transitionBalanced, "scenario-equal-original"),
			episodeBlock,
			result.seed,
			BOOTSTRAP_ITERATIONS,
			"scenario-equal-original",
		),
	];

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

/** Compute every observation-lag check the report prints. */
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
	"MODELS. `scenario-equal` is the demand-conserving scan that ADVANCES each",
	"   reading over its observation lag; `scenario-equal-original` is the same",
	"   equal split with the pre-correction scan, which schedules every window",
	"   from the instant of the replay however old its reading is. Both are",
	"   scored on the COMMON cohort: every model usable, truth observed.",
	"",
	"A. NOT MORE OPTIMISTIC ON TRANSITIONS. On the any-transition cohort,",
	"   lifecycle-balanced: max(paired median signed error of scenario-equal, 0)",
	"   <= max(paired median signed error of current, 0), AND recall of",
	"   scenario-equal >= recall of current. (Positive signed error = predicted",
	"   later than observed = optimistic; a model that is EARLY is not rewarded",
	"   for it, which is why both sides are clamped at 0.)",
	"B. BETTER AT TRANSITIONS. On the same cohort, F1 of scenario-equal >= F1 of",
	"   current.",
	"C. NO SIGNIFICANT OVERALL LOSS. On the overall cohort, the block-bootstrap",
	"   95% CI of F1(scenario-equal) - F1(current) is not entirely below zero",
	"   (p97.5 >= 0). Read from the entry whose BASELINE is the current model.",
	"D. NOT WORSE THAN THE ORIGINAL SCENARIO. On the any-transition common",
	"   cohort, lifecycle-balanced: F1(scenario-equal) >= F1(scenario-equal-",
	"   original), AND the paired median of |error of scenario-equal| - |error",
	"   of scenario-equal-original| <= 0 over the records both models dated.",
	"   Recall of both is printed beside D and is NOT judged: the correction",
	"   can change the ORDER of a class's events, and with it which windows are",
	"   dated before their reset at all, in EITHER direction.",
	"",
	"replace = A and B and C and D. keep-scenario = any criterion FALSE.",
	"insufficient-evidence = no criterion false, at least one indeterminate.",
	"The verdict basis is the EQUAL share rule, pre-declared; the headroom rule",
	"is reported beside it and is never the basis.",
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
 * All three of label, statistic and baseline are matched EXACTLY: the table
 * carries the same cohort label twice, once per baseline, and a prefix match
 * would resolve whichever happens to come first.
 */
const bootstrapEntry = (
	entries: readonly RedistributionBootstrapEntry[],
	label: string,
	statistic: string,
	baseline: RedistributionBootstrapEntry["baseline"],
): RedistributionBootstrapEntry | null =>
	entries.find(
		(entry) =>
			entry.label === label &&
			entry.statistic === statistic &&
			entry.baseline === baseline,
	) ?? null;

/**
 * Apply the pre-declared rule. Nothing here reads a number the report does not
 * print, and nothing is decided on a value that is absent — an absent value is
 * INDETERMINATE, never a pass and never a fail.
 */
export function evaluateVerdict(
	cohorts: CohortSet,
	replay: ReplayResult,
): Verdict {
	const transition = cohorts.anyTransition;
	const scenario = metricsOf(transition.balanced, "scenario-equal");
	const current = metricsOf(transition.balanced, "current");
	const bias = transition.pairedBias;

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
				name: "paired median signed error, scenario-equal (min)",
				value: bias.medianA,
			},
			{
				name: "paired median signed error, current (min)",
				value: bias.medianB,
			},
			{ name: "paired n", value: bias.n, digits: 0 },
			{ name: "recall, scenario-equal", value: scenario?.recall ?? null },
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
			{ name: "F1, scenario-equal", value: scenario?.f1 ?? null },
			{ name: "F1, current", value: current?.f1 ?? null },
		],
	};

	const overallCi = bootstrapEntry(
		cohorts.bootstrap,
		OVERALL_BOOTSTRAP_LABEL,
		"f1",
		"current",
	);
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

	const original = metricsOf(transition.balanced, "scenario-equal-original");
	const absDelta = transition.pairedAbsVsOriginal;
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
			{ name: "F1, scenario-equal", value: scenario?.f1 ?? null },
			{
				name: "F1, scenario-equal-original",
				value: original?.f1 ?? null,
			},
			{
				name: "paired median |error| change vs original (min)",
				value: absDelta.medianDeltaMinutes,
			},
			{ name: "paired n", value: absDelta.n, digits: 0 },
			// Printed, never judged — see the rule text.
			{ name: "recall, scenario-equal", value: scenario?.recall ?? null },
			{
				name: "recall, scenario-equal-original",
				value: original?.recall ?? null,
			},
		],
	};

	const criteria = [criterionA, criterionB, criterionC, criterionD];
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
	 * The causal absorption measurement, precomputed by the caller the way
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
	out.push(
		`Paired median signed error (n=${cohort.pairedBias.n}; positive = optimistic): scenario-equal ${num(cohort.pairedBias.medianA, 1)} min, current ${num(cohort.pairedBias.medianB, 1)} min.`,
	);
	out.push("");
	out.push(
		`Against the pre-correction scan (n=${cohort.pairedBiasVsOriginal.n}): scenario-equal ${num(cohort.pairedBiasVsOriginal.medianA, 1)} min, scenario-equal-original ${num(cohort.pairedBiasVsOriginal.medianB, 1)} min; paired median change in absolute error ${num(cohort.pairedAbsVsOriginal.medianDeltaMinutes, 1)} min (n=${cohort.pairedAbsVsOriginal.n}, negative = the correction lands closer).`,
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
	"| exposure | window | fills | censored | fill fraction | median fill (h) | median observed span (h) | median unobserved head (min) | median resolution (min) | median censored span (h) |";
const FILL_TABLE_ALIGN = "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|";

const fillTableRow = (row: WindowFillRow): string =>
	`| ${row.exposure} | ${row.window} | ${row.fills} | ${row.censored} | ${pct(row.fillFraction)} | ${num(row.medianFillHours, 2)} | ${num(row.medianObservedSpanHours, 2)} | ${num(row.medianUnobservedHeadMinutes, 1)} | ${num(row.medianResolutionMinutes, 1)} | ${num(row.medianCensoredSpanHours, 2)} |`;

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
		"How long a window took to reach its first reading at or above 100 %, measured from the window start its reset implies (`reset - window length`, the same derivation the projections use) to that reading. The population is every non-placeholder window lifecycle in the replayed snapshot history, both window kinds, every account the history holds, split by whether the account's demand class lost a peer early in the window. Early is a FIXED prefix of the window: its first hour for a five-hour window, its first 24 hours for a weekly one. A peer's death counts whichever of the peer's own windows filled, because an account at 100 % in either window leaves routing and its share of the class demand lands on the survivors.",
	);
	out.push("");
	out.push(
		"A median over only the windows that filled selects on the outcome: the windows that never filled are the slow ones, so this median understates typical time-to-fill, and it understates it more in whichever cell censors more. Compare the `censored` column before comparing medians.",
	);
	out.push("");
	out.push(
		"A peer dies because its class is busy, and the same busy period fills a survivor faster, so a shorter fill under peer loss is equally consistent with absorption and with common cause. This section is direct and slope-free; it is not causal.",
	);
	out.push("");
	out.push(
		"Three populations sit outside the two arms rather than inside them. A segment whose reset column is null carries no derivable window start, so it has no fill duration to state. A lifecycle whose first sample already reads 100 % filled before observation began, which is not a fill duration either. And a lifecycle whose prefix is not wholly inside the replayed range has its own row: peer deaths are only detected inside that range, so such a window would read as `no peer lost` from missing data alone. The reconciliation line below accounts for all of them.",
	);
	out.push("");
	out.push(
		"`fills` counts the windows of a cell that reached 100 %, `censored` the ones whose last sample was still below it. `median fill` runs from the derived window start, `median observed span` from the first sample instead, and `median unobserved head` is the gap between those two origins, i.e. how much of the window had already elapsed when the sampler first saw it. `median resolution` is the gap between the crossing sample and the sample before it. `median censored span` is the one column taken over the censored windows: window start to last sample.",
	);
	out.push("");
	out.push(FILL_TABLE_HEADER);
	out.push(FILL_TABLE_ALIGN);
	for (const row of tally.prefixRows) out.push(fillTableRow(row));
	out.push("");
	out.push(
		"The same rows again, split instead by whether a same-class peer died anywhere between the window start and the crossing. That definition is length-biased in the direction of longer fills, because a longer fill has more calendar time in which to contain a peer death, and that is why the fixed-prefix split above is the primary one. Both are printed; neither was chosen on its result.",
	);
	out.push("");
	out.push(FILL_TABLE_HEADER);
	out.push(FILL_TABLE_ALIGN);
	for (const row of tally.duringFillRows) out.push(fillTableRow(row));
	out.push("");
	out.push(
		`Every cell with fewer than ${RAW_FILL_DURATION_LIMIT} fills prints its fill durations, sorted, in hours. At that n a median is not a summary of anything, and the values themselves are what a reader can judge.`,
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
		`Reconciliation: ${tally.filled} filled + ${tally.censored} censored + ${tally.noResetOnSegment} with no reset on the segment + ${tally.firstSampleAlreadyFull} already full at the first sample + ${replay.placeholderLifecyclesSkipped} placeholder lifecycles skipped = ${lifecycles} window lifecycles.`,
	);
	out.push("");
	return out;
}

const ABSORPTION_GROUP_HEADER =
	"| population | basis | n | median survivor rate ratio | median alpha | median top-mover share of moved volume | median equal split 1/S | median top-mover pre-death share |";
const ABSORPTION_GROUP_ALIGN = "|---|---|---:|---:|---:|---:|---:|---:|";

const ABSORPTION_DEATH_HEADER =
	"| event | instant | class | window | dying account | basis | W (min) | pre volume (dying) | pre volume (survivors) | post volume (survivors) | dying pre-share | alpha | survivor rate ratio | top mover | top-mover moved share | top-mover pre-share | equal split | controls eligible |";
const ABSORPTION_DEATH_ALIGN =
	"|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|";

function absorptionDeathRow(
	death: AbsorptionDeath,
	basis: AbsorptionBasis,
): string {
	const cell = death.wide[basis];
	return [
		`| ${death.eventId}`,
		iso(death.atMs),
		death.demandClass,
		death.windowKind ?? EM_DASH,
		death.dyingAccountName,
		basis,
		num(death.halfWidthMs / MINUTE_MS, 0),
		num(cell.preVolumeDying, 0),
		num(cell.preVolumeSurvivors, 0),
		num(cell.postVolumeSurvivors, 0),
		pct(cell.dyingPreShare),
		num(cell.alpha),
		num(cell.survivorRateRatio),
		cell.topMoverAccountId ?? EM_DASH,
		pct(cell.topMovedShare),
		pct(cell.topMoverPreShare),
		pct(cell.equalSplitShare),
		`${death.controlsEligible} |`,
	].join(" | ");
}

/**
 * The measurement whose every share and weight predates the death it is about.
 *
 * Prose rule for this section, and the reason it reads as flatly as it does:
 * it states what was measured and over which population, and never what a
 * number ought to be, would confirm, or is consistent with.
 */
function causalAbsorptionSection(
	absorption: AbsorptionChecks | null,
): string[] {
	const out: string[] = [];
	out.push("### Causal absorption shares around a death");
	out.push("");
	if (absorption == null) {
		out.push(
			"The request table was unreadable in this run — this database has no `requests` — so no traffic share was measured here. Every number this subsection would print comes from that table; none of them is estimated from the snapshot history instead.",
		);
		out.push("");
		return out;
	}

	out.push(
		`What each survivor's own request volume did around the instant a peer of its demand class reached 100 %. The population is every peer-exhaustion event inside the replayed interval, ${absorption.peerExhaustionEvents} of them, reduced by the exclusions reconciled at the end of this subsection. Volumes come from the \`requests\` table on a fixed ${REQUEST_BUCKET_MS / MINUTE_MS}-minute grid, per account, and are turned into rates by dividing by the minutes actually counted.`,
	);
	out.push("");
	out.push(
		"Nothing at or after the death enters any share or weight: the dying account's pre-death share, each survivor's pre-death share, and the equal split are all functions of the window `[D − W, D)` alone. The moved-volume split is necessarily observed after the death, because it IS the moved volume; the causal constraint binds the shares and the weights, not the observable being split.",
	);
	out.push("");
	out.push(
		`Two half-widths are ALWAYS computed and always printed beside each other: \`W = min(${absorption.halfWidthMs / HOUR_MS} h, dead span)\` and \`W = min(${absorption.narrowHalfWidthMs / MINUTE_MS} min, dead span)\`. Neither was selected on its result, and neither is a fitted parameter: the wide one is the production regression lookback this replay already reconstructs, and the narrow one is a fixed second reading of the same event. The pre and post windows are symmetric, so the ratio is directly interpretable and diurnal drift is held to one window's width.`,
	);
	out.push("");
	out.push(
		`The bucket containing the death is in neither half — a bucket enters pre only if it ends at or before \`D\`, and post only if it starts at or after it — so up to one minute is uncounted on each side.`,
	);
	out.push("");
	out.push(
		"`requests.timestamp` is stamped when the row is persisted rather than when the request was made, so the pre/post boundary is fuzzy by the write lag. That biases alpha upward: a pre-death survivor request whose row is stamped after the death lands in the post window.",
	);
	out.push("");
	out.push(
		"Both bases are reported because request count and token volume answer different questions — the scenario redistributes capacity units, not requests — and where the two disagree, that disagreement is the finding rather than an error in one of them.",
	);
	out.push("");
	out.push(
		"No confidence interval, bootstrap or p-value is computed here. The blocks are deaths, they cluster on a handful of accounts and in time, and this many correlated blocks cannot support an interval. There is no threshold split of any kind either: a cut point read off the same data it is applied to is a fit rather than a measurement. The per-death table below prints every analysed death, sorted by the dying account's pre-death share, and is the deliverable at this n; the aggregate is a summary of it.",
	);
	out.push("");
	out.push(
		"Deaths happen because the class is busy. The matched control removes the seasonal level and the placebo removes a pool-wide surge, but a class-specific surge that both killed the peer and raised survivor traffic is not removable from observational data.",
	);
	out.push("");

	out.push(
		"Definitions, per basis, over the survivor set `S` and the dying account `d`:",
	);
	out.push("");
	out.push("```");
	out.push(
		"preRate_a          = volume(a, [D-W, D)) / minutes counted in [D-W, D)",
	);
	out.push(
		"dyingPreShare      = preRate_d / (preRate_d + sum over S of preRate_s)",
	);
	out.push("survivorPreShare_s = preRate_s / sum over S of preRate_s");
	out.push("equalSplitShare    = 1 / |S|");
	out.push("alpha              = (postRateSurv - preRateSurv) / preRateDying");
	out.push("survivorRateRatio  = postRateSurv / preRateSurv");
	out.push("delta_s            = postRate_s - preRate_s");
	out.push("movedPositive      = sum over S of max(delta_s, 0)");
	out.push("topMovedShare      = max_s max(delta_s, 0) / movedPositive");
	out.push("topMoverPreShare   = survivorPreShare of that same account");
	out.push("```");
	out.push("");
	out.push(
		"A quantity with no value prints a dash and is never coerced to zero: alpha has no value when the dying account had no pre-death traffic, the top-mover share has none when no survivor's rate rose, and the survivor rate ratio has none when the survivors had no pre-death traffic.",
	);
	out.push("");

	out.push(
		`Matched controls sit at the same instant ±${ABSORPTION_CONTROL_OFFSET_MS / DAY_MS} d, so weekday and hour are both matched, and are measured over the IDENTICAL survivor set at the IDENTICAL half-width. A control is used only when its whole interval lies inside the loaded request span, no peer-exhaustion event of the same class falls inside it, and no account of the class reads at or above 100 % at any snapshot inside it. Ineligible controls are counted rather than skipped: ${absorption.controlsIneligible["outside-loaded-span"]} outside the loaded span, ${absorption.controlsIneligible["peer-exhaustion-inside"]} holding a same-class death, ${absorption.controlsIneligible["class-at-hundred"]} with an account of the class already at 100 %.`,
	);
	out.push("");
	out.push(
		"The other-class placebo measures the same ratio over the other servable class's accounts across the same interval at the death. It is thin by construction, and it is uninformative for anthropic deaths before 2026-09-04, when the codex class held a single account and so had no survivor set to speak of.",
	);
	out.push("");

	out.push(ABSORPTION_GROUP_HEADER);
	out.push(ABSORPTION_GROUP_ALIGN);
	for (const row of absorption.groups) {
		out.push(
			`| ${row.population} | ${row.basis} | ${row.n} | ${num(row.medianSurvivorRateRatio)} | ${num(row.medianAlpha)} | ${pct(row.medianTopMovedShare)} | ${pct(row.medianEqualSplitShare)} | ${pct(row.medianTopMoverPreShare)} |`,
		);
	}
	out.push("");
	out.push(
		"Paired within a death, over the same accounts and the same weekday and hour; where both offsets are eligible their ratios are averaged first. Two unpaired medians would leave the seasonal level in.",
	);
	out.push("");
	for (const entry of absorption.paired) {
		out.push(
			`- \`${entry.basis}\`: paired median (ratio at death minus ratio at matched control): ${num(entry.medianDelta)} over ${entry.n} ${entry.n === 1 ? "death" : "deaths"} with an eligible control.`,
		);
	}
	out.push("");

	if (absorption.deaths.length === 0) {
		out.push(
			"No death was analysed in this run. The aggregate rows above print their zero counts rather than being omitted, and the reconciliation below states where every death went.",
		);
		out.push("");
	} else {
		out.push(
			"Every analysed death, one row pair per death — requests above tokens — because eighteen columns twice over is not a table anyone can read. Volumes are raw counts and raw tokens over the half-window; rates are those divided by the minutes counted.",
		);
		out.push("");
		out.push(ABSORPTION_DEATH_HEADER);
		out.push(ABSORPTION_DEATH_ALIGN);
		for (const death of absorption.deaths) {
			for (const basis of ABSORPTION_BASES) {
				out.push(absorptionDeathRow(death, basis));
			}
		}
		out.push("");
	}

	if (absorption.excludedDeaths.length > 0) {
		out.push("Deaths that were not measured, printed rather than dropped:");
		out.push("");
		out.push(
			"| event | instant | class | window | dying account | excluded by |",
		);
		out.push("|---:|---|---|---|---|---|");
		for (const death of absorption.excludedDeaths) {
			out.push(
				`| ${death.eventId} | ${iso(death.atMs)} | ${death.demandClass} | ${death.windowKind ?? EM_DASH} | ${death.dyingAccountName} | ${death.reason} |`,
			);
		}
		out.push("");
	}
	const reconciliation = ABSORPTION_EXCLUSION_REASONS.map(
		(reason) => `${absorption.excluded[reason]} ${reason}`,
	).join(" + ");
	out.push(
		`Reconciliation: ${absorption.deaths.length} analysed + ${reconciliation} = ${absorption.peerExhaustionEvents} peer-exhaustion events in the replayed interval.`,
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
		"What the correction actually did to the projections, as opposed to what it scored. `scenario-equal` advances each reading over its observation lag; `scenario-equal-original` is the identical equal split with that advance switched off. Each check below states what it measures, which records enter it, which are excluded and by which predicate, and prints the number that falls out of that population. None of them states what the number ought to be; reading it against the mechanism described is the reader's job. An eligible set of zero is reported as such rather than as a pass.",
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
		"- Observation lag: `scenario-equal` and `scenario-headroom` advance each reading over the gap between the instant its estimator measured to and the instant being replayed, at the share slope the first assignment gives it. The lag is taken per estimator path from the same anchor the current model uses: the fit's own last point on the regression path, the observation instant on the observation-anchored lifetime path, and nothing on the now-anchored paths, which carry none. An anchor ahead of the replayed instant clamps to zero lag, while the current model keeps anchoring its own ETA to that future instant, so the two part company there. On a lone account, wherever the anchor was recoverable and sits behind the instant, this projects the window from the same anchor the current model projects it from; a window there can still land elsewhere whenever another window of the class exhausts while this one is still projecting — including a death the correction applies AT the replayed instant — because that suspends the account's burn and the ETA then carries the span it spends dead, which is the scenario's own semantics rather than the redistribution. `scenario-equal-original` is the same equal split with that advance switched off, and is the control the mechanism checks below are measured against.",
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
		"Block bootstrap of `scenario-equal − baseline`, resampling blocks rather than instants (window lifecycles overall, episodes on transitions). The baseline is the current model for criteria A-C and the pre-correction scan for criterion D; both rows are printed for both cohorts.",
	);
	out.push("");
	out.push(
		"| cohort | baseline | statistic | p2.5 | p50 | p97.5 | resamples |",
	);
	out.push("|---|---|---|---:|---:|---:|---:|");
	for (const entry of cohorts.bootstrap) {
		out.push(
			`| ${entry.label} | ${entry.baseline} | ${entry.statistic} | ${num(entry.p2_5)} | ${num(entry.p50)} | ${num(entry.p97_5)} | ${entry.samples} |`,
		);
	}
	out.push("");

	out.push(...absorptionSection(replay));
	out.push(...causalAbsorptionSection(input.absorption));

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
		const state =
			criterion.pass === true
				? "PASS"
				: criterion.pass === false
					? "FAIL"
					: "INDETERMINATE";
		out.push(`**${criterion.id}. ${criterion.label}: ${state}**`);
		out.push("");
		out.push("| value | number |");
		out.push("|---|---:|");
		for (const value of criterion.values) {
			out.push(`| ${value.name} | ${num(value.value, value.digits ?? 3)} |`);
		}
		out.push("");
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
		`Coverage of the two equal-split scans: scenario-equal ${usableOf("scenario-equal")} usable records, scenario-equal-original ${usableOf("scenario-equal-original")}.`,
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
		"The headroom share rule is reported, never used as the verdict basis. The verdict basis is the equal split, pre-declared.",
		"IF a survivor's own lookback already contains the traffic it absorbed, the scenario would be adding that demand a second time. Whether it does is a hypothesis this replay reports on (the peer-exhaustion cohort and the survivor slope table) rather than a property these measurements establish; nothing here corrects for it.",
		"The observation-lag advance never rewinds the scan clock below the instant being replayed: a window that fills inside its lag dies AT that instant, though the projection it records carries the true, earlier one. Any redistribution such a death causes therefore starts at the instant, not at the fill.",
		"A reading whose row carries no `observed_at` and whose estimator is the now-anchored lifetime average has no derivable lag and is advanced by nothing. That is a real absence, not a measured zero, and the mechanism section reports those records under `unknown` rather than folding them into the fresh bucket.",
		"The absorption section's first reading at or above 100 % is a sampled crossing, not the instant the window filled, so every fill duration there is an upper bound within the sample gap printed beside it in that section's `median resolution` column.",
		"`requests.timestamp` is persistence time, not request time, so the pre/post boundary of the causal absorption measurement is fuzzy by the write lag, and the resulting bias in alpha is upward.",
		"`requests` has no foreign key to `accounts`, so a deleted account's traffic is unattributed. Such an account also has no snapshots, which cascade-delete with it, and so cannot appear as a survivor in the absorption measurement either.",
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
