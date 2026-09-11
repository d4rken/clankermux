import type { CostCoverage } from "@clankermux/types";

export interface CostCoverageRow {
	reported_cost: number | null;
	estimated_cost: number | null;
	unknown_source_cost: number | null;
	priced_requests: number | null;
	unpriced_requests: number | null;
	reported_requests: number | null;
	estimated_requests: number | null;
	unknown_source_requests: number | null;
}

/** Internal SQL expressions only; never interpolate user input here. */
export function costCoverageSql(predicate = "1=1"): string {
	return `
		SUM(CASE WHEN (${predicate}) AND cost_source = 'reported' THEN cost_usd ELSE 0 END) AS reported_cost,
		SUM(CASE WHEN (${predicate}) AND cost_source = 'estimated' THEN cost_usd ELSE 0 END) AS estimated_cost,
		SUM(CASE WHEN (${predicate}) AND COALESCE(cost_source, 'unknown') NOT IN ('reported','estimated') THEN cost_usd ELSE 0 END) AS unknown_source_cost,
		COUNT(CASE WHEN (${predicate}) THEN cost_usd END) AS priced_requests,
		COUNT(CASE WHEN (${predicate}) AND cost_usd IS NULL THEN 1 END) AS unpriced_requests,
		COUNT(CASE WHEN (${predicate}) AND cost_usd IS NOT NULL AND cost_source = 'reported' THEN 1 END) AS reported_requests,
		COUNT(CASE WHEN (${predicate}) AND cost_usd IS NOT NULL AND cost_source = 'estimated' THEN 1 END) AS estimated_requests,
		COUNT(CASE WHEN (${predicate}) AND cost_usd IS NOT NULL AND COALESCE(cost_source, 'unknown') NOT IN ('reported','estimated') THEN 1 END) AS unknown_source_requests`;
}

export function toCostCoverage(
	row: CostCoverageRow | null | undefined,
): CostCoverage {
	return {
		reportedUsd: row?.reported_cost ?? 0,
		estimatedUsd: row?.estimated_cost ?? 0,
		unknownSourceUsd: row?.unknown_source_cost ?? 0,
		pricedRequests: row?.priced_requests ?? 0,
		unpricedRequests: row?.unpriced_requests ?? 0,
		reportedRequests: row?.reported_requests ?? 0,
		estimatedRequests: row?.estimated_requests ?? 0,
		unknownSourceRequests: row?.unknown_source_requests ?? 0,
	};
}
