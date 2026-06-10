/**
 * /api/analytics/memory-history — thin wrapper dispatching through the shared
 * read-only dashboard worker (kind "memory-history") so the synchronous
 * bun:sqlite bucketed scan (range=all covers the full snapshot retention)
 * never blocks the main event loop. The actual query/shaping logic lives in
 * memory-history-direct.ts.
 */
export { createIsolatedMemoryHistoryHandler as createMemoryHistoryHandler } from "./analytics-runner";
