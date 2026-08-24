#!/usr/bin/env bun
/**
 * ledger-feasibility.ts — can the recorded request ledger explain the polled
 * utilization at all? A DIAGNOSTIC study for handover item 2. It is never wired
 * into the server, it produces no estimator, and no number it prints is used to
 * predict anything.
 *
 *     bun scripts/ledger-feasibility.ts [--db=<path>] [--from=<ISO>] [--to=<ISO>]
 *                                       [--selection-block-end=<ISO>] [--seed=N]
 *                                       [--out=<path>]
 *
 * The database is opened STRICTLY read-only. The live database is ~9.6 GB and
 * serves the running proxy; this script has no write path of any kind, and
 * `--out` refuses to resolve to the database file or any of its sidecars.
 *
 * All analysis lives in `packages/core/src/ledger-feasibility.ts` (pure,
 * unit-tested). This file does I/O and orchestration only. The deep imports
 * below follow the precedent set by `scripts/prediction-backtest.ts`.
 *
 * The report is a pure function of the rows inside `[from, to)` and the flags.
 * The live `accounts` table reaches none of it: the provider above all, since a
 * changed one would regroup rows the study already binned, but the identity
 * tier and its capture instant equally — they are rewritten by every identity
 * refresh of the running deployment, and no recorded row carries a tier the
 * study could have used instead. All of it is stderr-only.
 */

import type { Database } from "bun:sqlite";
import {
	type BinAnchor,
	BIN_ANCHORS,
	buildBins,
	capabilityMatrix,
	type CellKey,
	type CellScore,
	aggregateRelation,
	type EraBoundary,
	excludedGroupReason,
	type FeasibilityDatasetSummary,
	formatFeasibilityReport,
	type GroupCapability,
	type LedgerBin,
	type LedgerRequest,
	type LedgerWindowKind,
	permutedAccountRelationR2,
	selectCell,
	type TimeInterval,
	unmeasuredPermutationControl,
} from "../packages/core/src/ledger-feasibility";
import { resolveDbPath } from "../packages/database/src/paths";
import type { PredictionPoint } from "../packages/types/src/usage-prediction";
import {
	assertSafeOutPath,
	openReadOnlyDatabase,
	shellQuoteArg,
} from "./db-tool-io";

const MINUTE_MS = 60_000;

export const DEFAULT_SEED = 20260823;

/**
 * The frozen end of the study range, matching the committed prediction-backtest
 * baseline so both reports describe the same history.
 */
export const DEFAULT_TO_ISO = "2026-08-23T00:00:00Z";

/**
 * Where the selection block ends and the evaluation block begins.
 *
 * Everything before this instant may choose the (lag, width, anchor) cell;
 * nothing before it may be reported as a result.
 */
export const DEFAULT_SELECTION_BLOCK_END_ISO = "2026-07-15T00:00:00Z";

export const WINDOW_KINDS: readonly LedgerWindowKind[] = [
	"five_hour",
	"seven_day",
];

/** Bin widths swept, in minutes. 2 minutes is one sampler tick. */
export const WIDTH_GRID_MINUTES = [2, 5, 10] as const;

/**
 * Candidate lags swept, in minutes. All non-negative: a cause precedes its
 * effect, so a bin's rise may only be attributed to tokens spent at or before
 * it.
 */
export const LAG_GRID_MINUTES = [0, 2, 4, 6] as const;

/**
 * Future-token control offsets, in minutes.
 *
 * The control lag at width `W` is `-(W + offset)`, never a fixed small negative
 * number. A control must attribute a bin's rise to tokens spent WHOLLY after
 * that bin, and only a shift of at least a full bin width achieves that: at
 * `W = 10min` a lag of -2min moves a request's tokens into a bin that still
 * overlaps 8 of its own 10 minutes, so the "future" tokens are mostly the bin's
 * own present and the control inherits most of the real relation. A margin over
 * such a control is manufactured by construction rather than measured.
 *
 * With this construction a bin `(s, s+W]` at control lag `-(W+offset)` draws
 * from anchors in `(s+W+offset, s+2W+offset]`, every one of them strictly later
 * than the bin's own close, by at least `offset`.
 */
export const CONTROL_FUTURE_OFFSET_MINUTES = [2, 4] as const;

