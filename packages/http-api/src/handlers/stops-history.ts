/**
 * /api/analytics/stops-history — thin wrapper dispatching through the shared
 * read-only dashboard worker (kind "stops-history") so the synchronous
 * bun:sqlite aggregation never blocks the main event loop. The actual
 * query/shaping logic lives in stops-history-direct.ts.
 */
export { createIsolatedStopsHistoryHandler as createStopsHistoryHandler } from "./analytics-runner";
