import { FIXED_WINDOW_DURATION_MS } from "@clankermux/core";
import {
	AccountRepository,
	UsageSnapshotRepository,
} from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	Account,
	RankedSnapshot,
	UsageHistoryPoint,
	UsageHistoryPoolPoint,
	UsageHistoryResponse,
	UsageHistorySeries,
} from "@clankermux/types";
import type { APIContext } from "../types";
import { getRangeConfig } from "./range-config";
import {
	avgOrNull,
	buildBucketGrid,
	type CarryPredecessor,
	type CarrySample,
	maxOrNull,
	normalizeRange,
	walkCarry,
} from "./usage-history-shared";

const log = new Logger("UsageHistoryHandler");

/**
 * Data sources the usage-history shaping logic reads from. In production these
 * are repositories on the dashboard worker's read-only connection; tests
 * supply plain mocks so the carry-forward/pool logic stays unit-testable
 * without a worker or a real database.
 */
export interface UsageHistorySources {
	getUsageSnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<RankedSnapshot[]>;
	/**
	 * The last reading per account before the range starts, so the left edge of
	 * the chart is not blind. See UsageSnapshotRepository.getLatestSnapshotsBefore.
	 */
	getLatestSnapshotsBefore(beforeMs: number): Promise<RankedSnapshot[]>;
	getAllAccounts(): Promise<Array<Pick<Account, "id" | "name">>>;
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?(): number;
}

/**
 * Direct (in-process) /api/analytics/usage-history implementation for the
 * Limits-tab sawtooth chart.
 *
 * Pure read path: runs against whatever connection the supplied context
 * exposes via `dbOps.getAdapter()`. In production this executes inside the
 * read-only dashboard worker (see analytics-runner.ts / analytics-worker.ts)
 * so the synchronous bun:sqlite queries never block the main event loop —
 * range=all scans the full snapshot retention (~260k rows at 90d × 2-min
 * sampling × 4 accounts), which is far too long for the main thread.
 */
export function createUsageHistoryHandler(context: APIContext) {
	const adapter = context.dbOps.getAdapter();
	const usageSnapshots = new UsageSnapshotRepository(adapter);
	const accounts = new AccountRepository(adapter);
	return createUsageHistoryHandlerFromSources({
		getUsageSnapshots: (opts) => usageSnapshots.getSnapshots(opts),
		getLatestSnapshotsBefore: (beforeMs) =>
			usageSnapshots.getLatestSnapshotsBefore(beforeMs),
		getAllAccounts: () => accounts.findAll(),
	});
}

/**
 * Shape the usage_snapshots time-series into per-account series + a pool
 * aggregate over a regular bucket grid.
 *
 * Carry-forward: a maxed-out account that stops reporting (paused, exhausted)
 * must not silently fall out of the pool average — dropping the highest
 * account makes the pool *look* healthier the moment it got worse. So each
 * account's last recorded value is held across gap buckets until that sample's
 * window reset (per window), keeping its contribution in both its own series
 * and the pool denominator. After the real reset it expires, so a genuine
 * window roll (a true drop to ~0%) still shows.
 *
 * The grid comes from buildBucketGrid rather than from the timestamps present
 * in the rows, and the walk is seeded with the reading in force at the range
 * start — see that helper for the two gaps this closes at the edges.
 */
