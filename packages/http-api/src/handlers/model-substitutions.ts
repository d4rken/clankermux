/**
 * Thin dispatch shim, matching every other worker-routed dashboard endpoint:
 * the implementation lives in `model-substitutions-direct.ts`, which the
 * analytics worker imports directly and which also serves as the in-process
 * fallback when no DB path can be resolved.
 */
export { createIsolatedModelSubstitutionsHandler as createModelSubstitutionsHandler } from "./analytics-runner";
