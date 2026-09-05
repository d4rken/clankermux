// Re-export provider-related types and functions from @clankermux/providers
export type {
	Provider,
	RateLimitInfo,
	TokenRefreshResult,
} from "@clankermux/providers";
export {
	getProvider,
	listProviders,
	registerProvider,
} from "@clankermux/providers";
export {
	ANTHROPIC_BUNDLED_MODEL_CREATED_AT,
	ANTHROPIC_MODEL_CATALOG_LOOKUP_BUDGET_MS,
	ANTHROPIC_MODEL_CATALOG_RETRY_AFTER_MS,
	ANTHROPIC_MODEL_CATALOG_TTL_MS,
	ANTHROPIC_MODEL_CATALOG_URL,
	type AnthropicCatalogModel,
	AnthropicModelCatalogCache,
	type AnthropicModelCatalogCacheDeps,
	type AnthropicModelCatalogSnapshot,
} from "./anthropic-model-catalog-cache";
export { AutoRefreshScheduler } from "./auto-refresh-scheduler";
export {
	BRIDGE_HOURS_PER_RISK_UNIT,
	bridgeHoursToRiskFactor,
	clampBridgeHours,
	clampRiskFactor,
	KEEPALIVE_REFRESH_1H_MS,
	MAX_BRIDGE_HOURS,
	MAX_RISK_FACTOR,
	RISK_FACTOR,
	riskFactorToBridgeHours,
} from "./bridge-policy";
export { type BridgeStatsSnapshot, bridgeStats } from "./bridge-stats";
export { CacheKeepaliveScheduler } from "./cache-keepalive-scheduler";
export {
	CODEX_MODEL_CATALOG_LOOKUP_BUDGET_MS,
	CODEX_MODEL_CATALOG_MAX_ENTRIES,
	CODEX_MODEL_CATALOG_TTL_MS,
	CodexModelCatalogCache,
	type CodexModelCatalogCacheDeps,
	type CodexModelCatalogEntry,
} from "./codex-model-catalog-cache";
export {
	type CodexResetCreditApplyDeps,
	CodexResetCreditApplyScheduler,
	createCodexResetCreditApplyScheduler,
} from "./codex-reset-credit-applier";
export {
	type CodexSpendCause,
	CodexSpendCoordinator,
	type CodexSpendResult,
} from "./codex-spend-coordinator";
export {
	CodexUsagePoller,
	type CodexUsagePollerDeps,
	type PolledCodexAccount,
} from "./codex-usage-poller";
export { computeContextAndToolStats } from "./context-composition";
export { dispatchProxyRequest } from "./dispatch";
// clearFamilyWeeklyExhaustedForAccount is called by the account-removal
// handler in http-api; the record/get pair rides along so its integration test
// can seed and observe the memo through the package boundary.
export {
	clearFamilyWeeklyExhaustedForAccount,
	getFamilyWeeklyExhaustedUntil,
	recordFamilyWeeklyExhausted,
} from "./family-weekly-memo";
export {
	type CapacityProbeReservation,
	type CodexResetCreditConsumeDispatchOutcome,
	type CodexUsageRefreshOutcome,
	checkAllAccountsHealth,
	checkRefreshTokenHealth,
	clearAccountAffinity,
	clearAccountRefreshCache,
	clearAllPendingRotationsForTests,
	clearCapacityRestoredProbePending,
	clearCodexUsagePersistMemo,
	clearPendingRotation,
	consumeCodexResetCreditForAccount,
	createUsageThrottledResponse,
	formatTokenHealthReport,
	getAccountsNeedingReauth,
	getCoalescibleRecentRefresh,
	getForcedAccount,
	getPendingRotation,
	getUsageThrottleStatus,
	getUsageThrottleUntil,
	getValidAccessToken,
	hasCapacityRestoredProbePending,
	isRefreshTokenLikelyExpired,
	// The weekly headroom the routing gate holds back as failover capacity.
	// Re-exported so the pool-sizing read can fire its "add an account" signal
	// at exactly the threshold routing actually reserves at, rather than at a
	// second number that could drift away from it.
	LIVENESS_RESERVE_HEADROOM_PCT,
	markCapacityRestoredProbePending,
	type PendingRotation,
	type PendingRotationWriter,
	recordPendingRotation,
	recordRecentRefresh,
	refreshCodexResetCreditsForAccount,
	refreshCodexUsageForAccount,
	registerAffinityClearer,
	registerCodexResetCreditConsumer,
	registerCodexResetCreditsRefresher,
	registerCodexUsageRefresher,
	registerPollingRestarter,
	registerRefreshClearer,
	restartUsagePollingForAccount,
	rollbackCapacityRestoredProbePending,
	setForcedAccount,
	startGlobalTokenHealthChecks,
	stopGlobalTokenHealthChecks,
	type TokenHealthReport,
	type TokenHealthStatus,
	unregisterCodexResetCreditConsumer,
	unregisterCodexResetCreditsRefresher,
	unregisterCodexUsageRefresher,
} from "./handlers";
// Re-exported for apps/server, which must answer a departed client with the same
// 499 terminal the proxy uses. Imported from the leaf module because the
// ./handlers barrel does not export it at all — the leaf sits outside that
// barrel on purpose, so that proxy.ts and proxy-operations.ts can both use it
// without an import cycle. Safe for the browser bundle: dashboard-web does not
// depend on this package.
export { createClientAbortResponse } from "./handlers/client-abort-response";
export {
	canonicalize,
	createIdentityBoundRefusalResponse,
	IDENTITY_BOUND_PATH_PREFIXES,
	isIdentityBoundPath,
} from "./identity-bound-paths";
export {
	runIntegrityCheckOnDemand,
	startFullIntegrityCheckBackground,
	startIntegrityScheduler,
} from "./integrity-scheduler";
export {
	getActiveOverloadHoldCount,
	getOccupiedOverloadHoldKeys,
} from "./overload-hold";
export {
	DEFAULT_ROUTING_CONTEXT,
	type DefaultCandidateEvaluation,
	earliestExclusionRecoveryMs,
	evaluateDefaultCandidates,
	type PeekExclusion,
	type PeekExclusionReason,
	peekDefaultCandidateIds,
	peekPrimaryAccountId,
} from "./peek-primary";
export {
	ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	completeProviderOverloadProbe,
	getOverloadDiagnostics,
	getProbeLeaseSafetyTtlMs,
	getProviderOverloadKey,
	getProviderOverloadSnapshot,
	getProviderOverloadUntil,
	getProviderWideOverloadUntil,
	inspectProviderOverload,
	isOfficialAnthropicProvider,
	isProviderOverloaded,
	type OverloadBreakerState,
	type OverloadBreakerStatus,
	type OverloadBucketSnapshot,
	type OverloadDiagnosticBucket,
	type OverloadProbeToken,
	type ProbeAdmission,
	tryAcquireProviderOverloadProbe,
} from "./provider-overload-cooldown";
export {
	getRequestRecorder,
	handleProxy,
	type ProxyContext,
	setRequestRecorder,
} from "./proxy";
export {
	type RecordMeta,
	type RecordRouting,
	RequestRecorder,
	type RequestRecorderConfig,
	type RequestRecorderDeps,
	type SlimUsageSummary,
	type TransportOutcome,
} from "./request-recorder";
export {
	drainPendingUsageFinalizers,
	forwardToClient,
	type ResponseHandlerOptions,
} from "./response-handler";
export { sessionCacheStore } from "./session-cache-store";
export { sessionProjectCache } from "./session-project-cache";
export { sessionPromotionTracker } from "./session-promotion";
export type { ProxyRequest, ProxyResponse } from "./types";
export {
	type UnmatchedPath,
	UnmatchedPathTracker,
	unmatchedPathTracker,
} from "./unmatched-paths";
export {
	clearUsageRevisionAnchors,
	getUsageRevisionAnchor,
	observeUsageReading,
	REVISION_MIN_DROP_PCT,
} from "./usage-revision-anchor";
export {
	getWeeklyBurnSlope,
	recordWeeklyBurnSlope,
	resolveEffectiveWeeklySlope,
	WEEKLY_SLOPE_MAX_AGE_MS,
	WEEKLY_SLOPE_RESET_MATCH_TOLERANCE_MS,
	type WeeklyBurnSlopeEntry,
	type WeeklyBurnSlopeRecord,
} from "./weekly-burn-slope";
