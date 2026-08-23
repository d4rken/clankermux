/**
 * /api/analytics/quota-drift — thin wrapper dispatching through the shared
 * read-only dashboard worker (kind "quota-drift") on the LIGHT lane.
 *
 * Light is right: the analysis is precomputed by the scheduler, so this request
 * is one indexed single-row read of a JSON blob. The precompute pass itself
 * runs on its own dedicated worker (quota-drift-worker.ts) precisely so its
 * seconds-long scan never sits in a lane that serves panel reads.
 */
export { createIsolatedQuotaDriftHandler as createQuotaDriftHandler } from "./analytics-runner";
