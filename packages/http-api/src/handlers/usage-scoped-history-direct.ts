import { FIXED_WINDOW_DURATION_MS } from "@clankermux/core";
import {
	AccountRepository,
	UsageScopedSnapshotRepository,
} from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	Account,
	RankedScopedSnapshot,
	UsageScopedHistoryFamily,
	UsageScopedHistoryPoint,
	UsageScopedHistoryPoolPoint,
	UsageScopedHistoryResponse,
	UsageScopedHistorySeries,
} from "@clankermux/types";
import type { APIContext } from "../types";
import { getRangeConfig } from "./range-config";
import {
	avgOrNull,
	buildBucketGrid,
	maxOrNull,
	normalizeRange,
	walkCarry,
} from "./usage-history-shared";

const log = new Logger("UsageScopedHistoryHandler");

/**
 * Data sources for the scoped (per-model-family) usage-history shaping. Same
 * seam as UsageHistorySources: repositories in production, plain mocks in the
 * unit tests.
 */
export interface UsageScopedHistorySources {
	getScopedSnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<RankedScopedSnapshot[]>;
	getLatestScopedSnapshotsBefore(
		beforeMs: number,
	): Promise<RankedScopedSnapshot[]>;
	getAllAccounts(): Promise<Array<Pick<Account, "id" | "name" | "provider">>>;
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?(): number;
}

/**
 * Direct (in-process) /api/analytics/usage-scoped-history implementation,
 * backing the Limits-tab per-family weekly panels (one panel per family the
 * provider scopes, e.g. "Fable weekly window").
 *
 * Same read path and worker isolation as the account-wide usage-history
 * handler; see that file for why the scan runs off the main thread.
 */
export function createUsageScopedHistoryHandler(context: APIContext) {
	const adapter = context.dbOps.getAdapter();
	const scopedSnapshots = new UsageScopedSnapshotRepository(adapter);
	const accounts = new AccountRepository(adapter);
	return createUsageScopedHistoryHandlerFromSources({
		getScopedSnapshots: (opts) => scopedSnapshots.getBucketedSnapshots(opts),
		getLatestScopedSnapshotsBefore: (beforeMs) =>
			scopedSnapshots.getLatestSnapshotsBefore(beforeMs),
		getAllAccounts: () => accounts.findAll(),
	});
}

/**
 * Shape usage_scoped_snapshots into one entry per model family, each carrying
 * per-account series plus a pool aggregate over that family's bucket grid.
 *
 * ONE response covers every family recorded in the range — there is no
 * `family` parameter. The panel list itself is derived from this response, so
 * a family must not have to be known in advance to be asked for. It also keeps
 * the panels alive across a window rollover: the live account payload drops a
 * scoped limit the moment its reset passes, and family discovery based on live
 * evidence alone would make the panel vanish until the next poll.
 *
 * Carry-forward and the bucket grid are the account-wide handler's, unchanged
 * (see usage-history-shared.ts). Nominal window length is the scoped weekly
 * one, used only when a row carries no reset of its own.
 */
