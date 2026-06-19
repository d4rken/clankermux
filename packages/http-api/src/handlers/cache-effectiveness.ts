// Thin re-export: the public handler is the worker-isolated wrapper from
// analytics-runner.ts (the direct implementation lives in
// cache-effectiveness-direct.ts and runs inside the read-only dashboard worker).
export { createIsolatedCacheEffectivenessHandler as createCacheEffectivenessHandler } from "./analytics-runner";
