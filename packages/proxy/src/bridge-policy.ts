/**
 * Cost/benefit math and tuning constants for the Session Cache Bridge.
 *
 * A "keepalive" replays a session's cached request prefix to refresh Anthropic's
 * prompt cache before it expires (5-min TTL). Bridging is only worthwhile when
 * the model has a real cache-WRITE premium — i.e. re-creating the cache on
 * resume costs more than reading it warm. Providers whose `cache_write` is 0 or
 * not above `cache_read` (OpenAI/Codex, zai/GLM, …) gain nothing from bridging,
 * so we gate on {@link hasCacheWritePremium}.
 *
 * SPEND-BUDGET model (replaces the old fixed keepalive count):
 *  - A keepalive HIT (cache still warm) costs `cache_read × prefix` (~0.1× input)
 *    and refreshes the TTL — see {@link keepaliveHitCostUsd}.
 *  - A keepalive MISS (cache had expired, `cache_creation>0`) costs
 *    `cache_write × prefix` (~1.25× input) and re-creates the cache —
 *    {@link keepaliveMissCostUsd}.
 *  - The BUDGET is the one-time resume re-cache penalty we'd spend to avoid,
 *    derated by {@link RISK_FACTOR} to hedge sessions that never resume —
 *    {@link keepaliveBudgetUsd}.
 *  - A session stays eligible while `spentUsd < budgetUsd`. ~4-5 hits fit the
 *    budget; a single miss ≈ the whole budget, so a miss naturally stops further
 *    keepalives (and it has already re-warmed the cache server-side anyway).
 *
 * This module is intentionally PURE and dependency-free — it imports nothing
 * (no pricing module, no logger). Every input is a plain number, so it's
 * trivially unit-testable. Inline named constants per repo rule (no env feature
 * gates / tuning knobs).
 */

/**
 * Providers whose explicit-breakpoint prompt cache has a write premium worth
 * keeping warm. Bridging is gated on this so an unknown model id (which
 * getModelCacheRates resolves to a Sonnet-rate fallback) can't make a
 * non-Anthropic provider look bridgeable. To support a new such provider, add it
 * here AND ensure its model cache rates are in BUNDLED_PRICING.
 */
export const PREMIUM_CACHE_PROVIDERS = new Set(["anthropic"]);

/**
 * Whether an account's provider is one we bridge (keepalive) at all. The
 * provider-identity gate that complements {@link hasCacheWritePremium}: it
 * excludes non-Anthropic providers up front, so a request with an unrecognized
 * model id (resolved to a Sonnet-rate fallback by getModelCacheRates) can never
 * be staged and bridged from a non-Anthropic provider.
 */
export function isBridgeableProvider(
	provider: string | null | undefined,
): boolean {
	return provider != null && PREMIUM_CACHE_PROVIDERS.has(provider);
}

/** Derate factor on the resume-penalty budget — hedges abandoned sessions. */
export const RISK_FACTOR = 0.4;

/** Default eligibility threshold: sessions below this cached-token count aren't
 * worth bridging. Configurable elsewhere via the store's minTokens. */
export const DEFAULT_MIN_CACHE_TOKENS = 100_000;

/** Hard cap on the number of stored session bodies. */
export const MAX_SESSION_SLOTS = 100;

/** Total byte budget across all stored session bodies. */
export const MAX_SESSION_BRIDGE_BYTES = 64 * 1024 * 1024;

/** Per-body size cap; bodies larger than this are not stored. */
export const MAX_SESSION_BODY_BYTES = 2 * 1024 * 1024;

/** Evict a warm slot after this many consecutive non-routable/failed keepalive attempts — the account is gone or persistently paused. */
export const MAX_KEEPALIVE_FAILURES = 3;

/**
 * Max random decorrelation delay (≤1s) between SEQUENTIAL keepalive dispatches.
 * Anti-burst: a small per-dispatch jitter spreads replays across the per-IP
 * window without making a tick take minutes (20 sequential sessions × this cap).
 */
export const BRIDGE_JITTER_MAX_MS = 1_000;

