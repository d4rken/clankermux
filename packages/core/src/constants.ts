/**
 * Centralized constants for the ClankerMux application
 * All magic numbers should be defined here to improve maintainability
 */

// Time constants (all in milliseconds)
export const TIME_CONSTANTS = {
	// Base units
	SECOND: 1000,
	MINUTE: 60 * 1000,
	HOUR: 60 * 60 * 1000,
	DAY: 24 * 60 * 60 * 1000,

	// Session durations - specifically for Anthropic usage windows
	ANTHROPIC_SESSION_DURATION_DEFAULT: 5 * 60 * 60 * 1000, // 5 hours - default for Anthropic provider session tracking
	ANTHROPIC_SESSION_DURATION_FALLBACK: 1 * 60 * 60 * 1000, // 1 hour - fallback for Anthropic provider
	/**
	 * @deprecated Use ANTHROPIC_SESSION_DURATION_DEFAULT instead.
	 * This constant is kept for backward compatibility only and should not be used in new code.
	 */
	SESSION_DURATION_DEFAULT: 5 * 60 * 60 * 1000, // 5 hours - kept for backward compatibility - new code should use ANTHROPIC_SESSION_DURATION_DEFAULT

	// "Active Sessions" live gauge (Overview) + Analytics time-series: trailing
	// lookback window for counting a distinct request_routing.affinity_key_hash
	// (a client session pinned for account affinity) as "currently active". A
	// session counts as active if its most recent routed request landed within
	// this window. Fixed definition of "recent activity", not an operator knob —
	// a single named constant, no env override (see feedback_no_env_feature_gates).
	// Deliberately far shorter than the 5h account-pin lifetime above: a pin
	// survives long idle gaps so the session snaps back to its account, but
	// "active right now" should reflect genuine recent traffic.
	ACTIVE_SESSION_WINDOW_MS: 15 * 60 * 1000, // 15 minutes

	// Timeouts
	STREAM_TIMEOUT_DEFAULT: 1000 * 60 * 1, // 1 minute
	STREAM_READ_TIMEOUT_MS: 60000, // 60 seconds - overall timeout for stream reads
	STREAM_OPERATION_TIMEOUT_MS: 30000, // 30 seconds - timeout per read operation

	// Streaming forwarder timeouts (response-handler.ts).
	// Agentic workloads (e.g. recursive claude-code-sdk sessions) can have long
	// quiet periods between chunks while sub-calls run. These defaults are set
	// conservatively high so nested calls don't trigger a false timeout and cause
	// the outer request to appear failed/missing in the UI (issue #84).
	STREAM_FORWARD_TOTAL_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes (max total stream duration)
	STREAM_FORWARD_CHUNK_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes (max silence between chunks)
	OAUTH_STATE_TTL: 10, // 10 minutes (stored separately as minutes)
	RETRY_DELAY_DEFAULT: 1000, // 1 second
	PROXY_REQUEST_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes — covers long agent calls

	// Cache durations
	CACHE_YEAR: 31536000, // 365 days in seconds for HTTP cache headers

	// Token expiration durations
	API_KEY_TOKEN_EXPIRY_MS: 365 * 24 * 60 * 60 * 1000, // 1 year - for API keys that don't expire
	GOOGLE_TOKEN_EXPIRY_MS: 60 * 60 * 1000, // 1 hour - Google Cloud access tokens

	// Default cooldown applied when an upstream returns 429 *without* a
	// reset hint (no `retry-after`, no rate-limit-reset header, no SSE
	// reset frame, no usage-cache window reset). Treats the cooldown
	// as a probe interval rather than a hard ban: the account is
	// excluded for a short window, then the next request re-probes.
	// Real upstream rate-limit replies ship a retry-after / reset
	// header and use the precise value from the header — those flows
	// are unaffected by this default.
	// Override at runtime via CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS.
	DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS: 60 * 1000, // 60s

	// Adaptive rate-limit cooldown with exponential backoff.
	// On each 429 in a consecutive streak, the cooldown grows: BASE * 2^(n-1),
	// capped at MAX. Counter resets to 0 only after a successful response that
	// follows a quiet period of at least RESET_STABILITY_MS since the last 429.
	RATE_LIMIT_BACKOFF_BASE_MS: 30 * 1000, // 30s: cooldown for the 1st 429 in a streak
	RATE_LIMIT_BACKOFF_MAX_MS: 5 * 60 * 1000, // 5min: ceiling for the exponential ramp
	RATE_LIMIT_RESET_STABILITY_MS: 5 * 60 * 1000, // 5min: healthy operation needed to reset the streak counter

	// Long cooldown applied when an Anthropic account returns 429 with
	// `anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits` — the
	// account's credits/overage are depleted, NOT a transient burst. Such a 429
	// ships no retry-after/reset header and `x-should-retry: true`, so the generic
	// no-reset path pins it at the 60s probe interval and storms the depleted
	// account ~1/min (issue #261). We instead exclude it for a long window (until
	// the usage-window reset if known, else this value) so fallback providers take
	// over. No env override by design.
	OUT_OF_CREDITS_COOLDOWN_MS: 60 * 60 * 1000, // 1 hour
} as const;

/**
 * Compute the cooldown duration (ms) for the n-th consecutive 429 in a streak.
 *
 * Behavior:
 *   - For n in [1..], returns `BASE * 2^(n-1)`, clamped to MAX.
 *   - For n <= 0, behaves as n=1 (returns BASE).
 *   - Caps the exponent at 30 before the bit-shift to prevent overflow at
 *     very large n (e.g. n=100).
 *
 * Sequence: 30s → 60s → 120s → 240s → 300s (capped) → 300s …
 */
