// Re-export only used items from each module

export {
	isAccountAllowedByPin,
	isPinActive,
	isRoutingPinValid,
	type RoutingPin,
} from "./api-key-pin";
export {
	accountWideWeeklyResetMs,
	computeApiKeyRunways,
	effectiveRunwayOutcome,
	IDLE_POOL_KEY_NAME,
	type KeyRunway,
	type RunwayAccountSource,
	type RunwayHeadline,
	type RunwayWindowObservations,
	scopedFamilyIdle,
	scopedFamilyPresence,
	scopedFamilyReadings,
	scopedWeeklyWindowKind,
	summarizeKeyRunways,
	toRunwayAccountInput,
	toScopedFamilyRunwayInput,
	worstKeyRunway,
} from "./api-key-runway";
export {
	// Test-only handle (forget the captured boot commit). NOT a runtime API:
	// re-capturing at runtime would erase the restart signal.
	__bootProvenanceTestHooks,
	type BootProvenance,
	type CommitRead,
	captureBootProvenance,
	getBootProvenance,
	isRestartPending,
} from "./boot-provenance";
export {
	assertBunRuntimeFloor,
	type BunRuntimeCheck,
	BunRuntimeFloorError,
	type BunRuntimeVerdict,
	evaluateBunRuntime,
	MIN_BUN_VERSION,
	UNSUPPORTED_RUNTIME_EXIT_CODE,
} from "./bun-runtime-floor";
export {
	type BurnRatio,
	burnRatioTone,
	computeBurnRatio,
	formatBurnRatio,
} from "./burn-ratio";
export {
	ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS,
	computeCapacityRunway,
	computeCapacityRunwayBand,
	estimateWindowExhaustion,
	isLearningEstimate,
	isUnstartedWindow,
	type LifetimeConfidence,
	PACE_DEFICIT_PROBE_MIN,
	PACE_MARGIN_PRECISION,
	PACE_MARGIN_PROBE_MAX,
	probeDeficitOver,
	probeMarginOver,
	RUNWAY_HORIZON_MS,
	type RunwayAccountInput,
	type RunwayAssumedCredits,
	type RunwayBand,
	type RunwayCause,
	type RunwayOutcome,
	type RunwayResetCreditBank,
	type RunwayWindowInput,
	runwayPaceHeadroom,
	UNSTARTED_WINDOW_TOLERANCE_MS,
	type WindowExhaustion,
	type WindowExhaustionInput,
	type WindowExhaustionSource,
	weeklyTimeToFull,
	windowForecast,
} from "./capacity-runway";
export {
	computeCapacityRunwayScenario,
	equalShareRule,
	MAX_SCENARIO_EVENTS,
	type RunwayScenarioAccountInput,
	type RunwayScenarioBasis,
	type RunwayScenarioDemand,
	type RunwayScenarioExhaustion,
	type RunwayScenarioOptions,
	type RunwayScenarioOutcome,
	type RunwayScenarioPresence,
	type RunwayScenarioShare,
	type RunwayScenarioTier,
	type RunwayTierProvenance,
	type ShareCandidate,
	type ShareRule,
} from "./capacity-runway-scenario";
export { supportsChatIngress, unsupportedChatField } from "./chat-capabilities";
// The standing claim-series audit, on the same terms as the quota-drift
// estimator below: pure, DB-free, and reachable from http-api only through this
// root entry.
export * from "./claim-audit";
export {
	BUFFER_SIZES,
	CACHE,
	computeRateLimitBackoffMs,
	getRateLimitResetStabilityMs,
	HTTP_STATUS,
	isPlausibleSpeed,
	isReauthDueSoon,
	MAX_PLAUSIBLE_TOKENS_PER_SECOND,
	NETWORK,
	REFRESH_TOKEN_REAUTH_WARNING_MS,
	TIME_CONSTANTS,
} from "./constants";
export { isDebugEnabled, readEnv } from "./env";
export {
	AppError,
	isInvalidGrantMessage,
	logError,
	ModelNotServedError,
	ModelSubstitutedError,
	OAuthError,
	OAuthRefreshTokenError,
	PAUSE_REASON_NEEDS_REAUTH,
	ProviderError,
	RateLimitError,
	ServiceUnavailableError,
	TokenRefreshError,
	ValidationError,
} from "./errors";
export {
	drainEventLoopSnapshotMaxLagMs,
	EVENT_LOOP_ERROR_THRESHOLD_MS,
	EVENT_LOOP_TICK_INTERVAL_MS,
	EVENT_LOOP_WARN_THRESHOLD_MS,
	EventLoopMonitor,
	type EventLoopMonitorOptions,
	getEventLoopStats,
	startEventLoopMonitor,
	stopEventLoopMonitor,
} from "./event-loop-monitor";
export {
	type ClassPacing,
	classIsUnread,
	computeFiveHourPacing,
	type FiveHourPacing,
} from "./five-hour-pacing";
export {
	detectHarness,
	HARNESS_LABEL_FOR_APPLICATION,
	type HarnessDetection,
	isCodexClient,
	normalizeClientUserAgent,
} from "./harness";
export {
	type IntervalConfig,
	intervalManager,
	registerCleanup,
	registerHeartbeat,
	registerUIRefresh,
} from "./interval-manager";
export * from "./lifecycle";
export {
	canonicalWindowKind,
	usageObservedAtMs,
	WEEKLY_RED_MIN_WINDOW_AGE_MS,
	weeklyLifetimeConfidence,
	weeklyRedEligible,
	windowBurnAnchor,
} from "./lifetime-confidence";
export { isModelAliasId, validateModelAlias } from "./model-alias";
export {
	type BodyMeasurement,
	type ContentBlockMeasurement,
	codexAccountFitsRequest,
	codexAccountFitsRequestUnmargined,
	estimateContextWindowTokens,
	estimateRequestTokens,
	FAMILY_PRIORITY,
	GATE_CHARS_PER_TOKEN,
	GATE_OUTPUT_RESERVE_CAP,
	getAllowedModelsMessage,
	getEndpointUrl,
	getModelFamily,
	IMAGE_TOKEN_ESTIMATE,
	isProtectedFamily,
	isValidClaudeModel,
	KNOWN_PATTERNS,
	MODEL_CONTEXT_WINDOWS,
	type ModelFamily,
	measureBodyForEstimate,
	measureContentBlock,
	PROTECTED_FAMILY,
	parseCustomEndpointData,
	resolveModelContextWindow,
	resolveModelMaxContextWindow,
	SAFETY_MARGIN,
} from "./model-mappings";
export {
	type ModelCachePolicyRoute,
	type ModelMetadataRequest,
	reduceClientModelMetadata,
	reduceModelCachePolicies,
	reduceModelCacheRetentions,
	resolveClientModelMetadata,
	resolveModelCachePolicy,
	resolveModelCacheRetention,
} from "./model-metadata";
export {
	CLAUDE_MODEL_IDS,
	type ClaudeModelId,
	getModelDisplayName,
	getModelShortName,
	isValidModelId,
	LATEST_FABLE_MODEL,
	LATEST_OPUS_MODEL,
	LATEST_SONNET_MODEL,
	MODEL_DISPLAY_NAMES,
	MODEL_SHORT_NAMES,
	stripDatedModelSuffix,
} from "./models";
export {
	type ClassBudget,
	computePacingFromAccounts,
	type PacingSnapshot,
} from "./pacing-scan";
export {
	compareServableClasses,
	type ServableClass,
	servableClassFor,
} from "./pool-classes";
export {
	applyHeaderRewrite,
	buildAnthropicUnifiedRewrite,
	buildCodexWeeklyRewrite,
	type HeaderRewrite,
	type PooledWindowFigure,
	type PoolHeadroomFigures,
} from "./pool-headroom-headers";
// Account-weeks consumed per completed weekly cycle. `@clankermux/core` exposes
// only its root entry, so an unexported module here is unreachable from
// http-api.
export * from "./pool-sizing";
export {
	computeFamilyWeeklyUsage,
	computePoolUsage,
	type ExcludedReason,
	FAMILY_WEEKLY_ELEVATED_THRESHOLD_PCT,
	type FamilyRow,
	type FamilyWeeklyAccountUsage,
	type FamilyWeeklyUsage,
	type LiveScopedFamily,
	listFamilyRows,
	listLiveScopedFamilies,
	listLiveScopedFamiliesByClass,
	mergeScopedFamilies,
	type Outlook,
	type OutlookTone,
	type PoolAccountBar,
	type PoolUsageContribution,
	type PoolUsageExclusion,
	type PoolUsageFallback,
	type PoolUsageLearning,
	type PoolUsageProjection,
	type PoolUsageResult,
	type PoolWindow,
	pickBindingScopedLimit,
	poolClassOutlook,
	type ServableClassPool,
	scopeResultToClass,
	willRunOutCount,
} from "./pool-usage";
export {
	// Test-only handle (reset cached pricing + the pricing-miss registry). NOT a
	// runtime API: there is deliberately no public way to clear recorded gaps.
	__pricingTestHooks,
	estimateCostUSD,
	getModelCacheRates,
	getPricingGapOverflowCount,
	getPricingGaps,
	loadPricingCatalogue,
	type PricingEstimateContext,
	pricingCatalogueStatus,
	setPricingLogger,
	type TokenBreakdown,
} from "./pricing";
export { providerDisplayName } from "./provider-display";
// The quota-drift estimator. `@clankermux/core` exposes only its root entry, so
// an unexported module here is unreachable from http-api.
export * from "./quota-drift";
export * from "./rate-limit-status";
export {
	getAliasReasoningEfforts,
	getModelReasoningEfforts,
	resolveTargetReasoningProfile,
} from "./reasoning-profiles";
export * from "./request-events";
export * from "./routing";
export {
	classifyScopedFamilyEvidence,
	type ScopedFamilyEvidence,
	type ScopedFamilyEvidenceInput,
} from "./scoped-family-evidence";
export {
	FAMILY_WEEKLY_EXHAUSTED_THRESHOLD_PERCENT,
	getExhaustedFamilies,
	getScopedFamilyLimits,
	isFamilyWeeklyExhaustedWithHeadroom,
	type ScopedFamilyLimit,
} from "./scoped-limits";
export {
	type CacheEstimateContext,
	type CacheEstimateRequest,
	type CacheUsageEvidence,
	readCacheUsage,
	SessionCacheEstimate,
	type SessionCacheEstimateState,
} from "./session-cache-estimate";
export * from "./strategy";
export {
	isCodexSubscriptionLapse,
	isDevinSubscriptionLapse,
	PAUSE_REASON_SUBSCRIPTION_EXPIRED,
} from "./subscription-expiry";
export {
	computeExpectedPct,
	computeThrottleResumeAt,
	computeWindowStartMs,
	FIXED_WINDOW_DURATION_MS,
	type SupportedWindow,
} from "./throttle-utils";
export {
	type AccountTier,
	TIER_CAPACITY_TABLE,
	type TierCapacityEntry,
	tierCapacityUnits,
} from "./tier-capacity";
export { formatPlanTierLabel } from "./tier-label";
export * from "./tool-error-evidence";
export { TtlCache } from "./ttl-cache";
export {
	type AccountWideClaimHeadroom,
	type ExtractedClaimReading,
	type ExtractedSummaryReading,
	extractUnifiedClaimReadings,
	extractUnifiedSummaryReading,
	getAccountWideClaimHeadroom,
	getScopedClaimRejection,
	hasAccountWideUnifiedRejection,
	isScopedOnlyUnifiedRejection,
	parseStrictDecimal,
	type ScopedClaimRejection,
	type UnifiedClaimReading,
} from "./unified-claim-headers";
export {
	consumeUpstreamReportedNoUsage,
	markUpstreamReportedNoUsage,
	resetUpstreamUsagePresence,
} from "./upstream-usage-presence";
export {
	collectObservedWindows,
	getRepresentativeUtilization as getNormalizedRepresentativeUtilization,
	isAnthropicUsageShape,
	type NormalizedAnthropicUsage,
	type NormalizedUsageWindow,
	normalizeAnthropicUsage,
	type ObservedWindow,
} from "./usage-normalizer";
export {
	computeUsagePrediction,
	isFitBoundary,
	isResetBoundary,
	isRevisionDrop,
	REVISION_MIN_DROP_PCT,
	splitSeries,
} from "./usage-prediction";
export {
	DAILY_ELIGIBLE_PROVIDERS,
	type ExtractedValue,
	extractDaily,
	extractFiveHour,
	extractSevenDay,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	isAlibabaShape,
	isAnthropicStyleShape,
	isDevinShape,
	isZaiShape,
	normalizeResetMs,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
	USAGE_HISTORY_PROVIDERS,
} from "./usage-window-extract";
export { levenshteinDistance } from "./utils";
export {
	baseUrlShapeProblem,
	patterns,
	sanitizers,
	validateApiKey,
	validateEndpointUrl,
	validateNumber,
	validatePriority,
	validateString,
} from "./validation";
export {
	CLAUDE_CLI_VERSION,
	extractClaudeVersion,
	getAppVersionSync,
	getClientVersion,
	getVersion,
	trackClientVersion,
} from "./version";
export {
	type AccountWideExhaustionBinding,
	type AccountWideExhaustionVerdict,
	type AccountWideWindow,
	accountWideExhaustion,
	accountWideExhaustionFor,
	flatOauthAppsWindow,
	type WeeklyWindow,
	weeklyExhaustion,
	zaiAccountWideExhaustion,
} from "./weekly-exhaustion";
export {
	computeWeeklyWorkloads,
	type WeeklyWorkload,
	weeklyOnlySource,
} from "./weekly-workloads";
export {
	classifyWorkloadGuidance,
	type WorkloadGuidanceState,
} from "./workload-guidance";
export {
	computeWorkloadHeadroom,
	type HeadroomAbsence,
	type HeadroomBasis,
	type NextResetHeadroomAbsence,
	type ProjectionBasis,
	type WorkloadDimensionKind,
	type WorkloadHeadroomRow,
} from "./workload-headroom";