/**
 * Era boundaries the ratio is checked across.
 *
 * The two July constants are declared, not derived. The August one is resolved
 * to the merge commit of the usage-persistence change (`478440d3`, "Merge
 * inline-usage-sole-writer-reland: inline collector becomes the sole usage
 * writer", v2026.8.21), which is when the inline collector became the sole
 * writer of per-request token usage. Its COMMIT time stands in for its deploy
 * time — this checkout is the live deployment and restarts from the working
 * tree, so the two are close, but they are not the same instant and the report
 * says so.
 */
export const ERA_BOUNDARIES: readonly EraBoundary[] = [
	{
		label: "2026-07-20 boundary",
		atMs: Date.parse("2026-07-20T00:00:00Z"),
		provenance: "Declared constant.",
	},
	{
		label: "2026-07-21 boundary",
		atMs: Date.parse("2026-07-21T00:00:00Z"),
		provenance: "Declared constant.",
	},
	{
		label: "August usage-persistence cutover",
		// git log: 478440d3, Thu Aug 13 10:48:59 2026 +0200.
		atMs: Date.parse("2026-08-13T08:48:59Z"),
		provenance:
			"Commit time of merge `478440d3` (inline collector becomes the sole usage writer, v2026.8.21). COMMIT time is a proxy for DEPLOY time: this checkout is the live deployment and rebuilds from the working tree on restart, so the deploy followed the commit by an unrecorded interval.",
	},
];

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function openLedgerDatabase(dbPath: string): Database {
	return openReadOnlyDatabase(dbPath);
}

interface SnapshotRow {
	account_id: string;
	provider: string | null;
	sampled_at: number;
	five_hour_pct: number | null;
	five_hour_reset: number | null;
	seven_day_pct: number | null;
	seven_day_reset: number | null;
}

interface RequestRow {
	timestamp: number;
	account_used: string;
	model: string | null;
	response_time_ms: number | null;
	billing_type: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
}

interface AccountRow {
	id: string;
	provider: string | null;
	identity_rate_limit_tier: string | null;
	identity_captured_at: number | null;
}

export interface AccountSeries {
	accountId: string;
	provider: string;
	points: Record<LedgerWindowKind, PredictionPoint[]>;
	requests: LedgerRequest[];
}

/** The `usage_snapshots.provider` value used when the column itself is NULL. */
export const NULL_PROVIDER = "(null)";

/**
 * An account whose in-range snapshots do not agree on the provider.
 *
 * Reportable: every field of it comes from rows inside `[from, to)`, so it
 * cannot make the artifact move for a reason outside the studied history.
 */
export interface ProviderConflict {
	accountId: string;
	/** Distinct in-range values with their row counts, most frequent first. */
	values: { provider: string; rows: number }[];
	/** The value the study grouped the account under. */
	chosen: string;
}

/**
 * `accounts`-table metadata as it reads NOW. STDERR ONLY.
 *
 * The table is mutable and carries no history: a provider or tier changed after
 * the range would silently rewrite a frozen artifact, and a changed provider
 * would regroup rows the study already binned. So none of it reaches the report,
 * the tier and its capture instant included — an operator still wants to see
 * them, which is what stderr is for.
 */
export interface LiveAccountMetadata {
	accountId: string;
	liveProvider: string | null;
	liveTier: string | null;
	identityCapturedAtIso: string | null;
	/** The provider the study used, derived from in-range snapshots. */
	derivedProvider: string | null;
}

export interface StudyData {
	accounts: Map<string, AccountSeries>;
	keepalive: TimeInterval[];
	dataset: FeasibilityDatasetSummary;
	/** The frozen range every statistic above was computed over. */
	range: TimeInterval;
	/** In-range snapshot disagreements about an account's provider. */
	providerConflicts: ProviderConflict[];
	/** Live `accounts` rows, for stderr. Never an input to the report. */
	liveAccounts: LiveAccountMetadata[];
}

/**
 * Each account's provider, taken from its IN-RANGE snapshot rows.
 *
 * `usage_snapshots.provider` is the denormalized copy written when the sample
 * was taken, so it says what the account WAS during the studied history. The
 * `accounts` table says only what it is now, and a provider changed since would
 * regroup rows the study already binned — a re-run of a frozen range would then
 * produce a different report from the same history.
 *
 * The majority in-range value wins, ties going to the earliest seen (rows
 * arrive ordered by `sampled_at`, and `Map` preserves insertion order). Any
 * account whose rows disagree at all is reported as a conflict.
 */
