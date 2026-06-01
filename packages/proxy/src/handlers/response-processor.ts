import { getRateLimitResetStabilityMs, logError } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	isGenuineWindowRoll,
	type Provider,
	parseCodexUsageHeaders,
	toEpochMs,
	usageCache,
} from "@clankermux/providers";
import type { Account, RateLimitReason, RequestMeta } from "@clankermux/types";
import type { ProxyContext } from "./proxy-types";
import { applyRateLimitCooldown } from "./rate-limit-cooldown";

const log = new Logger("ResponseProcessor");

/**
 * Updates account metadata in the background
 * @param account - The account to update
 * @param response - The response to extract metadata from
 * @param ctx - The proxy context
 * @param requestId - The request ID for usage tracking
 * @param bypassSession - Whether to bypass session tracking (for auto-refresh)
 */
export function updateAccountMetadata(
	account: Account,
	response: Response,
	ctx: ProxyContext,
	requestId?: string,
	bypassSession = false,
): void {
	// Update basic usage (with optional bypass)
	if (bypassSession) {
		// Increment request count without updating session tracking
		ctx.asyncWriter.enqueue(async () => {
			// Manually increment request count and total requests without touching session
			const db = ctx.dbOps.getAdapter();
			const now = Date.now();
			await db.run(
				`UPDATE accounts
				 SET last_used = ?, request_count = request_count + 1, total_requests = total_requests + 1
				 WHERE id = ?`,
				[now, account.id],
			);
		});
	} else {
		ctx.asyncWriter.enqueue(() => ctx.dbOps.updateAccountUsage(account.id));
	}
	// Extract and update rate limit info for every response
	const rateLimitInfo = ctx.provider.parseRateLimit(response);
	// Only update rate limit metadata when we have actual rate limit headers
	if (rateLimitInfo.statusHeader) {
		const status = rateLimitInfo.statusHeader;
		ctx.asyncWriter.enqueue(() =>
			ctx.dbOps.updateAccountRateLimitMeta(
				account.id,
				status,
				rateLimitInfo.resetTime ?? null,
				rateLimitInfo.remaining,
			),
		);
	}
	// Note: rate_limited_until is cleared unconditionally in processProxyResponse on any
	// successful response. No need to duplicate that logic here.

	if (account.provider === "codex") {
		const codexUsage = parseCodexUsageHeaders(response.headers, {
			defaultUtilization: response.status === 429 ? 100 : 0,
		});
		if (codexUsage) {
			const prevUsage = usageCache.get(account.id);
			const prevResetAt = (
				prevUsage as { five_hour?: { resets_at: string | null } } | null
			)?.five_hour?.resets_at;
			const newResetAt = codexUsage.five_hour?.resets_at;
			// Detect a genuine 5h window roll using the shared guard: only when the
			// previous reset has actually arrived (prevResetMs <= now) and the new
			// reset is strictly later. This rejects sub-second forward drift of a
			// still-future reset, which would otherwise churn session_start and flap
			// the dashboard Primary badge (mirrors the Anthropic usage-fetcher fix).
			const prevResetMs = toEpochMs(prevResetAt);
			const newResetMs = toEpochMs(newResetAt);
			const windowRolledOver = isGenuineWindowRoll(
				prevResetMs,
				newResetMs,
				Date.now(),
			);

			usageCache.set(account.id, codexUsage);
			log.debug(
				`Updated Codex usage cache for ${account.name}: 5h=${codexUsage.five_hour.utilization}%, 7d=${codexUsage.seven_day.utilization}%`,
			);

			// Update rate_limit_reset from usage headers so auto-refresh can track
			// windows. We persist the earliest of the 5h/7d resets.
			const earliestResetOf = (
				usage: {
					five_hour?: { resets_at: string | null };
					seven_day?: { resets_at: string | null };
				} | null,
			): number | null => {
				const resetTimes = [
					usage?.five_hour?.resets_at,
					usage?.seven_day?.resets_at,
				]
					.map((t) => toEpochMs(t))
					.filter((ms): ms is number => ms != null);
				return resetTimes.length > 0 ? Math.min(...resetTimes) : null;
			};
			const newEarliestReset = earliestResetOf(codexUsage);
			// Compare against the PERSISTED account value (rate_limit_reset, epoch ms),
			// NOT the usageCache: usageCache.set(...) above has already overwritten the
			// prior entry, and — more importantly — on a failed async DB write the cache
			// would hold the new value, so comparing against it would suppress the retry
			// and leave the DB permanently stale. Comparing against account.rate_limit_reset
			// means a failed write is retried on the next response (the persisted value
			// only advances on a real, committed write), while genuine sub-second forward
			// drift of a still-future reset is still suppressed (the persisted value won't
			// have moved, so |new - persisted| stays < 1s once it has been written once).
			if (
				newEarliestReset != null &&
				(account.rate_limit_reset == null ||
					Math.abs(newEarliestReset - account.rate_limit_reset) >= 1000)
			) {
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps
						.getAdapter()
						.run("UPDATE accounts SET rate_limit_reset = ? WHERE id = ?", [
							newEarliestReset,
							account.id,
						]),
				);
			}

			if (windowRolledOver) {
				log.info(
					`Codex window rolled over for ${account.name}: ${prevResetAt} → ${newResetAt}, resetting session`,
				);
				ctx.dbOps
					.resetAccountSession(account.id, Date.now())
					.catch((err) =>
						log.warn(
							`Failed to reset Codex session for ${account.name} on window reset: ${err}`,
						),
					);
			}
		}
	}

	// Extract usage info if supported
	if (requestId) {
		// For streaming responses, prefer parseUsage (handles SSE final events)
		// For non-streaming, use extractUsageInfo (handles JSON responses)
		const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;

		if (isStream && ctx.provider.parseUsage) {
			const parseUsage = ctx.provider.parseUsage.bind(ctx.provider);
			(async () => {
				try {
					const usageInfo = await parseUsage(response.clone() as Response);
					if (usageInfo) {
						log.debug(
							`Extracted streaming usage for account ${account.name}: ${JSON.stringify(usageInfo)}`,
						);
						// Store usage info in database
						try {
							await ctx.asyncWriter.enqueue(() =>
								ctx.dbOps.updateRequestUsage(requestId, usageInfo),
							);
						} catch (error) {
							log.warn(`Failed to save usage for request ${requestId}:`, error);
						}
					}
				} catch (error) {
					log.warn(
						`Failed to extract streaming usage for account ${account.name}:`,
						error,
					);
				}
			})();
		} else if (ctx.provider.extractUsageInfo) {
			const extractUsageInfo = ctx.provider.extractUsageInfo.bind(ctx.provider);
			(async () => {
				try {
					const usageInfo = await extractUsageInfo(
						response.clone() as Response,
					);
					if (usageInfo) {
						log.debug(
							`Extracted usage info for account ${account.name}: ${JSON.stringify(usageInfo)}`,
						);
						// Store usage info in database
						try {
							await ctx.asyncWriter.enqueue(() =>
								ctx.dbOps.updateRequestUsage(requestId, usageInfo),
							);
						} catch (error) {
							log.warn(`Failed to save usage for request ${requestId}:`, error);
						}
					}
				} catch (error) {
					log.warn(
						`Failed to extract usage info for account ${account.name}:`,
						error,
					);
				}
			})();
		}
	}
}

