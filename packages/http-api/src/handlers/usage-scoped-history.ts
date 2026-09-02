/**
 * /api/analytics/usage-scoped-history — thin wrapper dispatching through the
 * shared read-only dashboard worker (kind "usage-scoped-history") so the
 * synchronous bun:sqlite window-function scan never blocks the main event
 * loop. The actual query/shaping logic lives in
 * usage-scoped-history-direct.ts.
 */
export { createIsolatedUsageScopedHistoryHandler as createUsageScopedHistoryHandler } from "./analytics-runner";
