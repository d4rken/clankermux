import { MAX_PLAUSIBLE_TOKENS_PER_SECOND } from "@clankermux/core";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import { NO_ACCOUNT_ID } from "@clankermux/types";
import type {
	ActiveSessionsAnalytics,
	ActiveSessionsTimePoint,
	AnalyticsResponse,
	APIContext,
	CacheFlowPoint,
	SpeedTimePoint,
} from "../types";
import { getRangeConfig } from "./range-config";

const log = new Logger("AnalyticsHandler");

// Plausible-speed predicate, shared across every output-speed aggregation so
// the artifact ceiling is applied identically (drift between sites would let
// 137k-tok/s artifacts back into one query but not another). A bare
// `output_tokens_per_second > 0` already excludes NULLs in a WHERE/CASE, so no
// separate IS NOT NULL is needed. MAX_PLAUSIBLE_TOKENS_PER_SECOND is a numeric
// constant, not user input, so interpolating it is injection-safe.
const SPEED_IN_RANGE_SQL = `output_tokens_per_second > 0 AND output_tokens_per_second <= ${MAX_PLAUSIBLE_TOKENS_PER_SECOND}`;

// Max project rows in the project_breakdown UNION branch.
const PROJECT_BREAKDOWN_LIMIT = 20;

// Max per-account rows in the activeSessions.perAccount breakdown.
const ACTIVE_SESSIONS_BY_ACCOUNT_LIMIT = 50;

// Context composition limits.
const CONTEXT_BY_PROJECT_LIMIT = 10;
const GROWTH_CURVE_PROJECT_LIMIT = 5;
const GROWTH_CURVE_POINT_LIMIT = 1000;
const TOP_TOOL_CONTRIBUTORS_LIMIT = 10;

// Tool-call error analytics limits.
const TOOL_ERROR_BY_TOOL_LIMIT = 30;
const TOOL_ERROR_TIME_SERIES_TOOL_LIMIT = 5;
const TOOL_ERROR_TIME_SERIES_POINT_LIMIT = 2000;
const TOOL_ERROR_TOP_MESSAGES_LIMIT = 100;
// Per-tool cap inside the top-messages query so one noisy tool cannot
// monopolize all TOOL_ERROR_TOP_MESSAGES_LIMIT rows.
const TOOL_ERROR_MESSAGES_PER_TOOL_LIMIT = 20;

// Real context-window tokens for one request: uncached input plus both cache
// buckets. Used by every contextComposition query so the token denominator is
// identical everywhere.
const CONTEXT_TOKENS_SQL =
	"COALESCE(r.input_tokens, 0) + COALESCE(r.cache_read_input_tokens, 0) + COALESCE(r.cache_creation_input_tokens, 0)";

type PhaseTiming = { phase: string; durationMs: number };

function recordPhase(
	timings: PhaseTiming[],
	phase: string,
	startedAt: number,
): void {
	const durationMs = performance.now() - startedAt;
	timings.push({ phase, durationMs });
	if (durationMs > 250) {
		log.warn(`Analytics phase '${phase}' took ${Math.round(durationMs)}ms`);
	}
}

function logAnalyticsTimings(timings: PhaseTiming[], startedAt: number): void {
	const totalMs = performance.now() - startedAt;
	if (totalMs <= 500) return;
	const phases = timings
		.map(({ phase, durationMs }) => `${phase}=${Math.round(durationMs)}ms`)
		.join(", ");
	log.warn(`Analytics request took ${Math.round(totalMs)}ms (${phases})`);
}

// Exported for unit tests.
export function effectiveBurnRateDays(
	firstTs: number | null,
	windowStartMs: number,
	windowDays: number,
	nowMs: number,
): number {
	if (firstTs == null) return windowDays;
	const dayMs = 24 * 60 * 60 * 1000;
	const start = Math.max(firstTs, windowStartMs);
	const days = Math.ceil((nowMs - start) / dayMs);
	return Math.min(windowDays, Math.max(1, days));
}

