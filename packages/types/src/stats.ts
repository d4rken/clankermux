import type { RateLimitReason } from "./account";

/** Whether a given integrity probe is a fast page-structure check or the
 *  slower full check (page structure + index/table cross-checks + foreign
 *  keys). The full check needs to run in a worker on large DBs. */
export type IntegrityCheckKind = "quick" | "full";

/**
 * Cached integrity status. The `status` collapses both probes into a single
 * surface, but each probe's own most-recent result is preserved so a quick
 * `ok` cannot mask a previously-detected full `corrupt`.
 *
 * Status semantics:
 *  - `unchecked`: no probe has completed yet (fresh boot, scheduler still in
 *    its initial-delay window).
 *  - `running`: a probe is currently in flight; `runningKind` says which.
 *  - `ok`: both the last-known quick and full results are "ok" (or only one
 *    has been run and it was "ok").
 *  - `corrupt`: at least one of the last-known probes returned non-"ok".
 *    A subsequent quick `ok` clears quick-only corruption but does NOT clear
 *    a full `corrupt`; only another full `ok` does that.
 */
export interface IntegrityStatus {
	status: "ok" | "corrupt" | "unchecked" | "running";
	/** Which kind of probe is in flight when status="running"; null otherwise. */
	runningKind: IntegrityCheckKind | null;
	/** Last completed probe of either kind, ms epoch. */
	lastCheckAt: number | null;
	/** Combined error message if status is "corrupt"; null when "ok". */
	lastError: string | null;
	/** Most recent quick_check result. */
	lastQuickCheckAt: number | null;
	lastQuickResult: "ok" | "corrupt" | null;
	lastQuickError: string | null;
	/** Most recent full integrity_check + foreign_key_check result. */
	lastFullCheckAt: number | null;
	lastFullResult: "ok" | "corrupt" | null;
	lastFullError: string | null;
}

// Stats types
export interface Stats {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	avgTokensPerSecond: number | null;
}

export interface StatsResponse {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	avgTokensPerSecond: number | null;
}

export interface RecentErrorGroup {
	errorCode: string; // raw value from requests.error_message
	accountId: string | null; // null when unauthenticated
	accountName: string | null; // null when account deleted
	provider: string | null; // owning account's provider, null when account deleted
	occurrenceCount: number;
	latestTimestamp: number; // ms epoch
	firstTimestamp: number; // ms epoch
	latestRequestId: string;
	model: string | null;
	statusCode: number | null;
	path: string | null;
	failoverAttempts: number;
	rateLimitedUntil: number | null; // from accounts table, ms epoch
	rateLimitedReason: RateLimitReason | null;
	rateLimitedAt: number | null;
}

export interface StatsWithErrors extends Stats {
	recentErrors: RecentErrorGroup[];
}

// Analytics types
export interface TimePoint {
	ts: number; // period start (ms)
	model?: string; // Optional model name for per-model time series
	requests: number;
	tokens: number;
	costUsd: number;
	planCostUsd: number;
	apiCostUsd: number;
	successRate: number; // 0-100
	errorRate: number; // 0-100
	cacheHitRate: number; // 0-100
	avgResponseTime: number; // ms
	avgTokensPerSecond: number | null;
}

export interface TokenBreakdown {
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
}

export interface ModelPerformance {
	model: string;
	avgResponseTime: number;
	p95ResponseTime: number;
	errorRate: number;
	// Output-speed stats are percentile-based and artifact-filtered (see
	// MAX_PLAUSIBLE_TOKENS_PER_SECOND). Median (p50) is the headline "typical"
	// speed — robust to the few legitimately-fast requests that pull a mean
	// around; p95 is the honest fast end (replaces the old raw MAX, which
	// surfaced measurement artifacts directly). Null when a model has no
	// requests with a usable speed sample in range.
	medianTokensPerSecond: number | null;
	p95TokensPerSecond: number | null;
	// Number of in-range requests with a plausible recorded speed that feed the
	// percentiles above (a p50/p95 over 1-2 samples is noise — the UI can warn).
	speedSampleCount: number;
}

/**
 * One per-model point in the output-speed-over-time series. Median (p50) tok/s
 * per time bucket, artifact-filtered. Separate from {@link TimePoint} because
 * it is always per-model and percentile-based, independent of the main chart's
 * model-breakdown toggle.
 */
export interface SpeedTimePoint {
	ts: number; // bucket start (ms)
	model: string;
	medianTps: number; // p50 tokens/sec in this bucket for this model
}

