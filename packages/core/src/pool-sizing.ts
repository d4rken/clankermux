import {
	POOL_SIZING_REJECTED_ATTEMPT_LABELS,
	POOL_SIZING_SEPARATE_STOP_LABELS,
	POOL_SIZING_TERMINAL_STOP_LABELS,
	type PoolSizingAccountCycle,
	type PoolSizingBoundaryRule,
	type PoolSizingCycle,
	type PoolSizingResponse,
	type PoolSizingRow,
	type PoolSizingSeparateStop,
	type PoolSizingVerdict,
	type PoolSizingVerdictBasis,
} from "@clankermux/types";
import { getModelFamily } from "./model-mappings";
import { compareServableClasses, servableClassFor } from "./pool-classes";
import {
	MAX_SAMPLE_GAP_MS,
	RESET_MOVE_TOLERANCE_MS,
} from "./quota-drift/segments";
import { FIXED_WINDOW_DURATION_MS } from "./throttle-utils";
import { formatPlanTierLabel } from "./tier-label";

/**
 * Account-weeks consumed per completed weekly cycle — the computation behind
 * `GET /api/analytics/pool-sizing`.
 *
 * Pure and database-free: it takes grouped rows and returns the whole response
 * body, so every rule below is unit-testable against fixtures rather than
 * against the live snapshot history.
 *
 * The chain is: reported reset values → reset CLUSTERS (jitter absorbed) →
 * WINDOWS (a moved reset is a revision, not a new window) → CYCLES (windows
 * bucketed by where they actually ended) → rows. Each step is documented at
 * the function that performs it, because each one exists to survive a specific
 * shape in the recorded data rather than to be elegant.
 */

/** Nominal weekly window length. */
const WINDOW_MS = FIXED_WINDOW_DURATION_MS.seven_day;

/**
 * Longest reset move that still reads as a REVISION of the current window
 * rather than the start of a new one.
 *
 * Codex re-anchors a window by hours when a reset credit lands, and the
 * provider revises a reported boundary by minutes routinely. A move of a full
 * day is a different window by any reading, and using a day here means the
 * rule never has to know whether a credit was involved — which matters,
 * because `codex_reset_credit_events` recorded only 3 of the observed
 * re-anchors and cannot be used to annotate them.
 */
const REVISION_MAX_MS = 24 * 3_600_000;

/**
 * How close to a full window ahead a reported reset must stay, with nothing
 * ever consumed, to be a PLACEHOLDER — a window that never started.
 *
 * While a Codex account is idle the reported reset creeps forward every poll
 * as `now + 7d` at 0%. One hour of slack absorbs the poll cadence and the
 * provider's own rounding without admitting a window that really did open.
 */
const PLACEHOLDER_SLACK_MS = 3_600_000;

/**
 * How far an account's reset phases may spread before it stops counting as
 * phase-locked. Anthropic weekly resets sit on a fixed weekday/hour, jittering
 * by a second; an hour of tolerance keeps a locked account locked across a
 * provider-side clock correction without absorbing a genuine re-anchor.
 */
const PHASE_LOCK_TOLERANCE_MS = 3_600_000;

/** Most completed cycles a row emits. */
export const POOL_SIZING_MAX_CYCLES = 12;

/**
 * Fixed lookback. Three windows wider than what is emitted, so the oldest
 * emitted cycle is never truncated by the edge of the scan: a window whose
 * samples begin before `sinceMs` would otherwise report a peak that is missing
 * its own start.
 */
export const POOL_SIZING_LOOKBACK_MS = (POOL_SIZING_MAX_CYCLES + 3) * WINDOW_MS;

/** How many completed cycles a row headline considers. */
export const VERDICT_CYCLES = 4;

/** Monday 00:00 UTC as a phase within the 7-day grid (epoch day 0 is a Thursday). */
const ISO_WEEK_ANCHOR_PHASE_MS = 4 * 86_400_000;

/** Separator for the encoded `(planTier, rateLimitTier)` pair. */
const TIER_PAIR_SEP = "\u0000";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One `(account, reset value)` group of the account-wide weekly series. */
export interface PoolSizingResetPeakRow {
	accountId: string;
	resetAt: number;
	peakPct: number | null;
	sampleCount: number;
	firstSampledAt: number;
	lastSampledAt: number;
	/** Percentage at the earliest sample of the group. */
	firstPct: number | null;
	/** Percentage at the latest sample of the group. */
	lastPct: number | null;
	planTier: string | null;
	rateLimitTier: string | null;
}

/** One `(account, family, display name, reset value)` group of the scoped series. */
export interface PoolSizingScopedResetPeakRow {
	accountId: string;
	family: string;
	displayName: string;
	resetAt: number;
	peakPct: number | null;
	sampleCount: number;
	firstSampledAt: number;
	lastSampledAt: number;
	firstPct: number | null;
	lastPct: number | null;
}

/** Sampling evidence for one account and calendar day, at exact sample times. */
export interface PoolSizingPresenceRow {
	accountId: string;
	firstSampledAt: number;
	lastSampledAt: number;
}

/** Sampling evidence for one account, family and calendar day. */
export interface PoolSizingScopedPresenceRow extends PoolSizingPresenceRow {
	family: string;
}

/** Accounts reported at 100% of their 5-hour window, per sampler tick and provider. */
export interface PoolSizingBurstTickRow {
	sampledAt: number;
	provider: string | null;
	spent: number;
}

/** One refused request, as stored. */
export interface PoolSizingStopRow {
	label: string;
	model: string | null;
	timestamp: number;
}

/** The pool as it exists now — the denominator does not depend on sampling. */
export interface PoolSizingAccountInput {
	id: string;
	name: string;
	provider: string;
	createdAt: number;
}

