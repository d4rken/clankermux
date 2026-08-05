import {
	getAccountWideClaimHeadroom,
	isScopedOnlyUnifiedRejection,
	logError,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	getFreshCapacity,
	type Provider,
	type RateLimitInfo,
	usageCache,
} from "@clankermux/providers";
import type { Account, RateLimitReason, RequestMeta } from "@clankermux/types";
import { markAnthropicBurstThrottle } from "./burst-cooldown";
import { applyCodexObservation } from "./codex-observation";
import type { ProxyContext } from "./proxy-types";
import {
	applyRateLimitCooldown,
	applySuccessRateLimitClear,
	completeRateLimitProbe,
} from "./rate-limit-cooldown";
import {
	BURST_RETRY_MAX_USAGE_AGE_MS,
	classify429Transient,
	isOAuthAnthropicAccount,
} from "./transparent-retry";

const log = new Logger("ResponseProcessor");

/**
 * Defensive ceiling on a projected 5h-claim reset. The claim's own reset is
 * ≤ ~5h out by construction; anything beyond this is a garbled header and the
 * projection degrades to no reset (persisted NULL — which the auto-refresh
 * scheduler treats as "due", triggering the prime that rewrites honest values).
 */
const SCOPED_PROJECTION_MAX_RESET_MS = 24 * 60 * 60 * 1000;

/**
 * Scope-aware projection of a 429's parsed rate-limit info.
 *
 * On a CLAIM-SCOPED rejection (`7d_oi` rejected while the account-wide 5h/7d
 * pair proves headroom) the summary headers assert account-wide rejection
 * until the SCOPED claim's reset — observed 4.5 days out. Persisting or
 * cooling on those values turns one family's exhaustion into an account-wide
 * verdict. This projection substitutes the 5h claim's OWN status and reset (a
 * coherent single-claim pair — the persisted reset's dominant consumer is the
 * scheduler's 5-hour window anchor). `isRateLimited` is left untouched: the
 * request itself WAS rejected and must still fail over.
 *
 * Trust boundary: header reinterpretation is only safe for the official
 * Anthropic OAuth upstream — a custom endpoint could emit these headers with
 * different or adversarial semantics — so the predicate mirrors the family
 * gate's (`resolveFamilyWeeklyExclusionFromHeaders`). The parse itself lives
 * in `@clankermux/core` (`unified-claim-headers.ts`); this wrapper adds the
 * account context the provider-layer parser deliberately does not have.
 */
export function projectScopedRateLimitInfo(
	account: Account,
	response: Response,
	rateLimitInfo: RateLimitInfo,
): RateLimitInfo {
	if (response.status !== 429) return rateLimitInfo;
	if (account.provider !== "anthropic" || account.custom_endpoint) {
		return rateLimitInfo;
	}
	if (!isScopedOnlyUnifiedRejection(response.headers)) return rateLimitInfo;
	const headroom = getAccountWideClaimHeadroom(response.headers);
	// isScopedOnlyUnifiedRejection implies headroom; bail defensively anyway.
	if (!headroom) return rateLimitInfo;
	const now = Date.now();
	const resetMs = headroom.fiveHour.resetMs;
	// REJECT (don't clamp) a reset outside (now, now+24h]: a "5h claim reset"
	// a day out is garbled evidence, and manufacturing a 24h value from it
	// would freeze the status refresh — or, via the generic cooldown path,
	// lock the account — for a day on malformed input. Degrading to none
	// persists NULL, which the scheduler treats as "due" (self-repairing).
	const projectedReset =
		resetMs !== null &&
		resetMs > now &&
		resetMs <= now + SCOPED_PROJECTION_MAX_RESET_MS
			? resetMs
			: undefined;
	log.debug(
		`Scoped 429 on ${account.name}: projecting account-wide meta from the 5h claim ` +
			`(status=${headroom.fiveHour.status} reset=${projectedReset ? new Date(projectedReset).toISOString() : "none"}) ` +
			`instead of the summary (status=${rateLimitInfo.statusHeader} reset=${rateLimitInfo.resetTime ? new Date(rateLimitInfo.resetTime).toISOString() : "none"})`,
	);
	return {
		...rateLimitInfo,
		statusHeader: headroom.fiveHour.status,
		resetTime: projectedReset,
	};
}