export function createAnalyticsHandler(context: APIContext) {
	return async (params: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		const range = params.get("range") ?? "24h";
		// `startMs: null` means "no cutoff" (the all-time range): the timestamp
		// predicate is omitted from the WHERE clause entirely rather than
		// degenerating to `timestamp > 0`.
		const bucket = getRangeConfig(range);
		const startMs =
			bucket.windowMs === null ? null : Date.now() - bucket.windowMs;
		const mode = params.get("mode") ?? "normal";
		const isCumulative = mode === "cumulative";

		// Extract filters
		const accountsFilter =
			params.get("accounts")?.split(",").filter(Boolean) || [];
		const modelsFilter = params.get("models")?.split(",").filter(Boolean) || [];
		const apiKeysFilter =
			params.get("apiKeys")?.split(",").filter(Boolean) || [];
		// Named projects plus a dedicated flag for the NULL bucket — no in-band
		// sentinel, so a project literally named "no-project" stays filterable
		// as a normal name.
		const projectsFilter =
			params.get("projects")?.split(",").filter(Boolean) || [];
		const projectsNone = params.get("projectsNone") === "true";
		const statusFilter = params.get("status") || "all";

		// Build filter conditions. The timestamp bound is structurally omitted
		// for the all-time range (startMs === null) instead of widening to
		// `timestamp > 0`.
		const conditions: string[] = [];
		const queryParams: (string | number)[] = [];
		if (startMs !== null) {
			conditions.push("r.timestamp > ?");
			queryParams.push(startMs);
		}

		if (accountsFilter.length > 0) {
			// Handle account filter - map account names to IDs via join
			const placeholders = accountsFilter.map(() => "?").join(",");
			conditions.push(`(
				r.account_used IN (SELECT id FROM accounts WHERE name IN (${placeholders}))
				OR (r.account_used = ? AND ? IN (${placeholders}))
			)`);
			queryParams.push(
				...accountsFilter,
				NO_ACCOUNT_ID,
				NO_ACCOUNT_ID,
				...accountsFilter,
			);
		}

		if (modelsFilter.length > 0) {
			const placeholders = modelsFilter.map(() => "?").join(",");
			conditions.push(`r.model IN (${placeholders})`);
			queryParams.push(...modelsFilter);
		}

		if (apiKeysFilter.length > 0) {
			// Match the key's CURRENT name (api_keys.name) so a filter on the
			// post-rename name finds requests stamped under the old one; the
			// record-time snapshot remains the fallback for hard-deleted keys.
			// A correlated subquery keeps the shared whereClause self-contained —
			// it's interpolated into many sub-selects whose requests alias is `r`,
			// so it must not depend on any particular JOIN being present.
			const placeholders = apiKeysFilter.map(() => "?").join(",");
			conditions.push(
				`COALESCE((SELECT name FROM api_keys WHERE id = r.api_key_id), r.api_key_name) IN (${placeholders})`,
			);
			queryParams.push(...apiKeysFilter);
		}

		if (projectsFilter.length > 0 || projectsNone) {
			const parts: string[] = [];
			if (projectsFilter.length > 0) {
				const placeholders = projectsFilter.map(() => "?").join(",");
				parts.push(`r.project IN (${placeholders})`);
				queryParams.push(...projectsFilter);
			}
			if (projectsNone) {
				parts.push("r.project IS NULL");
			}
			conditions.push(`(${parts.join(" OR ")})`);
		}

		if (statusFilter === "success") {
			conditions.push("r.success = TRUE");
		} else if (statusFilter === "error") {
			conditions.push("r.success = FALSE");
		}

		// range=all with no filters leaves no conditions; keep the WHERE slot
		// valid with a constant-true predicate.
		const whereClause =
			conditions.length > 0 ? conditions.join(" AND ") : "1=1";

		try {
			const analyticsStartedAt = performance.now();
			const phaseTimings: PhaseTiming[] = [];
			// Check if we need per-model time series
			const includeModelBreakdown = params.get("modelBreakdown") === "true";

			// Consolidated query to get all analytics data in a single roundtrip
			let phaseStartedAt = performance.now();
			const consolidatedResult = await db.get<{
				total_requests: number;
				success_rate: number;
				avg_response_time: number;
				total_tokens: number;
				total_cost_usd: number;
				plan_cost_usd: number;
				api_cost_usd: number;
				cache_hit_rate: number;
				avg_tokens_per_second: number;
				active_accounts: number;
				input_tokens: number;
				cache_read_input_tokens: number;
				cache_creation_input_tokens: number;
				output_tokens: number;
			}>(
				`
				WITH filtered_requests AS (
					SELECT * FROM requests r
					WHERE ${whereClause}
				)
				SELECT
					(SELECT COUNT(*) FROM filtered_requests) as total_requests,
					(SELECT SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) FROM filtered_requests) as success_rate,
					(SELECT AVG(response_time_ms) FROM filtered_requests) as avg_response_time,
					(SELECT SUM(COALESCE(total_tokens, 0)) FROM filtered_requests) as total_tokens,
					(SELECT SUM(COALESCE(cost_usd, 0)) FROM filtered_requests) as total_cost_usd,
					(SELECT SUM(CASE WHEN billing_type = 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) FROM filtered_requests) as plan_cost_usd,
					(SELECT SUM(CASE WHEN COALESCE(billing_type, 'api') != 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) FROM filtered_requests) as api_cost_usd,
					(SELECT SUM(COALESCE(cache_read_input_tokens, 0)) * 100.0 /
						NULLIF(SUM(COALESCE(input_tokens, 0) + COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0)), 0) FROM filtered_requests) as cache_hit_rate,
					(SELECT AVG(CASE WHEN ${SPEED_IN_RANGE_SQL} THEN output_tokens_per_second END) FROM filtered_requests) as avg_tokens_per_second,
					(SELECT COUNT(DISTINCT COALESCE(account_used, ?)) FROM filtered_requests) as active_accounts,
					(SELECT SUM(COALESCE(input_tokens, 0)) FROM filtered_requests) as input_tokens,
					(SELECT SUM(COALESCE(cache_read_input_tokens, 0)) FROM filtered_requests) as cache_read_input_tokens,
					(SELECT SUM(COALESCE(cache_creation_input_tokens, 0)) FROM filtered_requests) as cache_creation_input_tokens,
					(SELECT SUM(COALESCE(output_tokens, 0)) FROM filtered_requests) as output_tokens
			`,
				[...queryParams, NO_ACCOUNT_ID],
			);
			recordPhase(phaseTimings, "totals", phaseStartedAt);

			// Fixed-window burn-rate aggregates. Independent of the user's range
			// or filters so "Avg / day" and "Avg / week" stay stable when the
			// dashboard range filter changes. Divisor is clamped to the actual
			// age of the data so thin history (e.g. the proxy was started 3 days
			// ago) doesn't get padded with imaginary zero days.
			const dayMs = 24 * 60 * 60 * 1000;
			const nowMs = Date.now();
			const sevenDayStart = nowMs - 7 * dayMs;
			const thirtyDayStart = nowMs - 30 * dayMs;
			phaseStartedAt = performance.now();
			const burnRateResult = await db.get<{
				plan_cost_7d: number;
				api_cost_7d: number;
				plan_cost_30d: number;
				api_cost_30d: number;
				first_plan_ts: number | null;
				first_api_ts: number | null;
			}>(
				`
				SELECT
					SUM(CASE WHEN timestamp > ? AND billing_type = 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as plan_cost_7d,
					SUM(CASE WHEN timestamp > ? AND COALESCE(billing_type, 'api') != 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as api_cost_7d,
					SUM(CASE WHEN billing_type = 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as plan_cost_30d,
					SUM(CASE WHEN COALESCE(billing_type, 'api') != 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as api_cost_30d,
					MIN(CASE WHEN billing_type = 'plan' THEN timestamp ELSE NULL END) as first_plan_ts,
					MIN(CASE WHEN COALESCE(billing_type, 'api') != 'plan' THEN timestamp ELSE NULL END) as first_api_ts
				FROM requests
				WHERE timestamp > ?
			`,
				[sevenDayStart, sevenDayStart, thirtyDayStart],
			);
			recordPhase(phaseTimings, "burn_rate", phaseStartedAt);
			const planCost7d = Number(burnRateResult?.plan_cost_7d) || 0;
			const apiCost7d = Number(burnRateResult?.api_cost_7d) || 0;
			const planCost30d = Number(burnRateResult?.plan_cost_30d) || 0;
			const apiCost30d = Number(burnRateResult?.api_cost_30d) || 0;
			const firstPlanTs =
				burnRateResult?.first_plan_ts != null
					? Number(burnRateResult.first_plan_ts)
					: null;
			const firstApiTs =
				burnRateResult?.first_api_ts != null
					? Number(burnRateResult.first_api_ts)
					: null;
			const avgDailyPlanCostUsd =
				planCost7d /
				effectiveBurnRateDays(firstPlanTs, sevenDayStart, 7, nowMs);
			const avgDailyApiCostUsd =
				apiCost7d / effectiveBurnRateDays(firstApiTs, sevenDayStart, 7, nowMs);
			const avgWeeklyPlanCostUsd =
				(planCost30d /
					effectiveBurnRateDays(firstPlanTs, thirtyDayStart, 30, nowMs)) *
				7;
			const avgWeeklyApiCostUsd =
				(apiCost30d /
					effectiveBurnRateDays(firstApiTs, thirtyDayStart, 30, nowMs)) *
				7;

			// Global output-speed percentiles for the headline tiles. Median (p50)
			// is the robust "typical" speed; p95 is the honest fast end. Both are
			// artifact-filtered via the sanity ceiling and computed with the same
			// PERCENT_RANK ranked-CTE pattern used for p95 response time below
			// (uses a PERCENT_RANK CTE rather than PERCENTILE_CONT).
			phaseStartedAt = performance.now();
			const speedTotals = await db.get<{
				median_tokens_per_second: number | null;
				p95_tokens_per_second: number | null;
			}>(
				`
				WITH filtered_speed AS (
					SELECT output_tokens_per_second AS otps
					FROM requests r
					WHERE ${whereClause}
						AND ${SPEED_IN_RANGE_SQL}
				),
				ranked_speed AS (
					SELECT otps, PERCENT_RANK() OVER (ORDER BY otps) AS pr
					FROM filtered_speed
				)
				SELECT
					MIN(CASE WHEN pr >= 0.5 THEN otps END) as median_tokens_per_second,
					MIN(CASE WHEN pr >= 0.95 THEN otps END) as p95_tokens_per_second
				FROM ranked_speed
			`,
				queryParams,
			);
			recordPhase(phaseTimings, "speed_totals", phaseStartedAt);
			const medianTokensPerSecond =
				speedTotals?.median_tokens_per_second != null
					? Number(speedTotals.median_tokens_per_second)
					: null;
			const p95TokensPerSecond =
				speedTotals?.p95_tokens_per_second != null
					? Number(speedTotals.p95_tokens_per_second)
					: null;

			// Get time series data
			phaseStartedAt = performance.now();
			const timeSeries = await db.query<{
				ts: number;
				model?: string;
				requests: number;
				tokens: number;
				cost_usd: number;
				plan_cost_usd: number;
				api_cost_usd: number;
				success_rate: number;
				error_rate: number;
				cache_hit_rate: number;
				avg_response_time: number;
				avg_tokens_per_second: number | null;
			}>(
				`
				SELECT
					(timestamp / ?) * ? as ts,
					${includeModelBreakdown ? "model," : ""}
					COUNT(*) as requests,
					SUM(COALESCE(total_tokens, 0)) as tokens,
					SUM(COALESCE(cost_usd, 0)) as cost_usd,
					SUM(CASE WHEN billing_type = 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as plan_cost_usd,
					SUM(CASE WHEN COALESCE(billing_type, 'api') != 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as api_cost_usd,
					SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
					SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as error_rate,
					SUM(COALESCE(cache_read_input_tokens, 0)) * 100.0 /
						NULLIF(SUM(COALESCE(input_tokens, 0) + COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0)), 0) as cache_hit_rate,
					AVG(response_time_ms) as avg_response_time,
					AVG(CASE WHEN ${SPEED_IN_RANGE_SQL} THEN output_tokens_per_second END) as avg_tokens_per_second
				FROM requests r
				WHERE ${whereClause} ${includeModelBreakdown ? "AND model IS NOT NULL" : ""}
				GROUP BY ts${includeModelBreakdown ? ", model" : ""}
				ORDER BY ts${includeModelBreakdown ? ", model" : ""}
			`,
				[bucket.bucketMs, bucket.bucketMs, ...queryParams],
			);
			recordPhase(phaseTimings, "time_series", phaseStartedAt);

			// Get additional data (model distribution, account performance, cost by model, api key performance, account model usage)
			phaseStartedAt = performance.now();
			const additionalData = await db.query<{
				data_type: string;
				name: string;
				secondary_name: string | null;
				count: number | null;
				requests: number | null;
				success_rate: number | null;
				cost_usd: number | null;
				plan_cost_usd: number | null;
				api_cost_usd: number | null;
				total_cost_usd: number | null;
				total_tokens: number | null;
			}>(
				`
				-- UNION 11-column contract (ALL 6 sub-selects MUST match in this exact column order):
				-- 1. data_type TEXT
				-- 2. name TEXT
				-- 3. secondary_name TEXT
				-- 4. count BIGINT
				-- 5. requests BIGINT
				-- 6. success_rate DOUBLE PRECISION
				-- 7. cost_usd DOUBLE PRECISION
				-- 8. plan_cost_usd DOUBLE PRECISION
				-- 9. api_cost_usd DOUBLE PRECISION
				-- 10. total_cost_usd DOUBLE PRECISION
				-- 11. total_tokens BIGINT
				SELECT * FROM (
					SELECT
						'model_distribution' as data_type,
						model as name,
						CAST(NULL AS TEXT) as secondary_name,
						COUNT(*) as count,
						CAST(NULL AS BIGINT) as requests,
						CAST(NULL AS DOUBLE PRECISION) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as plan_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as api_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as total_cost_usd,
						CAST(NULL AS BIGINT) as total_tokens
					FROM requests r
					WHERE ${whereClause} AND model IS NOT NULL
					GROUP BY model
					ORDER BY count DESC
					LIMIT 10
				) q1

				UNION ALL

				SELECT * FROM (
					SELECT
						'account_performance' as data_type,
						COALESCE(a.name, r.account_used, ?) as name,
						CAST(NULL AS TEXT) as secondary_name,
						CAST(NULL AS BIGINT) as count,
						COUNT(r.id) as requests,
						SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(r.id), 0) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						SUM(CASE WHEN r.billing_type = 'plan' THEN COALESCE(r.cost_usd, 0) ELSE 0 END) as plan_cost_usd,
						SUM(CASE WHEN COALESCE(r.billing_type, 'api') != 'plan' THEN COALESCE(r.cost_usd, 0) ELSE 0 END) as api_cost_usd,
						SUM(COALESCE(r.cost_usd, 0)) as total_cost_usd,
						CAST(NULL AS BIGINT) as total_tokens
					FROM requests r
					LEFT JOIN accounts a ON a.id = r.account_used
					WHERE ${whereClause}
					GROUP BY r.account_used, a.name
					HAVING COUNT(r.id) > 0
					ORDER BY requests DESC
					LIMIT 10
				) q2

				UNION ALL

				SELECT * FROM (
					SELECT
						'cost_by_model' as data_type,
						model as name,
						CAST(NULL AS TEXT) as secondary_name,
						CAST(NULL AS BIGINT) as count,
						COUNT(*) as requests,
						CAST(NULL AS DOUBLE PRECISION) as success_rate,
						SUM(COALESCE(cost_usd, 0)) as cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as plan_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as api_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as total_cost_usd,
						SUM(COALESCE(total_tokens, 0)) as total_tokens
					FROM requests r
					WHERE ${whereClause} AND COALESCE(cost_usd, 0) > 0 AND model IS NOT NULL
					GROUP BY model
					ORDER BY cost_usd DESC
					LIMIT 10
				) q3

				UNION ALL

				SELECT * FROM (
					SELECT
						'api_key_performance' as data_type,
						-- Current key name with the record-time snapshot as fallback for
						-- hard-deleted keys. Grouped by key id alone so a key renamed
						-- mid-history still collapses to ONE row; MAX() picks a single
						-- deterministic name when deleted-key snapshots vary.
						MAX(COALESCE(k.name, r.api_key_name)) as name,
						CAST(NULL AS TEXT) as secondary_name,
						CAST(NULL AS BIGINT) as count,
						COUNT(*) as requests,
						SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as plan_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as api_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as total_cost_usd,
						CAST(NULL AS BIGINT) as total_tokens
					FROM requests r
					LEFT JOIN api_keys k ON k.id = r.api_key_id
					WHERE ${whereClause} AND r.api_key_id IS NOT NULL
					GROUP BY r.api_key_id
					HAVING COUNT(*) > 0
					ORDER BY requests DESC
					LIMIT 10
				) q4

				UNION ALL

				SELECT * FROM (
					SELECT
						'account_model_usage' as data_type,
						COALESCE(a.name, 'Unknown') as name,
						r.model as secondary_name,
						COUNT(*) as count,
						CAST(NULL AS BIGINT) as requests,
						CAST(NULL AS DOUBLE PRECISION) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as plan_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as api_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as total_cost_usd,
						CAST(NULL AS BIGINT) as total_tokens
					FROM requests r
					LEFT JOIN accounts a ON a.id = r.account_used
					WHERE ${whereClause} AND r.model IS NOT NULL
					GROUP BY COALESCE(a.name, 'Unknown'), r.model
					HAVING COUNT(*) > 0
					ORDER BY count DESC
					LIMIT 50
				) q5

				UNION ALL

				SELECT * FROM (
					SELECT
						'project_breakdown' as data_type,
						-- Raw column, no COALESCE: SQL NULL groups as one bucket
						-- (mapped to null in TS) and a historical row literally
						-- named 'no-project' stays a distinct project.
						r.project as name,
						CAST(NULL AS TEXT) as secondary_name,
						CAST(NULL AS BIGINT) as count,
						COUNT(*) as requests,
						SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						SUM(CASE WHEN r.billing_type = 'plan' THEN COALESCE(r.cost_usd, 0) ELSE 0 END) as plan_cost_usd,
						SUM(CASE WHEN COALESCE(r.billing_type, 'api') != 'plan' THEN COALESCE(r.cost_usd, 0) ELSE 0 END) as api_cost_usd,
						SUM(COALESCE(r.cost_usd, 0)) as total_cost_usd,
						SUM(COALESCE(r.total_tokens, 0)) as total_tokens
					FROM requests r
					WHERE ${whereClause}
					-- Positional: "GROUP BY name" would bind to a source column if
					-- one existed; 2 pins the grouping to the project label
					-- (column 1 is the constant data_type).
					GROUP BY 2
					ORDER BY total_tokens DESC
					LIMIT ${PROJECT_BREAKDOWN_LIMIT}
				) q6
			`,
				[
					...queryParams,
					NO_ACCOUNT_ID,
					...queryParams,
					...queryParams,
					...queryParams,
					...queryParams,
					...queryParams,
				],
			);
			recordPhase(phaseTimings, "additional_data", phaseStartedAt);

			// Parse the combined results
			const modelDistribution = additionalData
				.filter((row) => row.data_type === "model_distribution")
				.map((row) => ({
					model: row.name,
					count: Number(row.count) || 0,
				}));

			const accountPerformance = additionalData
				.filter((row) => row.data_type === "account_performance")
				.map((row) => ({
					name: row.name,
					requests: Number(row.requests) || 0,
					successRate: Number(row.success_rate) || 0,
					planCostUsd: Number(row.plan_cost_usd) || 0,
					apiCostUsd: Number(row.api_cost_usd) || 0,
					totalCostUsd: Number(row.total_cost_usd) || 0,
				}));

			const costByModel = additionalData
				.filter((row) => row.data_type === "cost_by_model")
				.map((row) => ({
					model: row.name,
					costUsd: Number(row.cost_usd) || 0,
					requests: Number(row.requests) || 0,
					totalTokens: Number(row.total_tokens) || 0,
				}));

			const apiKeyPerformance = additionalData
				.filter((row) => row.data_type === "api_key_performance")
				.map((row) => ({
					id: row.name, // API key name used as id for now
					name: row.name,
					requests: Number(row.requests) || 0,
					successRate: Number(row.success_rate) || 0,
				}));

			const accountModelUsage = additionalData
				.filter((row) => row.data_type === "account_model_usage")
				.map((row) => ({
					account: row.name,
					model: row.secondary_name ?? "Unknown",
					count: Number(row.count) || 0,
				}));

			const projectBreakdown = additionalData
				.filter((row) => row.data_type === "project_breakdown")
				.map((row) => ({
					// q6 selects the raw r.project column, so unlike the other
					// branches `name` can be SQL NULL here (the no-project bucket).
					project: (row.name as string | null) ?? null,
					requests: Number(row.requests) || 0,
					successRate: Number(row.success_rate) || 0,
					planCostUsd: Number(row.plan_cost_usd) || 0,
					apiCostUsd: Number(row.api_cost_usd) || 0,
					totalCostUsd: Number(row.total_cost_usd) || 0,
					totalTokens: Number(row.total_tokens) || 0,
				}));

			// Get model performance metrics. Speed percentiles (median/p95) are
			// computed over a separately-filtered row set (plausible speeds only)
			// from the response-time percentiles, so artifact rows and rows
			// missing a speed sample never pollute each other's PERCENT_RANK
			// windows. The two aggregates are joined back per model.
			phaseStartedAt = performance.now();
			const modelPerfData = await db.query<{
				model: string;
				avg_response_time: number;
				max_response_time: number;
				total_requests: number;
				error_count: number;
				error_rate: number;
				p95_response_time: number | null;
				speed_sample_count: number | null;
				median_tokens_per_second: number | null;
				p95_tokens_per_second: number | null;
			}>(
				`
				WITH filtered AS (
					SELECT
						model,
						response_time_ms,
						output_tokens_per_second,
						success
					FROM requests r
					WHERE ${whereClause}
						AND model IS NOT NULL
						AND response_time_ms IS NOT NULL
				),
				resp_ranked AS (
					SELECT
						model,
						response_time_ms,
						success,
						PERCENT_RANK() OVER (
							PARTITION BY model
							ORDER BY response_time_ms
						) AS pr_resp
					FROM filtered
				),
				speed_ranked AS (
					SELECT
						model,
						output_tokens_per_second,
						PERCENT_RANK() OVER (
							PARTITION BY model
							ORDER BY output_tokens_per_second
						) AS pr_speed
					FROM filtered
					WHERE ${SPEED_IN_RANGE_SQL}
				),
				resp_agg AS (
					SELECT
						model,
						AVG(response_time_ms) as avg_response_time,
						MAX(response_time_ms) as max_response_time,
						COUNT(*) as total_requests,
						SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) as error_count,
						SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as error_rate,
						MIN(CASE WHEN pr_resp >= 0.95 THEN response_time_ms END) as p95_response_time
					FROM resp_ranked
					GROUP BY model
				),
				speed_agg AS (
					SELECT
						model,
						COUNT(*) as speed_sample_count,
						-- PERCENT_RANK is 0 for a single-row partition, so the
						-- pr>=0.5 / pr>=0.95 selectors return NULL with <2 samples.
						-- Fall back to the lone value (MIN/MAX over the 1 row) so a
						-- model with a sample still shows a number, consistent with
						-- speed_sample_count > 0.
						COALESCE(MIN(CASE WHEN pr_speed >= 0.5 THEN output_tokens_per_second END), MIN(output_tokens_per_second)) as median_tokens_per_second,
						COALESCE(MIN(CASE WHEN pr_speed >= 0.95 THEN output_tokens_per_second END), MAX(output_tokens_per_second)) as p95_tokens_per_second
					FROM speed_ranked
					GROUP BY model
				)
				SELECT
					ra.model,
					ra.avg_response_time,
					ra.max_response_time,
					ra.total_requests,
					ra.error_count,
					ra.error_rate,
					ra.p95_response_time,
					sa.speed_sample_count,
					sa.median_tokens_per_second,
					sa.p95_tokens_per_second
				FROM resp_agg ra
				LEFT JOIN speed_agg sa ON sa.model = ra.model
				ORDER BY ra.total_requests DESC
				LIMIT 10
			`,
				queryParams,
			);
			recordPhase(phaseTimings, "model_performance", phaseStartedAt);

			const modelPerformance = modelPerfData.map((modelData) => ({
				model: modelData.model,
				avgResponseTime: Number(modelData.avg_response_time) || 0,
				p95ResponseTime:
					Number(modelData.p95_response_time) ||
					Number(modelData.max_response_time) ||
					Number(modelData.avg_response_time) ||
					0,
				errorRate: Number(modelData.error_rate) || 0,
				medianTokensPerSecond:
					modelData.median_tokens_per_second != null
						? Number(modelData.median_tokens_per_second)
						: null,
				p95TokensPerSecond:
					modelData.p95_tokens_per_second != null
						? Number(modelData.p95_tokens_per_second)
						: null,
				speedSampleCount: Number(modelData.speed_sample_count) || 0,
			}));

			// Per-model output-speed-over-time: median (p50) tok/s per time bucket
			// per model, artifact-filtered. Always per-model and independent of the
			// main chart's modelBreakdown toggle. HAVING count >= 3 drops buckets
			// too thin for a meaningful median (a 1-2 sample p50 is just noise).
			phaseStartedAt = performance.now();
			const speedTimeSeriesData = await db.query<{
				ts: number;
				model: string;
				median_tps: number | null;
				sample_count: number;
			}>(
				`
				WITH bucketed AS (
					SELECT
						(timestamp / ?) * ? AS ts,
						model,
						output_tokens_per_second AS otps
					FROM requests r
					WHERE ${whereClause}
						AND model IS NOT NULL
						AND ${SPEED_IN_RANGE_SQL}
				),
				ranked AS (
					SELECT
						ts,
						model,
						otps,
						PERCENT_RANK() OVER (PARTITION BY ts, model ORDER BY otps) AS pr
					FROM bucketed
				)
				SELECT
					ts,
					model,
					MIN(CASE WHEN pr >= 0.5 THEN otps END) as median_tps,
					COUNT(*) as sample_count
				FROM ranked
				GROUP BY ts, model
				HAVING COUNT(*) >= 3
				ORDER BY ts, model
			`,
				[bucket.bucketMs, bucket.bucketMs, ...queryParams],
			);
			recordPhase(phaseTimings, "speed_time_series", phaseStartedAt);

			const speedTimeSeries: SpeedTimePoint[] = speedTimeSeriesData
				.filter((row) => row.median_tps != null)
				.map((row) => ({
					ts: Number(row.ts),
					model: row.model,
					medianTps: Number(row.median_tps),
				}));

			// Distinct-active-sessions series, bucketed by requests.timestamp and
			// split by affinity scope.
			//
			// Bucket on r.timestamp (NOT rr.created_at): the shared whereClause
			// bounds the range on r.timestamp, and every other time series in this
			// handler buckets on r.timestamp too. request_routing.created_at is the
			// request START time while requests.timestamp is the persist/completion
			// time — for long agentic turns those differ by the whole request
			// duration, so bucketing on created_at could place a point outside the
			// filtered window and misalign this panel against the others. Using
			// r.timestamp keeps the time axis consistent with the range filter and
			// with every sibling chart.
			//
			// Base table is request_routing INNER JOIN requests (deliberately
			// asymmetric with the routing panels above, which LEFT JOIN so untracked
			// requests still show up as an "untracked" account flow): a request with
			// no affinity_key_hash was never a tracked session, so it must not count
			// toward any session gauge. The JOIN back to requests is what makes the
			// shared whereClause (range + account/model/apiKey/project/status)
			// apply identically to this panel — filtering the same rows every other
			// panel filters.
			//
			// Per-bucket PRESENCE semantics: a session whose requests span multiple
			// buckets is counted once in EACH bucket it touches (COUNT(DISTINCT hash)
			// GROUP BY bucket), so the series is NOT summable to a range total. The
			// 'total' row is a separate COUNT(DISTINCT hash) across the whole filtered
			// range, counting each session exactly once — that is the honest headline.
			//
			// Param order: queryParams (whereClause lives inside the CTE, which is
			// emitted first in the SQL string) precede the two bucket placeholders
			// (the bucket sub-select comes after the CTE).
			phaseStartedAt = performance.now();
			const activeSessionRows = await db.query<{
				row_type: string;
				ts: number | null;
				scope: string | null;
				sessions: number;
			}>(
				`
				WITH session_requests AS (
					SELECT
						rr.affinity_key_hash AS hash,
						rr.affinity_scope AS scope,
						r.timestamp AS ts_source
					FROM request_routing rr
					JOIN requests r ON r.id = rr.request_id
					WHERE rr.affinity_key_hash IS NOT NULL AND ${whereClause}
				)
				SELECT
					'total' AS row_type,
					CAST(NULL AS INTEGER) AS ts,
					CAST(NULL AS TEXT) AS scope,
					COUNT(DISTINCT hash) AS sessions
				FROM session_requests

				UNION ALL

				SELECT * FROM (
					SELECT
						'bucket' AS row_type,
						(ts_source / ?) * ? AS ts,
						scope,
						COUNT(DISTINCT hash) AS sessions
					FROM session_requests
					WHERE scope IS NOT NULL
					GROUP BY ts, scope
					ORDER BY ts, scope
				)
			`,
				[...queryParams, bucket.bucketMs, bucket.bucketMs],
			);
			recordPhase(phaseTimings, "active_sessions", phaseStartedAt);

			// Per-account distinct-session breakdown for the "Active Sessions by
			// account" bar list, across the WHOLE filtered range.
			//
			// Kept as a STANDALONE query rather than a 3rd branch of the
			// activeSessionRows UNION on purpose: that UNION is shaped as
			// (row_type, ts, scope, sessions) for the time-bucketed presence series,
			// whereas this breakdown groups by account (a different key and output
			// shape). Widening the UNION to carry an account column would force NULL
			// account placeholders into the 'total'/'bucket' rows and NULL ts/scope
			// placeholders into these — muddying both. A sibling query is clearer and
			// the JOIN back to requests still applies the identical shared whereClause.
			//
			// PRESENCE, not partition: a session that failed over between two accounts
			// has request_routing rows with different selected_account_id but the same
			// affinity_key_hash, so it is counted under EACH account. This breakdown
			// therefore does NOT sum to totalDistinctSessions — same caveat as
			// timeSeries. NULL selected_account_id collapses to the NO_ACCOUNT_ID
			// sentinel for both id and name.
			phaseStartedAt = performance.now();
			const activeSessionsByAccountRows = await db.query<{
				account_id: string;
				account_name: string;
				sessions: number;
			}>(
				`SELECT
					COALESCE(rr.selected_account_id, ?) AS account_id,
					COALESCE(a.name, rr.selected_account_id, ?) AS account_name,
					COUNT(DISTINCT rr.affinity_key_hash) AS sessions
				FROM request_routing rr
				JOIN requests r ON r.id = rr.request_id
				LEFT JOIN accounts a ON a.id = rr.selected_account_id
				WHERE rr.affinity_key_hash IS NOT NULL AND ${whereClause}
				GROUP BY rr.selected_account_id, a.name
				ORDER BY sessions DESC
				LIMIT ${ACTIVE_SESSIONS_BY_ACCOUNT_LIMIT}`,
				[NO_ACCOUNT_ID, NO_ACCOUNT_ID, ...queryParams],
			);
			recordPhase(phaseTimings, "active_sessions_by_account", phaseStartedAt);

			const activeSessions: ActiveSessionsAnalytics = {
				totalDistinctSessions:
					Number(
						activeSessionRows.find((row) => row.row_type === "total")?.sessions,
					) || 0,
				timeSeries: activeSessionRows
					.filter(
						(row) =>
							row.row_type === "bucket" && row.ts != null && row.scope != null,
					)
					.map(
						(row): ActiveSessionsTimePoint => ({
							ts: Number(row.ts),
							scope: row.scope as ActiveSessionsTimePoint["scope"],
							sessions: Number(row.sessions) || 0,
						}),
					),
				perAccount: activeSessionsByAccountRows.map((row) => ({
					accountId: String(row.account_id),
					accountName: String(row.account_name),
					sessions: Number(row.sessions) || 0,
				})),
			};

			// Routing analytics: "why did this account get selected?"
			// Requests without request_routing rows predate telemetry and are
			// labeled "untracked" so the overview still shows account flow.
			phaseStartedAt = performance.now();
			const routingFlowRows = await db.query<{
				strategy: string;
				decision: string;
				account_id: string;
				account_name: string;
				outcome: "success" | "rate_limited" | "error";
				requests: number;
				success_rate: number;
				failover_attempts: number;
			}>(
				`
				SELECT
					COALESCE(rr.strategy, 'untracked') as strategy,
					COALESCE(rr.decision, 'untracked') as decision,
					COALESCE(rr.selected_account_id, r.account_used, ?) as account_id,
					COALESCE(sa.name, ua.name, rr.selected_account_id, r.account_used, ?) as account_name,
					CASE
						WHEN r.success = TRUE THEN 'success'
						WHEN r.status_code = 429 THEN 'rate_limited'
						ELSE 'error'
					END as outcome,
					COUNT(*) as requests,
					SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
					SUM(COALESCE(rr.failover_attempts, 0)) as failover_attempts
				FROM requests r
				LEFT JOIN request_routing rr ON rr.request_id = r.id
				LEFT JOIN accounts sa ON sa.id = rr.selected_account_id
				LEFT JOIN accounts ua ON ua.id = r.account_used
				WHERE ${whereClause}
				GROUP BY strategy, decision, account_id, account_name, outcome
				ORDER BY requests DESC
				LIMIT 120
			`,
				[NO_ACCOUNT_ID, NO_ACCOUNT_ID, ...queryParams],
			);

			const routingDecisionRows = await db.query<{
				strategy: string;
				decision: string;
				requests: number;
				success_rate: number;
				failover_attempts: number;
			}>(
				`
				SELECT
					COALESCE(rr.strategy, 'untracked') as strategy,
					COALESCE(rr.decision, 'untracked') as decision,
					COUNT(*) as requests,
					SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
					SUM(COALESCE(rr.failover_attempts, 0)) as failover_attempts
				FROM requests r
				LEFT JOIN request_routing rr ON rr.request_id = r.id
				WHERE ${whereClause}
				GROUP BY strategy, decision
				ORDER BY requests DESC
				LIMIT 20
			`,
				queryParams,
			);

			const routingAccountRows = await db.query<{
				account_id: string;
				account_name: string;
				requests: number;
				success_rate: number;
				failover_attempts: number;
			}>(
				`
				SELECT
					COALESCE(rr.selected_account_id, r.account_used, ?) as account_id,
					COALESCE(sa.name, ua.name, rr.selected_account_id, r.account_used, ?) as account_name,
					COUNT(*) as requests,
					SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
					SUM(COALESCE(rr.failover_attempts, 0)) as failover_attempts
				FROM requests r
				LEFT JOIN request_routing rr ON rr.request_id = r.id
				LEFT JOIN accounts sa ON sa.id = rr.selected_account_id
				LEFT JOIN accounts ua ON ua.id = r.account_used
				WHERE ${whereClause}
				GROUP BY account_id, account_name
				ORDER BY requests DESC
				LIMIT 12
			`,
				[NO_ACCOUNT_ID, NO_ACCOUNT_ID, ...queryParams],
			);

			const routingTimelineRows = await db.query<{
				ts: number;
				account_id: string;
				account_name: string;
				decision: string;
				requests: number;
				success_rate: number;
			}>(
				`
				SELECT
					(r.timestamp / ?) * ? as ts,
					COALESCE(rr.selected_account_id, r.account_used, ?) as account_id,
					COALESCE(sa.name, ua.name, rr.selected_account_id, r.account_used, ?) as account_name,
					COALESCE(rr.decision, 'untracked') as decision,
					COUNT(*) as requests,
					SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate
				FROM requests r
				LEFT JOIN request_routing rr ON rr.request_id = r.id
				LEFT JOIN accounts sa ON sa.id = rr.selected_account_id
				LEFT JOIN accounts ua ON ua.id = r.account_used
				WHERE ${whereClause}
				GROUP BY ts, account_id, account_name, decision
				ORDER BY ts ASC, requests DESC
				LIMIT 1000
			`,
				[
					bucket.bucketMs,
					bucket.bucketMs,
					NO_ACCOUNT_ID,
					NO_ACCOUNT_ID,
					...queryParams,
				],
			);
			recordPhase(phaseTimings, "routing", phaseStartedAt);

			// Cache token flow: per-(model, account) sums of the three disjoint
			// input buckets (cache reads, cache writes, uncached input). Feeds
			// the Cache Flow graph on the dashboard.
			phaseStartedAt = performance.now();
			const cacheFlowRows = await db.query<{
				model: string;
				account_name: string;
				cache_read_tokens: number;
				cache_write_tokens: number;
				uncached_tokens: number;
			}>(
				`
				SELECT
					COALESCE(r.model, 'unknown') as model,
					COALESCE(a.name, r.account_used, ?) as account_name,
					SUM(COALESCE(r.cache_read_input_tokens, 0)) as cache_read_tokens,
					SUM(COALESCE(r.cache_creation_input_tokens, 0)) as cache_write_tokens,
					SUM(COALESCE(r.input_tokens, 0)) as uncached_tokens
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				WHERE ${whereClause}
				-- Positional: "GROUP BY model" would bind to the raw r.model column
				-- (SQLite prefers source columns over aliases), splitting NULL
				-- models from the 'unknown' label they coalesce into.
				GROUP BY 1, 2
				ORDER BY (cache_read_tokens + cache_write_tokens + uncached_tokens) DESC
				LIMIT 100
			`,
				[NO_ACCOUNT_ID, ...queryParams],
			);
			recordPhase(phaseTimings, "cache_flow", phaseStartedAt);

			const cacheFlow: CacheFlowPoint[] = cacheFlowRows.map((row) => ({
				model: row.model,
				accountName: row.account_name,
				cacheReadTokens: Number(row.cache_read_tokens) || 0,
				cacheWriteTokens: Number(row.cache_write_tokens) || 0,
				uncachedTokens: Number(row.uncached_tokens) || 0,
			}));

			// Context composition (1/3): char-bucket totals/averages plus the
			// per-project split, over COVERED rows only (context columns recorded
			// at ingest; NULL = not recorded). One UNION query with a shared
			// covered-only CTE — the discriminator column separates the single
			// totals row from the grouped project rows.
			phaseStartedAt = performance.now();
			const compositionRows = await db.query<{
				row_type: string;
				project: string | null;
				requests: number;
				sum_system_chars: number | null;
				sum_tools_chars: number | null;
				sum_messages_chars: number | null;
				sum_tool_result_chars: number | null;
				sum_context_tokens: number | null;
				avg_context_tokens: number | null;
				avg_system_chars: number | null;
				avg_tools_chars: number | null;
				avg_messages_chars: number | null;
				avg_message_count: number | null;
			}>(
				`
				WITH covered AS (
					SELECT
						r.project as project,
						COALESCE(r.context_system_chars, 0) as system_chars,
						COALESCE(r.context_tools_chars, 0) as tools_chars,
						COALESCE(r.context_messages_chars, 0) as messages_chars,
						COALESCE(r.context_tool_result_chars, 0) as tool_result_chars,
						COALESCE(r.context_message_count, 0) as message_count,
						${CONTEXT_TOKENS_SQL} as context_tokens
					FROM requests r
					WHERE ${whereClause} AND r.context_messages_chars IS NOT NULL
				)
				SELECT
					'totals' as row_type,
					CAST(NULL AS TEXT) as project,
					COUNT(*) as requests,
					SUM(system_chars) as sum_system_chars,
					SUM(tools_chars) as sum_tools_chars,
					SUM(messages_chars) as sum_messages_chars,
					SUM(tool_result_chars) as sum_tool_result_chars,
					SUM(context_tokens) as sum_context_tokens,
					AVG(context_tokens) as avg_context_tokens,
					AVG(system_chars) as avg_system_chars,
					AVG(tools_chars) as avg_tools_chars,
					AVG(messages_chars) as avg_messages_chars,
					AVG(message_count) as avg_message_count
				FROM covered

				UNION ALL

				SELECT * FROM (
					SELECT
						'project' as row_type,
						project,
						COUNT(*) as requests,
						CAST(NULL AS BIGINT) as sum_system_chars,
						CAST(NULL AS BIGINT) as sum_tools_chars,
						CAST(NULL AS BIGINT) as sum_messages_chars,
						CAST(NULL AS BIGINT) as sum_tool_result_chars,
						CAST(NULL AS BIGINT) as sum_context_tokens,
						AVG(context_tokens) as avg_context_tokens,
						AVG(system_chars) as avg_system_chars,
						AVG(tools_chars) as avg_tools_chars,
						AVG(messages_chars) as avg_messages_chars,
						CAST(NULL AS DOUBLE PRECISION) as avg_message_count
					FROM covered
					GROUP BY project
					ORDER BY requests DESC
					LIMIT ${CONTEXT_BY_PROJECT_LIMIT}
				)
			`,
				queryParams,
			);
			recordPhase(phaseTimings, "context_composition", phaseStartedAt);

			// Context composition (2/3): growth curve over ALL filtered rows (no
			// composition predicate — token columns exist for full history),
			// bucketed like timeSeries, restricted to the top projects by
			// request count in range. The NULL "project" needs its own branch:
			// IN (...) never matches SQL NULL.
			phaseStartedAt = performance.now();
			const growthCurveRows = await db.query<{
				ts: number;
				project: string | null;
				avg_context_tokens: number | null;
				max_context_tokens: number | null;
				requests: number;
			}>(
				`
				WITH top_projects AS (
					SELECT r.project as project
					FROM requests r
					WHERE ${whereClause}
					GROUP BY r.project
					ORDER BY COUNT(*) DESC
					LIMIT ${GROWTH_CURVE_PROJECT_LIMIT}
				)
				SELECT
					(r.timestamp / ?) * ? as ts,
					r.project as project,
					AVG(${CONTEXT_TOKENS_SQL}) as avg_context_tokens,
					MAX(${CONTEXT_TOKENS_SQL}) as max_context_tokens,
					COUNT(*) as requests
				FROM requests r
				WHERE ${whereClause}
					AND (
						r.project IN (SELECT project FROM top_projects WHERE project IS NOT NULL)
						OR (r.project IS NULL AND EXISTS (SELECT 1 FROM top_projects WHERE project IS NULL))
					)
				GROUP BY ts, r.project
				ORDER BY ts
				LIMIT ${GROWTH_CURVE_POINT_LIMIT}
			`,
				[...queryParams, bucket.bucketMs, bucket.bucketMs, ...queryParams],
			);
			recordPhase(phaseTimings, "context_growth_curve", phaseStartedAt);

			// Context composition (3/3): biggest single tool results — the
			// actionable "what to trim" list. > 0 excludes both NULL (not
			// recorded) and zero (no tool results in the request).
			phaseStartedAt = performance.now();
			const topToolRows = await db.query<{
				id: string;
				timestamp: number;
				project: string | null;
				model: string | null;
				context_largest_tool_name: string | null;
				context_largest_tool_chars: number;
			}>(
				`
				SELECT
					r.id,
					r.timestamp,
					r.project,
					r.model,
					r.context_largest_tool_name,
					r.context_largest_tool_chars
				FROM requests r
				WHERE ${whereClause} AND r.context_largest_tool_chars > 0
				ORDER BY r.context_largest_tool_chars DESC
				LIMIT ${TOP_TOOL_CONTRIBUTORS_LIMIT}
			`,
				queryParams,
			);
			recordPhase(phaseTimings, "context_top_tools", phaseStartedAt);

			// Tool-call error analytics (1/3): per-tool call/error totals over the
			// filtered range. Tool rows join back to requests so the shared
			// whereClause (range + account/model/key/project/status filters)
			// applies identically to every block.
			phaseStartedAt = performance.now();
			const toolErrorByToolRows = await db.query<{
				tool_name: string;
				total_calls: number;
				total_errors: number;
				error_rate_pct: number | null;
			}>(
				`
				SELECT
					tc.tool_name,
					SUM(tc.call_count) as total_calls,
					SUM(tc.error_count) as total_errors,
					SUM(tc.error_count) * 100.0 / NULLIF(SUM(tc.call_count), 0) as error_rate_pct
				FROM request_tool_calls tc
				JOIN requests r ON r.id = tc.request_id
				WHERE ${whereClause}
				GROUP BY tc.tool_name
				ORDER BY total_errors DESC, total_calls DESC
				LIMIT ${TOOL_ERROR_BY_TOOL_LIMIT}
			`,
				queryParams,
			);

			// Tool-call error analytics (2/3): bucketed calls/errors over time,
			// restricted to the top tools by error count within the same filtered
			// window so the chart stays readable. Params: the CTE consumes one
			// whereClause pass first, then the bucket pair, then the outer pass —
			// same ordering convention as growthCurveRows above.
			const toolErrorTimeSeriesRows = await db.query<{
				ts: number;
				tool_name: string;
				calls: number;
				errors: number;
			}>(
				`
				WITH top_error_tools AS (
					SELECT tc.tool_name as tool_name
					FROM request_tool_calls tc
					JOIN requests r ON r.id = tc.request_id
					WHERE ${whereClause}
					GROUP BY tc.tool_name
					ORDER BY SUM(tc.error_count) DESC, SUM(tc.call_count) DESC
					LIMIT ${TOOL_ERROR_TIME_SERIES_TOOL_LIMIT}
				)
				SELECT
					(r.timestamp / ?) * ? as ts,
					tc.tool_name,
					SUM(tc.call_count) as calls,
					SUM(tc.error_count) as errors
				FROM request_tool_calls tc
				JOIN requests r ON r.id = tc.request_id
				WHERE ${whereClause}
					AND tc.tool_name IN (SELECT tool_name FROM top_error_tools)
				GROUP BY ts, tc.tool_name
				ORDER BY ts, tc.tool_name
				LIMIT ${TOOL_ERROR_TIME_SERIES_POINT_LIMIT}
			`,
				[...queryParams, bucket.bucketMs, bucket.bucketMs, ...queryParams],
			);

			// Tool-call error analytics (3/3): most frequent distinct error texts
			// per tool. error_text is pre-truncated at ingest (≤500 chars) so
			// grouping on it is bounded; NULL texts carry no signal and are skipped.
			// A window function caps each tool at TOOL_ERROR_MESSAGES_PER_TOOL_LIMIT
			// rows before the global limit so one noisy tool cannot crowd out the
			// rest of the fleet.
			const toolErrorMessageRows = await db.query<{
				tool_name: string;
				error_text: string;
				occurrences: number;
			}>(
				`
				WITH ranked AS (
					SELECT
						te.tool_name,
						te.error_text,
						COUNT(*) as occurrences,
						ROW_NUMBER() OVER (
							PARTITION BY te.tool_name
							ORDER BY COUNT(*) DESC
						) as rn
					FROM request_tool_errors te
					JOIN requests r ON r.id = te.request_id
					WHERE ${whereClause} AND te.error_text IS NOT NULL
					GROUP BY te.tool_name, te.error_text
				)
				SELECT tool_name, error_text, occurrences
				FROM ranked
				WHERE rn <= ${TOOL_ERROR_MESSAGES_PER_TOOL_LIMIT}
				ORDER BY occurrences DESC
				LIMIT ${TOOL_ERROR_TOP_MESSAGES_LIMIT}
			`,
				queryParams,
			);
			recordPhase(phaseTimings, "tool_errors", phaseStartedAt);

			const toolCallErrors = {
				byTool: toolErrorByToolRows.map((row) => ({
					toolName: row.tool_name,
					totalCalls: Number(row.total_calls) || 0,
					totalErrors: Number(row.total_errors) || 0,
					errorRatePct: Number(row.error_rate_pct) || 0,
				})),
				timeSeries: toolErrorTimeSeriesRows.map((row) => ({
					ts: Number(row.ts),
					toolName: row.tool_name,
					calls: Number(row.calls) || 0,
					errors: Number(row.errors) || 0,
				})),
				topMessages: toolErrorMessageRows.map((row) => ({
					toolName: row.tool_name,
					errorText: row.error_text,
					occurrences: Number(row.occurrences) || 0,
				})),
			};

			const compositionTotalsRow = compositionRows.find(
				(row) => row.row_type === "totals",
			);
			const contextComposition = {
				coverage: {
					withComposition: Number(compositionTotalsRow?.requests) || 0,
					// Reuse the consolidated all-rows total — same whereClause,
					// already computed; recounting would just burn a scan.
					totalRequests: Number(consolidatedResult?.total_requests) || 0,
				},
				totals: {
					systemChars: Number(compositionTotalsRow?.sum_system_chars) || 0,
					toolsChars: Number(compositionTotalsRow?.sum_tools_chars) || 0,
					messagesChars: Number(compositionTotalsRow?.sum_messages_chars) || 0,
					toolResultChars:
						Number(compositionTotalsRow?.sum_tool_result_chars) || 0,
					contextTokens: Number(compositionTotalsRow?.sum_context_tokens) || 0,
					avgContextTokens:
						Number(compositionTotalsRow?.avg_context_tokens) || 0,
				},
				avgPerRequest: {
					systemChars: Number(compositionTotalsRow?.avg_system_chars) || 0,
					toolsChars: Number(compositionTotalsRow?.avg_tools_chars) || 0,
					messagesChars: Number(compositionTotalsRow?.avg_messages_chars) || 0,
					messageCount: Number(compositionTotalsRow?.avg_message_count) || 0,
				},
				byProject: compositionRows
					.filter((row) => row.row_type === "project")
					.map((row) => ({
						project: row.project ?? null,
						requests: Number(row.requests) || 0,
						avgContextTokens: Number(row.avg_context_tokens) || 0,
						avgSystemChars: Number(row.avg_system_chars) || 0,
						avgToolsChars: Number(row.avg_tools_chars) || 0,
						avgMessagesChars: Number(row.avg_messages_chars) || 0,
					})),
				growthCurve: growthCurveRows.map((row) => ({
					ts: Number(row.ts),
					project: row.project ?? null,
					avgContextTokens: Number(row.avg_context_tokens) || 0,
					maxContextTokens: Number(row.max_context_tokens) || 0,
					requests: Number(row.requests) || 0,
				})),
				topToolContributors: topToolRows.map((row) => ({
					requestId: row.id,
					ts: Number(row.timestamp),
					project: row.project ?? null,
					model: row.model ?? null,
					toolName: row.context_largest_tool_name ?? null,
					chars: Number(row.context_largest_tool_chars) || 0,
				})),
			};

			const routingTotalRequests = routingDecisionRows.reduce(
				(total, row) => total + (Number(row.requests) || 0),
				0,
			);

			const topDecisionByAccount = new Map<string, string>();
			for (const row of routingFlowRows) {
				if (!topDecisionByAccount.has(row.account_id)) {
					topDecisionByAccount.set(row.account_id, row.decision);
				}
			}

			const routing = {
				totalRequests: routingTotalRequests,
				flow: routingFlowRows.map((row) => ({
					strategy: row.strategy,
					decision: row.decision,
					accountId: row.account_id,
					accountName: row.account_name,
					outcome: row.outcome,
					requests: Number(row.requests) || 0,
					successRate: Number(row.success_rate) || 0,
					failoverAttempts: Number(row.failover_attempts) || 0,
				})),
				timeline: routingTimelineRows.map((row) => ({
					ts: Number(row.ts),
					accountId: row.account_id,
					accountName: row.account_name,
					decision: row.decision,
					requests: Number(row.requests) || 0,
					successRate: Number(row.success_rate) || 0,
				})),
				decisionBreakdown: routingDecisionRows.map((row) => {
					const requests = Number(row.requests) || 0;
					return {
						strategy: row.strategy,
						decision: row.decision,
						requests,
						percentage:
							routingTotalRequests > 0
								? (requests / routingTotalRequests) * 100
								: 0,
						successRate: Number(row.success_rate) || 0,
						failoverAttempts: Number(row.failover_attempts) || 0,
					};
				}),
				accountSplit: routingAccountRows.map((row) => {
					const requests = Number(row.requests) || 0;
					return {
						accountId: row.account_id,
						accountName: row.account_name,
						requests,
						percentage:
							routingTotalRequests > 0
								? (requests / routingTotalRequests) * 100
								: 0,
						successRate: Number(row.success_rate) || 0,
						failoverAttempts: Number(row.failover_attempts) || 0,
						topDecision: topDecisionByAccount.get(row.account_id) ?? null,
					};
				}),
			};

			// Transform timeSeries data
			let transformedTimeSeries = timeSeries.map((point) => ({
				ts: Number(point.ts),
				...(point.model && { model: point.model }),
				requests: Number(point.requests) || 0,
				tokens: Number(point.tokens) || 0,
				costUsd: Number(point.cost_usd) || 0,
				planCostUsd: Number(point.plan_cost_usd) || 0,
				apiCostUsd: Number(point.api_cost_usd) || 0,
				successRate: Number(point.success_rate) || 0,
				errorRate: Number(point.error_rate) || 0,
				cacheHitRate: Number(point.cache_hit_rate) || 0,
				avgResponseTime: Number(point.avg_response_time) || 0,
				avgTokensPerSecond:
					point.avg_tokens_per_second != null
						? Number(point.avg_tokens_per_second)
						: null,
			}));

			// Apply cumulative transformation if requested
			if (isCumulative && !includeModelBreakdown) {
				let runningRequests = 0;
				let runningTokens = 0;
				let runningCostUsd = 0;

				transformedTimeSeries = transformedTimeSeries.map((point) => {
					runningRequests += point.requests;
					runningTokens += point.tokens;
					runningCostUsd += point.costUsd;

					return {
						...point,
						requests: runningRequests,
						tokens: runningTokens,
						costUsd: runningCostUsd,
						// Keep rates as-is (not cumulative)
					};
				});
			} else if (isCumulative && includeModelBreakdown) {
				// For per-model cumulative, track running totals per model
				const runningTotals: Record<
					string,
					{ requests: number; tokens: number; costUsd: number }
				> = {};

				transformedTimeSeries = transformedTimeSeries.map((point) => {
					if (point.model) {
						if (!runningTotals[point.model]) {
							runningTotals[point.model] = {
								requests: 0,
								tokens: 0,
								costUsd: 0,
							};
						}
						runningTotals[point.model].requests += point.requests;
						runningTotals[point.model].tokens += point.tokens;
						runningTotals[point.model].costUsd += point.costUsd;

						return {
							...point,
							requests: runningTotals[point.model].requests,
							tokens: runningTotals[point.model].tokens,
							costUsd: runningTotals[point.model].costUsd,
						};
					}
					return point;
				});
			}

			const response: AnalyticsResponse = {
				meta: {
					range,
					bucket: bucket.displayName,
					cumulative: isCumulative,
				},
				totals: {
					requests: Number(consolidatedResult?.total_requests) || 0,
					successRate: Number(consolidatedResult?.success_rate) || 0,
					activeAccounts: Number(consolidatedResult?.active_accounts) || 0,
					avgResponseTime: Number(consolidatedResult?.avg_response_time) || 0,
					totalTokens: Number(consolidatedResult?.total_tokens) || 0,
					totalCostUsd: Number(consolidatedResult?.total_cost_usd) || 0,
					planCostUsd: Number(consolidatedResult?.plan_cost_usd) || 0,
					apiCostUsd: Number(consolidatedResult?.api_cost_usd) || 0,
					cacheHitRate: Number(consolidatedResult?.cache_hit_rate) || 0,
					avgTokensPerSecond:
						consolidatedResult?.avg_tokens_per_second != null
							? Number(consolidatedResult.avg_tokens_per_second)
							: null,
					medianTokensPerSecond,
					p95TokensPerSecond,
					avgDailyPlanCostUsd,
					avgWeeklyPlanCostUsd,
					avgDailyApiCostUsd,
					avgWeeklyApiCostUsd,
				},
				timeSeries: transformedTimeSeries,
				tokenBreakdown: {
					inputTokens: Number(consolidatedResult?.input_tokens) || 0,
					cacheReadInputTokens:
						Number(consolidatedResult?.cache_read_input_tokens) || 0,
					cacheCreationInputTokens:
						Number(consolidatedResult?.cache_creation_input_tokens) || 0,
					outputTokens: Number(consolidatedResult?.output_tokens) || 0,
				},
				modelDistribution,
				accountPerformance,
				apiKeyPerformance,
				costByModel,
				accountModelUsage,
				modelPerformance,
				speedTimeSeries,
				routing,
				cacheFlow,
				projectBreakdown,
				contextComposition,
				toolCallErrors,
				activeSessions,
			};

			logAnalyticsTimings(phaseTimings, analyticsStartedAt);
			return jsonResponse(response);
		} catch (error) {
			log.error("Analytics error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch analytics data"),
			);
		}
	};
}
