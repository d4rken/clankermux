import { StatsRepository } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import type { APIContext } from "../types";

/**
 * Direct (in-process) /api/stats implementation.
 *
 * Pure read path: runs against whatever connection the supplied context
 * exposes via `dbOps.getAdapter()`. In production this executes inside the
 * read-only dashboard worker (see analytics-runner.ts / analytics-worker.ts)
 * so the synchronous bun:sqlite queries never block the main event loop.
 */
export function createStatsHandler(context: APIContext) {
	return async (params: URLSearchParams): Promise<Response> => {
		const statsRepository = new StatsRepository(context.dbOps.getAdapter());

		// Parse optional ?since=<days> query parameter (default: 30, max: 365)
		const sinceRaw = Number(params.get("since") ?? 30);
		const sinceDays =
			Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.min(sinceRaw, 365) : 30;
		const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

		// Parse optional ?errorsSinceHours=<n> query parameter
		// (default: 24, max: 8760 hours = 365 days)
		const errorsHoursRaw = Number(params.get("errorsSinceHours") ?? 24);
		const errorsHours =
			Number.isFinite(errorsHoursRaw) && errorsHoursRaw > 0
				? Math.min(errorsHoursRaw, 8760)
				: 24;
		const errorsSinceMs = Date.now() - errorsHours * 60 * 60 * 1000;

		// Get overall statistics using the consolidated repository
		const stats = await statsRepository.getAggregatedStats(sinceMs);
		const activeAccounts = await statsRepository.getActiveAccountCount();

		const successRate =
			stats.totalRequests > 0
				? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
				: 0;

		// Get recent errors
		const recentErrors = await statsRepository.getRecentErrorGroups(
			errorsSinceMs,
			50,
		);

		const response = {
			totalRequests: stats.totalRequests,
			successRate,
			activeAccounts,
			avgResponseTime: Math.round(stats.avgResponseTime || 0),
			totalTokens: stats.totalTokens,
			totalCostUsd: stats.totalCostUsd,
			avgTokensPerSecond: stats.avgTokensPerSecond,
			recentErrors,
		};

		return jsonResponse(response);
	};
}