/**
 * Parses the provider rate-limit headers off `response` and, when the
 * unified-status header is present, enqueues a DB write persisting
 * status/reset/remaining (`accounts.rate_limit_status` & friends — the
 * dashboard chip and the auto-refresh scheduler's window anchor).
 *
 * When the header is absent this is a no-op: the stored status is never
 * overwritten with null by a response that carries no rate-limit info.
 *
 * Reads HEADERS ONLY — never the body. Callers on failover/short-circuit
 * paths discard or forward the body elsewhere; consuming it here would break
 * them.
 *
 * Must be called on every path that observes a 429 and then short-circuits
 * before processProxyResponse/updateAccountMetadata (e.g. the
 * `model_fallback_429` / `all_models_exhausted_429` cooldown sites in
 * proxy-operations), otherwise `rate_limit_status` goes stale — frozen at the
 * last successful response's status while `rate_limited_until` is active.
 *
 * Note the reset persisted here is the PROVIDER-PARSED reset header (window
 * semantics, consumed by the auto-refresh scheduler) — never the locally
 * computed backoff `cooldownUntil`, which is a short retry deadline with
 * different semantics.
 *
 * @param provider - The provider whose parseRateLimit understands this
 *   response's headers; defaults to ctx.provider. proxy-operations call sites
 *   pass their account-specific provider.
 */