export function computeRateLimitBackoffMs(consecutiveCount: number): number {
	const base = TIME_CONSTANTS.RATE_LIMIT_BACKOFF_BASE_MS;
	const max = TIME_CONSTANTS.RATE_LIMIT_BACKOFF_MAX_MS;
	const n = Math.max(1, consecutiveCount);
	// Cap exponent before bit-shift to avoid overflow at large n
	const exp = Math.min(n - 1, 30);
	return Math.min(base * 2 ** exp, max);
}

/**
 * The stability-reset window (ms) for the consecutive_rate_limits counter: the
 * streak counter only resets to 0 after a successful response that follows a
 * quiet period of at least this long since the last 429.
 */
export function getRateLimitResetStabilityMs(): number {
	return TIME_CONSTANTS.RATE_LIMIT_RESET_STABILITY_MS;
}

// Buffer sizes (in bytes unless specified)
export const BUFFER_SIZES = {
	// Stream usage buffer size in KB (multiplied by 1024 to get bytes)
	STREAM_USAGE_BUFFER_KB: 64,
	STREAM_USAGE_BUFFER_BYTES: 64 * 1024,

	// Stream body max size
	STREAM_BODY_MAX_KB: 256,
	STREAM_BODY_MAX_BYTES: 256 * 1024, // 256KB default

	// Anthropic provider stream cap
	ANTHROPIC_STREAM_CAP_BYTES: 32768, // 32KB

	// Stream tee default max bytes
	STREAM_TEE_MAX_BYTES: 1024 * 1024, // 1MB

	// Log file size
	LOG_FILE_MAX_SIZE: 10 * 1024 * 1024, // 10MB

	// Max request body bytes stored per request (response-handler cap + worker cap).
	// 4MB so afterburn can see full conversation history for friction analysis.
	MAX_REQUEST_BODY_BYTES: 4 * 1024 * 1024,
} as const;

// Network constants
export const NETWORK = {
	// Ports
	DEFAULT_PORT: 8080,

	// Timeouts
	// Bun's HARD per-connection idle cap (uint8 seconds). We no longer run AT this
	// ceiling: the global Bun `idleTimeout` is set to SERVER_IDLE_TIMEOUT_SECONDS
	// (below) and long holds / long quiet streaming gaps are kept alive by
	// re-arming the per-connection timer via `server.timeout(req, N)` on the
	// IDLE_REARM_INTERVAL_MS cadence. Each `server.timeout` call must still be
	// ≤ this cap (oven-sh/bun#15589).
	IDLE_TIMEOUT_MAX: 255,
	// Global Bun `idleTimeout` (seconds). Held connections (CW hold, streaming
	// quiet gaps) re-arm this per-connection via `server.timeout(req, N)`.
	SERVER_IDLE_TIMEOUT_SECONDS: 180,
	// Re-arm cadence (ms) — fires ~30s before the 180s timer would expire so a
	// silent gap never reaps a held/streaming connection.
	IDLE_REARM_INTERVAL_MS: 150_000,
} as const;

// Cache control headers
export const CACHE = {
	// HTTP cache control max-age values (in seconds)
	STATIC_ASSETS_MAX_AGE: 31536000, // 1 year
	CACHE_CONTROL_IMMUTABLE: "public, max-age=31536000, immutable",
	CACHE_CONTROL_STATIC: "public, max-age=31536000",
	CACHE_CONTROL_NO_CACHE: "no-cache, no-store, must-revalidate",
} as const;

// Request/Response limits
export const LIMITS = {
	// Request history limits
	REQUEST_HISTORY_DEFAULT: 50,
	REQUEST_DETAILS_DEFAULT: 100,
	REQUEST_HISTORY_MAX: 1000,
	LOG_READ_DEFAULT: 1000,

	// Account name constraints
	ACCOUNT_NAME_MIN_LENGTH: 1,
	ACCOUNT_NAME_MAX_LENGTH: 100,

	// UI formatting
	CONSOLE_SEPARATOR_LENGTH: 100,
	CONSOLE_COLUMN_PADDING: {
		NAME: 20,
		TYPE: 10,
		REQUESTS: 12,
		TOKEN: 10,
		STATUS: 20,
	},
} as const;

/**
 * Sanity ceiling for recorded output speed (tokens/sec). Values at or above
 * this threshold are measurement artifacts, not real inference rates — they
 * come from dividing the output-token count by a sub-millisecond duration
 * (e.g. a cached/single-chunk response whose measured elapsed time rounds to
 * ~0). No real LLM inference path through this proxy sustains tokens faster
 * than this, so anything above it is dropped rather than allowed to skew the
 * analytics averages (a single 137,000 tok/s artifact poisons a whole bucket).
 *
 * Used in TWO places — keep them consistent:
 *   1. usage-collector.ts (`computeTokensPerSecond`) — discards artifacts at
 *      record time, so they never enter the DB going forward.
 *   2. analytics-direct.ts — filters pre-existing artifact rows out of every
 *      speed aggregation (median/p95/avg) at query time.
 *
 * Tunable: raise it if a genuinely faster provider is ever routed through here.
 */
export const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1500;

/** True when `tps` is a physically plausible output speed (0 < tps <= ceiling). */
export function isPlausibleSpeed(tps: number): boolean {
	return tps > 0 && tps <= MAX_PLAUSIBLE_TOKENS_PER_SECOND;
}

// HTTP status codes
export const HTTP_STATUS = {
	OK: 200,
	NOT_FOUND: 404,
	TOO_MANY_REQUESTS: 429,
	INTERNAL_SERVER_ERROR: 500,
	SERVICE_UNAVAILABLE: 503,
} as const;

// Account tiers - removed unused ACCOUNT_TIERS export
// Statistical calculations - removed unused STATS export
