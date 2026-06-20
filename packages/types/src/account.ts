import { microsToUsd } from "./payment";

export type RateLimitReason =
	| "upstream_429_with_reset"
	/** @deprecated written by ccflare ≤ v3.5.x when no-reset 429s used a 5h ban.
	 *  v3.5.2+ emits `upstream_429_no_reset_probe_cooldown` for the same path
	 *  with a configurable shorter default. Existing DB rows keep the old
	 *  value for history. */
	| "upstream_429_no_reset_default_5h"
	| "upstream_429_no_reset_probe_cooldown"
	| "model_fallback_429"
	| "all_models_exhausted_429"
	/** Anthropic 529 overloaded_error with a Retry-After reset time. */
	| "upstream_529_overloaded_with_reset"
	/** Anthropic 529 overloaded_error with no Retry-After header; probe cooldown applied. */
	| "upstream_529_overloaded_no_reset";

// Usage data types for Anthropic accounts
export interface UsageWindowData {
	utilization: number | null;
	resets_at: string | null;
}

export interface AnthropicUsageData {
	five_hour?: UsageWindowData;
	seven_day?: UsageWindowData;
	seven_day_oauth_apps?: UsageWindowData;
	seven_day_opus?: UsageWindowData;
	seven_day_sonnet?: UsageWindowData;
}

// Usage data types for Zai accounts
export interface ZaiUsageWindow {
	used: number;
	remaining: number;
	percentage: number; // 0-100 from API
	resetAt: number | null; // Unix timestamp in milliseconds
	type: string;
}

export interface ZaiUsageData {
	time_limit: ZaiUsageWindow | null;
	tokens_limit: ZaiUsageWindow | null;
}

// Usage data types for Kilo accounts
export interface KiloUsageData {
	remainingUsd: number; // Remaining credits in USD
	microdollarsUsed: number;
	totalMicrodollarsAcquired: number;
	utilizationPercent: number; // 0-100
}

// Usage data types for Alibaba Coding Plan accounts
export interface AlibabaCodingPlanQuotaWindow {
	used: number;
	total: number;
	percentUsed: number; // 0-100
	resetAt: number | null; // Unix timestamp in milliseconds
}

export interface AlibabaCodingPlanUsageData {
	five_hour: AlibabaCodingPlanQuotaWindow;
	weekly: AlibabaCodingPlanQuotaWindow;
	monthly: AlibabaCodingPlanQuotaWindow;
	planName: string | null;
	status: string | null;
	remainingDays: number | null;
}

// Combined usage data type that supports all providers
export type FullUsageData =
	| AnthropicUsageData
	| ZaiUsageData
	| KiloUsageData
	| AlibabaCodingPlanUsageData;

// Database row types that match the actual database schema
export interface AccountRow {
	id: string;
	name: string;
	provider: string | null;
	api_key: string | null;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	created_at: number;
	last_used: number | null;
	request_count: number;
	total_requests: number;
	rate_limited_until?: number | null;
	rate_limited_reason?: RateLimitReason | null;
	rate_limited_at?: number | null;
	consecutive_rate_limits?: number | null;
	session_start?: number | null;
	session_request_count?: number;
	paused?: boolean | number | null;
	rate_limit_reset?: number | null;
	rate_limit_status?: string | null;
	rate_limit_remaining?: number | null;
	priority?: number;
	auto_fallback_enabled?: boolean | number | null;
	auto_refresh_enabled?: boolean | number | null;
	auto_pause_on_overage_enabled?: boolean | number | null;
	peak_hours_pause_enabled?: boolean | number | null;
	custom_endpoint?: string | null;
	model_mappings?: string | null; // JSON string for OpenAI-compatible providers
	model_fallbacks?: string | null; // JSON string for model family fallback mappings
	billing_type?: string | null; // Per-account billing override
	pause_reason?: string | null; // null=not paused, 'manual'=user paused, 'failure_threshold'=auto-refresh failures, 'overage'=billing overage, 'oauth_invalid_grant'=OAuth refresh token rejected (needs reauth)
	notes?: string | null; // Free-text per-account operator notes
	refresh_token_issued_at?: number | null; // Timestamp when the current refresh token was issued (updated on each token refresh)
	renewal_anchor?: string | null; // Original subscription renewal anchor date (YYYY-MM-DD); null=renewal tracking off
	renewal_cadence?: string | null; // 'monthly' | 'yearly' | 'none'; null when no anchor
	renewal_price_usd_micros?: number | null; // Subscription price in USD micros (1 USD = 1_000_000); null=no price configured
	renewal_auto_start_date?: string | null; // Lower bound (YYYY-MM-DD) for auto-recorded payments; due dates before it are never backfilled
}