export function providersFromSnapshots(
	rows: readonly { account_id: string; provider: string | null }[],
): {
	providerByAccount: Map<string, string>;
	conflicts: ProviderConflict[];
} {
	const countsByAccount = new Map<string, Map<string, number>>();
	for (const row of rows) {
		let counts = countsByAccount.get(row.account_id);
		if (counts == null) {
			counts = new Map<string, number>();
			countsByAccount.set(row.account_id, counts);
		}
		const provider = row.provider ?? NULL_PROVIDER;
		counts.set(provider, (counts.get(provider) ?? 0) + 1);
	}
	const providerByAccount = new Map<string, string>();
	const conflicts: ProviderConflict[] = [];
	for (const [accountId, counts] of countsByAccount) {
		const ranked = [...counts.entries()]
			.map(([provider, count]) => ({ provider, rows: count }))
			.sort((a, b) => b.rows - a.rows);
		const chosen = ranked[0].provider;
		providerByAccount.set(accountId, chosen);
		if (ranked.length > 1) conflicts.push({ accountId, values: ranked, chosen });
	}
	conflicts.sort((a, b) => a.accountId.localeCompare(b.accountId));
	return { providerByAccount, conflicts };
}

/**
 * Stretches during which cache keepalive was doing work.
 *
 * `cache_keepalive_snapshots` carries CUMULATIVE-since-restart counters and no
 * account or token attribution at all, so it cannot say WHOSE quota keepalive
 * traffic spent, only WHEN some was spent. An increase in `keepalives_sent`
 * between two consecutive samples marks the interval between them active; a
 * DECREASE is a process restart resetting the counter, not activity, and is
 * ignored. Adjacent active intervals are merged so the result is a small,
 * sorted, disjoint list.
 */
export function keepaliveActivePeriods(
	rows: readonly { sampled_at: number; keepalives_sent: number }[],
): TimeInterval[] {
	const periods: TimeInterval[] = [];
	for (let i = 1; i < rows.length; i++) {
		const prev = rows[i - 1];
		const cur = rows[i];
		if (!(cur.keepalives_sent > prev.keepalives_sent)) continue;
		const last = periods.length ? periods[periods.length - 1] : null;
		if (last != null && last.toMs >= prev.sampled_at) {
			last.toMs = Math.max(last.toMs, cur.sampled_at);
		} else {
			periods.push({ fromMs: prev.sampled_at, toMs: cur.sampled_at });
		}
	}
	return periods;
}

/**
 * Snapshot history bounds over the WHOLE table.
 *
 * The one live, unbounded read in this tool, and it exists for a single
 * purpose: resolving a missing `--from` to the start of history. Nothing it
 * returns reaches the report — every dataset statistic there is computed over
 * `[from, to)` so that a growing database cannot rewrite a frozen artifact.
 */
export function readSnapshotBounds(db: Database): {
	firstMs: number | null;
	lastMs: number | null;
} {
	const row = db
		.query<{ first_ms: number | null; last_ms: number | null }, []>(
			"SELECT MIN(sampled_at) AS first_ms, MAX(sampled_at) AS last_ms FROM usage_snapshots",
		)
		.get();
	return { firstMs: row?.first_ms ?? null, lastMs: row?.last_ms ?? null };
}

