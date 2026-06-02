import type { DatabaseOperations } from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	UsageHistoryPoint,
	UsageHistoryPoolPoint,
	UsageHistoryResponse,
	UsageHistorySeries,
} from "@clankermux/types";

const log = new Logger("UsageHistoryHandler");

const ALLOWED_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
type Range = (typeof ALLOWED_RANGES)[number];
const DEFAULT_RANGE: Range = "7d";

/**
 * Map a range to its lookback window + bucket size. Mirrors getRangeConfig in
 * analytics-direct.ts so the sawtooth chart bucketing matches the analytics
 * charts: 1h→1m, 6h→5m, 24h/7d→1h, 30d→1d.
 */
function getRangeConfig(range: Range): { sinceMs: number; bucketMs: number } {
	const now = Date.now();
	const hour = 60 * 60 * 1000;
	const day = 24 * hour;

	switch (range) {
		case "1h":
			return { sinceMs: now - hour, bucketMs: 60 * 1000 };
		case "6h":
			return { sinceMs: now - 6 * hour, bucketMs: 5 * 60 * 1000 };
		case "24h":
			return { sinceMs: now - day, bucketMs: hour };
		case "7d":
			return { sinceMs: now - 7 * day, bucketMs: hour };
		case "30d":
			return { sinceMs: now - 30 * day, bucketMs: day };
	}
}

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
 */
export function createUsageHistoryHandler(dbOps: DatabaseOperations) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			const { sinceMs, bucketMs } = getRangeConfig(range);

			const [rows, accounts] = await Promise.all([
				dbOps.getUsageSnapshots({ sinceMs, bucketMs }),
				dbOps.getAllAccounts(),
			]);

			const nameById = new Map(accounts.map((a) => [a.id, a.name]));

			// Group rows into per-account series. Rows arrive ordered by ts then
			// accountId; we still sort each series' points defensively so the
			// chart never has to.
			const seriesById = new Map<string, UsageHistorySeries>();
			for (const row of rows) {
				let series = seriesById.get(row.accountId);
				if (!series) {
					series = {
						accountId: row.accountId,
						name: nameById.get(row.accountId) ?? row.accountId ?? "unknown",
						provider: row.provider ?? "unknown",
						points: [],
					};
					seriesById.set(row.accountId, series);
				}
				const point: UsageHistoryPoint = {
					ts: row.ts,
					fiveHourPct: row.fiveHourPct,
					sevenDayPct: row.sevenDayPct,
				};
				series.points.push(point);
			}
			const series = Array.from(seriesById.values());
			for (const s of series) {
				s.points.sort((a, b) => a.ts - b.ts);
			}

			// Build the pool aggregate per distinct ts. Because the sampler stamps
			// a shared timestamp per tick and getUsageSnapshots floors to buckets,
			// accounts sampled in the same bucket share `ts`.
			const byTs = new Map<
				number,
				{ fiveHour: number[]; sevenDay: number[]; contributors: number }
			>();
			for (const row of rows) {
				let bucket = byTs.get(row.ts);
				if (!bucket) {
					bucket = { fiveHour: [], sevenDay: [], contributors: 0 };
					byTs.set(row.ts, bucket);
				}
				let contributed = false;
				if (row.fiveHourPct != null) {
					bucket.fiveHour.push(row.fiveHourPct);
					contributed = true;
				}
				if (row.sevenDayPct != null) {
					bucket.sevenDay.push(row.sevenDayPct);
					contributed = true;
				}
				if (contributed) bucket.contributors++;
			}
			const pool: UsageHistoryPoolPoint[] = Array.from(byTs.entries())
				.map(([ts, b]) => ({
					ts,
					fiveHourAvg: avgOrNull(b.fiveHour),
					sevenDayAvg: avgOrNull(b.sevenDay),
					fiveHourMax: maxOrNull(b.fiveHour),
					sevenDayMax: maxOrNull(b.sevenDay),
					sampledCount: b.contributors,
				}))
				.sort((a, b) => a.ts - b.ts);

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