// Domain model - used throughout the application
export interface Account {
	id: string;
	name: string;
	provider: string;
	api_key: string | null;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	request_count: number;
	total_requests: number;
	last_used: number | null;
	created_at: number;
	rate_limited_until: number | null;
	rate_limited_reason: RateLimitReason | null;
	rate_limited_at: number | null;
	consecutive_rate_limits: number;
	session_start: number | null;
	session_request_count: number;
	paused: boolean;
	rate_limit_reset: number | null;
	rate_limit_status: string | null;
	rate_limit_remaining: number | null;
	priority: number;
	auto_fallback_enabled: boolean;
	auto_refresh_enabled: boolean;
	auto_pause_on_overage_enabled: boolean;
	peak_hours_pause_enabled: boolean;
	custom_endpoint: string | null;
	model_mappings: string | null; // JSON string for OpenAI-compatible providers
	model_fallbacks: string | null; // JSON string for model family fallback mappings
	billing_type: string | null;
	pause_reason: string | null; // null=not paused, 'manual'=user paused, 'failure_threshold'=auto-refresh failures, 'overage'=billing overage, 'oauth_invalid_grant'=OAuth refresh token rejected (needs reauth)
	notes: string | null; // Free-text per-account operator notes
	refresh_token_issued_at: number | null; // Timestamp when the current refresh token was issued (updated on each token refresh)
	renewal_anchor: string | null; // Original subscription renewal anchor date (YYYY-MM-DD); null=renewal tracking off
	renewal_cadence: string | null; // 'monthly' | 'yearly' | 'none'; null when no anchor
	renewal_price_usd_micros: number | null; // Subscription price in USD micros (1 USD = 1_000_000); null=no price configured
	renewal_auto_start_date: string | null; // Lower bound (YYYY-MM-DD) for auto-recorded payments; due dates before it are never backfilled
}

// Session statistics for 5-hour token window
export interface SessionStats {
	requests: number;
	inputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	outputTokens: number;
	planCostUsd: number;
	apiCostUsd: number;
}

/**
 * Last-known weekly usage recovered from the persisted `usage_snapshots`
 * time-series, served when the live usage cache has nothing for an account
 * (e.g. usage polling fails because the subscription lapsed). Only the weekly
 * window is carried: a stale 5-hour reading is meaningless minutes after
 * polling stops, while the weekly utilization/reset stays relevant for days.
 */
export interface StaleUsageInfo {
	sevenDayUtilization: number;
	sevenDayResetIso: string;
	/** When the snapshot was sampled — the "as of" timestamp shown in the UI. */
	asOfIso: string;
}

// API response type - what clients receive
export interface AccountResponse {
	id: string;
	name: string;
	provider: string;
	requestCount: number;
	totalRequests: number;
	lastUsed: string | null;
	created: string;
	paused: boolean;
	/** Why the account is paused (e.g. "manual", "overage", "failure_threshold", "subscription_expired", "oauth_invalid_grant"); null when not paused or unknown. */
	pauseReason?: string | null;
	tokenStatus: "valid" | "expired";
	tokenExpiresAt: string | null; // ISO timestamp of token expiration
	rateLimitStatus: string;
	rateLimitReset: string | null;
	rateLimitRemaining: number | null;
	rateLimitedUntil: number | null;
	rateLimitedReason: RateLimitReason | null;
	rateLimitedAt: number | null;
	sessionInfo: string;
	priority: number;
	autoFallbackEnabled: boolean;
	autoRefreshEnabled: boolean;
	autoPauseOnOverageEnabled?: boolean;
	peakHoursPauseEnabled?: boolean;
	customEndpoint: string | null;
	modelMappings: { [key: string]: string | string[] } | null; // Parsed model mappings (arrays = cycling models)
	usageUtilization: number | null; // Percentage utilization (0-100) from API
	usageWindow: string | null; // Most restrictive window (e.g., "five_hour")
	usageData: FullUsageData | null; // Full usage data for Anthropic accounts
	staleUsage?: StaleUsageInfo | null; // Last-known weekly usage when live data is unavailable
	usageRateLimitedUntil: number | null; // Timestamp (ms) until usage API 429 clears; null if not rate-limited
	usageThrottledUntil: number | null; // Timestamp (ms) until proactive usage throttling clears; null if not throttled
	usageThrottledWindows: string[]; // Exact usage windows currently being throttled
	providerOverloadKey?: string | null; // Shared upstream overload group, e.g. "anthropic-upstream"
	providerOverloadedUntil?: number | null; // In-memory provider overload cooldown; null if provider is routable
	hasRefreshToken: boolean; // Indicates if the account has a refresh token (OAuth account)
	modelFallbacks?: { [key: string]: string } | null;
	billingType?: string | null;
	notes: string | null; // Free-text per-account operator notes
	renewalAnchor?: string | null;
	renewalCadence?: "monthly" | "yearly" | "none" | null;
	renewalPriceUsd?: number | null; // Subscription price in USD (API boundary speaks USD floats)
	sessionStats: SessionStats | null;
	isPrimary: boolean; // True if this is the account the load balancer would pick next
}