export function loadStudyData(
	db: Database,
	fromMs: number,
	toMs: number,
): StudyData {
	const snapshotRows = db
		.query<SnapshotRow, [number, number]>(
			`SELECT account_id, provider, sampled_at, five_hour_pct, five_hour_reset,
			        seven_day_pct, seven_day_reset
			 FROM usage_snapshots
			 WHERE sampled_at >= ? AND sampled_at < ?
			 ORDER BY account_id, sampled_at`,
		)
		.all(fromMs, toMs);
	// Grouping comes from the snapshots themselves, never from the live
	// `accounts` row: see `providersFromSnapshots`.
	const { providerByAccount, conflicts: providerConflicts } =
		providersFromSnapshots(snapshotRows);

	const accountRows = db
		.query<AccountRow, []>(
			"SELECT id, provider, identity_rate_limit_tier, identity_captured_at FROM accounts",
		)
		.all();
	const liveAccounts: LiveAccountMetadata[] = [];
	for (const row of accountRows) {
		// Read, but only for stderr. Neither the tier nor its capture instant is an
		// input to the report: both are rewritten by every identity refresh of the
		// running deployment, so either one in the artifact would rewrite a frozen
		// report for a reason that has nothing to do with the studied history.
		liveAccounts.push({
			accountId: row.id,
			liveProvider: row.provider,
			liveTier: row.identity_rate_limit_tier,
			identityCapturedAtIso:
				row.identity_captured_at != null
					? new Date(row.identity_captured_at).toISOString()
					: null,
			derivedProvider: providerByAccount.get(row.id) ?? null,
		});
	}
	liveAccounts.sort((a, b) => a.accountId.localeCompare(b.accountId));

	const accounts = new Map<string, AccountSeries>();
	const ensure = (accountId: string) => {
		let entry = accounts.get(accountId);
		if (entry == null) {
			entry = {
				accountId,
				provider: providerByAccount.get(accountId) ?? NULL_PROVIDER,
				points: { five_hour: [], seven_day: [] },
				requests: [],
			};
			accounts.set(accountId, entry);
		}
		return entry;
	};

	for (const row of snapshotRows) {
		const entry = ensure(row.account_id);
		if (row.five_hour_pct != null) {
			entry.points.five_hour.push({
				t: row.sampled_at,
				utilization: row.five_hour_pct,
				resetsAt: row.five_hour_reset,
			});
		}
		if (row.seven_day_pct != null) {
			entry.points.seven_day.push({
				t: row.sampled_at,
				utilization: row.seven_day_pct,
				resetsAt: row.seven_day_reset,
			});
		}
	}

	const requestRows = db
		.query<RequestRow, [number, number]>(
			`SELECT timestamp, account_used, model, response_time_ms, billing_type,
			        input_tokens, output_tokens, cache_read_input_tokens,
			        cache_creation_input_tokens
			 FROM requests
			 WHERE account_used IS NOT NULL AND timestamp >= ? AND timestamp < ?
			 ORDER BY account_used, timestamp`,
		)
		.all(fromMs, toMs);
	for (const row of requestRows) {
		// Only accounts that have a snapshot series can be binned at all; a
		// request for any other account has no percent series to explain.
		const entry = accounts.get(row.account_used);
		if (entry == null) continue;
		entry.requests.push({
			timestamp: row.timestamp,
			accountId: row.account_used,
			model: row.model,
			responseTimeMs: row.response_time_ms,
			billingType: row.billing_type,
			inputTokens: row.input_tokens ?? 0,
			outputTokens: row.output_tokens ?? 0,
			cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
			cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
		});
	}

	const keepaliveRows = db
		.query<{ sampled_at: number; keepalives_sent: number }, [number, number]>(
			`SELECT sampled_at, keepalives_sent FROM cache_keepalive_snapshots
			 WHERE sampled_at >= ? AND sampled_at < ? ORDER BY sampled_at`,
		)
		.all(fromMs, toMs);
	const keepalive = keepaliveActivePeriods(keepaliveRows);

	// IN-RANGE bounds, taken from the rows just loaded rather than from a
	// whole-table MIN/MAX. The database is live and keeps growing past `toMs`,
	// so a whole-table bound would both describe history this study never read
	// and change the report on every re-run.
	const bounds = (rows: readonly number[]) => {
		let first: number | null = null;
		let last: number | null = null;
		for (const ms of rows) {
			if (first == null || ms < first) first = ms;
			if (last == null || ms > last) last = ms;
		}
		return { first, last };
	};
	const snapshotBounds = bounds(snapshotRows.map((r) => r.sampled_at));
	const requestBounds = bounds(requestRows.map((r) => r.timestamp));
	const providers = [
		...new Set([...accounts.values()].map((a) => a.provider)),
	].sort();

	const iso = (ms: number | null | undefined) =>
		ms != null ? new Date(ms).toISOString() : "—";

	return {
		accounts,
		keepalive,
		dataset: {
			snapshotRows: snapshotRows.length,
			requestRows: requestRows.length,
			accounts: accounts.size,
			providers,
			firstSnapshotIso: iso(snapshotBounds.first),
			lastSnapshotIso: iso(snapshotBounds.last),
			firstRequestIso: iso(requestBounds.first),
			lastRequestIso: iso(requestBounds.last),
			keepaliveActivePeriods: keepalive.length,
		},
		range: { fromMs, toMs },
		providerConflicts,
		liveAccounts,
	};
}

// ---------------------------------------------------------------------------
// The cell grid
// ---------------------------------------------------------------------------

export interface GridCell extends CellKey {
	control: boolean;
}