export function createUsageScopedHistoryHandlerFromSources(
	sources: UsageScopedHistorySources,
) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			const { bucketMs, windowMs } = getRangeConfig(range);
			const nowMs = sources.now?.() ?? Date.now();
			const sinceMs = windowMs === null ? 0 : nowMs - windowMs;

			const [rows, predecessors, accounts] = await Promise.all([
				sources.getScopedSnapshots({ sinceMs, bucketMs }),
				// Nothing can precede an unbounded range, so don't pay for the scan.
				sinceMs > 0
					? sources.getLatestScopedSnapshotsBefore(sinceMs)
					: Promise.resolve([]),
				sources.getAllAccounts(),
			]);

			const accountById = new Map(accounts.map((a) => [a.id, a]));

			const families = new Map<string, FamilyBucket>();
			const bucketFor = (family: string): FamilyBucket => {
				let bucket = families.get(family);
				if (!bucket) {
					bucket = {
						displayName: "",
						latestRowTs: Number.NEGATIVE_INFINITY,
						earliestRowTs: null,
						hasPredecessor: false,
						accountOrder: [],
						rowsByAccount: new Map(),
						predecessorByAccount: new Map(),
					};
					families.set(family, bucket);
				}
				return bucket;
			};
			const register = (bucket: FamilyBucket, accountId: string): void => {
				if (bucket.rowsByAccount.has(accountId)) return;
				bucket.rowsByAccount.set(accountId, new Map());
				bucket.accountOrder.push(accountId);
			};
			// Predecessors first: their evidence is the oldest, and an account that
			// went silent before the range began still belongs in the chart.
			for (const row of predecessors) {
				const bucket = bucketFor(row.family);
				register(bucket, row.accountId);
				bucket.predecessorByAccount.set(row.accountId, row);
				bucket.hasPredecessor = true;
				noteDisplayName(bucket, row);
			}
			for (const row of rows) {
				const bucket = bucketFor(row.family);
				register(bucket, row.accountId);
				bucket.rowsByAccount.get(row.accountId)?.set(row.ts, row);
				if (bucket.earliestRowTs === null || row.ts < bucket.earliestRowTs) {
					bucket.earliestRowTs = row.ts;
				}
				noteDisplayName(bucket, row);
			}

			const result: UsageScopedHistoryFamily[] = [];
			for (const [family, bucket] of families) {
				// Each family gets its own grid: one recorded only since yesterday
				// should not carry a month of empty buckets in front of it.
				const grid = buildBucketGrid({
					sinceMs,
					bucketMs,
					nowMs,
					firstEvidenceMs: bucket.hasPredecessor
						? sinceMs
						: bucket.earliestRowTs,
				});
				result.push({
					family,
					displayName: bucket.displayName || family,
					...shapeFamily(bucket, grid, accountById),
				});
			}
			result.sort((a, b) => a.family.localeCompare(b.family));

			const response: UsageScopedHistoryResponse = {
				range,
				bucketMs,
				families: result,
			};
			return jsonResponse(response);
		} catch (error) {
			log.error("Scoped usage history error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch scoped usage history data"),
			);
		}
	};
}

/** Per-family accumulation while the flat row list is grouped. */
interface FamilyBucket {
	displayName: string;
	latestRowTs: number;
	earliestRowTs: number | null;
	hasPredecessor: boolean;
	accountOrder: string[];
	rowsByAccount: Map<string, Map<number, RankedScopedSnapshot>>;
	predecessorByAccount: Map<string, RankedScopedSnapshot>;
}

/**
 * The family key is lossy across model generations ("Claude Opus 4.8" and
 * "Claude Opus 5" both resolve to `opus`), so the label shown is the provider's
 * own scope name from the MOST RECENT row seen — the generation currently in
 * force, not whichever one happened to be read first.
 */
function noteDisplayName(
	bucket: FamilyBucket,
	row: RankedScopedSnapshot,
): void {
	if (row.ts < bucket.latestRowTs) return;
	bucket.latestRowTs = row.ts;
	bucket.displayName = row.displayName;
}

function shapeFamily(
	bucket: FamilyBucket,
	grid: number[],
	accountById: Map<string, Pick<Account, "id" | "name" | "provider">>,
): { series: UsageScopedHistorySeries[]; pool: UsageScopedHistoryPoolPoint[] } {
	const poolByTs = new Map<number, { values: number[] }>();
	for (const ts of grid) poolByTs.set(ts, { values: [] });

	const series: UsageScopedHistorySeries[] = [];
	for (const accountId of bucket.accountOrder) {
		const tsMap = bucket.rowsByAccount.get(accountId);
		if (!tsMap) continue;
		const samples = new Map(
			[...tsMap].map(([ts, row]) => [ts, { pct: row.pct, reset: row.resetAt }]),
		);
		const predecessorRow = bucket.predecessorByAccount.get(accountId);
		const held = walkCarry(
			grid,
			samples,
			predecessorRow
				? {
						pct: predecessorRow.pct,
						reset: predecessorRow.resetAt,
						sampledAt: predecessorRow.ts,
					}
				: null,
			FIXED_WINDOW_DURATION_MS.seven_day_scoped,
		);

		const points: UsageScopedHistoryPoint[] = [];
		for (const ts of grid) {
			const pct = held.get(ts);
			if (pct == null) continue;
			points.push({ ts, pct });
			poolByTs.get(ts)?.values.push(pct);
		}
		if (points.length === 0) continue;

		// The scoped table stores no provider column, so identity comes from the
		// accounts list; an account deleted since the samples were taken keeps its
		// id as a label rather than disappearing from its own history.
		const account = accountById.get(accountId);
		series.push({
			accountId,
			name: account?.name ?? accountId,
			provider: account?.provider ?? "unknown",
			points,
		});
	}

	const pool: UsageScopedHistoryPoolPoint[] = grid.map((ts) => {
		const values = poolByTs.get(ts)?.values ?? [];
		return {
			ts,
			avg: avgOrNull(values),
			max: maxOrNull(values),
			sampledCount: values.length,
		};
	});

	return { series, pool };
}
