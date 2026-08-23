import type { Config } from "@clankermux/config";
import {
	accountWideExhaustion,
	isAccountAvailable,
	TtlCache,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import { usageCache } from "@clankermux/providers";
import type { Account, AnthropicUsageData } from "@clankermux/types";
import type { HealthResponse, IntegrityStatus, PoolStatus } from "../types";

type AsyncWriterHealthFn = () => {
	healthy: boolean;
	failureCount: number;
	recentDrops: number;
	queuedJobs: number;
};
type IntegrityStatusFn = () => IntegrityStatus;

/**
 * Resolves an account's raw Anthropic-style usage payload (or null). Injected so
 * `computePoolStatus` stays pure/testable; the handler passes a reader backed by
 * the live `usageCache`.
 */
export type AccountUsageResolver = (
	account: Account,
) => AnthropicUsageData | null | undefined;

/**
 * The default account-usage resolver backed by the live `usageCache`. Reads usage
 * only for the windowed providers (anthropic/codex); the normalizer safely
 * returns "no evidence" for anything else, but this keeps the resolver honest.
 * Shared by `/health` and the dashboard's System Status so the two never disagree
 * about which accounts are usage-exhausted.
 *
 * FRESHNESS: `usageCache.peek()` is already TTL-gated at `USAGE_CACHE_TTL_MS`
 * (10 min), so everything reached from here is on the ROUTING-fresh view. That
 * is why `/health` calls `accountWideExhaustion` with two arguments while
 * `/api/accounts` passes a third: the accounts endpoint renders from a 30-minute
 * display horizon that is too generous to assert the fast-moving 5h session
 * window, and has to narrow it explicitly. Here there is nothing to narrow.
 */
export const usageCacheResolver: AccountUsageResolver = (account) =>
	account.provider === "anthropic" || account.provider === "codex"
		? (usageCache.peek(account.id) as AnthropicUsageData | null)
		: null;

export function computePoolStatus(
	accounts: Account[],
	now: number,
	getUsage?: AccountUsageResolver,
): PoolStatus {
	const configured = accounts.length;
	const paused = accounts.filter((a) => a.paused).length;
	const rateLimitedAccounts = accounts.filter(
		(a) => !a.paused && a.rate_limited_until && a.rate_limited_until >= now,
	);
	const rate_limited = rateLimitedAccounts.length;

	// Classic-available accounts (not paused, no live lock) may still be sidelined
	// by an exhausted ACCOUNT-WIDE window — a weekly one or the rolling 5-hour
	// session — with no `rate_limited_until` yet.
	let routable = 0;
	let usage_exhausted = 0;
	const usageResetTimes: number[] = [];
	for (const account of accounts) {
		if (!isAccountAvailable(account, now)) continue;
		if (getUsage) {
			const { exhausted, resetMs } = accountWideExhaustion(
				getUsage(account),
				now,
			);
			if (exhausted) {
				usage_exhausted++;
				if (resetMs !== null) usageResetTimes.push(resetMs);
				continue;
			}
		}
		routable++;
	}

	const earliestRateLimit = rateLimitedAccounts.reduce<number | null>(
		(min, account) => {
			if (!account.rate_limited_until) return min;
			return min === null
				? account.rate_limited_until
				: Math.min(min, account.rate_limited_until);
		},
		null,
	);

	// Recovery is the soonest of any rate-limit lock OR usage-window reset, so a
	// pool that is only usage-exhausted reports "degraded" (recovers) not
	// "unhealthy" (dead).
	const recoveryCandidates: number[] = [...usageResetTimes];
	if (earliestRateLimit !== null) recoveryCandidates.push(earliestRateLimit);
	const next_available_at =
		recoveryCandidates.length > 0
			? new Date(Math.min(...recoveryCandidates)).toISOString()
			: null;

	return {
		configured,
		paused,
		rate_limited,
		routable,
		usage_exhausted,
		next_available_at,
	};
}

export function computeHealthStatus(
	runtimeHealthy: boolean,
	pool: PoolStatus,
): "unhealthy" | "degraded" | "ok" {
	// Unhealthy: runtime broken OR no accounts configured OR empty pool with no recovery
	if (
		!runtimeHealthy ||
		pool.configured === 0 ||
		(pool.routable === 0 && !pool.next_available_at)
	) {
		return "unhealthy";
	}

	// Degraded: empty pool but will recover
	if (pool.routable === 0 && pool.next_available_at) {
		return "degraded";
	}

	// OK: runtime healthy and routable accounts available
	return "ok";
}

function toHttpStatus(status: HealthResponse["status"]): 200 | 503 {
	return status === "ok" ? 200 : 503;
}

/**
 * `GET /health` — a rollup, and UNCONDITIONALLY terse.
 *
 * There is no `?detail=1` any more. This endpoint is unauthenticated (a
 * container health check has to reach it before anything else works), and the
 * detail view answered it with account names and per-account availability. The
 * detailed read now lives on `/public/v1/status` and `/public/v1/accounts`,
 * which are designed for unauthenticated consumption and state exactly what
 * they disclose. Query parameters are ignored rather than rejected, so an old
 * caller's `?detail=1` still gets a valid health check.
 */
export function createHealthHandler(
	dbOps: DatabaseOperations,
	config: Config,
	getAsyncWriterHealth?: AsyncWriterHealthFn,
	getIntegrityStatus?: IntegrityStatusFn,
) {
	const cache = new TtlCache<HealthResponse>(2000);

	return async (): Promise<Response> => {
		const cached = cache.get();
		if (cached) {
			return jsonResponse(cached, toHttpStatus(cached.status));
		}

		const accounts = await dbOps.getAllAccounts();
		const now = Date.now();
		const getUsage = usageCacheResolver;
		const pool = computePoolStatus(accounts, now, getUsage);

		// Call each health function once and store results
		const asyncWriterHealth = getAsyncWriterHealth
			? getAsyncWriterHealth()
			: null;

		// Determine runtime health from stored results
		const asyncWriterHealthy = asyncWriterHealth
			? asyncWriterHealth.healthy
			: true;
		const runtimeHealthy = asyncWriterHealthy;

		const status = computeHealthStatus(runtimeHealthy, pool);

		const response: HealthResponse = {
			status,
			accounts: pool.configured,
			timestamp: new Date().toISOString(),
			strategy: config.getStrategy(),
			pool,
		};

		// Build runtime section from stored results
		if (asyncWriterHealth) {
			response.runtime = {
				asyncWriter: asyncWriterHealth,
			};
		}

		// Add storage integrity independently — orthogonal to asyncWriter
		if (getIntegrityStatus) {
			if (!response.runtime) {
				response.runtime = {};
			}
			const runtime = response.runtime;
			const integrity = getIntegrityStatus();
			runtime.storage = {
				integrity: {
					status: integrity.status,
					runningKind: integrity.runningKind,
					lastCheckAt: integrity.lastCheckAt
						? new Date(integrity.lastCheckAt).toISOString()
						: null,
					lastError: integrity.lastError,
					lastQuickCheckAt: integrity.lastQuickCheckAt
						? new Date(integrity.lastQuickCheckAt).toISOString()
						: null,
					lastQuickResult: integrity.lastQuickResult,
					lastQuickAttemptAt: integrity.lastQuickAttemptAt
						? new Date(integrity.lastQuickAttemptAt).toISOString()
						: null,
					lastQuickSkipReason: integrity.lastQuickSkipReason,
					lastFullCheckAt: integrity.lastFullCheckAt
						? new Date(integrity.lastFullCheckAt).toISOString()
						: null,
					lastFullResult: integrity.lastFullResult,
					lastFullAttemptAt: integrity.lastFullAttemptAt
						? new Date(integrity.lastFullAttemptAt).toISOString()
						: null,
					lastFullSkipReason: integrity.lastFullSkipReason,
				},
			};
		}

		cache.set(response);
		return jsonResponse(response, toHttpStatus(status));
	};
}
