/**
 * /api/analytics/pool-sizing — thin wrapper dispatching through the shared
 * read-only dashboard worker (kind "pool-sizing") so the synchronous
 * bun:sqlite scan over 15 weeks of usage snapshots never blocks the main event
 * loop. The actual query/shaping logic lives in pool-sizing-direct.ts.
 */
export { createIsolatedPoolSizingHandler as createPoolSizingHandler } from "./analytics-runner";