// UI display type - used in CLI and web dashboard
export interface AccountDisplay {
	id: string;
	name: string;
	provider: string;
	created: Date;
	lastUsed: Date | null;
	requestCount: number;
	totalRequests: number;
	tokenStatus: "valid" | "expired";
	rateLimitStatus: string;
	sessionInfo: string;
	paused: boolean;
	rate_limited_until?: number | null;
	rate_limited_reason?: RateLimitReason | null;
	rate_limited_at?: number | null;
	session_start?: number | null;
	session_request_count?: number;
	access_token?: string | null;
	priority: number;
	autoFallbackEnabled: boolean;
	autoRefreshEnabled: boolean;
}

// CLI list item type
export interface AccountListItem {
	id: string;
	name: string;
	provider: string;
	created: Date;
	lastUsed: Date | null;
	requestCount: number;
	totalRequests: number;
	paused: boolean;
	tokenStatus: "valid" | "expired";
	rateLimitStatus: string;
	sessionInfo: string;
	rate_limited_reason?: RateLimitReason | null;
	rate_limited_at?: number | null;
	mode:
		| "claude-oauth"
		| "console"
		| "zai"
		| "minimax"
		| "anthropic-compatible"
		| "openai-compatible"
		| "kilo"
		| "openrouter"
		| "alibaba-coding-plan"
		| "codex"
		| "qwen"
		| "ollama"
		| "ollama-cloud";
	priority: number;
	autoFallbackEnabled: boolean;
	autoRefreshEnabled: boolean;
	customEndpoint?: string | null;
}

// Account creation types
export interface AddAccountOptions {
	name: string;
	mode?:
		| "claude-oauth"
		| "console"
		| "zai"
		| "minimax"
		| "anthropic-compatible"
		| "openai-compatible"
		| "openrouter";
	priority?: number;
	customEndpoint?: string;
}

export interface AccountDeleteRequest {
	confirm: string;
}

// Helper coercions for database rows (normalizes SQLite integer/text values)
function toNum(v: unknown): number {
	return Number(v) || 0;
}
function toNumOrNull(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) && n !== 0 ? n : v != null && v !== 0 ? n : null;
}

// Type mappers
export function toAccount(row: AccountRow): Account {
	return {
		id: row.id,
		name: row.name,
		provider: row.provider || "anthropic",
		api_key: row.api_key,
		refresh_token: row.refresh_token,
		access_token: row.access_token,
		expires_at: toNumOrNull(row.expires_at),
		created_at: toNum(row.created_at),
		last_used: toNumOrNull(row.last_used),
		request_count: toNum(row.request_count),
		total_requests: toNum(row.total_requests),
		rate_limited_until: toNumOrNull(row.rate_limited_until),
		rate_limited_reason: row.rate_limited_reason ?? null,
		rate_limited_at: toNumOrNull(row.rate_limited_at),
		consecutive_rate_limits: toNum(row.consecutive_rate_limits),
		session_start: toNumOrNull(row.session_start),
		session_request_count: toNum(row.session_request_count),
		paused: !!row.paused,
		rate_limit_reset: toNumOrNull(row.rate_limit_reset),
		rate_limit_status: row.rate_limit_status || null,
		rate_limit_remaining: toNumOrNull(row.rate_limit_remaining),
		priority: toNum(row.priority),
		auto_fallback_enabled: !!row.auto_fallback_enabled,
		auto_refresh_enabled: !!row.auto_refresh_enabled,
		auto_pause_on_overage_enabled: !!row.auto_pause_on_overage_enabled,
		peak_hours_pause_enabled: !!row.peak_hours_pause_enabled,
		custom_endpoint: row.custom_endpoint || null,
		model_mappings: row.model_mappings || null,
		model_fallbacks: row.model_fallbacks || null,
		billing_type: row.billing_type || null,
		pause_reason: row.pause_reason || null,
		notes: row.notes || null,
		refresh_token_issued_at: toNumOrNull(row.refresh_token_issued_at),
		renewal_anchor: row.renewal_anchor || null,
		renewal_cadence: row.renewal_cadence || null,
		renewal_price_usd_micros: toNumOrNull(row.renewal_price_usd_micros),
		renewal_auto_start_date: row.renewal_auto_start_date || null,
	};
}