export interface RoutingFlowPoint {
	strategy: string;
	decision: string;
	accountId: string;
	accountName: string;
	outcome: "success" | "rate_limited" | "error";
	requests: number;
	successRate: number;
	failoverAttempts: number;
}

export interface RoutingTimelinePoint {
	ts: number;
	accountId: string;
	accountName: string;
	decision: string;
	requests: number;
	successRate: number;
}

export interface RoutingDecisionBreakdown {
	strategy: string;
	decision: string;
	requests: number;
	percentage: number;
	successRate: number;
	failoverAttempts: number;
}

export interface RoutingAccountSplit {
	accountId: string;
	accountName: string;
	requests: number;
	percentage: number;
	successRate: number;
	failoverAttempts: number;
	topDecision: string | null;
}

export interface RoutingAnalytics {
	totalRequests: number;
	flow: RoutingFlowPoint[];
	timeline: RoutingTimelinePoint[];
	decisionBreakdown: RoutingDecisionBreakdown[];
	accountSplit: RoutingAccountSplit[];
}

/** Token sums for one (model, account) pair, used by the Cache Flow graph.
 *  The three buckets are disjoint: `uncachedTokens` is raw input_tokens,
 *  which Anthropic reports separately from the two cache buckets. */
export interface CacheFlowPoint {
	model: string;
	accountName: string;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	uncachedTokens: number;
}

export interface AnalyticsResponse {
	meta?: {
		range: string;
		bucket: string;
		cumulative?: boolean;
	};
	totals: {
		requests: number;
		successRate: number;
		cacheHitRate: number;
		activeAccounts: number;
		avgResponseTime: number;
		totalTokens: number;
		totalCostUsd: number;
		planCostUsd: number;
		apiCostUsd: number;
		avgTokensPerSecond: number | null;
		// Median (p50) and p95 output speed across all in-range requests,
		// artifact-filtered. Drive the "Typical Output Speed" / "Peak Output
		// Speed" tiles. Optional because an older server may not populate them —
		// consumers should treat absence as null.
		medianTokensPerSecond?: number | null;
		p95TokensPerSecond?: number | null;
		// Fixed-window burn-rate KPIs, independent of the active range/filters.
		// Daily: sum(last 7d) / effectiveDays(≤7). Weekly: sum(last 30d) × 7 / effectiveDays(≤30).
		// effectiveDays is clamped to the actual age of data so thin history doesn't inflate the average.
		// Optional because an older server may not populate them — consumers should `?? 0`.
		avgDailyPlanCostUsd?: number;
		avgWeeklyPlanCostUsd?: number;
		avgDailyApiCostUsd?: number;
		avgWeeklyApiCostUsd?: number;
	};
	timeSeries: TimePoint[];
	tokenBreakdown: TokenBreakdown;
	modelDistribution: Array<{ model: string; count: number }>;
	accountPerformance: Array<{
		name: string;
		requests: number;
		successRate: number;
		planCostUsd: number;
		apiCostUsd: number;
		totalCostUsd: number;
	}>;
	apiKeyPerformance: Array<{
		id: string;
		name: string;
		requests: number;
		successRate: number;
	}>;
	costByModel: Array<{
		model: string;
		costUsd: number;
		requests: number;
		totalTokens?: number;
	}>;
	accountModelUsage: Array<{ account: string; model: string; count: number }>;
	modelPerformance: ModelPerformance[];
	// Per-model median output-speed time series (artifact-filtered). Optional
	// because an older server may not populate it; consumers should `?? []`.
	speedTimeSeries?: SpeedTimePoint[];
	routing: RoutingAnalytics;
	// Cache token flow grouped by (model, account). Optional because an older
	// server may not populate it — consumers should `?? []`.
	cacheFlow?: CacheFlowPoint[];
	// Per-project aggregates, ordered by total tokens. `project: null` is the
	// bucket for requests with no recorded project (distinct from any literal
	// project name). Optional because an older server may not populate it —
	// consumers should `?? []`.
	projectBreakdown?: Array<{
		project: string | null;
		requests: number;
		successRate: number;
		planCostUsd: number;
		apiCostUsd: number;
		totalCostUsd: number;
		totalTokens: number;
	}>;
	// Context composition analytics. Char sums are recorded at ingest on
	// "covered" rows (context columns non-NULL); coverage reports how much of
	// the range is covered so partial history is labeled honestly. Token
	// figures are REAL tokens (input + cache read + cache creation); the
	// covered-only denominator in `totals` exists because the global
	// tokenBreakdown spans all rows and would skew estimates under partial
	// coverage. Optional because an older server may not populate it —
	// consumers should treat absence as undefined.
	contextComposition?: {
		coverage: { withComposition: number; totalRequests: number };
		totals: {
			systemChars: number;
			toolsChars: number;
			messagesChars: number;
			toolResultChars: number;
			contextTokens: number;
			avgContextTokens: number;
		};
		avgPerRequest: {
			systemChars: number;
			toolsChars: number;
			messagesChars: number;
			messageCount: number;
		};
		byProject: Array<{
			project: string | null;
			requests: number;
			avgContextTokens: number;
			avgSystemChars: number;
			avgToolsChars: number;
			avgMessagesChars: number;
		}>;
		// Context size over time per project (top projects by request count in
		// range), over ALL rows — works for history without composition columns.
		growthCurve: Array<{
			ts: number;
			project: string | null;
			avgContextTokens: number;
			maxContextTokens: number;
			requests: number;
		}>;
		topToolContributors: Array<{
			requestId: string;
			ts: number;
			project: string | null;
			model: string | null;
			toolName: string | null;
			chars: number;
		}>;
	};
}

