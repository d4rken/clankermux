/**
 * /api/analytics/usage-history — thin wrapper dispatching through the shared
 * read-only dashboard worker (kind "usage-history") so the synchronous
 * bun:sqlite window-function scan (range=all covers the full snapshot
 * retention) never blocks the main event loop. The actual query/shaping logic
 * lives in usage-history-direct.ts.
 */
export { createIsolatedUsageHistoryHandler as createUsageHistoryHandler } from "./analytics-runner";
