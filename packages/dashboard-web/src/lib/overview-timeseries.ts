import type { AnalyticsResponse } from "@clankermux/types";
import { buildSessionTotalsByBucket } from "./active-sessions";

/**
 * Pure transform for the Overview tab's time-series chart rows. Kept out of the
 * component so the merge logic is unit-testable, mirroring lib/active-sessions.ts.
 */

/** One Overview chart row: a bucket timestamp plus the per-bucket metrics. */
export interface OverviewTimeSeriesRow {
	ts: number;
	requests: number;
	successRate: number;
	responseTime: number;
	/** Pre-formatted 2-dp string — the chart renders it verbatim. */
	cost: string;
	planCost: number;
	apiCost: number;
	tokensPerSecond: number;
	/**
	 * Distinct active sessions in this bucket, across all client scopes. The key
	 * is ABSENT (not `undefined`) when the server did not return activeSessions
	 * at all — the chart's presence detection keys off that, so an older server
	 * hides the series instead of drawing a flat zero line.
	 */
	activeSessions?: number;
}

/**
 * Build the Overview chart rows from an analytics response.
 *
 * MERGE POLICY: rows are driven by `analytics.timeSeries`. Both series floor the
 * same `requests.timestamp` column by the same bucket size under the same
 * filters, so a shared `ts` means the same bucket — but the two queries are
 * separate statements with no enclosing transaction, so under concurrent writes
 * the later sessions query can observe a request the earlier requests query did
 * not. A session bucket whose `ts` has no corresponding requests bucket is
 * therefore NOT rendered. That can only affect the newest bucket and self-heals
 * on the next refetch. Conversely a requests bucket with no session row gets an
 * explicit 0 — requests happened, none of them carried tracked affinity.
 */
export function buildOverviewTimeSeries(
	analytics: AnalyticsResponse | null | undefined,
): OverviewTimeSeriesRow[] {
	if (!analytics) return [];

	const sessions = analytics.activeSessions;
	// Built once outside the map so the merge stays O(buckets), not O(n²).
	const totals = sessions
		? buildSessionTotalsByBucket(sessions.timeSeries)
		: null;

	return analytics.timeSeries.map((point) => ({
		ts: point.ts,
		requests: point.requests,
		successRate: point.successRate,
		responseTime: Math.round(point.avgResponseTime),
		cost: point.costUsd.toFixed(2),
		planCost: point.planCostUsd ?? 0,
		apiCost: point.apiCostUsd ?? 0,
		tokensPerSecond: point.avgTokensPerSecond || 0,
		...(totals ? { activeSessions: totals.get(point.ts) ?? 0 } : {}),
	}));
}
