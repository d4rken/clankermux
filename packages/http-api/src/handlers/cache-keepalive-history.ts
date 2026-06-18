/**
 * /api/analytics/cache-keepalive-history — thin wrapper dispatching through the
 * shared read-only dashboard worker (kind "cache-keepalive-history") so the
 * synchronous bun:sqlite bucketed scan (range=all covers the full snapshot
 * retention) never blocks the main event loop. The actual query/delta-shaping
 * logic lives in cache-keepalive-history-direct.ts.
 */
export { createIsolatedCacheKeepaliveHistoryHandler as createCacheKeepaliveHistoryHandler } from "./analytics-runner";
