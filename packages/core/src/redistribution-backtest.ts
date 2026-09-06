import type { PredictionPoint, UsageBurnAnchor } from "@clankermux/types";
import {
	computeCapacityRunway,
	estimateWindowExhaustion,
	isLearningEstimate,
	RUNWAY_HORIZON_MS,
	type RunwayAccountInput,
	type RunwayOutcome,
	type RunwayWindowInput,
} from "./capacity-runway";
import {
	computeCapacityRunwayScenario,
	equalShareRule,
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

export type ReplayModel = "current" | "scenario-equal" | "scenario-headroom";

export const REPLAY_MODELS: readonly ReplayModel[] = [
	"current",
	"scenario-equal",
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

/** The share rule behind each scenario model. */
export const SHARE_RULES: Record<Exclude<ReplayModel, "current">, ShareRule> = {
	"scenario-equal": equalShareRule,
	"scenario-headroom": headroomShareRule,
};

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
	scenarioOutcomes: Map<Exclude<ReplayModel, "current">, RunwayScenarioOutcome>;
}

export interface InstantReplay {
	records: RedistributionRecord[];
	classes: ClassReplay[];
	placeholderWindowsSkipped: number;
	/**
	 * `${tag}::${demandClass}` → seven-day windows the label horizon dropped
	 * while carrying that tag. A pair with a count > 0 is unlabelled only
	 * because its weekly truth is still unfolding, which a later `--to` fixes;
	 * a pair with no count never had a tagged weekly window at all.
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
	/** Default {@link SHARE_RULES}. One rule per scenario model. */
	shareRules?: Record<Exclude<ReplayModel, "current">, ShareRule>;
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
		const scenarioOutcomes = new Map<
			Exclude<ReplayModel, "current">,
			RunwayScenarioOutcome
		>();
		const shareRules = options?.shareRules ?? SHARE_RULES;
		for (const model of ["scenario-equal", "scenario-headroom"] as const) {
			scenarioOutcomes.set(
				model,
				computeCapacityRunwayScenario(inputs, T, RUNWAY_HORIZON_MS, {
					shareRule: shareRules[model],
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

		for (const entry of entries) {
			// Account-level learning, the current model's strict rule: ONE learning
			// window makes the WHOLE account unprojectable.
			const estimates = new Map(
				entry.windows.map((window) => [
					window.kind,
					estimateWindowExhaustion(window.input, T),
				]),
			);
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
				// distinguishes a (tag, class) pair that a later `--to` can label
				// from one this roster can never label.
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
				};

				const estimate = estimates.get(window.kind);
				const currentUsable =
					!learningAtT && estimate != null && estimate.source !== "none";
				// A beyond-reset ETA is "not this cycle", which is the same statement
				// as the scenario's absent projection: both models are held to what
				// they can express about the window in front of them.
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

				for (const model of ["scenario-equal", "scenario-headroom"] as const) {
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
	 * Predicted-out instants whose 14 days were observed to hold NO outage, over
	 * the predicted-out instants whose truth is determinate. `null` with no
	 * determinate denominator — never 0, which would read as "no false alarms".
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
				[
					"scenario-equal",
					classReplay.scenarioOutcomes.get("scenario-equal")?.kind ?? "unknown",
				],
				[
					"scenario-headroom",
					classReplay.scenarioOutcomes.get("scenario-headroom")?.kind ??
						"unknown",
				],
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
	const a: number[] = [];
	const b: number[] = [];
	for (const entry of byKey.values()) {
		const first = entry.get(modelA);
		const second = entry.get(modelB);
		if (first == null || second == null) continue;
		if (first.predictedEtaMs == null || second.predictedEtaMs == null) continue;
		if (first.outcome.kind !== "exhausted") continue;
		a.push((first.predictedEtaMs - first.outcome.atMs) / MINUTE_MS);
		b.push((second.predictedEtaMs - first.outcome.atMs) / MINUTE_MS);
	}
	const median = (values: number[]): number | null => {
		if (values.length === 0) return null;
		const sorted = [...values].sort((x, y) => x - y);
		return sorted[Math.max(0, Math.ceil(0.5 * sorted.length) - 1)];
	};
	return { n: a.length, medianA: median(a), medianB: median(b) };
}

export interface CohortScores {
	label: string;
	/** Records per model in the per-record view. */
	records: number;
	lifecycles: number;
	episodes: number;
	balanced: ReportEstimatorMetrics[];
	perRecord: ReportEstimatorMetrics[];
	pairedBias: PairedBias;
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
	};
}

const metricsOf = (
	rows: readonly ReportEstimatorMetrics[],
	model: ReplayModel,
): BacktestMetrics | null =>
	rows.find((row) => row.estimator === model)?.metrics ?? null;

const SINCE_DEATH_BUCKETS: Array<{ label: string; maxMs: number }> = [
	{ label: "<1h", maxMs: HOUR_MS },
	{ label: "1-5h", maxMs: 5 * HOUR_MS },
	{ label: ">5h", maxMs: Number.POSITIVE_INFINITY },
];

export interface CohortSet {
	overall: CohortScores;
	anyTransition: CohortScores;
	byTag: CohortScores[];
	peerExhaustionBySinceDeath: CohortScores[];
	byClassAndKind: CohortScores[];
	scenarioExtra: CohortScores;
	bootstrap: ReportBootstrapEntry[];
	/** Records common to all three models, after `commonCohort`. */
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
	current: readonly RedistributionRecord[],
	blockOf: (record: RedistributionRecord) => string,
	seed: number,
	iterations: number,
): ReportBootstrapEntry[] {
	const clone = (records: readonly RedistributionRecord[]): BacktestRecord[] =>
		records.map((record) => ({ ...record, accountId: blockOf(record) }));
	const statistics = [
		"f1",
		"medianAbsErrorMinutes",
		"medianSignedErrorMinutes",
	] as const;
	return statistics.map((statistic) => {
		const ci = bootstrapDelta(clone(scenario), clone(current), {
			iterations,
			seed,
			statistic,
		});
		return {
			label,
			statistic,
			p2_5: ci.p2_5,
			p50: ci.p50,
			p97_5: ci.p97_5,
			samples: ci.samples,
		};
	});
}

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
	const peerExhaustionBySinceDeath = SINCE_DEATH_BUCKETS.map(
		(bucket, index) => {
			const lower = index === 0 ? 0 : SINCE_DEATH_BUCKETS[index - 1].maxMs;
			return scoreCohort(
				bucket.label,
				peerRecords.filter(
					(record) =>
						(record.sinceDeathMs ?? 0) >= lower &&
						(record.sinceDeathMs ?? 0) < bucket.maxMs,
				),
			);
		},
	);

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
	const bootstrap = [
		...blockBootstrap(
			"Overall (block = window lifecycle)",
			overallBalanced.filter((record) => record.model === "scenario-equal"),
			overallBalanced.filter((record) => record.model === "current"),
			(record) => record.lifecycleId,
			result.seed,
			BOOTSTRAP_ITERATIONS,
		),
		...blockBootstrap(
			"Any transition (block = episode)",
			transitionBalanced.filter((record) => record.model === "scenario-equal"),
			transitionBalanced.filter((record) => record.model === "current"),
			(record) =>
				record.eventIds.length > 0
					? String(Math.min(...record.eventIds))
					: record.lifecycleId,
			result.seed,
			BOOTSTRAP_ITERATIONS,
		),
	];

	return {
		overall,
		anyTransition,
		byTag,
		peerExhaustionBySinceDeath,
		byClassAndKind,
		scenarioExtra,
		bootstrap,
		common: commonRecords,
	};
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** The rule, printed verbatim in the report and evaluated by `evaluateVerdict`. */
export const VERDICT_RULE = [
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
	"   (p97.5 >= 0).",
	"",
	"replace = A and B and C. keep-scenario = any criterion FALSE.",
	"insufficient-evidence = no criterion false, at least one indeterminate.",
	"The verdict basis is the EQUAL share rule, pre-declared; the headroom rule",
	"is reported beside it and is never the basis.",
].join("\n");

export interface VerdictCriterion {
	id: "A" | "B" | "C";
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
	 * verdict `provisional`: a later `--to` labels them.
	 */
	pendingCohorts: string[];
	/**
	 * `(tag, class)` pairs with no labelled weekly record and none pending
	 * either — the class had no sibling to tag, or every tagged weekly record
	 * was withheld or censored. Structural in this data: re-running later cannot
	 * label them, so they never make the verdict provisional.
	 */
	unlabelledCohorts: string[];
	n: Array<{
		cohort: string;
		records: number;
		lifecycles: number;
		episodes: number;
	}>;
}

const bootstrapEntry = (
	entries: readonly ReportBootstrapEntry[],
	label: string,
	statistic: string,
): ReportBootstrapEntry | null =>
	entries.find(
		(entry) => entry.label.startsWith(label) && entry.statistic === statistic,
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

	const overallCi = bootstrapEntry(cohorts.bootstrap, "Overall", "f1");
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

	const criteria = [criterionA, criterionB, criterionC];
	const verdict: VerdictWord = criteria.some(
		(criterion) => criterion.pass === false,
	)
		? "keep-scenario"
		: criteria.some((criterion) => criterion.pass == null)
			? "insufficient-evidence"
			: "replace";

	// A tag whose events are in the data but which carries NO seven_day record is
	// unlabelled on its weekly half. WHY it is unlabelled decides what to do
	// about it, so the two causes are separated rather than both prescribing a
	// re-run: a pair whose tagged weekly windows were dropped by the label
	// horizon is PENDING (a later `--to` labels it, and only that makes the
	// verdict provisional), while a pair with no pending window never had a
	// tagged weekly window in this roster at all — a lone account whose peer
	// exhaustion tags nobody, or a tagged window that was withheld or censored.
	// Re-running changes nothing there.
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
		"rebuilt from recorded snapshots and BOTH models are fed the same window",
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
		"- No reset-credit bank is modelled: the credit ledger is not reconstructible per instant, so both models run without it.",
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
		`- Transition tagging: class-wide, ${TRANSITION_WINDOW_MS / HOUR_MS} h after the event, except a peer exhaustion whose shadow ends at the dying window's own reset. The dying account is excluded from its own event.`,
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
		"The scenario adds the dead peer's fill demand on top of a survivor whose own lookback ALREADY contains the traffic it absorbed, so it is expected to read pessimistic the longer the peer has been dead. Disclosed here, not corrected.",
	);
	out.push("");
	for (const cohort of cohorts.peerExhaustionBySinceDeath) {
		out.push(...cohortSection(cohort, `#### since death ${cohort.label}`));
	}
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
		"Block bootstrap of `scenario-equal − current`, resampling blocks rather than instants (window lifecycles overall, episodes on transitions).",
	);
	out.push("");
	out.push("| cohort | statistic | p2.5 | p50 | p97.5 | resamples |");
	out.push("|---|---|---:|---:|---:|---:|");
	for (const entry of cohorts.bootstrap) {
		out.push(
			`| ${entry.label} | ${entry.statistic} | ${num(entry.p2_5)} | ${num(entry.p50)} | ${num(entry.p97_5)} | ${entry.samples} |`,
		);
	}
	out.push("");

	out.push("## Pool calibration (all-out within 14 d)");
	out.push("");
	out.push(
		"The pool-level claim, scored against the observed grid. What the table can say is how often a predicted pool-out was followed by 14 days with no outage.",
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
	out.push(`**Verdict: ${verdict.verdict}**`);
	out.push("");
	if (verdict.pendingCohorts.length > 0) {
		const many = verdict.pendingCohorts.length > 1;
		out.push(
			`PROVISIONAL: the ${verdict.pendingCohorts.join(", ")} ${many ? "cohorts have" : "cohort has"} no completed weekly window inside the replay interval, so ${many ? "their" : "its"} weekly half is unlabelled and the verdict rests on five-hour evidence there. Re-run the reproduce command above with a later \`--to\` once those windows have reset, and re-read the verdict.`,
		);
		out.push("");
	}
	if (verdict.unlabelledCohorts.length > 0) {
		out.push(
			`No tagged survivor weekly record in this data for: ${verdict.unlabelledCohorts.join(", ")}; a later run cannot label these without a roster change.`,
		);
		out.push("");
	}
	if (
		verdict.pendingCohorts.length === 0 &&
		verdict.unlabelledCohorts.length === 0
	) {
		out.push("Every scored cohort has completed windows in both kinds.");
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
 * A class holding at least this share of the common cohort makes the overall
 * numbers a restatement of that class's numbers, which the report has to say
 * out loud rather than leave the reader to infer from the per-class table.
 */
const DOMINANT_CLASS_SHARE = 0.8;

/** The limits every run of this report has to state, plus what it measured. */
export function knownLimitsFor(
	replay: ReplayResult,
	cohorts: CohortSet,
	verdict: Verdict,
): string[] {
	const limits = [
		'Pause and removal cannot be replayed: `usage_snapshots` rows cascade-delete with their account, so no removed account has history, and `accounts.paused` keeps none. The scenario\'s `presence: "demand-only"` path is covered by its unit tests only.',
		"Snapshots before 2026-08-24 carry no `plan_tier`/`rate_limit_tier` and no `observed_at`. Tiers there are today's, marked `assumed`; without an observation instant the weekly full-confidence path is unavailable to BOTH models, so the two are still compared like for like.",
		"No reset-credit bank is modelled, and no live usage point is injected — the replay only has what the sampler stored.",
		"The headroom share rule is reported, never used as the verdict basis. The verdict basis is the equal split, pre-declared.",
		"The scenario double-counts a dead peer's demand while the survivor's own lookback already contains the traffic it absorbed. That is a property of the model, disclosed in the peer-exhaustion cohort rather than corrected here.",
	];

	// Measured, never assumed: one model's records only, because the three
	// models score the SAME windows and counting all of them would just triple
	// every class.
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
				`\`${dominant[0]}\` supplies ${(share * 100).toFixed(1)} % of the overall common-cohort records, so the overall numbers are close to that class's numbers.`,
			);
		}
	}
	if (verdict.pendingCohorts.length > 0) {
		limits.push(
			`Pending at this run (tag and servable class): ${verdict.pendingCohorts.join(", ")}. No weekly window of ${verdict.pendingCohorts.length > 1 ? "those classes carrying those tags" : "that class carrying that tag"} had completed by the end of the replay interval, so the cohort carries five-hour evidence only and the verdict is provisional.`,
		);
	}
	if (verdict.unlabelledCohorts.length > 0) {
		limits.push(
			`No tagged survivor weekly record in this data (tag and servable class): ${verdict.unlabelledCohorts.join(", ")}. Nothing tagged a weekly window of ${verdict.unlabelledCohorts.length > 1 ? "those classes" : "that class"} inside the replay interval — the dying account is excluded from its own event, so a class with no sibling tags nobody — and the cohort carries five-hour evidence only.`,
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
	return limits;
}
