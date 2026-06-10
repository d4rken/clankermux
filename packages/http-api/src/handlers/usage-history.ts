import { FIXED_WINDOW_DURATION_MS } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	RankedSnapshot,
	UsageHistoryPoint,
	UsageHistoryPoolPoint,
	UsageHistoryResponse,
	UsageHistorySeries,
} from "@clankermux/types";
import { getRangeConfig } from "./range-config";

const log = new Logger("UsageHistoryHandler");

/**
 * A window value held across gap buckets. `expiresAt` is the window's reset
 * (or the nominal-length fallback): the value is assumed to still hold until
 * then, and is dropped once a bucket reaches it.
 */
interface CarriedValue {
	pct: number;
	expiresAt: number;
}

/**
 * Advance one window's carry-forward state by one bucket. A fresh sample
 * refreshes the held value (until its own reset, or the nominal window length
 * when the row carries no reset); otherwise the last value is held until a
 * bucket reaches that reset, then dropped.
 */
function advanceCarry(
	carry: CarriedValue | null,
	pct: number | null | undefined,
	reset: number | null | undefined,
	ts: number,
	nominalMs: number,
): CarriedValue | null {
	if (pct != null) {
		return { pct, expiresAt: reset ?? ts + nominalMs };
	}
	if (carry && ts >= carry.expiresAt) return null;
	return carry;
}

const ALLOWED_RANGES = ["1h", "6h", "24h", "7d", "30d", "all"] as const;
type Range = (typeof ALLOWED_RANGES)[number];
const DEFAULT_RANGE: Range = "7d";

function normalizeRange(raw: string | null): Range {
	if (raw && (ALLOWED_RANGES as readonly string[]).includes(raw)) {
		return raw as Range;
	}
	return DEFAULT_RANGE;
}

/** Mean of the non-null numbers, or null when there are none. */
function avgOrNull(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Max of the non-null numbers, or null when there are none. */
function maxOrNull(values: number[]): number | null {
	if (values.length === 0) return null;
	return Math.max(...values);
}

/**
 * Direct (non-worker) handler for the Limits-tab sawtooth chart. Reads the
 * small usage_snapshots table via dbOps.getUsageSnapshots and shapes it into
 * per-account series + a pool aggregate. Kept off the heavy analytics Bun
 * worker because the table is tiny and last-value-per-bucket ranked.
 *
 * Carry-forward: a maxed-out account that stops reporting (paused, exhausted)
 * must not silently fall out of the pool average — dropping the highest
 * account makes the pool *look* healthier the moment it got worse. So each
 * account's last recorded value is held across gap buckets until that sample's
 * window reset (per window), keeping its contribution in both its own series
 * and the pool denominator. After the real reset it expires, so a genuine
 * window roll (a true drop to ~0%) still shows.
 */
export function createUsageHistoryHandler(dbOps: DatabaseOperations) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			// "all" scans from sinceMs 0 — the usage_snapshots table is small and
			// retention-capped, so an unbounded lookback stays cheap.
			const { bucketMs, windowMs } = getRangeConfig(range);
			const sinceMs = windowMs === null ? 0 : Date.now() - windowMs;

			const [rows, accounts] = await Promise.all([
				dbOps.getUsageSnapshots({ sinceMs, bucketMs }),
				dbOps.getAllAccounts(),
			]);

			const nameById = new Map(accounts.map((a) => [a.id, a.name]));

			// The chart's x-axis buckets: every distinct ts present in the data,
			// ascending. A bucket exists because at least one account reported in
			// it, so a silent (paused/maxed) account is carried into the buckets
			// its still-reporting peers keep creating.
			const allTs = Array.from(new Set(rows.map((r) => r.ts))).sort(
				(a, b) => a - b,
			);

			// Index rows by account → (ts → row), preserving first-appearance order
			// and each account's provider.
			const rowsByAccount = new Map<string, Map<number, RankedSnapshot>>();
			const providerById = new Map<string, string>();
			const accountOrder: string[] = [];
			for (const row of rows) {
				let tsMap = rowsByAccount.get(row.accountId);
				if (!tsMap) {
					tsMap = new Map();
					rowsByAccount.set(row.accountId, tsMap);
					providerById.set(row.accountId, row.provider ?? "unknown");
					accountOrder.push(row.accountId);
				}
				tsMap.set(row.ts, row);
			}

			// Pool buckets, seeded for every ts so an all-null bucket still yields a
			// (null-avg, count 0) point rather than vanishing.
			const poolByTs = new Map<
				number,
				{ fiveHour: number[]; sevenDay: number[]; contributors: Set<string> }
			>();
			for (const ts of allTs) {
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
				const points: UsageHistoryPoint[] = [];
				let five: CarriedValue | null = null;
				let seven: CarriedValue | null = null;
				for (const ts of allTs) {
					const row = tsMap.get(ts);
					five = advanceCarry(
						five,
						row?.fiveHourPct,
						row?.fiveHourReset,
						ts,
						FIXED_WINDOW_DURATION_MS.five_hour,
					);
					seven = advanceCarry(
						seven,
						row?.sevenDayPct,
						row?.sevenDayReset,
						ts,
						FIXED_WINDOW_DURATION_MS.seven_day,
					);

					const fivePct = five?.pct ?? null;
					const sevenPct = seven?.pct ?? null;
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

			// allTs is already ascending, so the pool is sorted by construction.
			const pool: UsageHistoryPoolPoint[] = allTs.map((ts) => {
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