export function toAccountResponse(account: Account): AccountResponse {
	const tokenStatus = account.access_token ? "valid" : "expired";
	const isRateLimited =
		account.rate_limited_until && account.rate_limited_until > Date.now();
	const rateLimitStatus =
		isRateLimited && account.rate_limited_until
			? `Rate limited until ${new Date(account.rate_limited_until).toLocaleString()}`
			: "OK";

	const sessionInfo = account.session_start
		? `Session: ${account.session_request_count} requests`
		: "No active session";

	// Parse model mappings (supported for any provider)
	let modelMappings: { [key: string]: string } | null = null;
	if (account.model_mappings) {
		try {
			const parsed = JSON.parse(account.model_mappings);
			// Stored as flat {"model": "target"} object
			modelMappings =
				typeof parsed === "object" && parsed !== null ? parsed : null;
		} catch {
			// If parsing fails, ignore model mappings
			modelMappings = null;
		}
	} else if (account.custom_endpoint) {
		// Also try parsing from custom_endpoint for backwards compatibility
		try {
			const parsed = JSON.parse(account.custom_endpoint);
			if (parsed.modelMappings) {
				modelMappings = parsed.modelMappings;
			}
		} catch {
			// If parsing fails, ignore model mappings
			modelMappings = null;
		}
	}

	// Parse model fallbacks for all providers
	let modelFallbacks: { [key: string]: string } | null = null;
	if (account.model_fallbacks) {
		try {
			modelFallbacks = JSON.parse(account.model_fallbacks);
		} catch {
			modelFallbacks = null;
		}
	}

	return {
		id: account.id,
		name: account.name,
		provider: account.provider,
		requestCount: account.request_count,
		totalRequests: account.total_requests,
		lastUsed: account.last_used
			? new Date(account.last_used).toISOString()
			: null,
		created: new Date(account.created_at).toISOString(),
		paused: account.paused,
		tokenStatus,
		tokenExpiresAt: account.expires_at
			? new Date(account.expires_at).toISOString()
			: null,
		rateLimitStatus,
		rateLimitReset: account.rate_limit_reset
			? new Date(account.rate_limit_reset).toISOString()
			: null,
		rateLimitRemaining: account.rate_limit_remaining,
		rateLimitedUntil: account.rate_limited_until || null,
		rateLimitedReason: account.rate_limited_reason ?? null,
		rateLimitedAt: account.rate_limited_at ?? null,
		sessionInfo,
		priority: account.priority,
		autoFallbackEnabled: account.auto_fallback_enabled,
		autoRefreshEnabled: account.auto_refresh_enabled,
		autoPauseOnOverageEnabled: account.auto_pause_on_overage_enabled,
		peakHoursPauseEnabled: account.peak_hours_pause_enabled,
		customEndpoint: account.custom_endpoint,
		modelMappings,
		usageUtilization: null, // Will be filled in by API handler from cache
		usageWindow: null, // Will be filled in by API handler from cache
		usageData: null, // Will be filled in by API handler from cache
		usageRateLimitedUntil: null, // Will be filled in by API handler from cache
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		providerOverloadKey: null,
		providerOverloadedUntil: null,
		hasRefreshToken: !!account.refresh_token, // OAuth accounts have refresh tokens
		modelFallbacks,
		billingType: account.billing_type,
		notes: account.notes,
		renewalAnchor: account.renewal_anchor,
		renewalCadence:
			(account.renewal_cadence as "monthly" | "yearly" | "none" | null) ?? null,
		renewalPriceUsd:
			account.renewal_price_usd_micros != null
				? microsToUsd(account.renewal_price_usd_micros)
				: null,
		sessionStats: null,
		isPrimary: false,
	};
}

export function toAccountDisplay(account: Account): AccountDisplay {
	const tokenStatus = account.access_token ? "valid" : "expired";
	const isRateLimited =
		account.rate_limited_until && account.rate_limited_until > Date.now();
	const rateLimitStatus =
		isRateLimited && account.rate_limited_until
			? `Rate limited until ${new Date(account.rate_limited_until).toLocaleString()}`
			: "OK";

	const sessionInfo = account.session_start
		? `Session: ${account.session_request_count} requests`
		: "No active session";

	return {
		id: account.id,
		name: account.name,
		provider: account.provider,
		created: new Date(account.created_at),
		lastUsed: account.last_used ? new Date(account.last_used) : null,
		requestCount: account.request_count,
		totalRequests: account.total_requests,
		tokenStatus,
		rateLimitStatus,
		sessionInfo,
		paused: account.paused,
		rate_limited_until: account.rate_limited_until,
		session_start: account.session_start,
		session_request_count: account.session_request_count,
		access_token: account.access_token,
		priority: account.priority,
		autoFallbackEnabled: account.auto_fallback_enabled,
		autoRefreshEnabled: account.auto_refresh_enabled,
	};
}