export function persistRateLimitStatusMeta(
	account: Account,
	response: Response,
	ctx: ProxyContext,
	provider: Pick<Provider, "parseRateLimit"> = ctx.provider,
): void {
	const rateLimitInfo = projectScopedRateLimitInfo(
		account,
		response,
		provider.parseRateLimit(response),
	);
	if (!rateLimitInfo.statusHeader) return;
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
	// Codex responses are observed through the single shared applicator, which
	// owns request accounting, rate-limit status-meta persistence, and the
	// usage-cache / credits-carry-forward / window-roll / earliest-reset
	// bookkeeping. On the real-traffic main path the 429 cooldown is applied by
	// processProxyResponse (before this call) and the success-cooldown recovery
	// runs there too, so the applicator is told to skip the cooldown
	// (rateLimitAction: "skip") and — for source "real-traffic" — performs no
	// recovery. This keeps the shared cross-provider cooldown/recovery path
	// exactly as before.
	if (account.provider === "codex") {
		applyCodexObservation(account, response, ctx, {
			source: "real-traffic",
			rateLimitInfo: ctx.provider.parseRateLimit(response),
			requestAccounting: bypassSession ? "count-only" : "session",
			rateLimitAction: { kind: "skip" },
			successRecovery: "standard",
		});
	} else {
		// Real Anthropic traffic just used this account: feed the demand-aware
		// usage poller's activity signal so an idle-cadence poller re-arms to the
		// active cadence promptly. Gated on real traffic (bypassSession is the
		// background auto-refresh path, NOT user demand) and on the provider that
		// actually runs demand-aware polling (no-op otherwise, but kept explicit).
		if (!bypassSession && account.provider === "anthropic") {
			usageCache.noteActivity(account.id);
		}
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
		// Extract and update rate limit info for every response. Only updates the
		// metadata when actual rate limit headers are present (shared helper).
		persistRateLimitStatusMeta(account, response, ctx);
	}
	// Note: rate_limited_until/rate_limited_reason are cleared in
	// processProxyResponse on a REAL success (response.ok, stale-response
	// guarded — see applySuccessRateLimitClear). No need to duplicate here.

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
	requestMeta?: Pick<RequestMeta, "headers" | "internal"> &
		Partial<Pick<RequestMeta, "timestamp">>,
): Promise<boolean> {
	// Scoped projection BEFORE any consumer: both the cooldown applied below
	// and the status-meta persisted via updateAccountMetadata must see the
	// account-wide truth of a claim-scoped 429, never the summary's multi-day
	// verdict. This is the generic (rung 8) path — streamed-content-type 429s
	// and any 429 not intercepted by the proxy-operations ladder land here.
	let rateLimitInfo = projectScopedRateLimitInfo(
		account,
		response,
		ctx.provider.parseRateLimit(response),
	);

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

			// Reliable burst marker (storm-affinity-hold Part 1). The transparent
			// burst-retry hold is gated on the shared Anthropic-OAuth burst marker,
			// but historically ONLY the proxy-operations early-intercept set it. A
			// 429 that reaches THIS path (e.g. a streamed-content-type 429, or a
			// model-fallback 429 that wasn't intercepted) cooled the cache account
			// WITHOUT tripping the marker — so subsequent affinity_hold requests
			// diverted to a sibling (cache miss) instead of holding. Set the marker
			// here too — but ONLY when the 429 is the SAME transient burst the hold
			// path acts on, using the exact `classify429Transient` predicate the
			// early-intercept uses rather than a broader OAuth-Anthropic-non-hard
			// check (Finding 5). The broader check would trip the marker on a 429
			// that classify429Transient rejects (e.g. zero/negative headroom with no
			// `x-should-retry` hint — a real per-account wall, not a per-IP burst),
			// pinning siblings to a genuinely-exhausted account. Gate on status 429
			// (NOT a 529 overload — that drives the separate provider-overload
			// cooldown); `classify429Transient` itself excludes non-OAuth-Anthropic
			// accounts and hard account-level unified-statuses. The freshness-guarded
			// capacity lookup mirrors the early-intercept wiring in
			// proxy-operations.ts (no usage refresh here — this is a pure
			// fire-and-forget side-effect on a request that already failed over). It
			// does not change this request's cooldown/return path; it only makes the
			// marker reliable for the session's NEXT requests.
			if (response.status === 429 && isOAuthAnthropicAccount(account)) {
				const now = Date.now();
				const classification = classify429Transient({
					response,
					account,
					now,
					getCapacity: (accountId) =>
						getFreshCapacity(
							usageCache,
							accountId,
							account.provider,
							now,
							BURST_RETRY_MAX_USAGE_AGE_MS,
						),
				});
				if (classification.retryable) {
					markAnthropicBurstThrottle(now);
				}
			}
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

	// On a non-rate-limited upstream response, resolve the probe lease and —
	// when the response POSITIVELY proves the account serves (`response.ok`) —
	// run the shared success recovery (stability reset + guarded clear of
	// `rate_limited_until` AND `rate_limited_reason`; see
	// applySuccessRateLimitClear). A non-ok non-429 (400/500) proves nothing
	// and clears nothing: it is the "abandoned" shape below, and letting it
	// clear would allow a generic upstream 500 to erase an `out_of_credits`
	// floor without evidence of recovery. The request's start time is the
	// stale-response guard bound: a delayed 200 issued before a NEWER 429
	// landed must not erase that newer state.
	if (!rateLimitInfo.isRateLimited) {
		// Single-flight recovery probe terminal outcome: this attempt got a
		// non-rate-limited response, so any in-flight probe lease for this account
		// is resolved. `response.ok` means the account genuinely recovered; a
		// non-ok, non-429 response (e.g. a 400/500) is treated as abandoned. The
		// 429 branch above releases via applyRateLimitCooldown ("cooldown_reapplied")
		// instead, and proxy.ts's try/finally is the belt-and-suspenders catch-all
		// for exceptions/skips.
		completeRateLimitProbe(account, response.ok ? "recovered" : "abandoned");

		if (response.ok) {
			applySuccessRateLimitClear(
				account,
				ctx,
				requestMeta?.timestamp ?? Date.now(),
			);
		}
	}

	return false;
}

/**
 * Returns true for an intentional abort — a client disconnect or the burst-retry
 * hold-budget deadline firing on the probe's AbortSignal. Both surface as an
 * `AbortError`, either as a plain `Error` (name === "AbortError") or as a
 * `DOMException` of the same name. These are not proxy failures and must not be
 * logged at ERROR (they de-noise the burst hold-budget aborts and ordinary
 * client disconnects proxy-wide).
 */
function isAbortError(error: unknown): boolean {
	return (
		(error instanceof Error || error instanceof DOMException) &&
		error.name === "AbortError"
	);
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
	// Intentional aborts (client disconnect or hold-budget deadline) are expected,
	// not failures — log a single concise DEBUG line and skip the ERROR output.
	if (isAbortError(error)) {
		logger.debug(
			`Upstream request aborted for account ${account?.name ?? "(none)"} (client disconnect or hold budget) — not a failure`,
		);
		return;
	}

	logError(error, logger);
	if (account) {
		logger.error(`Failed to proxy request with account ${account.name}`);
	} else {
		logger.error("Failed to proxy request");
	}
}
