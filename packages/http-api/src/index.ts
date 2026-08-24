// Export router - the main public API

// Export handlers
export { terminateAnalyticsWorker } from "./handlers/analytics-runner";
// Management session auth: the app-level login behind /api/*
export type { AuthStatusResponse } from "./handlers/auth";
export { NO_STORE_HEADERS } from "./handlers/public/cache-headers";
// The read-only widget API at /public/v1/*
export {
	MAX_STRING_BYTES,
	PUBLIC_ACCOUNTS_SCHEMA,
	PUBLIC_RUNWAY_SCHEMA,
	PUBLIC_STATUS_SCHEMA,
	PUBLIC_STREAM_SCHEMA,
	type PublicAccountDto,
	type PublicAccountsDto,
	type PublicActiveRequestDto,
	type PublicAvailabilityDto,
	type PublicAvailabilityReason,
	type PublicAvailabilityState,
	type PublicCredentialDto,
	type PublicCredentialStateDto,
	type PublicMeasurementStateDto,
	type PublicOverloadDto,
	type PublicOverloadStateDto,
	type PublicPredictionDto,
	type PublicPredictionState,
	type PublicProviderDto,
	type PublicRequestDoneDto,
	type PublicRequestDroppedDto,
	type PublicRequestOpenedDto,
	type PublicRequestUpstreamDto,
	type PublicRunwayCauseDto,
	type PublicRunwayDto,
	type PublicRunwayKind,
	type PublicScopedLimitDto,
	type PublicSnapshotEventDto,
	type PublicStatusDto,
	type PublicStreamEventDto,
	type PublicStreamEventType,
	type PublicWindowAggregateDto,
	type PublicWindowDto,
	type PublicWindowKind,
	type PublicWorstOutcomeDto,
	toPublicAccountDto,
	toPublicAccountsDto,
	toPublicAvailabilityReason,
	toPublicAvailabilityState,
	toPublicCredentialState,
	toPublicMeasurementState,
	toPublicOverloadState,
	toPublicPredictionState,
	toPublicRequestDoneDto,
	toPublicRunwayDto,
	toPublicRunwayKind,
	toPublicStatusDto,
	toPublicStatusLevel,
	toPublicWindowKind,
	truncateUtf8,
} from "./handlers/public/dto";
export { PublicRouter, type PublicRouterDeps } from "./handlers/public/router";
export { toPublicStreamEvent } from "./handlers/public/stream";
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
export {
	isManagementPath,
	type ManagementAuthRequirement,
	managementAuthRequirement,
} from "./services/management-auth-policy";
export {
	createPublicRunwayReader,
	type PublicRunwayCoverage,
	type PublicRunwayReader,
	type PublicRunwaySnapshot,
	type PublicWorstOutcome,
} from "./services/public-runway";
export {
	clampPct,
	createPublicSnapshotReader,
	type PublicAccountSnapshot,
	type PublicCredentialState,
	type PublicMeasurementState,
	type PublicOverloadSnapshot,
	type PublicPoolSnapshot,
	type PublicProviderSnapshot,
	type PublicRoutingSnapshot,
	type PublicScopedLimitAggregate,
	type PublicSnapshot,
	type PublicSnapshotReader,
	type PublicUsageAggregate,
	type PublicWindowAggregate,
	type PublicWindowSnapshot,
	resolveCredentialState,
} from "./services/public-snapshot";
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