export interface PoolSizingComputeInput {
	accounts: readonly PoolSizingAccountInput[];
	resetPeaks: readonly PoolSizingResetPeakRow[];
	scopedResetPeaks: readonly PoolSizingScopedResetPeakRow[];
	presence: readonly PoolSizingPresenceRow[];
	scopedPresence: readonly PoolSizingScopedPresenceRow[];
	burstTicks: readonly PoolSizingBurstTickRow[];
	stops: readonly PoolSizingStopRow[];
	/** Weekly headroom percentage below which the pool holds capacity in reserve. */
	reserveHeadroomPct: number;
	now: number;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface TimeRange {
	start: number;
	end: number;
}

/** One reported reset value with everything observed under it. */
interface ResetGroup {
	resetAt: number;
	peakPct: number;
	sampleCount: number;
	firstSampledAt: number;
	lastSampledAt: number;
	firstPct: number | null;
	lastPct: number | null;
	tiers: Set<string>;
}

/** One period of consumption, after jitter and revisions have been absorbed. */
interface SeriesWindow {
	resetAt: number;
	peakPct: number;
	sampleCount: number;
	firstSampledAt: number;
	lastSampledAt: number;
	tiers: Set<string>;
	/** Where the window actually ended: its reset, or the next window's first sample. */
	effectiveEnd: number;
	abandoned: boolean;
	observedThroughEnd: boolean;
}

/** One account's windows for one series key (the account itself, or a scoped display name). */
interface PreparedSeries {
	accountId: string;
	seriesKey: string;
	windows: SeriesWindow[];
	idleRanges: TimeRange[];
}

interface ClassifiedStop {
	label: string;
	model: string | null;
	timestamp: number;
	/** Class that normally serves the requested model, or null when unattributable. */
	classId: string | null;
	family: string | null;
	kind: "terminal" | "rejected" | "separate";
}

interface RowInput {
	kind: "class" | "family";
	classId: string;
	classLabel: string;
	family: string | null;
	familyLabel: string | null;
	boundaryRule: PoolSizingBoundaryRule;
	/** The row's account universe: n is the subset of it that existed in the cycle. */
	accountIds: string[];
	seriesByAccount: Map<string, PreparedSeries[]>;
	/** Sampling evidence per account, used for `accountsObserved`. */
	observationByAccount: Map<string, TimeRange[]>;
	/** Non-null only for class rows: peak simultaneous 5-hour-spent accounts per tick. */
	burstByTick: Map<number, number> | null;
}

// ---------------------------------------------------------------------------
// Stop attribution
// ---------------------------------------------------------------------------

const TERMINAL_LABELS: ReadonlySet<string> = new Set(
	POOL_SIZING_TERMINAL_STOP_LABELS,
);
const REJECTED_LABELS: ReadonlySet<string> = new Set(
	POOL_SIZING_REJECTED_ATTEMPT_LABELS,
);
const SEPARATE_LABELS: ReadonlySet<string> = new Set(
	POOL_SIZING_SEPARATE_STOP_LABELS,
);
/** The family-scoped stop labels, the only ones a family row may count. */
const FAMILY_LABELS: ReadonlySet<string> = new Set([
	"family_weekly_exhausted",
	"family_weekly_exhausted_429",
]);

const CODEX_MODEL_PATTERN = /^(gpt-|o[0-9]|codex-)/;

/**
 * Which servable class normally serves a requested model.
 *
 * The stored model string is the ONLY key available: no durable record exists
 * of which accounts were candidates for a refused request. An unrecognised
 * model returns null and its stops are listed separately rather than being
 * guessed onto a class — a wrong attribution here would move a refusal onto a
 * pool that could never have served it.
 */
export function stopClassForModel(model: string | null): string | null {
	if (!model) return null;
	const normalized = model.toLowerCase();
	if (getModelFamily(normalized) !== null || normalized.startsWith("claude-")) {
		return "anthropic";
	}
	if (CODEX_MODEL_PATTERN.test(normalized)) return "codex";
	return null;
}

function classifyStop(row: PoolSizingStopRow): ClassifiedStop {
	const family = row.model ? getModelFamily(row.model) : null;
	if (SEPARATE_LABELS.has(row.label)) {
		return { ...row, classId: null, family, kind: "separate" };
	}
	const classId = stopClassForModel(row.model);
	if (classId === null) {
		return { ...row, classId: null, family, kind: "separate" };
	}
	if (TERMINAL_LABELS.has(row.label)) {
		return { ...row, classId, family, kind: "terminal" };
	}
	if (REJECTED_LABELS.has(row.label)) {
		return { ...row, classId, family, kind: "rejected" };
	}
	return { ...row, classId: null, family, kind: "separate" };
}

// ---------------------------------------------------------------------------
// Series construction
// ---------------------------------------------------------------------------

function encodeTierPair(
	planTier: string | null,
	rateLimitTier: string | null,
): string | null {
	if (!planTier && !rateLimitTier) return null;
	return `${planTier ?? ""}${TIER_PAIR_SEP}${rateLimitTier ?? ""}`;
}

function decodeTierPair(encoded: string): string | null {
	const [plan = "", tier = ""] = encoded.split(TIER_PAIR_SEP);
	return formatPlanTierLabel(plan || null, tier || null);
}

/**
 * Collapse the SQL groups onto one entry per reported reset value.
 *
 * The account-wide read groups by tier as well as reset, so one reset value
 * arrives as several rows when identity capture started mid-window. Their
 * percentages describe the same window and must not be summed.
 */
function collapseByReset(
	rows: Array<{
		resetAt: number;
		peakPct: number | null;
		sampleCount: number;
		firstSampledAt: number;
		lastSampledAt: number;
		firstPct: number | null;
		lastPct: number | null;
		tierPair?: string | null;
	}>,
): ResetGroup[] {
	const byReset = new Map<number, ResetGroup>();
	for (const row of rows) {
		const existing = byReset.get(row.resetAt);
		const pair = row.tierPair ?? null;
		if (!existing) {
			byReset.set(row.resetAt, {
				resetAt: row.resetAt,
				peakPct: row.peakPct ?? 0,
				sampleCount: row.sampleCount,
				firstSampledAt: row.firstSampledAt,
				lastSampledAt: row.lastSampledAt,
				firstPct: row.firstPct,
				lastPct: row.lastPct,
				tiers: new Set(pair ? [pair] : []),
			});
			continue;
		}
		existing.peakPct = Math.max(existing.peakPct, row.peakPct ?? 0);
		existing.sampleCount += row.sampleCount;
		if (row.firstSampledAt < existing.firstSampledAt) {
			existing.firstSampledAt = row.firstSampledAt;
			existing.firstPct = row.firstPct;
		}
		if (row.lastSampledAt > existing.lastSampledAt) {
			existing.lastSampledAt = row.lastSampledAt;
			existing.lastPct = row.lastPct;
		}
		if (pair) existing.tiers.add(pair);
	}
	return [...byReset.values()].sort((a, b) => a.resetAt - b.resetAt);
}

/**
 * Group reported reset values whose difference is pure jitter.
 *
 * The live database holds 06:59:59, 07:00:00 and 07:00:01 for one Anthropic
 * cycle, so an exact-equality grouping splits one window into three. The
 * clustering tolerance is the SAME constant the quota-drift segmenter uses to
 * decide a reset really moved — one measurement, one number.
 */
function clusterResets(groups: ResetGroup[]): ResetGroup[] {
	const clusters: ResetGroup[] = [];
	let members: ResetGroup[] = [];
	let clusterFirstReset = Number.NaN;

	const flush = (): void => {
		if (members.length === 0) return;
		clusters.push(mergeClusterMembers(members));
		members = [];
	};

	for (const group of groups) {
		if (members.length === 0) {
			clusterFirstReset = group.resetAt;
		} else if (group.resetAt - clusterFirstReset > RESET_MOVE_TOLERANCE_MS) {
			flush();
			clusterFirstReset = group.resetAt;
		}
		members.push(group);
	}
	flush();
	return clusters;
}

function mergeClusterMembers(members: ResetGroup[]): ResetGroup {
	// The reset value the provider reported most often wins; on a tie the
	// earliest, so the pick is deterministic rather than iteration-ordered.
	let representative = members[0] as ResetGroup;
	for (const member of members) {
		if (
			member.sampleCount > representative.sampleCount ||
			(member.sampleCount === representative.sampleCount &&
				member.resetAt < representative.resetAt)
		) {
			representative = member;
		}
	}

	let first = members[0] as ResetGroup;
	let last = members[0] as ResetGroup;
	let peakPct = 0;
	let sampleCount = 0;
	const tiers = new Set<string>();
	for (const member of members) {
		peakPct = Math.max(peakPct, member.peakPct);
		sampleCount += member.sampleCount;
		if (member.firstSampledAt < first.firstSampledAt) first = member;
		if (member.lastSampledAt > last.lastSampledAt) last = member;
		for (const tier of member.tiers) tiers.add(tier);
	}

	return {
		resetAt: representative.resetAt,
		peakPct,
		sampleCount,
		firstSampledAt: first.firstSampledAt,
		lastSampledAt: last.lastSampledAt,
		firstPct: first.firstPct,
		lastPct: last.lastPct,
		tiers,
	};
}

/**
 * Merge clusters that are the SAME window seen under a revised reset value.
 *
 * A moved reset is not by itself a new window. Two shapes prove continuity:
 * overlapping sample spans (the provider reported both boundaries within one
 * observation), or a small move where consumption did not drop (a rollover
 * always starts lower than the window it replaces). This is also what absorbs
 * the Codex idle creep — a chain of `now + 7d` values at 0% — into the window
 * that finally opens after it.
 *
 * Peaks are taken, never summed: the merged clusters describe one window.
 */
function mergeRevisions(clusters: ResetGroup[]): ResetGroup[] {
	const ordered = [...clusters].sort(
		(a, b) => a.firstSampledAt - b.firstSampledAt,
	);
	const windows: ResetGroup[] = [];
	let current: ResetGroup | null = null;
	// Reset of the member with the latest firstSampledAt: the most recent
	// revision is the boundary that was actually in force at the end.
	let currentNewestStart = Number.NEGATIVE_INFINITY;

	for (const cluster of ordered) {
		if (!current) {
			current = { ...cluster, tiers: new Set(cluster.tiers) };
			currentNewestStart = cluster.firstSampledAt;
			continue;
		}
		const overlaps = cluster.firstSampledAt <= current.lastSampledAt;
		const continued =
			Math.abs(cluster.resetAt - current.resetAt) < REVISION_MAX_MS &&
			cluster.firstPct !== null &&
			current.lastPct !== null &&
			cluster.firstPct >= current.lastPct;
		if (!overlaps && !continued) {
			windows.push(current);
			current = { ...cluster, tiers: new Set(cluster.tiers) };
			currentNewestStart = cluster.firstSampledAt;
			continue;
		}
		if (cluster.firstSampledAt >= currentNewestStart) {
			currentNewestStart = cluster.firstSampledAt;
			current.resetAt = cluster.resetAt;
		}
		current.peakPct = Math.max(current.peakPct, cluster.peakPct);
		current.sampleCount += cluster.sampleCount;
		if (cluster.firstSampledAt < current.firstSampledAt) {
			current.firstSampledAt = cluster.firstSampledAt;
			current.firstPct = cluster.firstPct;
		}
		if (cluster.lastSampledAt > current.lastSampledAt) {
			current.lastSampledAt = cluster.lastSampledAt;
			current.lastPct = cluster.lastPct;
		}
		for (const tier of cluster.tiers) current.tiers.add(tier);
	}
	if (current) windows.push(current);
	return windows;
}

/**
 * A window that never started is not a window.
 *
 * While an account is idle the provider keeps reporting a reset a full window
 * ahead at 0%. Counting those as windows would invent an empty cycle for every
 * poll. They are still EVIDENCE though — positive evidence that nothing was
 * consumed — so their sample span is kept as an idle range, which is what stops
 * an idle account from flagging its cycle as unobserved.
 *
 * Any non-zero percentage disqualifies a placeholder, however briefly the
 * window was observed: a window at 20% seen for one hour is a real window with
 * a lower-bound peak, not an absence.
 */
function splitPlaceholders(windows: ResetGroup[]): {
	real: ResetGroup[];
	idleRanges: TimeRange[];
} {
	const real: ResetGroup[] = [];
	const idleRanges: TimeRange[] = [];
	for (const window of windows) {
		const neverStarted =
			window.peakPct <= 0 &&
			window.resetAt - window.lastSampledAt >= WINDOW_MS - PLACEHOLDER_SLACK_MS;
		if (neverStarted) {
			idleRanges.push({
				start: window.firstSampledAt,
				end: window.lastSampledAt,
			});
		} else {
			real.push(window);
		}
	}
	return { real, idleRanges };
}

/**
 * Where each window actually ended.
 *
 * A Codex window can be abandoned: the account re-anchors and starts consuming
 * a new window days before the old reset would have arrived. Bucketing that
 * window by its reset would file a week of consumption into a cycle it had
 * nothing to do with, so the end is the earlier of the reset and the next
 * window's first sample.
 */
function finalizeWindows(windows: ResetGroup[]): SeriesWindow[] {
	const ordered = [...windows].sort(
		(a, b) => a.firstSampledAt - b.firstSampledAt,
	);
	return ordered.map((window, index) => {
		const next = ordered[index + 1];
		const effectiveEnd = next
			? Math.min(window.resetAt, next.firstSampledAt)
			: window.resetAt;
		return {
			resetAt: window.resetAt,
			peakPct: window.peakPct,
			sampleCount: window.sampleCount,
			firstSampledAt: window.firstSampledAt,
			lastSampledAt: window.lastSampledAt,
			tiers: window.tiers,
			effectiveEnd,
			abandoned: effectiveEnd < window.resetAt - RESET_MOVE_TOLERANCE_MS,
			observedThroughEnd:
				window.lastSampledAt >= effectiveEnd - MAX_SAMPLE_GAP_MS,
		};
	});
}

function buildSeries(
	accountId: string,
	seriesKey: string,
	rows: Array<{
		resetAt: number;
		peakPct: number | null;
		sampleCount: number;
		firstSampledAt: number;
		lastSampledAt: number;
		firstPct: number | null;
		lastPct: number | null;
		tierPair?: string | null;
	}>,
): PreparedSeries {
	const clusters = clusterResets(collapseByReset(rows));
	const { real, idleRanges } = splitPlaceholders(mergeRevisions(clusters));
	return {
		accountId,
		seriesKey,
		windows: finalizeWindows(real),
		idleRanges,
	};
}

// ---------------------------------------------------------------------------
// Cycle grid
// ---------------------------------------------------------------------------

function phaseOf(ms: number): number {
	return ((ms % WINDOW_MS) + WINDOW_MS) % WINDOW_MS;
}

function circularDistance(a: number, b: number): number {
	const raw = Math.abs(a - b) % WINDOW_MS;
	return Math.min(raw, WINDOW_MS - raw);
}

/**
 * Anchor the 7-day grid at the WIDEST gap between the pool's reset phases.
 *
 * Anthropic accounts reset on fixed weekdays spread across two and a half days
 * (Sun 07:00 through Tue 09:00 on the live pool). Cutting anywhere inside that
 * spread would split one week of pool consumption across two cycles; cutting at
 * the middle of the empty stretch behind it groups each account's window ending
 * in that span into one comparable cycle. On the live phases the cut lands
 * around Thursday 20:00 UTC.
 */
function anchorFromPhases(phases: number[]): number {
	const unique = [...new Set(phases)].sort((a, b) => a - b);
	if (unique.length === 0) return 0;
	const first = unique[0] as number;
	if (unique.length === 1) return phaseOf(first + WINDOW_MS / 2);

	let bestStart = first;
	let bestGap = -1;
	for (let i = 0; i < unique.length; i += 1) {
		const start = unique[i] as number;
		const nextPhase =
			i + 1 < unique.length ? (unique[i + 1] as number) : first + WINDOW_MS;
		const gap = nextPhase - start;
		// Strictly greater, walking phases in ascending order: on a tie the gap
		// whose start phase is earliest wins, so the anchor is deterministic.
		if (gap > bestGap) {
			bestGap = gap;
			bestStart = start;
		}
	}
	return phaseOf(bestStart + bestGap / 2);
}

interface CycleGrid {
	anchorPhase: number;
	accountsVoting: number;
	accountsLocked: number;
}

/**
 * Is every one of this account's windows on the same reset phase?
 *
 * An account needs two windows to have a phase at all; a single window is
 * consistent with any schedule. A locked account is evidence about the pool's
 * grid, an unlocked one is not — but an unlocked account is still PLACED on the
 * grid by its own window end, so one account that re-anchored never moves the
 * other four.
 */
function isPhaseLocked(windows: SeriesWindow[]): boolean {
	if (windows.length < 2) return false;
	const newest = windows[windows.length - 1] as SeriesWindow;
	const reference = phaseOf(newest.resetAt);
	return windows.every(
		(window) =>
			circularDistance(phaseOf(window.resetAt), reference) <=
			PHASE_LOCK_TOLERANCE_MS,
	);
}

function buildCycleGrid(
	rule: PoolSizingBoundaryRule,
	windowsByAccount: Map<string, SeriesWindow[]>,
): CycleGrid {
	let accountsVoting = 0;
	let accountsLocked = 0;
	const lockedPhases: number[] = [];
	const allPhases: number[] = [];
	for (const windows of windowsByAccount.values()) {
		if (windows.length === 0) continue;
		if (windows.length >= 2) accountsVoting += 1;
		const newest = windows[windows.length - 1] as SeriesWindow;
		allPhases.push(phaseOf(newest.resetAt));
		if (isPhaseLocked(windows)) {
			accountsLocked += 1;
			lockedPhases.push(phaseOf(newest.resetAt));
		}
	}

	const anchorPhase =
		rule === "iso_week"
			? ISO_WEEK_ANCHOR_PHASE_MS
			: anchorFromPhases(lockedPhases.length > 0 ? lockedPhases : allPhases);

	return { anchorPhase, accountsVoting, accountsLocked };
}

function cycleIndexOf(ms: number, anchorPhase: number): number {
	return Math.floor((ms - anchorPhase) / WINDOW_MS);
}

function cycleStartOf(index: number, anchorPhase: number): number {
	return anchorPhase + index * WINDOW_MS;
}

function intersects(range: TimeRange, start: number, end: number): boolean {
	return range.start < end && range.end >= start;
}

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

interface RowContext {
	accountById: Map<string, PoolSizingAccountInput>;
	/** Account-wide windows per account: the only place tier pairs are recorded. */
	accountWideWindows: Map<string, SeriesWindow[]>;
	tierPairsByAccount: Map<string, Set<string>>;
	stops: ClassifiedStop[];
	reserveHeadroomPct: number;
	now: number;
	emitFloorMs: number;
}

function tierLabelFromPairs(pairs: Set<string>): string | null {
	if (pairs.size === 0) return null;
	if (pairs.size > 1) return "mixed";
	const [only] = pairs;
	return only === undefined ? null : decodeTierPair(only);
}

function cycleTierLabel(entries: PoolSizingAccountCycle[]): string | null {
	const labels = new Set<string>();
	for (const entry of entries) {
		if (entry.tierLabel !== null) labels.add(entry.tierLabel);
	}
	if (labels.size === 0) return null;
	if (labels.size > 1) return "mixed";
	const [only] = labels;
	return only ?? null;
}

function buildRow(row: RowInput, ctx: RowContext): PoolSizingRow | null {
	const windowsByAccount = new Map<string, SeriesWindow[]>();
	for (const [accountId, series] of row.seriesByAccount) {
		const merged = series.flatMap((entry) => entry.windows);
		merged.sort((a, b) => a.effectiveEnd - b.effectiveEnd);
		windowsByAccount.set(accountId, merged);
	}
	const grid = buildCycleGrid(row.boundaryRule, windowsByAccount);

	const rowStops = ctx.stops.filter((stop) => {
		if (stop.classId !== row.classId) return false;
		if (row.kind === "class") return true;
		return FAMILY_LABELS.has(stop.label) && stop.family === row.family;
	});

	// Every instant the row has evidence for, so an empty stretch in the middle
	// of the lookback still produces its (empty, dropped) cycle rather than
	// shifting the ones around it.
	const marks: number[] = [ctx.now];
	for (const windows of windowsByAccount.values()) {
		for (const window of windows) marks.push(window.effectiveEnd);
	}
	for (const ranges of row.observationByAccount.values()) {
		for (const range of ranges) {
			marks.push(range.start);
			marks.push(range.end);
		}
	}
	for (const stop of rowStops) marks.push(stop.timestamp);
	if (row.burstByTick) {
		for (const tick of row.burstByTick.keys()) marks.push(tick);
	}

	const firstIndex = cycleIndexOf(Math.min(...marks), grid.anchorPhase);
	// `marks` carries `now`, so the range always reaches the current cycle. It
	// can reach PAST it: an open window whose reset falls in the next cycle is
	// still consumption that has to be shown somewhere.
	const lastIndex = cycleIndexOf(Math.max(...marks), grid.anchorPhase);

	const tierPairsForRow = new Set<string>();
	let everyAccountHasTier = row.accountIds.length > 0;
	for (const accountId of row.accountIds) {
		const pairs = ctx.tierPairsByAccount.get(accountId);
		if (!pairs || pairs.size === 0) {
			everyAccountHasTier = false;
			continue;
		}
		for (const pair of pairs) tierPairsForRow.add(pair);
	}
	const tierComparable = everyAccountHasTier && tierPairsForRow.size === 1;

	const cycles: PoolSizingCycle[] = [];
	for (let index = firstIndex; index <= lastIndex; index += 1) {
		const start = cycleStartOf(index, grid.anchorPhase);
		const end = start + WINDOW_MS;
		if (start < ctx.emitFloorMs) continue;
		const cycle = buildCycle(row, ctx, grid, rowStops, tierComparable, {
			start,
			end,
		});
		if (cycle) cycles.push(cycle);
	}
	cycles.sort((a, b) => b.start - a.start);

	const completed = cycles.filter((cycle) => cycle.status === "completed");
	const kept: PoolSizingCycle[] = [];
	let completedKept = 0;
	for (const cycle of cycles) {
		if (cycle.status === "completed") {
			if (completedKept >= POOL_SIZING_MAX_CYCLES) continue;
			completedKept += 1;
		}
		kept.push(cycle);
	}

	const considered = completed.slice(0, VERDICT_CYCLES);
	const verdict: PoolSizingVerdict =
		considered.length === 0
			? "insufficient_history"
			: considered.some((cycle) => cycle.removalInfeasible)
				? "removal_infeasible"
				: "removal_not_established";

	if (kept.length === 0) return null;

	return {
		kind: row.kind,
		classId: row.classId,
		classLabel: row.classLabel,
		family: row.family,
		familyLabel: row.familyLabel,
		boundaryRule: row.boundaryRule,
		accountsVoting: grid.accountsVoting,
		accountsLocked: grid.accountsLocked,
		tierComparable,
		verdict,
		verdictBasis: considered[0]?.verdictBasis ?? null,
		verdictCycles: considered.length,
		reserveBandCycles: considered.filter((cycle) => cycle.reserveBandEntered)
			.length,
		terminalStopCycles: considered.filter((cycle) => cycle.terminalStops > 0)
			.length,
		cycles: kept,
	};
}

function buildCycle(
	row: RowInput,
	ctx: RowContext,
	_grid: CycleGrid,
	rowStops: ClassifiedStop[],
	tierComparable: boolean,
	span: { start: number; end: number },
): PoolSizingCycle | null {
	const { start, end } = span;

	const accountsInPoolIds = row.accountIds.filter((accountId) => {
		const account = ctx.accountById.get(accountId);
		return account !== undefined && account.createdAt < end;
	});
	const accountsInPool = accountsInPoolIds.length;

	const entries: PoolSizingAccountCycle[] = [];
	for (const accountId of accountsInPoolIds) {
		const entry = buildAccountEntry(row, ctx, accountId, start, end);
		if (entry) entries.push(entry);
	}
	entries.sort((a, b) => a.accountName.localeCompare(b.accountName));

	const accountsObserved = accountsInPoolIds.filter((accountId) =>
		(row.observationByAccount.get(accountId) ?? []).some((range) =>
			intersects(range, start, end),
		),
	).length;

	let terminalStops = 0;
	let rejectedAttempts = 0;
	for (const stop of rowStops) {
		if (stop.timestamp < start || stop.timestamp >= end) continue;
		if (stop.kind === "terminal") terminalStops += 1;
		else if (stop.kind === "rejected") rejectedAttempts += 1;
	}

	if (
		entries.length === 0 &&
		accountsObserved === 0 &&
		terminalStops === 0 &&
		rejectedAttempts === 0
	) {
		return null;
	}

	const consumed = entries.reduce((sum, entry) => sum + entry.peakPct / 100, 0);
	const status: "completed" | "in_progress" =
		end <= ctx.now ? "completed" : "in_progress";
	const lowerBound =
		accountsObserved < accountsInPool ||
		entries.some((entry) => !entry.observedThroughEnd);
	const multipleWindows = entries.some((entry) => entry.windows > 1);

	let verdictBasis: PoolSizingVerdictBasis;
	if (status === "in_progress") {
		verdictBasis = "in_progress";
	} else if (accountsInPool === 0 || consumed <= accountsInPool - 1) {
		// The threshold settles it on its own here; comparability only matters
		// for the branch that would otherwise claim infeasibility.
		verdictBasis = "at_or_below_threshold";
	} else if (!tierComparable) {
		verdictBasis = "tiers_not_comparable";
	} else if (multipleWindows) {
		verdictBasis = "multiple_windows";
	} else {
		verdictBasis = "above_threshold";
	}

	const ends = entries.map((entry) => entry.effectiveEnd);

	let burstPeakAccounts: number | null = null;
	if (row.burstByTick) {
		burstPeakAccounts = 0;
		for (const [sampledAt, spent] of row.burstByTick) {
			if (sampledAt < start || sampledAt >= end) continue;
			if (spent > burstPeakAccounts) burstPeakAccounts = spent;
		}
	}

	return {
		start,
		end,
		resetFrom: ends.length > 0 ? Math.min(...ends) : null,
		resetTo: ends.length > 0 ? Math.max(...ends) : null,
		status,
		accountsInPool,
		accountsObserved,
		consumed,
		lowerBound,
		removalInfeasible:
			status === "completed" && verdictBasis === "above_threshold",
		verdictBasis,
		reserveBandEntered:
			status === "completed" &&
			accountsInPool > 0 &&
			consumed > accountsInPool * (1 - ctx.reserveHeadroomPct / 100),
		terminalStops,
		rejectedAttempts,
		burstPeakAccounts,
		tierLabel: cycleTierLabel(entries),
		accounts: entries,
	};
}

function buildAccountEntry(
	row: RowInput,
	ctx: RowContext,
	accountId: string,
	start: number,
	end: number,
): PoolSizingAccountCycle | null {
	const account = ctx.accountById.get(accountId);
	if (!account) return null;

	// A family can report several display names for one limit ("Claude Opus
	// 4.8" and "Claude Opus 5"). They are alternative spellings of the same
	// window, so the account's consumption is the BINDING one — the maximum —
	// exactly as the scoped history reader picks a binding limit.
	let contributing: SeriesWindow[] = [];
	let bestPeak = -1;
	for (const series of row.seriesByAccount.get(accountId) ?? []) {
		const inCycle = series.windows.filter(
			(window) => window.effectiveEnd >= start && window.effectiveEnd < end,
		);
		if (inCycle.length === 0) continue;
		const peak = inCycle.reduce((sum, window) => sum + window.peakPct, 0);
		if (peak > bestPeak) {
			bestPeak = peak;
			contributing = inCycle;
		}
	}
	if (contributing.length === 0) return null;

	contributing.sort((a, b) => a.effectiveEnd - b.effectiveEnd);
	const newest = contributing[contributing.length - 1] as SeriesWindow;

	// Tier pairs live on the ACCOUNT-WIDE samples only; the scoped table has no
	// tier columns. A family entry therefore reports the tier the account was on
	// while the cycle ran, read off its account-wide windows for the same span.
	const pairs = new Set<string>();
	const tierWindows =
		row.kind === "class"
			? contributing
			: (ctx.accountWideWindows.get(accountId) ?? []).filter(
					(window) => window.effectiveEnd >= start && window.effectiveEnd < end,
				);
	for (const window of tierWindows) {
		for (const pair of window.tiers) pairs.add(pair);
	}

	return {
		accountId,
		accountName: account.name,
		peakPct: contributing.reduce((sum, window) => sum + window.peakPct, 0),
		windows: contributing.length,
		resetAt: newest.resetAt,
		effectiveEnd: newest.effectiveEnd,
		abandoned: contributing.some((window) => window.abandoned),
		sampleCount: contributing.reduce(
			(sum, window) => sum + window.sampleCount,
			0,
		),
		observedThroughEnd: contributing.every(
			(window) => window.observedThroughEnd,
		),
		tierLabel: tierLabelFromPairs(pairs),
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Shape the stored usage history into account-weeks consumed per weekly cycle.
 *
 * Rows come out as one per servable class, each followed by the Anthropic
 * scoped families recorded inside it. A class with no snapshots at all is
 * omitted rather than rendered empty.
 */
export function computePoolSizing(
	input: PoolSizingComputeInput,
): PoolSizingResponse {
	const { now, reserveHeadroomPct } = input;
	const sinceMs = now - POOL_SIZING_LOOKBACK_MS;
	// A cycle whose start is older than this may hold windows whose first
	// samples fall outside the scan, so its peaks would be understated for a
	// reason nothing on screen could explain.
	const emitFloorMs = sinceMs + 3 * WINDOW_MS;

	const accountById = new Map(
		input.accounts.map((account) => [account.id, account]),
	);
	const classOf = (accountId: string): { id: string; label: string } | null => {
		const account = accountById.get(accountId);
		if (!account) return null;
		const servable = servableClassFor(account.provider);
		return { id: servable.classId, label: servable.label };
	};

	// --- account-wide series -------------------------------------------------
	const accountWideRows = new Map<
		string,
		Array<{
			resetAt: number;
			peakPct: number | null;
			sampleCount: number;
			firstSampledAt: number;
			lastSampledAt: number;
			firstPct: number | null;
			lastPct: number | null;
			tierPair: string | null;
		}>
	>();
	for (const row of input.resetPeaks) {
		const list = accountWideRows.get(row.accountId) ?? [];
		list.push({
			resetAt: row.resetAt,
			peakPct: row.peakPct,
			sampleCount: row.sampleCount,
			firstSampledAt: row.firstSampledAt,
			lastSampledAt: row.lastSampledAt,
			firstPct: row.firstPct,
			lastPct: row.lastPct,
			tierPair: encodeTierPair(row.planTier, row.rateLimitTier),
		});
		accountWideRows.set(row.accountId, list);
	}

	const accountWideSeries = new Map<string, PreparedSeries>();
	const accountWideWindows = new Map<string, SeriesWindow[]>();
	const tierPairsByAccount = new Map<string, Set<string>>();
	for (const [accountId, rows] of accountWideRows) {
		const series = buildSeries(accountId, accountId, rows);
		accountWideSeries.set(accountId, series);
		accountWideWindows.set(accountId, series.windows);
		const pairs = new Set<string>();
		for (const window of series.windows) {
			for (const pair of window.tiers) pairs.add(pair);
		}
		tierPairsByAccount.set(accountId, pairs);
	}

	// --- scoped series -------------------------------------------------------
	const scopedRows = new Map<
		string,
		{
			accountId: string;
			family: string;
			displayName: string;
			rows: Array<{
				resetAt: number;
				peakPct: number | null;
				sampleCount: number;
				firstSampledAt: number;
				lastSampledAt: number;
				firstPct: number | null;
				lastPct: number | null;
			}>;
		}
	>();
	const familyDisplayName = new Map<string, { name: string; at: number }>();
	for (const row of input.scopedResetPeaks) {
		const key = `${row.accountId}\u0000${row.family}\u0000${row.displayName}`;
		const bucket = scopedRows.get(key) ?? {
			accountId: row.accountId,
			family: row.family,
			displayName: row.displayName,
			rows: [],
		};
		bucket.rows.push({
			resetAt: row.resetAt,
			peakPct: row.peakPct,
			sampleCount: row.sampleCount,
			firstSampledAt: row.firstSampledAt,
			lastSampledAt: row.lastSampledAt,
			firstPct: row.firstPct,
			lastPct: row.lastPct,
		});
		scopedRows.set(key, bucket);
		// The family key is lossy across model generations, so the label shown is
		// the provider's own scope name from the most recently sampled row.
		const seen = familyDisplayName.get(row.family);
		if (!seen || row.lastSampledAt >= seen.at) {
			familyDisplayName.set(row.family, {
				name: row.displayName,
				at: row.lastSampledAt,
			});
		}
	}

	const scopedSeriesByAccountFamily = new Map<string, PreparedSeries[]>();
	for (const bucket of scopedRows.values()) {
		const key = `${bucket.accountId}\u0000${bucket.family}`;
		const series = buildSeries(
			bucket.accountId,
			bucket.displayName,
			bucket.rows,
		);
		const list = scopedSeriesByAccountFamily.get(key) ?? [];
		list.push(series);
		scopedSeriesByAccountFamily.set(key, list);
	}

	// --- observation ranges --------------------------------------------------
	const observationByAccount = new Map<string, TimeRange[]>();
	const pushObservation = (
		map: Map<string, TimeRange[]>,
		key: string,
		range: TimeRange,
	): void => {
		const list = map.get(key) ?? [];
		list.push(range);
		map.set(key, list);
	};
	for (const row of input.presence) {
		pushObservation(observationByAccount, row.accountId, {
			start: row.firstSampledAt,
			end: row.lastSampledAt,
		});
	}
	for (const series of accountWideSeries.values()) {
		for (const window of series.windows) {
			pushObservation(observationByAccount, series.accountId, {
				start: window.firstSampledAt,
				end: window.lastSampledAt,
			});
		}
		for (const range of series.idleRanges) {
			pushObservation(observationByAccount, series.accountId, range);
		}
	}

	const scopedObservation = new Map<string, TimeRange[]>();
	for (const row of input.scopedPresence) {
		pushObservation(scopedObservation, `${row.accountId}\u0000${row.family}`, {
			start: row.firstSampledAt,
			end: row.lastSampledAt,
		});
	}
	for (const [key, seriesList] of scopedSeriesByAccountFamily) {
		for (const series of seriesList) {
			for (const window of series.windows) {
				pushObservation(scopedObservation, key, {
					start: window.firstSampledAt,
					end: window.lastSampledAt,
				});
			}
			for (const range of series.idleRanges) {
				pushObservation(scopedObservation, key, range);
			}
		}
	}

	// --- stops ---------------------------------------------------------------
	const classified = input.stops.map(classifyStop);
	const separateStops = summarizeSeparateStops(classified);

	// --- 5-hour burst --------------------------------------------------------
	const burstByClass = new Map<string, Map<number, number>>();
	for (const tick of input.burstTicks) {
		const servable = servableClassFor(tick.provider ?? "unknown");
		const byTick =
			burstByClass.get(servable.classId) ?? new Map<number, number>();
		byTick.set(tick.sampledAt, (byTick.get(tick.sampledAt) ?? 0) + tick.spent);
		burstByClass.set(servable.classId, byTick);
	}

	// --- rows ----------------------------------------------------------------
	const classAccounts = new Map<string, { label: string; ids: string[] }>();
	for (const account of input.accounts) {
		const servable = servableClassFor(account.provider);
		const bucket = classAccounts.get(servable.classId) ?? {
			label: servable.label,
			ids: [],
		};
		bucket.ids.push(account.id);
		classAccounts.set(servable.classId, bucket);
	}

	const classesWithSnapshots = new Set<string>();
	for (const accountId of [
		...accountWideSeries.keys(),
		...observationByAccount.keys(),
	]) {
		const servable = classOf(accountId);
		if (servable) classesWithSnapshots.add(servable.id);
	}

	const ctx: RowContext = {
		accountById,
		accountWideWindows,
		tierPairsByAccount,
		stops: classified,
		reserveHeadroomPct,
		now,
		emitFloorMs,
	};

	const rows: PoolSizingRow[] = [];
	const orderedClassIds = [...classAccounts.keys()]
		.filter((classId) => classesWithSnapshots.has(classId))
		.sort(compareServableClasses);

	for (const classId of orderedClassIds) {
		const bucket = classAccounts.get(classId);
		if (!bucket) continue;
		const boundaryRule: PoolSizingBoundaryRule =
			classId === "anthropic" ? "reset_phase_gap" : "iso_week";

		const seriesByAccount = new Map<string, PreparedSeries[]>();
		const observation = new Map<string, TimeRange[]>();
		for (const accountId of bucket.ids) {
			const series = accountWideSeries.get(accountId);
			seriesByAccount.set(accountId, series ? [series] : []);
			observation.set(accountId, observationByAccount.get(accountId) ?? []);
		}

		const classRow = buildRow(
			{
				kind: "class",
				classId,
				classLabel: bucket.label,
				family: null,
				familyLabel: null,
				boundaryRule,
				accountIds: bucket.ids,
				seriesByAccount,
				observationByAccount: observation,
				burstByTick: burstByClass.get(classId) ?? new Map<number, number>(),
			},
			ctx,
		);
		if (classRow) rows.push(classRow);

		// Family rows: only families this class actually reports scoped windows
		// for, so a class the provider does not scope shows one row, not two.
		const families = new Set<string>();
		for (const key of [
			...scopedSeriesByAccountFamily.keys(),
			...scopedObservation.keys(),
		]) {
			const [accountId = "", family = ""] = key.split("\u0000");
			if (!bucket.ids.includes(accountId)) continue;
			families.add(family);
		}

		for (const family of [...families].sort()) {
			const familyAccountIds: string[] = [];
			const familySeries = new Map<string, PreparedSeries[]>();
			const familyObservation = new Map<string, TimeRange[]>();
			for (const accountId of bucket.ids) {
				const key = `${accountId}\u0000${family}`;
				const series = scopedSeriesByAccountFamily.get(key) ?? [];
				const ranges = scopedObservation.get(key) ?? [];
				if (series.length === 0 && ranges.length === 0) continue;
				familyAccountIds.push(accountId);
				familySeries.set(accountId, series);
				familyObservation.set(accountId, ranges);
			}
			if (familyAccountIds.length === 0) continue;

			const familyRow = buildRow(
				{
					kind: "family",
					classId,
					classLabel: bucket.label,
					family,
					familyLabel: familyDisplayName.get(family)?.name ?? family,
					boundaryRule,
					accountIds: familyAccountIds,
					seriesByAccount: familySeries,
					observationByAccount: familyObservation,
					burstByTick: null,
				},
				ctx,
			);
			if (familyRow) rows.push(familyRow);
		}
	}

	return {
		generatedAt: now,
		sinceMs,
		windowMs: WINDOW_MS,
		reserveHeadroomPct,
		verdictCycles: VERDICT_CYCLES,
		maxCycles: POOL_SIZING_MAX_CYCLES,
		rows,
		separateStops,
	};
}

function summarizeSeparateStops(
	stops: ClassifiedStop[],
): PoolSizingSeparateStop[] {
	const grouped = new Map<string, PoolSizingSeparateStop>();
	for (const stop of stops) {
		if (stop.kind !== "separate") continue;
		const key = `${stop.label}\u0000${stop.model ?? ""}`;
		const existing = grouped.get(key);
		if (!existing) {
			grouped.set(key, {
				label: stop.label,
				model: stop.model,
				count: 1,
				firstAt: stop.timestamp,
				lastAt: stop.timestamp,
			});
			continue;
		}
		existing.count += 1;
		existing.firstAt = Math.min(existing.firstAt, stop.timestamp);
		existing.lastAt = Math.max(existing.lastAt, stop.timestamp);
	}
	return [...grouped.values()].sort(
		(a, b) =>
			b.count - a.count ||
			a.label.localeCompare(b.label) ||
			(a.model ?? "").localeCompare(b.model ?? ""),
	);
}