/**
 * Processes a successful proxy response
 * @param response - The provider response
 * @param account - The account used
 * @param ctx - The proxy context
 * @param requestId - The request ID for usage tracking
 * @returns Promise resolving to whether the response is rate-limited
 */
export async function processProxyResponse(
	response: Response,
	account: Account,
	ctx: ProxyContext,
	requestId?: string,
	requestMeta?: Pick<RequestMeta, "headers" | "internal">,
): Promise<boolean> {
	let rateLimitInfo = ctx.provider.parseRateLimit(response);

	// For Zai provider, if we got a 429 without resetTime, try parsing the body
	if (
		rateLimitInfo.isRateLimited &&
		!rateLimitInfo.resetTime &&
		account.provider === "zai" &&
		response.status === 429
	) {
		// Try to parse reset time from response body
		const provider = ctx.provider;
		if ("parseRateLimitFromBody" in provider) {
			const bodyResetTime = await (
				provider as Provider & {
					parseRateLimitFromBody: (
						response: Response,
					) => Promise<number | null>;
				}
			).parseRateLimitFromBody(response);
			if (bodyResetTime) {
				rateLimitInfo = {
					...rateLimitInfo,
					resetTime: bodyResetTime,
				};
			}
		}
	}

	// Handle rate limit
	//
	// We deliberately do NOT exclude streaming responses here. A rate-limited
	// account is rate-limited regardless of whether the response that revealed
	// it was a stream — and the failover decision (returning true to signal
	// the next-account loop) is safe at this point because no response bytes
	// have been written to the client yet. The proxy hasn't entered the
	// `forwardToClient` path; it's still inspecting the upstream response.
	//
	// In practice the most common pre-stream 429 has
	// `content-type: application/json` because Anthropic only opens an SSE
	// stream when the request is accepted, but the historic `!isStream` guard
	// here was a footgun: providers that emit `text/event-stream` 429s, or
	// future provider transforms that preserve the requested content-type on
	// errors, would silently bypass marking and failover. The mid-stream case
	// (status 200 with an SSE `event: error` frame partway through the body)
	// is handled separately by the streaming forwarder — see issue #114.
	if (rateLimitInfo.isRateLimited) {
		// Skip cooldown application on synthetic cache-keepalive replays. The
		// keepalive scheduler fires parallel requests across every cached
		// account simultaneously; bursts of 4+ concurrent requests can trip
		// Anthropic's per-IP burst limit and 429 every account at the same
		// instant. Treating those as real per-account rate limits drains the
		// pool to zero routable accounts even though no user-visible quota
		// was actually exhausted. Loop-prevention header set by
		// cache-keepalive-scheduler.ts; only synthetic replays carry it.
		const isKeepalive =
			requestMeta?.internal === true &&
			requestMeta?.headers?.get("x-clankermux-keepalive") === "true";
		if (isKeepalive) {
			log.warn(
				`Keepalive replay for ${account.name} got ${response.status} — skipping cooldown (synthetic burst, not a real per-account rate limit)`,
			);
		} else {
			// Single entry point for both with-reset and no-reset paths.
			// Derive a 529-specific reason override so the audit trail reflects
			// the actual HTTP status (529 overloaded vs 429 rate-limited).
			// applyRateLimitCooldown auto-derives the 429 reason when reason is undefined.
			const reason: RateLimitReason | undefined =
				response.status === 529
					? rateLimitInfo.resetTime
						? "upstream_529_overloaded_with_reset"
						: "upstream_529_overloaded_no_reset"
					: undefined;
			applyRateLimitCooldown(account, { ...rateLimitInfo, reason }, ctx);
		}
		// Also update metadata for rate-limited responses
		const bypassSession =
			requestMeta?.internal === true &&
			requestMeta?.headers?.get("x-clankermux-bypass-session") === "true";
		updateAccountMetadata(account, response, ctx, requestId, bypassSession);
		return true; // Signal rate limit
	}

	// Update account metadata in background
	const bypassSession =
		requestMeta?.internal === true &&
		requestMeta?.headers?.get("x-clankermux-bypass-session") === "true";
	updateAccountMetadata(account, response, ctx, requestId, bypassSession);

	// On any successful upstream response, run the two side-effects independently:
	//   (a) Stability reset: if the most recent 429 is older than the stability
	//       window, the streak counter resets to 0. Critically, this is gated on
	//       `rate_limited_at` ALONE — NOT on `rate_limited_until`. The periodic
	//       `clearExpiredRateLimits` job nulls `rate_limited_until` without
	//       touching `rate_limited_at`; if we required `rate_limited_until` to
	//       still be set, API-key accounts whose cooldown expired naturally
	//       would never get the counter reset and the next 429 would land at an
	//       inflated backoff tier.
	//   (b) Clearing `rate_limited_until`: only fires when the in-memory value
	//       is non-null (avoids a no-op DB write on the happy path). We clear
	//       unconditionally because a successful response proves the account is
	//       usable — e.g. after a seat reassignment resets usage mid-window
	//       before the stored expiry fires.
	if (!rateLimitInfo.isRateLimited) {
		// (a) Stability reset — gated only on rate_limited_at.
		if (
			account.rate_limited_at &&
			Date.now() - account.rate_limited_at > getRateLimitResetStabilityMs()
		) {
			account.consecutive_rate_limits = 0;
			account.rate_limited_at = null;
			ctx.asyncWriter.enqueue(() =>
				ctx.dbOps.resetConsecutiveRateLimits(account.id),
			);
		}

		// (b) Clear rate_limited_until (only if still set in-memory).
		if (account.rate_limited_until) {
			account.rate_limited_until = null;
			ctx.asyncWriter.enqueue(async () => {
				const db = ctx.dbOps.getAdapter();
				await db.run(
					"UPDATE accounts SET rate_limited_until = NULL WHERE id = ? AND rate_limited_until IS NOT NULL",
					[account.id],
				);
				log.debug(
					`Cleared rate_limited_until for account ${account.name} on successful response`,
				);
			});
		}
	}

	return false;
}

/**
 * Handles errors that occur during proxy operations
 * @param error - The error that occurred
 * @param account - The account that failed (optional)
 * @param logger - Logger instance
 */
export function handleProxyError(
	error: unknown,
	account: Account | null,
	logger: Logger,
): void {
	logError(error, logger);
	if (account) {
		logger.error(`Failed to proxy request with account ${account.name}`);
	} else {
		logger.error("Failed to proxy request");
	}
}