export function createUsageHistoryHandlerFromSources(
	sources: UsageHistorySources,
) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			// "all" scans from sinceMs 0 — full snapshot retention.
			const { bucketMs, windowMs } = getRangeConfig(range);
			const nowMs = sources.now?.() ?? Date.now();
			const sinceMs = windowMs === null ? 0 : nowMs - windowMs;

			const [rows, predecessors, accounts] = await Promise.all([
				sources.getUsageSnapshots({ sinceMs, bucketMs }),
				// Nothing can precede an unbounded range, so don't pay for the scan.
				sinceMs > 0
					? sources.getLatestSnapshotsBefore(sinceMs)
					: Promise.resolve([]),
				sources.getAllAccounts(),
			]);

			const nameById = new Map(accounts.map((a) => [a.id, a.name]));

			// A predecessor means evidence was already in force at the range start,
			// so the grid starts there. Otherwise it starts at the first recorded
			// bucket. Scanned rather than spread (`Math.min(...rows)`) because
			// range=all returns the full retention — hundreds of thousands of rows.
			let earliestRowTs: number | null = null;
			for (const row of rows) {
				if (earliestRowTs === null || row.ts < earliestRowTs) {
					earliestRowTs = row.ts;
				}
			}
			const firstEvidenceMs = predecessors.length > 0 ? sinceMs : earliestRowTs;
			const grid = buildBucketGrid({
				sinceMs,
				bucketMs,
				nowMs,
				firstEvidenceMs,
			});

			// Index rows by account → (ts → row), and each account's provider.
			// Predecessor-only accounts are registered FIRST: their evidence is the
			// oldest, and an account that went silent before the range began still
			// belongs in the chart.
			const rowsByAccount = new Map<string, Map<number, RankedSnapshot>>();
			const predecessorByAccount = new Map<string, RankedSnapshot>();
			const providerById = new Map<string, string>();
			const accountOrder: string[] = [];
			const register = (row: RankedSnapshot): void => {
				if (rowsByAccount.has(row.accountId)) return;
				rowsByAccount.set(row.accountId, new Map());
				providerById.set(row.accountId, row.provider ?? "unknown");
				accountOrder.push(row.accountId);
			};
			for (const row of predecessors) {
				register(row);
				predecessorByAccount.set(row.accountId, row);
			}
			for (const row of rows) {
				register(row);
				rowsByAccount.get(row.accountId)?.set(row.ts, row);
			}

			// Pool buckets, seeded for every GRID bucket so an all-null bucket still
			// yields a (null-avg, count 0) point rather than vanishing.
			const poolByTs = new Map<
				number,
				{ fiveHour: number[]; sevenDay: number[]; contributors: Set<string> }
			>();
			for (const ts of grid) {
				poolByTs.set(ts, {
					fiveHour: [],
					sevenDay: [],
					contributors: new Set(),
				});
			}

			// Walk each account across the shared bucket grid, carrying its last
			// value per window forward across gaps until that value's reset. Feeds
			// both the per-account series and the pool aggregate from one pass.
			const series: UsageHistorySeries[] = [];
			for (const accountId of accountOrder) {
				const tsMap = rowsByAccount.get(accountId);
				if (!tsMap) continue;
				const predecessor = predecessorByAccount.get(accountId) ?? null;
				const five = walkCarry(
					grid,
					windowSamples(tsMap, (r) => ({
						pct: r.fiveHourPct,
						reset: r.fiveHourReset,
					})),
					windowPredecessor(predecessor, (r) => ({
						pct: r.fiveHourPct,
						reset: r.fiveHourReset,
					})),
					FIXED_WINDOW_DURATION_MS.five_hour,
					sinceMs,
				);
				const seven = walkCarry(
					grid,
					windowSamples(tsMap, (r) => ({
						pct: r.sevenDayPct,
						reset: r.sevenDayReset,
					})),
					windowPredecessor(predecessor, (r) => ({
						pct: r.sevenDayPct,
						reset: r.sevenDayReset,
					})),
					FIXED_WINDOW_DURATION_MS.seven_day,
					sinceMs,
				);

				const points: UsageHistoryPoint[] = [];
				for (const ts of grid) {
					const fivePct = five.get(ts) ?? null;
					const sevenPct = seven.get(ts) ?? null;
					if (fivePct == null && sevenPct == null) continue;

					points.push({ ts, fiveHourPct: fivePct, sevenDayPct: sevenPct });
					const bucket = poolByTs.get(ts);
					if (bucket) {
						if (fivePct != null) bucket.fiveHour.push(fivePct);
						if (sevenPct != null) bucket.sevenDay.push(sevenPct);
						bucket.contributors.add(accountId);
					}
				}
				if (points.length > 0) {
					series.push({
						accountId,
						name: nameById.get(accountId) ?? accountId,
						provider: providerById.get(accountId) ?? "unknown",
						points,
					});
				}
			}

			// The grid is ascending, so the pool is sorted by construction.
			const pool: UsageHistoryPoolPoint[] = grid.map((ts) => {
				const b = poolByTs.get(ts) ?? {
					fiveHour: [],
					sevenDay: [],
					contributors: new Set<string>(),
				};
				return {
					ts,
					fiveHourAvg: avgOrNull(b.fiveHour),
					sevenDayAvg: avgOrNull(b.sevenDay),
					fiveHourMax: maxOrNull(b.fiveHour),
					sevenDayMax: maxOrNull(b.sevenDay),
					sampledCount: b.contributors.size,
				};
			});

			const response: UsageHistoryResponse = {
				range,
				bucketMs,
				series,
				pool,
			};
			return jsonResponse(response);
		} catch (error) {
			log.error("Usage history error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch usage history data"),
			);
		}
	};
}

/** Project one window out of an account's bucketed rows for {@link walkCarry}. */
function windowSamples(
	tsMap: Map<number, RankedSnapshot>,
	pick: (row: RankedSnapshot) => CarrySample,
): Map<number, CarrySample> {
	const samples = new Map<number, CarrySample>();
	for (const [ts, row] of tsMap) samples.set(ts, pick(row));
	return samples;
}

/** The same projection for the pre-range reading, keeping its sample time. */
function windowPredecessor(
	row: RankedSnapshot | null,
	pick: (row: RankedSnapshot) => CarrySample,
): CarryPredecessor | null {
	if (!row) return null;
	return { ...pick(row), sampledAt: row.ts };
}