/**
 * Refresh each warm idle session at least this often (3 min) — comfortably under
 * Anthropic's 5-min prompt-cache TTL so a keepalive lands before the cache dies.
 * A slot is due for a keepalive once this long has elapsed since its last touch
 * (real activity or prior keepalive). The margin must absorb the scheduler tick
 * granularity (KEEPALIVE_TICK_SECONDS) plus the keepalive's own upstream latency:
 * worst case a slot becomes due just after a tick, waits ~one tick, then the
 * replay still has to reach Anthropic — 3 min keeps all of that under 5 min.
 */
export const KEEPALIVE_REFRESH_MS = 3 * 60_000;

/**
 * Whether a model's cache rates carry a real WRITE premium worth bridging: both
 * rates finite, a positive cache-read rate, and a cache-write rate strictly above
 * it. This is the provider economic gate — it returns false for OpenAI/Codex and
 * zai/GLM (cache_write == 0), so only Anthropic-style providers are bridged.
 */
export function hasCacheWritePremium(
	cacheReadPer1M: number,
	cacheWritePer1M: number,
): boolean {
	return (
		Number.isFinite(cacheReadPer1M) &&
		Number.isFinite(cacheWritePer1M) &&
		cacheReadPer1M > 0 &&
		cacheWritePer1M > cacheReadPer1M
	);
}

/**
 * The keepalive spend budget for a session, in USD: the resume re-cache penalty
 * `(cache_write − cache_read) / 1M × cachedTokens` derated by {@link RISK_FACTOR}.
 * A session keeps bridging while its accumulated spend stays under this. Clamped
 * to `>= 0`; returns 0 when there is no write premium or inputs are invalid.
 */
export function keepaliveBudgetUsd(
	cachedTokens: number,
	cacheReadPer1M: number,
	cacheWritePer1M: number,
): number {
	if (
		!Number.isFinite(cachedTokens) ||
		cachedTokens <= 0 ||
		!hasCacheWritePremium(cacheReadPer1M, cacheWritePer1M)
	) {
		return 0;
	}
	return (
		((cacheWritePer1M - cacheReadPer1M) / 1_000_000) *
		cachedTokens *
		RISK_FACTOR
	);
}

/**
 * Cost in USD of a keepalive that HIT the warm cache: `cache_read / 1M × prefix`.
 * Clamped to `>= 0`; returns 0 for invalid inputs.
 */
export function keepaliveHitCostUsd(
	cachedTokens: number,
	cacheReadPer1M: number,
): number {
	if (
		!Number.isFinite(cachedTokens) ||
		!Number.isFinite(cacheReadPer1M) ||
		cachedTokens <= 0 ||
		cacheReadPer1M <= 0
	) {
		return 0;
	}
	return (cacheReadPer1M / 1_000_000) * cachedTokens;
}

/**
 * Cost in USD of a keepalive that MISSED (cache had expired, so it re-created the
 * cache): `cache_write / 1M × prefix`. ≈ the whole budget for one miss, which is
 * how a single miss naturally ends a session's bridging. Clamped to `>= 0`.
 */
export function keepaliveMissCostUsd(
	cachedTokens: number,
	cacheWritePer1M: number,
): number {
	if (
		!Number.isFinite(cachedTokens) ||
		!Number.isFinite(cacheWritePer1M) ||
		cachedTokens <= 0 ||
		cacheWritePer1M <= 0
	) {
		return 0;
	}
	return (cacheWritePer1M / 1_000_000) * cachedTokens;
}

/**
 * The un-derated resume re-cache penalty a warm cache avoids, in USD:
 * `(cache_write − cache_read) / 1M × cachedTokens`. Used as the LRU priority for
 * deciding which session bodies to keep (higher = more valuable to keep warm).
 * Clamped to `>= 0`; returns 0 when there is no premium or inputs are invalid.
 */
export function resumePenaltyUsd(
	cachedTokens: number,
	cacheReadPer1M: number,
	cacheWritePer1M: number,
): number {
	if (
		!Number.isFinite(cachedTokens) ||
		cachedTokens <= 0 ||
		!hasCacheWritePremium(cacheReadPer1M, cacheWritePer1M)
	) {
		return 0;
	}
	return ((cacheWritePer1M - cacheReadPer1M) / 1_000_000) * cachedTokens;
}

/** Whether a session's observed cached-token count clears the bridge threshold. */
export function isEligibleByTokens(
	cachedTokens: number,
	minTokens: number,
): boolean {
	return cachedTokens >= minTokens;
}
