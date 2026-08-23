// Export router - the main public API

// Export handlers
export { terminateAnalyticsWorker } from "./handlers/analytics-runner";
// Management session auth: the app-level login behind /api/*
export type { AuthStatusResponse } from "./handlers/auth";
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
export {
	isManagementPath,
	type ManagementAuthRequirement,
	managementAuthRequirement,
} from "./services/management-auth-policy";
export {
	SESSION_ABSOLUTE_MAX_MS,
	SESSION_COOKIE_NAME,
	SESSION_IDLE_MAX_MS,
	SessionAuthService,
	type SessionAuthStore,
	type SessionCheck,
	scryptPasswordHasher,
} from "./services/session-auth-service";
export {
	closeStreamsForSession,
	createSessionStreamGuard,
	type StreamSessionGuard,
} from "./services/session-stream-registry";
// Export SSE shutdown registry (used by server shutdown to close endless
// dashboard streams before the HTTP drain)
export { closeAllSseStreams, registerSseCloser } from "./sse-registry";
// Export types
export * from "./types";
// Export utilities
export * from "./utils/http-error";
