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

/**
 * DEFAULT derate factor on the resume-penalty budget — hedges abandoned sessions.
 * Configurable at runtime via the dashboard (stored as `cache_warming_risk_factor`,
 * surfaced in the UI as a bridge horizon in hours; see {@link riskFactorToBridgeHours}).
 * 0.4 ≈ a ~6.3h horizon for promoted 1h sessions. The store holds the live value.
 */
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
 * A session with at least this many cache-relevant turns is "established" and
 * likely to be juggled/forgotten by the user (left idle between turns) → eligible
 * for predictive 1-hour-TTL promotion. Part of the hybrid promotion policy.
 */
export const PROMOTE_AFTER_TURNS = 3;

/**
 * A gap this long (3 min) between a session's consecutive turns signals
 * idle-proneness — it approaches Anthropic's 5-min prompt-cache expiry — so the
 * session is promoted to 1-hour TTL even before it reaches PROMOTE_AFTER_TURNS.
 */
export const IDLE_GAP_FOR_PROMOTION_MS = 3 * 60_000;

/** De-stick: demote a promoted (dynamic-mode) session after this many CONSECUTIVE
 * non-idle (actively-worked) turns — at that point the 1h-TTL write premium is
 * being paid with no idle benefit, so drop it back to the cheap 5m TTL. A fresh
 * idle gap re-promotes. Dynamic mode only. */
export const DESTICK_AFTER_ACTIVE_TURNS = 5;

/**
 * Refresh cadence (50 min) for 1h-promoted keepalive slots — comfortably under
 * the 1-hour cache TTL. The per-slot interval the scheduler uses for promoted
 * sessions; KEEPALIVE_REFRESH_MS (3 min) remains the cadence for 5m-mode slots.
 */
export const KEEPALIVE_REFRESH_1H_MS = 50 * 60_000;

/**
 * Anthropic cache-rate multipliers relative to the model's input rate
 * (model-independent ratios): a 1-hour cache WRITE costs 2× input, a cache READ
 * costs 0.1× input. ONE_HOUR_WRITE_MULT is also the effective-write multiplier a
 * promoted (1h-TTL) slot uses — keep session-cache-store's effective-rate calc in
 * terms of this constant so the two never drift.
 */
export const ONE_HOUR_WRITE_MULT = 2;
export const CACHE_READ_MULT = 0.1;

/**
 * How many hours an idle, promoted (1h-TTL) session stays bridged per 1.0 of
 * RISK_FACTOR. Derived, not magic: a slot keeps bridging while spend < budget, so
 *   keepalives-to-exhaust = budget / hitCost
 *                         = RISK_FACTOR·(write−read)·tokens / (read·tokens)
 *                         = RISK_FACTOR · (ONE_HOUR_WRITE_MULT − CACHE_READ_MULT)/CACHE_READ_MULT
 * and hours = keepalives · (KEEPALIVE_REFRESH_1H_MS / 1h). The token count cancels,
 * so the horizon in hours depends only on the rate ratio and the refresh cadence —
 * NOT on session size. Only valid for the 1h-promoted bridge (5m slots use the
 * 3-min cadence and the 1.25× write rate, a much shorter horizon).
 */
export const BRIDGE_HOURS_PER_RISK_UNIT =
	((ONE_HOUR_WRITE_MULT - CACHE_READ_MULT) / CACHE_READ_MULT) *
	(KEEPALIVE_REFRESH_1H_MS / 3_600_000);

/**
 * Upper bound on RISK_FACTOR. At 1.0 the budget equals the whole avoided-rewrite
 * penalty, so even in the all-hit model a successful resume only breaks even (and a
 * budget-crossing keepalive or a single miss tips it slightly negative). Treat it
 * as a "never budget more than the rewrite you're avoiding" cap, not a guarantee.
 */
export const MAX_RISK_FACTOR = 1.0;

/** Break-even ceiling on the bridge horizon in hours (RISK_FACTOR = MAX_RISK_FACTOR). */
export const MAX_BRIDGE_HOURS = MAX_RISK_FACTOR * BRIDGE_HOURS_PER_RISK_UNIT;

/** NaN-safe clamp of a risk factor into [0, MAX_RISK_FACTOR]; non-finite → default. */
export function clampRiskFactor(riskFactor: number): number {
	if (!Number.isFinite(riskFactor)) return RISK_FACTOR;
	return Math.min(Math.max(riskFactor, 0), MAX_RISK_FACTOR);
}

/** NaN-safe clamp of a bridge-horizon hours value into [0, MAX_BRIDGE_HOURS]. */
export function clampBridgeHours(hours: number): number {
	if (!Number.isFinite(hours)) return riskFactorToBridgeHours(RISK_FACTOR);
	return Math.min(Math.max(hours, 0), MAX_BRIDGE_HOURS);
}

/** Convert a target bridge horizon (hours, promoted 1h slots) → RISK_FACTOR, clamped. */
export function bridgeHoursToRiskFactor(hours: number): number {
	if (!Number.isFinite(hours)) return RISK_FACTOR;
	return clampRiskFactor(hours / BRIDGE_HOURS_PER_RISK_UNIT);
}

/** Convert a RISK_FACTOR → its bridge horizon in hours (promoted 1h slots), clamped. */
export function riskFactorToBridgeHours(riskFactor: number): number {
	return clampRiskFactor(riskFactor) * BRIDGE_HOURS_PER_RISK_UNIT;
}

/**
 * Hard cap on the number of sessions the promotion tracker holds (memory bound).
 * Over cap, the entry with the oldest lastSeenTs is LRU-evicted. Entries are tiny
 * metadata only (no request bodies).
 */
export const MAX_PROMOTION_TRACKER_ENTRIES = 500;

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
	riskFactor: number = RISK_FACTOR,
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
		clampRiskFactor(riskFactor)
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
