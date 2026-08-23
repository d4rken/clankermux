// Export router - the main public API

// Export handlers
export { terminateAnalyticsWorker } from "./handlers/analytics-runner";
export {
	__setQuotaDriftWorkerFactoryForTests,
	QUOTA_DRIFT_PASS_TIMEOUT_MS,
	type QuotaDriftPassResult,
	runQuotaDriftPass,
} from "./handlers/quota-drift-precompute";
export * from "./handlers/storage";
export { APIRouter } from "./router";
// Export admin service functions (account + API-key management)
export * from "./services/admin/accounts";
export * from "./services/admin/api-keys";
// Export services
export {
	type AuthenticationResult,
	type AuthRequirement,
	AuthService,
} from "./services/auth-service";
// Export SSE shutdown registry (used by server shutdown to close endless
// dashboard streams before the HTTP drain)
export { closeAllSseStreams, registerSseCloser } from "./sse-registry";
// Export types
export * from "./types";
// Export utilities
export * from "./utils/http-error";
