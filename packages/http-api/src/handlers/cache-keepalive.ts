import { jsonResponse } from "@clankermux/http-common";
import { bridgeStats, sessionCacheStore } from "@clankermux/proxy";
import type { CacheKeepaliveLiveResponse } from "@clankermux/types";
import type { APIContext } from "../types";

/**
 * Live (main-thread) /api/analytics/cache-keepalive implementation.
 *
 * Reads in-memory proxy singletons (bridgeStats counters + sessionCacheStore
 * gauges) that the read-only dashboard worker can't see, so this MUST run on
 * the main thread (unlike the DB-backed *-history endpoints). Returns the
 * current live gauges (warm/promoted sessions, total bytes) alongside the
 * cumulative-since-restart counters from bridgeStats.snapshot() and the
 * configured warming mode/threshold.
 */
export function createCacheKeepaliveHandler(context: APIContext) {
	return (): Response => {
		const s = bridgeStats.snapshot();
		const response: CacheKeepaliveLiveResponse = {
			mode: context.config.getCacheWarmingMode(),
			minTokens: context.config.getCacheWarmingMinTokens(),
			warmSessions: sessionCacheStore.getSize(),
			promotedSessions: sessionCacheStore.getPromotedSessions(),
			totalBytes: sessionCacheStore.getTotalBytes(),
			...s,
		};
		return jsonResponse(response);
	};
}
