import { MAX_PLAUSIBLE_TOKENS_PER_SECOND } from "@clankermux/core";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import { NO_ACCOUNT_ID } from "@clankermux/types";
import type {
	AnalyticsResponse,
	APIContext,
	CacheFlowPoint,
	SpeedTimePoint,
} from "../types";

const log = new Logger("AnalyticsHandler");

// Plausible-speed predicate, shared across every output-speed aggregation so
// the artifact ceiling is applied identically (drift between sites would let
// 137k-tok/s artifacts back into one query but not another). A bare
// `output_tokens_per_second > 0` already excludes NULLs in a WHERE/CASE, so no
// separate IS NOT NULL is needed. MAX_PLAUSIBLE_TOKENS_PER_SECOND is a numeric
// constant, not user input, so interpolating it is injection-safe.
const SPEED_IN_RANGE_SQL = `output_tokens_per_second > 0 AND output_tokens_per_second <= ${MAX_PLAUSIBLE_TOKENS_PER_SECOND}`;

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

interface BucketConfig {
	bucketMs: number;
	displayName: string;
}

function getRangeConfig(range: string): {
	startMs: number;
	bucket: BucketConfig;
} {
	const now = Date.now();
	const hour = 60 * 60 * 1000;
	const day = 24 * hour;

	switch (range) {
		case "1h":
			return {
				startMs: now - hour,
				bucket: { bucketMs: 60 * 1000, displayName: "1m" },
			};
		case "6h":
			return {
				startMs: now - 6 * hour,
				bucket: { bucketMs: 5 * 60 * 1000, displayName: "5m" },
			};
		case "24h":
			return {
				startMs: now - day,
				bucket: { bucketMs: hour, displayName: "1h" },
			};
		case "7d":
			return {
				startMs: now - 7 * day,
				bucket: { bucketMs: hour, displayName: "1h" },
			};
		case "30d":
			return {
				startMs: now - 30 * day,
				bucket: { bucketMs: day, displayName: "1d" },
			};
		default:
			return {
				startMs: now - day,
				bucket: { bucketMs: hour, displayName: "1h" },
			};
	}
}

export function createAnalyticsHandler(context: APIContext) {
	return async (params: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		const range = params.get("range") ?? "24h";
		const { startMs, bucket } = getRangeConfig(range);
		const mode = params.get("mode") ?? "normal";
		const isCumulative = mode === "cumulative";

		// Extract filters
		const accountsFilter =
			params.get("accounts")?.split(",").filter(Boolean) || [];
		const modelsFilter = params.get("models")?.split(",").filter(Boolean) || [];
		const apiKeysFilter =
			params.get("apiKeys")?.split(",").filter(Boolean) || [];
		const statusFilter = params.get("status") || "all";

		// Build filter conditions
		const conditions: string[] = ["r.timestamp > ?"];
		const queryParams: (string | number)[] = [startMs];

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
			const placeholders = apiKeysFilter.map(() => "?").join(",");
			conditions.push(`r.api_key_name IN (${placeholders})`);
			queryParams.push(...apiKeysFilter);
		}

		if (statusFilter === "success") {
			conditions.push("r.success = TRUE");
		} else if (statusFilter === "error") {
			conditions.push("r.success = FALSE");
		}

		const whereClause = conditions.join(" AND ");

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
					(SELECT SUM(CASE WHEN billing_type != 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) FROM filtered_requests) as api_cost_usd,
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
					SUM(CASE WHEN timestamp > ? AND billing_type != 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as api_cost_7d,
					SUM(CASE WHEN billing_type = 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as plan_cost_30d,
					SUM(CASE WHEN billing_type != 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as api_cost_30d,
					MIN(CASE WHEN billing_type = 'plan' THEN timestamp ELSE NULL END) as first_plan_ts,
					MIN(CASE WHEN billing_type != 'plan' THEN timestamp ELSE NULL END) as first_api_ts
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
					SUM(CASE WHEN billing_type != 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as api_cost_usd,
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
				-- UNION 11-column contract (ALL 5 sub-selects MUST match in this exact column order):
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
						SUM(CASE WHEN r.billing_type != 'plan' THEN COALESCE(r.cost_usd, 0) ELSE 0 END) as api_cost_usd,
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
						api_key_name as name,
						CAST(NULL AS TEXT) as secondary_name,
						CAST(NULL AS BIGINT) as count,
						COUNT(*) as requests,
						SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as plan_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as api_cost_usd,
						CAST(NULL AS DOUBLE PRECISION) as total_cost_usd,
						CAST(NULL AS BIGINT) as total_tokens
					FROM requests r
					WHERE ${whereClause} AND api_key_id IS NOT NULL
					GROUP BY api_key_id, api_key_name
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
			`,
				[
					...queryParams,
					NO_ACCOUNT_ID,
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
				GROUP BY model, account_name
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