// Usage-history (Limits-tab sawtooth chart) types.
//
// Per-account utilization series + a pool aggregate, sampled at a regular
// cadence and read back bucketed (last-value-per-bucket) over a range. Built
// from RankedSnapshot rows (see usage-snapshot.ts) by the usage-history handler.

/** One bucketed sample of an account's window utilization. */
export interface UsageHistoryPoint {
	ts: number; // bucket start (ms)
	fiveHourPct: number | null;
	sevenDayPct: number | null;
}

/** One account's full utilization series over the requested range. */
export interface UsageHistorySeries {
	accountId: string;
	name: string;
	provider: string;
	points: UsageHistoryPoint[];
}

/**
 * Pool-wide aggregate at a single timestamp, across all sampled accounts.
 * Avg/max ignore nulls; both are null when no account reported a value at `ts`.
 * `sampledCount` is the number of accounts contributing any non-null value —
 * including values carried forward from an account's last sample until its
 * window reset (so a paused/maxed account keeps counting until it would roll),
 * not only accounts freshly sampled in this exact bucket.
 */
export interface UsageHistoryPoolPoint {
	ts: number;
	fiveHourAvg: number | null;
	sevenDayAvg: number | null;
	fiveHourMax: number | null;
	sevenDayMax: number | null;
	sampledCount: number;
}

export interface UsageHistoryResponse {
	range: string;
	bucketMs: number;
	series: UsageHistorySeries[];
	pool: UsageHistoryPoolPoint[];
}

// Pool status for health check
export interface PoolStatus {
	configured: number; // Total accounts in database
	routable: number; // Available for routing
	paused: number; // Manually or automatically paused
	rate_limited: number; // Temporarily rate-limited
	next_available_at: string | null; // ISO timestamp when earliest rate-limit expires
}

// Account detail for ?detail=1
export interface AccountDetail {
	name: string;
	status: "available" | "paused" | "rate_limited";
	rate_limited_until: number | null;
	rate_limited_reason: RateLimitReason | null;
	rate_limited_at: number | null;
}

// Health check response
export interface HealthResponse {
	status: string;
	accounts: number;
	timestamp: string;
	strategy: string;
	pool?: PoolStatus;
	accounts_detail?: Array<AccountDetail>;
	runtime?: {
		asyncWriter?: {
			healthy: boolean;
			failureCount: number;
			queuedJobs: number;
		};
		storage?: {
			integrity: {
				status: "ok" | "corrupt" | "unchecked" | "running";
				runningKind: IntegrityCheckKind | null;
				lastCheckAt: string | null;
				lastError: string | null;
				lastQuickCheckAt: string | null;
				lastQuickResult: "ok" | "corrupt" | null;
				lastFullCheckAt: string | null;
				lastFullResult: "ok" | "corrupt" | null;
			};
		};
	};
}

// Config types
export interface ConfigResponse {
	lb_strategy: string;
	port: number;
	sessionDurationMs: number;
	tls_enabled: boolean;
	system_prompt_cache_ttl_1h: boolean;
	usage_throttling_five_hour_enabled: boolean;
	usage_throttling_weekly_enabled: boolean;
}

export interface StrategyUpdateRequest {
	strategy: string;
}