/**
 * Every (lag, width, anchor) combination, in a fixed deterministic order.
 *
 * Candidate cells first, then that width's future-token controls. The controls
 * are WIDTH-DEPENDENT by construction (`-(width + offset)`), so a control cell
 * only ever exists alongside the width it was built for — which is also the
 * only width it may be compared against.
 */
export function buildCellGrid(): GridCell[] {
	const cells: GridCell[] = [];
	for (const widthMinutes of WIDTH_GRID_MINUTES) {
		const widthMs = widthMinutes * MINUTE_MS;
		for (const lagMinutes of LAG_GRID_MINUTES) {
			for (const anchor of BIN_ANCHORS) {
				cells.push({
					lagMs: lagMinutes * MINUTE_MS,
					widthMs,
					anchor,
					control: false,
				});
			}
		}
		for (const offsetMinutes of CONTROL_FUTURE_OFFSET_MINUTES) {
			for (const anchor of BIN_ANCHORS) {
				cells.push({
					lagMs: -(widthMs + offsetMinutes * MINUTE_MS),
					widthMs,
					anchor,
					control: true,
				});
			}
		}
	}
	return cells;
}

export interface GroupKey {
	provider: string;
	windowKind: LedgerWindowKind;
}

function groupKeyOf(key: GroupKey): string {
	return `${key.provider}|${key.windowKind}`;
}

export interface CellBlockBins {
	selection: LedgerBin[];
	evaluation: LedgerBin[];
	/** Bins whose data spanned the boundary and so belong to neither block. */
	boundaryDropped: number;
}

/** The three instants that bound the two blocks: `[from, split, to)`. */
export interface BlockBounds {
	fromMs: number;
	selectionEndMs: number;
	toMs: number;
}

/**
 * Bin one cell across every account and window, split into the two time blocks.
 *
 * Bins are built over the WHOLE range and then partitioned, so a bin never
 * exists in two blocks: one that straddles the boundary belongs to neither and
 * is dropped from both.
 *
 * A bin's DATA is two intervals, not one: the bin `(s, s+W]` supplies the
 * percent mass, and the tokens come from the unshifted anchor interval
 * `(s - lag, s + W - lag]`. Both must lie wholly inside `[from, split)` or
 * wholly inside `[split, to)` for the bin to count toward that block.
 *
 * Both halves of that rule are load-bearing, and the OUTER bound as much as the
 * inner one. Partitioning on the bin interval alone would let a positive lag
 * pull selection-block requests into an evaluation-block bin, which is the leak
 * the blocked design exists to prevent. Ignoring `[from, to)` would be a
 * quieter version of the same error against the range itself: only requests
 * inside the range were loaded, so a control bin near `to` — whose token source
 * interval lies a full width and more PAST the bin — would be scored on the
 * fraction of its token mass that happened to fall before the cutoff, and a
 * positive-lag bin at the range's start on tokens that were never read at all.
 * Bins in either position are dropped from both blocks and COUNTED.
 */
export function binsForCell(
	data: StudyData,
	cell: GridCell,
	bounds: BlockBounds,
): Map<string, CellBlockBins> {
	const { fromMs, selectionEndMs, toMs } = bounds;
	const out = new Map<string, CellBlockBins>();
	for (const account of [...data.accounts.values()].sort((a, b) =>
		a.accountId.localeCompare(b.accountId),
	)) {
		for (const windowKind of WINDOW_KINDS) {
			const points = account.points[windowKind];
			if (points.length === 0) continue;
			const key = groupKeyOf({ provider: account.provider, windowKind });
			let bucket = out.get(key);
			if (bucket == null) {
				bucket = { selection: [], evaluation: [], boundaryDropped: 0 };
				out.set(key, bucket);
			}
			const { bins } = buildBins(points, account.requests, {
				widthMs: cell.widthMs,
				lagMs: cell.lagMs,
				anchor: cell.anchor,
				accountId: account.accountId,
				keepaliveActivePeriods: data.keepalive,
			});
			for (const bin of bins) {
				const sourceStartMs = bin.startMs - cell.lagMs;
				const sourceEndMs = bin.endMs - cell.lagMs;
				const earliestMs = Math.min(bin.startMs, sourceStartMs);
				const latestMs = Math.max(bin.endMs, sourceEndMs);
				if (earliestMs >= fromMs && latestMs <= selectionEndMs) {
					bucket.selection.push(bin);
				} else if (earliestMs >= selectionEndMs && latestMs <= toMs) {
					bucket.evaluation.push(bin);
				} else {
					bucket.boundaryDropped++;
				}
			}
		}
	}
	return out;
}

