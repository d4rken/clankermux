/**
 * Thin dispatch shim, matching every other worker-routed dashboard endpoint:
 * the implementation lives in `sdk-bridge-health-direct.ts`.
 */
export { createIsolatedSdkBridgeHealthHandler as createSdkBridgeHealthHandler } from "./analytics-runner";