function blockScore(bins: readonly LedgerBin[]) {
	const relation = aggregateRelation(bins);
	return {
		r2: relation.r2,
		usableBins: relation.usableBins,
		positiveSignalBins: relation.positiveSignalBins,
	};
}

export interface StudyResult {
	data: StudyData;
	groups: GroupCapability[];
	cellScoresByGroup: {
		provider: string;
		windowKind: LedgerWindowKind;
		cells: CellScore[];
	}[];
	/** Per group, bins dropped at the selected cell for spanning the block split. */
	boundaryDroppedByGroup: {
		provider: string;
		windowKind: LedgerWindowKind;
		bins: number;
	}[];
	sweepMs: number;
	analysisMs: number;
}

export interface StudyOptions {
	fromMs: number;
	toMs: number;
	selectionEndMs: number;
	seed: number;
	/** Progress line per swept cell; off in tests. */
	onProgress?: (message: string) => void;
}

/**
 * Run the whole study.
 *
 * Two passes on purpose. The SWEEP builds bins for every cell, keeps only the
 * two scalar block scores, and throws the bins away — holding 36 cells' worth
 * of bins at once would be gigabytes for nothing. The ANALYSIS then rebuilds
 * bins once per group at that group's selected cell, which is the only cell any
 * reported number comes from.
 */
export function runFeasibilityStudy(
	dbPath: string,
	options: StudyOptions,
): StudyResult {
	const db = openLedgerDatabase(dbPath);
	let data: StudyData;
	try {
		data = loadStudyData(db, options.fromMs, options.toMs);
	} finally {
		db.close();
	}

	const grid = buildCellGrid();
	const scoresByGroup = new Map<string, CellScore[]>();
	const groupKeys = new Map<string, GroupKey>();

	const bounds: BlockBounds = {
		fromMs: options.fromMs,
		selectionEndMs: options.selectionEndMs,
		toMs: options.toMs,
	};

	const sweepStart = Date.now();
	for (const cell of grid) {
		const binned = binsForCell(data, cell, bounds);
		for (const [key, bucket] of binned) {
			const [provider, windowKind] = key.split("|");
			groupKeys.set(key, {
				provider,
				windowKind: windowKind as LedgerWindowKind,
			});
			const list = scoresByGroup.get(key) ?? [];
			list.push({
				cell: {
					lagMs: cell.lagMs,
					widthMs: cell.widthMs,
					anchor: cell.anchor,
				},
				selection: blockScore(bucket.selection),
				evaluation: blockScore(bucket.evaluation),
				control: cell.control,
			});
			scoresByGroup.set(key, list);
		}
		options.onProgress?.(
			`swept L=${cell.lagMs / MINUTE_MS}min W=${cell.widthMs / MINUTE_MS}min ${cell.anchor}`,
		);
	}
	const sweepMs = Date.now() - sweepStart;

	const analysisStart = Date.now();
	const groups: GroupCapability[] = [];
	const cellScoresByGroup: StudyResult["cellScoresByGroup"] = [];
	const boundaryDroppedByGroup: StudyResult["boundaryDroppedByGroup"] = [];
	for (const key of [...groupKeys.keys()].sort()) {
		const group = groupKeys.get(key);
		if (group == null) continue;
		const cells = scoresByGroup.get(key) ?? [];
		cellScoresByGroup.push({
			provider: group.provider,
			windowKind: group.windowKind,
			cells,
		});

		if (excludedGroupReason(group.provider, group.windowKind) != null) {
			groups.push(
				capabilityMatrix({
					provider: group.provider,
					windowKind: group.windowKind,
					evaluationBins: [],
					selectionBins: [],
					cellScores: cells,
					permutation: unmeasuredPermutationControl(
						options.seed,
						"the group is excluded outright, so no placebo was run",
					),
					eraBoundaries: ERA_BOUNDARIES,
					seed: options.seed,
				}),
			);
			continue;
		}

		// The RANKING depends only on the selection-block scores, never on a
		// control, so the winner can be read from a call whose control is still
		// unknown. Only the verdict of the second call is used.
		const tentative = selectCell(
			cells,
			unmeasuredPermutationControl(
				options.seed,
				"ranking pass: the placebo needs the selected cell's bins, which do not exist yet",
			),
		);
		if (tentative.selected == null) {
			// No cell was scorable on the selection block. There is nothing to
			// analyse and nothing may stand in for it: falling back to some other
			// cell would report numbers from a cell the selection rule REJECTED,
			// and the first cell of the grid is not even a candidate.
			groups.push(
				capabilityMatrix({
					provider: group.provider,
					windowKind: group.windowKind,
					evaluationBins: [],
					selectionBins: [],
					cellScores: cells,
					permutation: unmeasuredPermutationControl(
						options.seed,
						"no cell was selected, so no bins were built to permute",
					),
					eraBoundaries: ERA_BOUNDARIES,
					seed: options.seed,
					analysisUnavailable: `No cell reached the minimum usable and positive-signal bin counts on the selection block, so no cell was selected and no bins were analysed. ${tentative.verdictDetail}`,
				}),
			);
			continue;
		}
		const chosen: GridCell = { ...tentative.selected, control: false };
		const binned = binsForCell(data, chosen, bounds);
		const bucket = binned.get(key) ?? {
			selection: [],
			evaluation: [],
			boundaryDropped: 0,
		};
		boundaryDroppedByGroup.push({
			provider: group.provider,
			windowKind: group.windowKind,
			bins: bucket.boundaryDropped,
		});
		const permutation = permutedAccountRelationR2(
			bucket.evaluation,
			options.seed,
		);
		groups.push(
			capabilityMatrix({
				provider: group.provider,
				windowKind: group.windowKind,
				evaluationBins: bucket.evaluation,
				selectionBins: bucket.selection,
				cellScores: cells,
				permutation,
				eraBoundaries: ERA_BOUNDARIES,
				seed: options.seed,
			}),
		);
	}
	const analysisMs = Date.now() - analysisStart;

	return {
		data,
		groups,
		cellScoresByGroup,
		boundaryDroppedByGroup,
		sweepMs,
		analysisMs,
	};
}


// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: bun scripts/ledger-feasibility.ts [--db=<path>] [--from=<ISO>] [--to=<ISO>]
       [--selection-block-end=<ISO>] [--seed=N] [--out=<path>]`;

export interface CliOptions {
	dbPath: string | null;
	fromIso: string | null;
	toIso: string | null;
	selectionBlockEndIso: string | null;
	seed: number;
	outPath: string | null;
}

export function parseCliArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		dbPath: null,
		fromIso: null,
		toIso: null,
		selectionBlockEndIso: null,
		seed: DEFAULT_SEED,
		outPath: null,
	};
	for (const arg of argv) {
		if (arg.startsWith("--db=")) options.dbPath = arg.slice(5);
		else if (arg.startsWith("--from=")) options.fromIso = arg.slice(7);
		else if (arg.startsWith("--to=")) options.toIso = arg.slice(5);
		else if (arg.startsWith("--selection-block-end=")) {
			options.selectionBlockEndIso = arg.slice(22);
		} else if (arg.startsWith("--seed=")) {
			const n = Number(arg.slice(7));
			if (!Number.isInteger(n)) throw new Error(`Invalid --seed: ${arg}`);
			options.seed = n;
		} else if (arg.startsWith("--out=")) options.outPath = arg.slice(6);
		else if (arg === "--help" || arg === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
	}
	return options;
}

function parseIso(value: string, flag: string): number {
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) {
		throw new Error(`Invalid ${flag} timestamp: ${value}`);
	}
	return ms;
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const dbPath = options.dbPath ?? resolveDbPath();
	if (options.outPath) assertSafeOutPath(options.outPath, dbPath);

	const probe = openLedgerDatabase(dbPath);
	let historyFirst: number | null;
	try {
		historyFirst = readSnapshotBounds(probe).firstMs;
	} finally {
		probe.close();
	}
	if (historyFirst == null) {
		throw new Error("usage_snapshots is empty — nothing to study");
	}

	// History starts at the first snapshot: nothing earlier can produce a bin,
	// however far back the request ledger reaches.
	const fromMs = options.fromIso
		? parseIso(options.fromIso, "--from")
		: historyFirst;
	const toMs = parseIso(options.toIso ?? DEFAULT_TO_ISO, "--to");
	const selectionEndMs = parseIso(
		options.selectionBlockEndIso ?? DEFAULT_SELECTION_BLOCK_END_ISO,
		"--selection-block-end",
	);
	if (toMs <= fromMs) throw new Error("--to must be after --from");
	if (selectionEndMs <= fromMs || selectionEndMs >= toMs) {
		throw new Error("--selection-block-end must fall inside [--from, --to)");
	}

	const started = Date.now();
	const result = runFeasibilityStudy(dbPath, {
		fromMs,
		toMs,
		selectionEndMs,
		seed: options.seed,
		onProgress: (message) => console.error(message),
	});
	const elapsedMs = Date.now() - started;

	const command = [
		"bun scripts/ledger-feasibility.ts",
		...process.argv.slice(2).map(shellQuoteArg),
	].join(" ");

	const boundaryDropped = result.boundaryDroppedByGroup
		.map((g) => `${g.provider}/${g.windowKind} ${g.bins}`)
		.join(", ");

	// A conflict is derived wholly from in-range rows, so it belongs in the
	// artifact: it says the studied history itself disagrees about the account,
	// not that a live row changed after the fact.
	const conflictNotes = result.data.providerConflicts.map(
		(c) =>
			`In-range snapshots disagree about the provider of account ${c.accountId}: ${c.values
				.map((v) => `${v.provider} (${v.rows} rows)`)
				.join(", ")}. The study grouped it under \`${c.chosen}\`, the majority in-range value, so some of its bins describe history recorded under another provider.`,
	);

	const markdown = formatFeasibilityReport({
		title: "ClankerMux request-ledger burn-model feasibility",
		command,
		config: {
			from: new Date(fromMs).toISOString(),
			to: new Date(toMs).toISOString(),
			selectionBlockEnd: new Date(selectionEndMs).toISOString(),
			seed: options.seed,
			widthsMinutes: WIDTH_GRID_MINUTES.join(","),
			candidateLagsMinutes: LAG_GRID_MINUTES.join(","),
			controlFutureOffsetsMinutes: CONTROL_FUTURE_OFFSET_MINUTES.join(","),
			anchors: BIN_ANCHORS.join(","),
			cells: buildCellGrid().length,
		},
		dataset: result.data.dataset,
		selectionBlock: {
			fromIso: new Date(fromMs).toISOString(),
			toIso: new Date(selectionEndMs).toISOString(),
		},
		evaluationBlock: {
			fromIso: new Date(selectionEndMs).toISOString(),
			toIso: new Date(toMs).toISOString(),
		},
		eraBoundaries: ERA_BOUNDARIES,
		groups: result.groups,
		cellScoresByGroup: result.cellScoresByGroup,
		notes: [
			"This is a data-feasibility study. It produces no estimator and nothing here is wired into the running service.",
			`Bins dropped at the selected cell because the bin interval or its token-source interval left the block it would otherwise belong to — by spanning the selection/evaluation split, or by reaching before the study range's start or past its end: ${boundaryDropped || "none"}. A bin counts toward a block only when BOTH intervals lie wholly inside it.`,
			"`cache_keepalive_snapshots` carries no account or token attribution, so keepalive-active marking says WHEN keepalive traffic existed, never WHOSE quota it spent. It is informational and does not exclude a bin.",
			"Each account is grouped by the provider its IN-RANGE snapshots recorded, not by the live `accounts` row: the table has no history, so reading it would let a provider changed after the range regroup history the study already binned.",
			...conflictNotes,
		],
	});

	// Runtime metadata is stderr-only: it must never reach the artifact, which
	// has to stay byte-identical across re-runs on unchanged history.
	console.error(
		`cell sweep ${(result.sweepMs / 1000).toFixed(1)} s; per-group analyses ${(result.analysisMs / 1000).toFixed(1)} s; total ${(elapsedMs / 1000).toFixed(1)} s`,
	);

	// Live `accounts` metadata, likewise stderr-only. It is worth SEEING — a
	// provider that has since changed explains a group the report describes — but
	// it is mutable and unversioned, so it may not enter the artifact.
	for (const account of result.data.liveAccounts) {
		console.error(
			`live accounts row ${account.accountId}: provider ${account.liveProvider ?? "(null)"} (study used ${account.derivedProvider ?? "no in-range snapshots"}); identity_rate_limit_tier ${account.liveTier ?? "(null)"} captured ${account.identityCapturedAtIso ?? "(never)"}`,
		);
	}
	for (const note of conflictNotes) console.error(note);

	if (options.outPath) {
		await Bun.write(options.outPath, markdown);
		console.error(`wrote ${options.outPath}`);
	} else {
		console.log(markdown);
	}
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
