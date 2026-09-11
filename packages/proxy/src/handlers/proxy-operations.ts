import {
	accountWideExhaustion,
	getModelFamily,
	isDebugEnabled,
	isProtectedFamily,
	isScopedOnlyUnifiedRejection,
	NETWORK,
	resolveModelMaxContextWindow,
	TIME_CONSTANTS,
	ValidationError,
} from "@clankermux/core";
import {
	type DrainReport,
	discardTeeBranch,
	discardUpstreamBody,
} from "@clankermux/core/response-body-disposal";
import { Logger } from "@clankermux/logger";
import { stripCacheControlFromOpenAIRequest } from "@clankermux/openai-formats";
import {
	getFreshCapacity,
	getProvider,
	isAnthropicHardLimitStatus,
	isAnthropicOrgPermissionDenied,
	isAnthropicOutOfCredits,
	usageCache,
} from "@clankermux/providers";
import { supportsLocalTokenCounting } from "@clankermux/providers/local-token-count";
import {
	type Account,
	type AnthropicUsageData,
	getNativeResponsesMetaContext,
	NATIVE_RESPONSES_REQUEST_HEADER,
	PROVIDER_NAMES,
	type RateLimitReason,
	type RequestMeta,
} from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import {
	clearFamilyWeeklyExhausted,
	recordFamilyWeeklyExhausted,
} from "../family-weekly-memo";
import { getPoolHeadroomCandidates } from "../pool-headroom";
import { recordProtectedFamilyDemand } from "../protected-family-demand";
import {
	applyProviderOverloadCooldown,
	completeProviderOverloadProbe,
	isOfficialAnthropicProvider,
	type OverloadProbeEvidence,
	type OverloadProbeToken,
	resolveOverloadAttributionModel,
	tryAcquireProviderOverloadProbe,
} from "../provider-overload-cooldown";
import { captureRawUpstreamObservation } from "../raw-response-observations";
import { RequestBodyContext } from "../request-body-context";
import {
	getAttemptTarget,
	RoutingPolicyError,
	rejectModelSwitchFields,
} from "../resolved-route";
import { forwardToClient } from "../response-handler";
import {
	type RoutingAttemptAudit,
	recordLocalRoutingOutcome,
	sendAuthorizedRequest,
} from "../routing-dispatch";
import { isModelRouteRestriction } from "../routing-response-audit";
import { dispatchObservationSource } from "../should-record-request";
import {
	type AccountQuota429,
	resolveLiveAccountQuota429,
} from "./anthropic-account-quota";
import { markAnthropicBurstThrottle } from "./burst-cooldown";
// Direct leaf import (not via the `handlers` barrel, which re-exports this
// module) — see the module comment.
import { createClientAbortResponse } from "./client-abort-response";
import { applyCodexObservation } from "./codex-observation";
import {
	FAMILY_WEEKLY_MAX_USAGE_AGE_MS,
	hasAccountWideUnifiedRejection,
	resolveFamilyWeeklyExclusion,
	resolveFamilyWeeklyExclusionFromHeaders,
} from "./family-weekly-gate";
import { ERROR_MESSAGES, type ProxyContext } from "./proxy-types";
import {
	applyRateLimitCooldown,
	completeRateLimitProbe,
} from "./rate-limit-cooldown";
import { validateProviderPath } from "./request-handler";
import {
	handleProxyError,
	persistRateLimitStatusMeta,
	processProxyResponse,
} from "./response-processor";
import {
	canAttemptStaleTokenRefresh,
	getValidAccessToken,
	refreshAccessTokenSafe,
} from "./token-manager";
import {
	BURST_RETRY_COOLDOWN_CAP_MS,
	BURST_RETRY_MAX_USAGE_AGE_MS,
	classify429Transient,
} from "./transparent-retry";

import { isZaiOverloadResponse, recoverZaiOverload } from "./zai-overload";

const log = new Logger("ProxyOperations");

/**
 * Size above which an abandoned body with NO recognised completion signature is
 * still worth a line. Everything this path discards should be a small error
 * envelope (a 429/529 JSON error is a few hundred bytes); kilobytes of
 * unrecognised content means we are throwing away something we do not
 * understand, which is the shape a future regression would take.
 *
 * A size threshold alone would be the WRONG guard on its own, which is why the
 * marker check below is the primary signal: a perfectly valid short completion
 * (`{"type":"message","usage":{…}}`) is ~70 bytes and sits far below any
 * error-payload threshold.
 */
const ABANDONED_BODY_SIZE_ALARM_BYTES = 8 * 1024;

/** Stable event id — a completed/usage-bearing body was discarded on failover. */
export const EVENT_ABANDONED_BODY_COMPLETION_MARKER =
	"abandoned_body_completion_marker";

/** Stable event id — an unexpectedly large abandoned body with no marker. */
export const EVENT_ABANDONED_BODY_OVERSIZE_NO_MARKER =
	"abandoned_body_oversize_no_marker";

/**
 * Log-only observer for the body thrown away by the rate-limited failover.
 *
 * The inline usage collector only sees bodies that are FORWARDED, so a body
 * abandoned here is usage that is never accounted for. Production measurement
 * says this path carries error envelopes exclusively — this exists to prove
 * that stays true, and to say so loudly if it does not.
 *
 * Emits STABLE event identifiers so post-deploy occurrences can be counted by
 * field rather than by matching log prose. Purely observational: it is invoked
 * from the drain, long after `fail()` returned, and changes no control flow.
 */
export function reportAbandonedRateLimitedBody(
	drain: DrainReport,
	ctx: {
		requestId: string;
		accountName: string;
		accountId: string;
		provider: string;
		status: number;
	},
): void {
	const where =
		`requestId=${ctx.requestId} account=${ctx.accountName} ` +
		`accountId=${ctx.accountId} provider=${ctx.provider} status=${ctx.status} ` +
		`bytes=${drain.bytesRead} stopReason=${drain.stopReason} ` +
		`reachedEof=${drain.reachedEof}`;

	if (drain.marker !== null) {
		log.warn(
			`event=${EVENT_ABANDONED_BODY_COMPLETION_MARKER} ` +
				`marker=${drain.marker} ${where} — rate-limited failover discarded a ` +
				`body carrying a completion/usage signature; its tokens were never ` +
				`accounted for`,
		);
		return;
	}

	if (drain.bytesRead > ABANDONED_BODY_SIZE_ALARM_BYTES) {
		log.warn(
			`event=${EVENT_ABANDONED_BODY_OVERSIZE_NO_MARKER} ` +
				`threshold=${ABANDONED_BODY_SIZE_ALARM_BYTES} ${where} — rate-limited ` +
				`failover discarded an unexpectedly large body with no recognised ` +
				`completion signature`,
		);
	}
}

/**
 * Categorical outcome of a single `proxyWithAccount` attempt that returned
 * `null` (i.e. signalled failover rather than forwarding a response). Recorded
 * into the optional outcome sink (see {@link ProxyAttemptOptions.onOutcome}) so
 * the proxy's decide-before-loop control flow can tell a transparent-429
 * (hold-eligible) failure apart from a hard exhaustion / auth / network / model
 * failure WITHOUT re-parsing the upstream response (whose body has been
 * discarded by the `fail()` helper).
 *
 *  - `retryable_429`   — an OAuth-Anthropic transient burst 429 the caller may
 *                         hold-and-retry on the cache account. Carries the
 *                         classifier confidence so the orchestrator can cap a
 *                         `stale_should_retry` to a single short probe.
 *  - `hard_429`        — a 429 that is NOT hold-eligible (non-OAuth-Anthropic,
 *                         hard-limit status, no headroom + no retry hint, or
 *                         feature disabled). Normal failover.
 *  - `auth`            — upstream 401.
 *  - `overload_529`    — provider overload (529) → provider-overload cooldown.
 *  - `model_not_found` — a forwarded model-not-found (404/400). (Not a `null`
 *                         return — recorded for completeness when applicable.)
 *  - `network_error`   — a thrown error in the attempt (caught failover).
 *  - `overload_suppressed` — the attempt was refused BEFORE any upstream fetch
 *                         because the overload breaker denied admission: either
 *                         a relevant bucket is open (`until` set) or another
 *                         request already holds the half-open probe lease
 *                         (`until` null). The outer loop treats it as failover;
 *                         a suppressed-only exhaustion must surface the 529
 *                         provider-overloaded terminal, not ALL_ACCOUNTS_FAILED.
 *  - `other`           — any other null-return failover not covered above.
 */
export type ProxyAttemptOutcome =
	| {
			kind: "retryable_429";
			confidence: "fresh_headroom" | "stale_should_retry";
			cooldownUntil?: number;
	  }
	| { kind: "hard_429"; cooldownUntil?: number }
	| { kind: "auth" }
	| { kind: "org_permission_denied" }
	| { kind: "overload_529"; cooldownUntil?: number }
	| { kind: "overload_suppressed"; until: number | null }
	| { kind: "model_not_found" }
	| { kind: "model_route_restricted" }
	/** The model exists, but the account plan cannot serve it. */
	| { kind: "model_not_entitled" }
	| { kind: "network_error" }
	| { kind: "other" };

/**
 * Optional, behaviour-only extension bag for {@link proxyWithAccount}. Every
 * field is optional and defaults to today's behaviour, so existing positional
 * callers and tests are unaffected.
 */
export interface ProxyAttemptOptions {
	/** True only when no account failover remains. Separate from the 529 flag,
	 * which can stop early when all remaining accounts share the overloaded provider. */
	isLastAccountAttempt?: () => boolean;
	/**
	 * Sink invoked exactly once with the categorical outcome whenever the attempt
	 * fails over (returns `null`) or forwards a model-not-found. The proxy uses it
	 * to drive the transparent burst-retry decision. Recording is routed through
	 * the internal `fail()` helper so it can never drift from the body-cancel.
	 */
	onOutcome?: (outcome: ProxyAttemptOutcome) => void;
	/**
	 * Re-probe mode for the transparent burst-retry hold. When true:
	 *   - the cache-keepalive staging step is skipped (no re-`Buffer.from` copy of
	 *     the body on each re-probe — the original attempt already staged it),
	 *   - the 429 cooldown is applied with `{ reprobe: true }` semantics (no streak
	 *     escalation, no `rate_limited_at` bump — see rate-limit-cooldown.ts).
	 * The caller (the hold orchestrator) is responsible for the cooldown-gate
	 * bypass (it invokes this directly on a held, still-cooled account).
	 */
	reprobe?: boolean;
	/**
	 * AbortSignal threaded through to the upstream `fetch` so a client disconnect
	 * (or the orchestrator giving up) aborts the in-flight request immediately —
	 * essential in re-probe mode so a disconnect releases the hold slot rather
	 * than waiting for the upstream timeout.
	 */
	signal?: AbortSignal;
	/**
	 * True when this attempt originates from a recovery hold's re-attempt sweep.
	 * Purely a LOG-LEVEL discriminator: inside a hold, an overload-admission
	 * refusal is the expected steady state (one holder probes, every other
	 * holder is refused, ~14 times per hold), and the hold emits its own
	 * one-line exit summary — so the per-attempt line goes to DEBUG. Outside a
	 * hold it stays at INFO: there it is the ONLY signal that a main-loop
	 * attempt hit contention and failed over.
	 */
	fromHold?: boolean;
}

/**
 * Max reactive stale-token refresh+retry attempts on the SAME account after an
 * upstream 401, before failing over. One is enough: a healthy stale token is
 * fixed on the single retry; a genuinely-dead account 401s again and fails over.
 * Bounding to one keeps a revoked account from looping against the same upstream.
 */
const STALE_TOKEN_MAX_RETRY = 1;

/**
 * Minimum gap between reactive stale-token refreshes for the SAME account. The
 * per-request cap (STALE_TOKEN_MAX_RETRY) bounds a single request, but a
 * successful refresh clears the token-manager backoff — so without this, an
 * account whose OAuth endpoint keeps issuing tokens the upstream still rejects
 * would trigger one fresh refresh per incoming request, hammering the token
 * endpoint under load. Within this window a 401 fails over directly. The common
 * case is unaffected: a genuinely stale token is fixed on the first retry, and
 * subsequent requests use the now-valid token and never reach this path.
 */
const STALE_TOKEN_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Per-account epoch ms of the last reactive stale-token refresh, enforcing
 * STALE_TOKEN_REFRESH_COOLDOWN_MS. Module-level (like refreshFailures /
 * cacheControlRejectors) and bounded by the account count.
 */
const lastStaleTokenRefreshAt = new Map<string, number>();

export function isSyntheticInternalRequest(headers: Headers): boolean {
	return (
		!!headers.get("x-clankermux-keepalive") ||
		!!headers.get("x-clankermux-auto-refresh")
	);
}

/**
 * Which synthetic-probe marker a call site accepts.
 *
 * The kind is LOAD-BEARING and deliberately has no default: several exemptions
 * are keepalive-only (the keepalive scheduler fans out in parallel and trips
 * Anthropic's per-IP burst limit, which an auto-refresh probe does not do), and
 * the Request-History suppressions are split one per marker. Flattening them all
 * to "any" would silently widen each exemption to the other marker.
 */
export type SyntheticProbeKind = "any" | "keepalive" | "auto-refresh";

/**
 * True only for a TRUSTED synthetic probe: an in-process scheduler dispatch
 * (`internal` — the flag handleProxy sets from its own `isInternal` parameter,
 * never from a request header) that also carries the requested marker.
 *
 * The `internal` gate is mandatory: the marker headers are client-spoofable, so
 * header presence alone must NOT let an external caller bypass operator-side
 * gates (usage throttling, 429 cooldowns, the out_of_credits floor, the
 * family-weekly safety net, burst-retry classification, the stale-token 401
 * retry, the overload hold, or Request-History recording). Use this — never the
 * header-only {@link isSyntheticInternalRequest} — wherever a probe exemption
 * would otherwise be a spoofable privilege.
 */
export function isTrustedSyntheticProbe(
	headers: Headers,
	internal: boolean,
	kind: SyntheticProbeKind,
): boolean {
	if (!internal) return false;
	switch (kind) {
		case "keepalive":
			return !!headers.get("x-clankermux-keepalive");
		case "auto-refresh":
			return !!headers.get("x-clankermux-auto-refresh");
		default:
			return isSyntheticInternalRequest(headers);
	}
}

/**
 * Determines the absolute epoch timestamp (ms since epoch) until which an account
 * should be marked rate-limited after model exhaustion. Priority:
 *   1. retry-after / x-ratelimit-reset response header (actual upstream backoff)
 *   2. getRateLimitedUntil — usage-window reset time if known
 *   3. probe-cooldown default (TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS,
 *      60s) as last resort. Was a 1-hour ban prior to v3.5.x — that locked accounts
 *      out unnecessarily when upstream returned a transient 429 without a
 *      reset hint, draining small pools to zero routable accounts on a
 *      single burst. Aligns with the same default used in
 *      response-processor.ts when 429s arrive without a reset header.
 *
 * The result is always clamped to at least 60 seconds in the future to avoid a
 * zero or negative value when a parsed timestamp is already in the past.
 *
 * NOTE: getRateLimitedUntil is injected rather than called directly on usageCache
 * so that callers in production pass usageCache.getRateLimitedUntil.bind(usageCache)
 * and tests pass a plain stub — avoiding module-mock symlink issues with Bun.
 */
export function extractCooldownUntil(
	response: Response,
	accountId: string,
	getRateLimitedUntil: (accountId: string) => number | null,
): number {
	const MIN_COOLDOWN_MS = 60 * 1000; // 60 seconds floor
	const DEFAULT_COOLDOWN_MS =
		TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS;
	const now = Date.now();

	// 1. Check retry-after / x-ratelimit-reset headers
	const retryAfter =
		response.headers.get("retry-after") ??
		response.headers.get("x-ratelimit-reset");
	if (retryAfter) {
		const parsed = Number(retryAfter);
		if (!Number.isNaN(parsed) && parsed > 0) {
			// Unix timestamp (seconds) if value looks like an epoch (> 1 billion)
			const isUnixTimestamp = parsed > 1_000_000_000;
			const epochMs = isUnixTimestamp ? parsed * 1000 : now + parsed * 1000;
			if (epochMs > now) {
				return Math.max(epochMs, now + MIN_COOLDOWN_MS);
			}
			// epochMs <= now: stale/already-past timestamp — fall through to next priority
		} else {
			// Try HTTP-date format (RFC 7231), e.g. "Wed, 21 Oct 2026 07:28:00 GMT"
			const dateMs = new Date(retryAfter).getTime();
			if (!Number.isNaN(dateMs) && dateMs > now) {
				return Math.max(dateMs, now + MIN_COOLDOWN_MS);
			}
			// Invalid or past date — fall through to next priority
		}
	}

	// 2. Fall back to usage-window reset time if available
	const rateLimitedUntil = getRateLimitedUntil(accountId);
	if (rateLimitedUntil !== null && rateLimitedUntil > now) {
		return Math.max(rateLimitedUntil, now + MIN_COOLDOWN_MS);
	}

	// 3. Last resort: 1 hour
	return now + DEFAULT_COOLDOWN_MS;
}

/**
 * Flat ceiling on the RESIDUAL 429 rungs' cooldowns (`model_fallback_429`,
 * `all_models_exhausted_429`). Parity with the provider parser's 24h reset
 * clamp: an honest minutes-to-hours retry-after passes through verbatim; a
 * multi-day or headerless pathology is bounded and re-probed daily.
 */
export const RESIDUAL_429_COOLDOWN_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * Cap the cooldown deadline the two residual 429 rungs write, or return null
 * when live scoped-only evidence proves no account-wide cooldown is warranted.
 *
 * These rungs are by construction the residue after every evidence-gated rung
 * declined — they possess NO corroborating account-wide evidence, so an
 * unbounded account-wide lock is never justified from them. Uncapped, they
 * copied the 429's `retry-after` verbatim: on a claim-scoped 429 that slipped
 * past the family rung (unresolvable model family, untrusted endpoint, or
 * unparseable claim headers) that value is the SCOPED claim's reset —
 * observed 4.5 days — under a reason outside QUOTA_DERIVED_RATE_LIMIT_REASONS,
 * which the poller's capacity-restored release is forbidden to clear
 * (the 2026-08-02 incident).
 *
 * Two arms:
 *  - a PROVABLY scoped-only rejection on a trusted official-Anthropic account
 *    gets no account-wide cooldown. An unknown family cannot be memoized, so
 *    later requests may re-ask it; this is the accepted cost of keeping other
 *    models available rather than disabling the entire account;
 *  - everything else gets the flat 24h ceiling. The asymmetry is deliberate:
 *    an over-capped genuine exhaustion self-corrects on the next 429 (which
 *    lands on an evidence rung once the usage cache recovers), whereas an
 *    uncapped scoped 429 writes a multi-day lock nothing can release.
 *
 * The evidence-gated account-wide exhaustion rung is NOT routed through this
 * helper — its uncapped server-directed deadline is backed by fresh usage
 * data and stays that way by design.
 */
export function capResidualRung429Cooldown(
	account: Account,
	response: Response,
	uncappedUntil: number,
	now: number,
): number | null {
	if (
		response.status === 429 &&
		account.provider === "anthropic" &&
		!account.custom_endpoint &&
		isScopedOnlyUnifiedRejection(response.headers)
	) {
		return null;
	}
	return Math.min(uncappedUntil, now + RESIDUAL_429_COOLDOWN_CAP_MS);
}

/**
 * Filters thinking blocks from request body
 * Used when Claude rejects thinking blocks with invalid signatures from other providers
 * @param requestBodyBuffer - The original request body buffer
 * @returns New buffer with thinking blocks filtered out, or null if filtering fails
 */
function filterThinkingBlocks(
	requestBody: ArrayBuffer | RequestBodyContext | null,
): ArrayBuffer | null {
	const bodyContext =
		requestBody instanceof RequestBodyContext
			? requestBody
			: new RequestBodyContext(requestBody);
	const requestBodyBuffer = bodyContext.getBuffer();
	if (!requestBodyBuffer) return null;

	try {
		const body = bodyContext.getParsedJson();
		if (!body) return null;

		// Only process if there are messages
		if (!body.messages || !Array.isArray(body.messages)) {
			return requestBodyBuffer;
		}

		let hasChanges = false;

		// Filter out thinking blocks from message content and track which messages were modified
		const processedMessages = body.messages.map(
			(
				msg: {
					role: string;
					content: string | Array<{ type: string; [key: string]: unknown }>;
				},
				index: number,
			) => {
				// Only process assistant messages with array content
				if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
					return { msg, isEmpty: false, hadThinking: false, index };
				}

				// Check if this message has thinking blocks
				const hadThinkingBlock = msg.content.some(
					(block: { type: string }) => block.type === "thinking",
				);

				// Filter out thinking blocks
				const filteredContent = msg.content.filter(
					(block: { type: string; [key: string]: unknown }) => {
						if (block.type === "thinking") {
							hasChanges = true;
							return false;
						}
						return true;
					},
				);

				// Check if message is now effectively empty
				const isEmpty =
					filteredContent.length === 0 ||
					(filteredContent.length === 1 &&
						filteredContent[0].type === "text" &&
						(!filteredContent[0].text || filteredContent[0].text === ""));

				return {
					msg: {
						...msg,
						content: filteredContent.length > 0 ? filteredContent : msg.content,
					},
					isEmpty,
					hadThinking: hadThinkingBlock,
					index,
				};
			},
		);

		// Just filter out thinking blocks and keep all messages
		const filteredMessages = processedMessages
			.filter(
				(item: {
					msg: {
						role: string;
						content: string | Array<{ type: string; [key: string]: unknown }>;
					};
					isEmpty: boolean;
					hadThinking: boolean;
					index: number;
				}) => {
					// Remove empty messages
					if (item.isEmpty) return false;
					return true;
				},
			)
			.map(
				(item: {
					msg: {
						role: string;
						content: string | Array<{ type: string; [key: string]: unknown }>;
					};
					isEmpty: boolean;
					hadThinking: boolean;
					index: number;
				}) => item.msg,
			);

		// Only create new buffer if we made changes
		if (hasChanges) {
			const warningMessage =
				"Disabled thinking mode due to incompatible thinking blocks from previous provider. Conversation context preserved.";
			log.info(warningMessage);

			const filteredBody = {
				...body,
				messages: filteredMessages,
				// Disable thinking mode since we removed thinking blocks
				// This prevents Claude from requiring the final message to start with thinking
				thinking: undefined,
			};
			return RequestBodyContext.fromParsed(
				requestBodyBuffer,
				filteredBody,
			).getBuffer();
		}

		return requestBodyBuffer;
	} catch (error) {
		log.warn("Failed to filter thinking blocks:", error);
		return null;
	}
}

/**
 * Checks if a response error is due to invalid thinking block signatures or thinking-related errors
 * @param response - The response to check
 * @returns True if the error is about invalid thinking blocks
 */
async function isInvalidThinkingSignatureError(
	response: Response,
): Promise<boolean> {
	if (response.status !== 400) return false;

	try {
		const contentType = response.headers.get("content-type");

		if (!contentType?.includes("application/json")) return false;

		// Clone only AFTER the content-type guard: a clone() tees the body, so
		// cloning before an early return orphans an unconsumed tee branch (leak).
		const clone = response.clone();

		const json = await clone.json();

		// Check for Claude's thinking-related errors
		if (json.error?.message && typeof json.error.message === "string") {
			const message = json.error.message;
			// Check for invalid signature error
			if (message.includes("Invalid `signature` in `thinking` block")) {
				return true;
			}
			// Check for final message must start with thinking block error
			if (
				message.includes(
					"final `assistant` message must start with a thinking block",
				)
			) {
				return true;
			}
		}
	} catch {
		// Ignore parse errors
	}

	return false;
}

/**
 * In-memory set of (accountId, model) pairs known to reject cache_control.
 * Populated on first 400 rejection; cleared on server restart (fast re-learn).
 */
const cacheControlRejectors = new Set<string>();

function cacheControlRejectorKey(accountId: string, model: string): string {
	return `${accountId}:${model}`;
}

/**
 * Checks if a 400 response is caused by an upstream provider rejecting the
 * cache_control field (e.g. GLM-5.1 strict OpenAI-compatible validation).
 */
async function isCacheControlRejectionError(
	response: Response,
): Promise<boolean> {
	if (response.status !== 400) return false;

	try {
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;
		// Clone only AFTER the content-type guard: a clone() tees the body, so
		// cloning before an early return orphans an unconsumed tee branch (leak).
		const clone = response.clone();

		const json = await clone.json();
		const message: string = json.error?.message ?? json.message ?? "";
		return (
			typeof message === "string" &&
			message.includes("cache_control") &&
			(message.includes("Extra inputs are not permitted") ||
				message.includes("unknown field"))
		);
	} catch {
		return false;
	}
}

async function isModelRouteRestrictedError(
	response: Response,
): Promise<boolean> {
	if (
		![400, 403, 404].includes(response.status) ||
		!response.headers.get("content-type")?.includes("application/json")
	)
		return false;
	try {
		return isModelRouteRestriction(
			await response.clone().json(),
			response.status,
		);
	} catch {
		return false;
	}
}

/**
 * Checks if a response error indicates the requested model is unavailable.
 * Covers Anthropic (not_found_error), OpenAI-compat (model_not_found),
 * and generic messages.
 */
export async function isModelUnavailableError(
	response: Response,
): Promise<boolean> {
	if (isZaiOverloadResponse(response)) return true;

	if (
		response.status !== 404 &&
		response.status !== 400 &&
		response.status !== 429
	)
		return false;

	if (response.status === 429) {
		return true;
	}

	try {
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;
		// Clone only AFTER the content-type guard: a clone() tees the body, so
		// cloning before an early return orphans an unconsumed tee branch (leak).
		const clone = response.clone();

		const json = await clone.json();

		// Anthropic native format
		if (json.error?.type === "not_found_error") return true;

		// OpenAI-compat format
		if (json.error?.code === "model_not_found") return true;

		// Generic: message contains "model not found" or "does not exist"
		if (
			json.error?.message &&
			typeof json.error.message === "string" &&
			(json.error.message.toLowerCase().includes("model not found") ||
				json.error.message.toLowerCase().includes("does not exist"))
		) {
			return true;
		}

		// Codex/ChatGPT-backend format: message sits on a top-level "detail"
		// field rather than under "error". See issue #393 — e.g.
		// {"detail": "The 'gpt-5.3-codex' model is not supported when using
		// Codex with a ChatGPT account."}
		if (
			typeof json.detail === "string" &&
			json.detail.toLowerCase().includes("model") &&
			(json.detail.toLowerCase().includes("not supported") ||
				json.detail.toLowerCase().includes("not found") ||
				json.detail.toLowerCase().includes("does not exist"))
		) {
			return true;
		}
	} catch {
		// Ignore parse errors
	}

	return false;
}

/**
 * Narrower sibling of isModelUnavailableError: the Codex/ChatGPT-backend
 * ENTITLEMENT error, where the model exists but this account's plan may not
 * serve it (e.g. "The 'gpt-5.3-codex' model is not supported when using Codex
 * with a ChatGPT account."). That condition is account-scoped, so failing over
 * to another account can succeed — unlike a generic model-not-found, which is
 * deliberately forwarded to the client.
 */
export async function isCodexEntitlementModelError(
	response: Response,
): Promise<boolean> {
	if (response.status !== 404 && response.status !== 400) return false;

	try {
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;
		// Clone only AFTER the content-type guard: a clone() tees the body, so
		// cloning before an early return orphans an unconsumed tee branch (leak).
		const clone = response.clone();

		const json = await clone.json();
		if (typeof json.detail !== "string") return false;
		const detail = json.detail.toLowerCase();
		return (
			detail.includes("model") &&
			detail.includes("not supported") &&
			(detail.includes("codex") || detail.includes("chatgpt"))
		);
	} catch {
		// Ignore parse errors
	}

	return false;
}

/**
 * Validate the native Responses body and apply a combo model override to it
 * (native Responses passthrough, Stage A). The body is ALWAYS parsed — even
 * with no override — so a corrupt nativeBody can never enter the native path.
 * Never throws: a parse failure returns null so the caller falls back to the
 * translated Anthropic body (defensive — the adapter always stores valid JSON).
 */
function prepareNativeBody(
	nativeBody: string,
	target: string | null | undefined,
): string {
	if (!target) throw new RoutingPolicyError("Missing resolved native model");
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(nativeBody);
	} catch {
		throw new RoutingPolicyError("Cannot parse native Responses body");
	}
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new RoutingPolicyError("Invalid native Responses body");
	rejectModelSwitchFields(body);
	body.model = target;
	return JSON.stringify(body);
}

/**
 * Handles proxy request without authentication
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param ctx - The proxy context
 * @returns Promise resolving to the response
 * @throws {ProviderError} If the unauthenticated request fails
 */

/**
 * Capture the RAW rate-limit evidence of ONE authenticated upstream attempt, the
 * instant it arrives, and hand the response straight back.
 *
 * ## Why it wraps the fetch instead of sitting on the forwarding path
 *
 * The capture used to live at the two terminal forwarding sites, which is after
 * the retry/model-cycling/thinking-signature/cache-control/stale-token branches
 * have already inspected, replaced or DISCARDED the response. The attempts those
 * branches throw away are exactly the ones the series exists to record — a 429
 * that triggered model cycling, a 401 that triggered a token refresh — so the
 * shapes worth having were the shapes systematically missing. Routing every
 * `makeProxyRequest` result through here means an attempt is recorded because it
 * HAPPENED, not because it survived.
 *
 * Called BEFORE any inspection of the response, because several of those
 * branches read (and one of them discards) the body, and `processResponse` later
 * normalizes the Codex window headers and deletes the whole `x-ratelimit-*`
 * family outright.
 *
 * `endpoint` comes from the ATTEMPT's own request URL, never the client-facing
 * `url.pathname`: an Anthropic-shaped `/v1/messages` request reaches an
 * openai-compatible backend as `/v1/chat/completions`, and the bucket rows have
 * to name the path whose limits they describe. Each retry builds its own
 * transformed request, so each attempt reports its own path.
 *
 * One call = one attempt = one `observation_id` (the hook mints it per call).
 */
function captureUpstreamAttempt(
	attemptRequest: Request,
	response: Response,
	account: Account,
	requestMeta: RequestMeta,
	clientHeaders: Headers,
	ctx: ProxyContext,
): Response {
	let endpoint: string | null = null;
	try {
		endpoint = new URL(attemptRequest.url).pathname;
	} catch {
		// A non-absolute URL cannot happen for a fetched Request, but an unknown
		// path is a legitimate row while a throw here would take down a response
		// that already succeeded upstream.
	}
	captureRawUpstreamObservation(
		{
			requestId: requestMeta.id,
			account,
			source: dispatchObservationSource(
				(name) => clientHeaders.get(name),
				requestMeta.internal === true,
			),
			requestStartedAt: requestMeta.timestamp,
			endpoint,
			httpStatus: response.status,
			headers: response.headers,
		},
		ctx,
	);
	return response;
}

/**
 * Attempts to proxy a request with a specific account
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param account - The account to use
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream (buffered earlier)
 * @param failoverAttempts - Number of failover attempts
 * @param ctx - The proxy context
 * @param returnRateLimitedResponseOnExhaustion - "this is the request's last
 *   realistic attempt, so forward a genuine upstream 529 instead of discarding
 *   it in favour of the generic pool-exhausted terminal". Prefer the PREDICATE
 *   form: whether a later candidate is still attemptable can change while this
 *   attempt is in flight (a sibling's recovery-probe lease is released, an
 *   overload bucket closes), and a boolean snapshotted before the fetch reports
 *   the state at REQUEST-PREPARATION time, not at the moment the 529 arrives.
 *   The predicate is evaluated at most once per attempt, when the response is
 *   in hand, and memoized for the rest of that attempt.
 * @returns Promise resolving to response or null if failed
 */
export async function proxyWithAccount(
	req: Request,
	url: URL,
	account: Account,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	_createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	failoverAttempts: number,
	ctx: ProxyContext,
	modelOverride?: string | null,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	requestBodyContext?: RequestBodyContext | null,
	returnRateLimitedResponseOnExhaustion: boolean | (() => boolean) = false,
	options?: ProxyAttemptOptions,
	staleTokenRetryAttempt = 0,
): Promise<Response | null> {
	modelOverride = getAttemptTarget(requestMeta, account).upstreamModel;
	const attemptAudit: RoutingAttemptAudit = { id: null };
	// Resolved lazily at the 529 decision points (see the param doc). Memoized so
	// the clone decision and the forward decision, which straddle an await, can
	// never disagree about whether this attempt is terminal.
	let terminalAttemptResolved: boolean | undefined;
	const isTerminalAttempt = (): boolean => {
		if (typeof returnRateLimitedResponseOnExhaustion !== "function") {
			return returnRateLimitedResponseOnExhaustion;
		}
		if (terminalAttemptResolved === undefined) {
			terminalAttemptResolved = returnRateLimitedResponseOnExhaustion();
		}
		return terminalAttemptResolved;
	};
	// Best-effort re-arm of this connection's Bun idle timer, threaded into
	// forwardToClient so long quiet gaps mid-stream don't reap the connection at
	// the 180s base idleTimeout. ctx.server is unset in tests / non-HTTP callers
	// (optional), in which case this is a no-op.
	const bumpIdleTimeout = () => {
		try {
			ctx.server?.timeout(req, NETWORK.SERVER_IDLE_TIMEOUT_SECONDS);
		} catch {
			// server.timeout can throw if req isn't a tracked connection
		}
	};

	// Half-open overload-probe token held by THIS attempt (null = closed buckets
	// or admission not yet acquired). Ownership either transfers into
	// forwardToClient (which settles it at the first healthy `message_start`,
	// falling back to the stream's end/error verdict) or is completed locally on
	// every non-forwarding exit. Completion is idempotent
	// and generation-checked, so belt-and-suspenders double-completion is safe.
	let overloadProbeToken: OverloadProbeToken | null = null;
	// Release the held probe lease locally and drop ownership. `fail()` calls
	// this with "abandoned" as the universal chokepoint; the 529 trip site calls
	// it with "reopened" first (fail's later "abandoned" then no-ops on null).
	const settleOverloadProbe = (
		outcome: "recovered" | "reopened" | "abandoned",
		evidence?: OverloadProbeEvidence,
	): void => {
		completeProviderOverloadProbe(overloadProbeToken, outcome, evidence);
		overloadProbeToken = null;
	};

	// Single helper that records a categorical outcome into the optional sink AND
	// disposes the upstream body, so the many failover (`return null`) paths can't
	// let recording and body-disposal drift apart (Codex's anti-drift requirement).
	// Returns `null` so call sites can `return fail(...)` directly. Also releases
	// a still-held overload-probe lease as "abandoned" — a failover means the
	// probe never reached a verdict on this attempt.
	//
	// The disposal is deliberately NOT awaited: `discardUpstreamBody` drains the
	// abandoned body in the background so this attempt can fail over to the next
	// candidate immediately. Awaiting it would make every failover wait for the
	// dead account's body — the exact stall this helper exists to avoid.
	//
	// Every fail() site disposes an EXCLUSIVELY OWNED upstream body: nothing else
	// is reading it when fail() runs, so it must be DRAINED (see
	// response-body-disposal) — a body that is neither read to EOF nor cancelled
	// keeps its socket and Bun's ~512 KB native read buffer committed, and
	// cancelling alone does not reliably return that allocation. The one site that
	// used to hand fail() a live tee branch was the rate-limited failover, back
	// when updateAccountMetadata cloned the response for usage extraction; usage
	// is now collected inline off the bytes already being forwarded, so no such
	// clone exists and there is no tee variant here any more.
	//
	// `onDrained` is a pure OBSERVER handed to the drain (see
	// discardUpstreamBody): it is invoked after this function has already
	// returned, so it can never add latency to a failover. It exists only so a
	// site can report on what it threw away.
	const fail = async (
		outcome: ProxyAttemptOutcome,
		response?: Response | null,
		onDrained?: (report: DrainReport) => void,
		auditReason?: string,
	): Promise<null> => {
		settleOverloadProbe("abandoned", "attempt_failed");
		options?.onOutcome?.(outcome);
		const reason =
			auditReason ??
			(outcome.kind === "hard_429"
				? (account.rate_limited_reason ?? "rate_limited")
				: outcome.kind);
		try {
			await recordLocalRoutingOutcome(
				attemptAudit,
				requestMeta,
				account,
				ctx,
				reason,
				response?.status ?? null,
			);
		} catch (error) {
			log.warn("Could not persist routing attempt outcome", error);
		}

		discardUpstreamBody(response, onDrained);
		return null;
	};
	// Tracks the live, uncancelled upstream response body at each stage so the
	// catch below can release it on a thrown error (e.g. a provider
	// processResponse / processProxyResponse failure after the fetch succeeded)
	// instead of leaking its socket + ~512 KB native read buffer. Updated as
	// rawResponse → taggedRawResponse → response take ownership. The explicit
	// failover return-null paths cancel directly and return before the catch, and
	// the forwardToClient returns transfer ownership (so the catch is unreached on
	// success; if forwardToClient itself throws, discard's locked-guard no-ops).
	let liveUpstream: Response | null = null;
	let activeUpstreamModel: string | null = null;
	// Trust-gated probe predicate for every exemption below. `requestMeta.internal`
	// is handleProxy's own `isInternal` parameter (default false, sourced only from
	// dispatchProxyRequest) and is therefore unspoofable; the marker headers alone
	// are not. The KIND is always explicit — several exemptions are keepalive-only
	// and must not widen to auto-refresh probes (or vice versa).
	const isTrustedProbe = (kind: SyntheticProbeKind): boolean =>
		isTrustedSyntheticProbe(req.headers, requestMeta.internal === true, kind);
	try {
		if (isDebugEnabled("proxy") || process.env.NODE_ENV === "development") {
			log.info(
				`Attempting request with account: ${account.name} (provider: ${account.provider})`,
			);
		}

		// Patch the frozen routing target before provider conversion.
		const baseBodyContext =
			requestBodyContext ?? new RequestBodyContext(requestBodyBuffer);
		const originalBody = baseBodyContext.getParsedJson();
		if (!originalBody)
			throw new RoutingPolicyError("Cannot parse inference request");
		rejectModelSwitchFields(originalBody);
		const effectiveBodyContext =
			baseBodyContext.withPatchedModel(modelOverride);
		if (!effectiveBodyContext)
			throw new RoutingPolicyError("Cannot apply resolved model");
		const effectiveBodyBuffer = effectiveBodyContext.getBuffer();

		// Stage the original request body + headers for cache keepalive replay.
		// Preserve the resolved model for a faithful replay to this destination.
		// Headers are stored because Anthropic's prepareHeaders() copies incoming
		// client headers (anthropic-version, anthropic-beta, x-stainless-*, etc.)
		// and augments them — providers that build headers from scratch ignore them.
		// Skip staging for internal synthetic requests:
		//   - keepalive replays — prevent infinite loop
		//   - auto-refresh probes — same loop-prevention concern, plus these
		//     hit known-cooled accounts and shouldn't pollute the staged-body cache
		//     (issue #199, bug 2).
		// Both checks are truthy (not strict-equality) to preserve the original
		// keepalive guard's behaviour: any non-empty header value triggers the
		// skip, matching what `!req.headers.get(...)` returned before.
		//
		// Also skip on a transparent-retry re-probe: the original attempt already
		// staged this request id (same account), and stageRequest() does a real
		// `Buffer.from(body)` copy (~0.5–1.5 MB) — re-staging it on every gentle
		// re-probe would churn that copy needlessly.
		if (!isTrustedProbe("any") && !options?.reprobe) {
			cacheBodyStore.stageRequest(
				requestMeta.id,
				account.id,
				effectiveBodyBuffer,
				req.headers,
				url.pathname,
				requestMeta.affinityKey ?? null,
				account.provider,
			);
		}

		// Get the provider for this account
		const provider = getProvider(account.provider) || ctx.provider;

		// Validate that the account-specific provider can handle this path.
		//
		// Caught HERE, around this one call, rather than left to the attempt-wide
		// catch below: an incompatible path is a routing fact about this account
		// (only CodexProvider restricts paths at all), not a failure — nothing was
		// sent and nothing broke. The attempt-wide catch logged it at ERROR and
		// classified it as `network_error`. Failover behaviour is unchanged: the
		// attempt still fails over through `fail()`, and an all-Codex pool asked
		// for an endpoint Codex does not serve still reaches the generic give-up
		// terminal.
		//
		// Deliberately NOT a broad ValidationError catch: request transformation
		// and reasoning validation throw the same class further down this
		// function, and those keep their existing (loud) handling.
		try {
			validateProviderPath(provider, url.pathname);
		} catch (error) {
			if (!(error instanceof ValidationError)) throw error;
			log.debug(
				`Account ${account.name} (${account.provider}) cannot serve ${url.pathname} — failing over`,
			);
			return await fail({ kind: "other" });
		}

		// Skip token refresh for explicitly supported local count paths that
		// never reach the upstream network.
		const isLocalCountTokens =
			supportsLocalTokenCounting(account.provider, account.custom_endpoint) &&
			url.pathname === "/v1/messages/count_tokens";
		const accessToken = isLocalCountTokens
			? undefined
			: await getValidAccessToken(account, ctx);

		// Pre-process request if provider supports it (e.g., to extract model for URL)
		if (provider.prepareRequest) {
			provider.prepareRequest(req, effectiveBodyBuffer, account);
		}

		// Prepare request using account-specific provider
		const headers = provider.prepareHeaders(
			req.headers,
			accessToken,
			account.api_key || undefined,
		);
		// Strip client-supplied synthetic-response markers: a client cannot forge
		// a synthetic count_tokens response by injecting these headers. The provider
		// is the only code that may legitimately set them (on a trusted internal URL).
		headers.delete("x-clankermux-synthetic-response");
		headers.delete("x-clankermux-synthetic-status");
		const targetUrl = provider.buildUrl(url.pathname, url.search, account);

		// ── Native Responses passthrough (Stage A, request leg) ────────────────
		// When the client request was an OpenAI-Responses call (the adapter
		// attached a NativeResponsesContext) and this attempt targets a codex
		// account, forward the ORIGINAL Responses body instead of the
		// double-translated Anthropic body. What the CLIENT asked for does not
		// enter into it: the upstream transport is SSE either way (the provider
		// forces `stream: true`), and the adapter reduces that SSE to a single
		// JSON document for a non-streaming client. The decision is strictly
		// per-attempt: the translated effectiveBodyBuffer stays untouched, so a
		// failover to a non-codex account re-enters here and picks it up.
		const nativeCtx = getNativeResponsesMetaContext(requestMeta);
		const useNative = nativeCtx !== undefined && account.provider === "codex";
		let nativeBodyText: string | null = null;
		if (nativeCtx && useNative) {
			nativeBodyText = prepareNativeBody(nativeCtx.nativeBody, modelOverride);
			if (nativeBodyText !== null) {
				log.info(
					`Native Responses passthrough: forwarding original request to ${account.name}`,
				);
			} else {
				log.warn(
					`Native Responses passthrough: unparseable native body (model override: ${modelOverride ? `"${modelOverride}"` : "none"}) — using translated body for ${account.name}`,
				);
			}
		} else if (nativeCtx && account.provider !== "codex") {
			log.debug(
				`Native passthrough unavailable for account ${account.name} (provider ${account.provider}); using translated body`,
			);
		}

		const requestInit: RequestInit & { duplex?: "half" } = {
			method: req.method,
			headers,
		};
		if (nativeBodyText !== null) {
			// Use a copy of the prepared headers: the shared `headers` object is
			// reused by the translated-body retry paths below (thinking-signature,
			// model cycling), which must NOT carry the native flag.
			const nativeHeaders = new Headers(headers);
			nativeHeaders.set(NATIVE_RESPONSES_REQUEST_HEADER, "1");
			requestInit.headers = nativeHeaders;
			requestInit.body = nativeBodyText;
			requestInit.duplex = "half";
		} else if (effectiveBodyBuffer) {
			requestInit.body = new Uint8Array(effectiveBodyBuffer);
			requestInit.duplex = "half";
		}

		const providerRequest = new Request(targetUrl, requestInit);

		let transformedRequest = provider.transformRequestBody
			? await provider.transformRequestBody(providerRequest, account)
			: providerRequest;

		// Pre-strip cache_control for (account, model) pairs known to reject it
		const transformedBodyText = await transformedRequest.clone().text();
		let transformedBodyJson: Record<string, unknown> | null = null;
		try {
			transformedBodyJson = JSON.parse(transformedBodyText);
		} catch {
			// ignore
		}

		// ── Native Responses passthrough: capture the relay flag, strip the
		// internal header ─────────────────────────────────────────────────────
		// The TRANSFORMED request is authoritative for the native flag (the
		// provider strips it in its parse-failure fallback, so reading it here —
		// not the nativeBodyText decision above — can never mis-mark a fallback
		// response as native). Capture it into a boolean for the response tag
		// below, then DELETE the internal header so it never reaches the
		// upstream Codex backend.
		const nativeUpstreamAttempt =
			transformedRequest.headers.get(NATIVE_RESPONSES_REQUEST_HEADER) === "1";
		if (nativeUpstreamAttempt) {
			const outboundHeaders = new Headers(transformedRequest.headers);
			outboundHeaders.delete(NATIVE_RESPONSES_REQUEST_HEADER);
			transformedRequest = new Request(transformedRequest.url, {
				method: transformedRequest.method,
				headers: outboundHeaders,
				body: transformedBodyText,
			});
		}
		const transformedModel =
			(transformedBodyJson?.model as string | undefined) ?? "";
		activeUpstreamModel = transformedModel || null;

		const computeOverloadAttributionModel = (): string | null =>
			resolveOverloadAttributionModel(
				activeUpstreamModel,
				effectiveBodyContext.getModel(),
			);
		const overloadAttributionModel = computeOverloadAttributionModel();
		if (
			transformedModel &&
			cacheControlRejectors.has(
				cacheControlRejectorKey(account.id, transformedModel),
			) &&
			transformedBodyJson
		) {
			stripCacheControlFromOpenAIRequest(
				transformedBodyJson as unknown as Parameters<
					typeof stripCacheControlFromOpenAIRequest
				>[0],
			);
			transformedRequest = new Request(transformedRequest.url, {
				method: transformedRequest.method,
				headers: transformedRequest.headers,
				body: JSON.stringify(transformedBodyJson),
			});
			log.debug(
				`Pre-stripped cache_control for known rejector: account=${account.name} model=${transformedModel}`,
			);
		}

		if (!isLocalCountTokens) {
			const overloadAdmission = tryAcquireProviderOverloadProbe(
				account.provider,
				overloadAttributionModel,
			);
			if (!overloadAdmission.admitted) {
				const refusalLine = `Overload probe admission refused for account ${account.name} (${overloadAdmission.reason}) — failing over without an upstream attempt`;
				if (options?.fromHold) {
					log.debug(refusalLine);
				} else {
					log.info(refusalLine);
				}
				return await fail({
					kind: "overload_suppressed",
					until: overloadAdmission.until,
				});
			}
			overloadProbeToken = overloadAdmission.token;
		}

		// Every authenticated upstream attempt in this function goes through this
		// wrapper, so the raw window/bucket evidence is recorded before anything
		// below can inspect, replace or discard the response. See
		// captureUpstreamAttempt.
		const captureAttempt = (
			attemptRequest: Request,
			response: Response,
		): Response =>
			captureUpstreamAttempt(
				attemptRequest,
				response,
				account,
				requestMeta,
				req.headers,
				ctx,
			);

		const forwardAttempt = async (
			attemptRequest: Request,
		): Promise<Response> => {
			const previousUpstream = liveUpstream;
			// fetch consumes bodies; retain a replayable template only for Zai.
			const replay = account.provider === "zai" ? attemptRequest.clone() : null;
			const send = async (): Promise<Response> => {
				const outgoing = replay ? replay.clone() : attemptRequest;
				const response = captureAttempt(
					outgoing,
					await sendAuthorizedRequest(
						outgoing,
						account,
						requestMeta,
						ctx,
						options?.signal,
						attemptAudit,
					),
				);
				liveUpstream = response;
				return response;
			};
			const response = await send();
			if (account.provider !== "zai") return response;
			try {
				return await recoverZaiOverload(response, send, options?.signal);
			} catch (error) {
				// A failed/aborted peek may own a retry response already. Release
				// it even when the cache-control retry's local catch keeps its 400.
				discardUpstreamBody(liveUpstream ?? response);
				liveUpstream = previousUpstream;
				throw error;
			}
		};

		const finishZaiOverload = async (
			response: Response,
		): Promise<Response | null> => {
			log.warn(`Z.ai overload retries exhausted on account ${account.name}`);
			if (isTerminalAttempt()) {
				settleOverloadProbe("abandoned", "sse_overloaded_error");
				options?.onOutcome?.({ kind: "other" });
				return forwardToClient(
					{
						clientSignal: req.signal,
						requestId: requestMeta.id,
						method: req.method,
						path: url.pathname,
						account,
						poolCandidates: getPoolHeadroomCandidates(requestMeta),
						internal: requestMeta.internal === true,
						requestHeaders: req.headers,
						requestBody: effectiveBodyBuffer,
						requestedModel: requestMeta.requestedModel,
						fallbackCreditClaimed: requestMeta.fallbackCreditClaimed,
						fallbackFromModel: requestMeta.fallbackFromModel,
						project: requestMeta.project,
						projectAttributionSource: requestMeta.projectAttributionSource,
						contextComposition: requestMeta.contextComposition,
						toolCallStats: requestMeta.toolCallStats,
						reasoningEffort: requestMeta.reasoningEffort,
						sessionKey: requestMeta.sessionKey,
						cachePrefixHashes: requestMeta.cachePrefixHashes,
						response,
						timestamp: requestMeta.timestamp,
						retryAttempt: 0,
						failoverAttempts,
						comboName: requestMeta.comboName,
						apiKeyId,
						apiKeyName,
						routing: requestMeta.routing ?? null,
						upstreamModel: overloadAttributionModel,
						bumpIdleTimeout,
					},
					{ ...ctx, provider },
				);
			}
			// This model exhausted its local retry budget. It has no provider
			// breaker to wait on, so do not seed the Anthropic overload hold or
			// exclude the account from attempts using another model.
			return fail({ kind: "other" }, response);
		};

		// Make the request. Thread the caller's AbortSignal (if any) into the
		// upstream fetch so a client disconnect aborts it immediately — essential
		// in re-probe mode so a disconnect releases the hold slot promptly. When
		// absent, makeProxyRequest installs its own timeout controller as before.
		let rawResponse = await forwardAttempt(transformedRequest);
		liveUpstream = rawResponse;

		// Check if this is a Claude provider and we got an invalid thinking signature error
		const isClaudeProvider =
			provider.name === "anthropic" || account.provider === "claude-oauth";
		if (
			isClaudeProvider &&
			(await isInvalidThinkingSignatureError(rawResponse))
		) {
			log.info(
				`Detected invalid thinking block signature error for account ${account.name}, retrying with thinking blocks filtered`,
			);

			// Filter thinking blocks from the request body
			const filteredBodyBuffer = filterThinkingBlocks(effectiveBodyContext);

			if (filteredBodyBuffer && filteredBodyBuffer !== effectiveBodyBuffer) {
				// Retry the request with filtered body
				const retryRequestInit: RequestInit & { duplex?: "half" } = {
					method: req.method,
					headers,
					body: new Uint8Array(filteredBodyBuffer),
					duplex: "half",
				};

				const retryProviderRequest = new Request(targetUrl, retryRequestInit);

				const retryTransformedRequest = provider.transformRequestBody
					? await provider.transformRequestBody(retryProviderRequest, account)
					: retryProviderRequest;

				// Acquire the retry FIRST, then discard the original body so its
				// socket + ~512 KB read buffer is released. Acquiring first means a
				// throw here leaves the original intact for the outer catch/failover
				// instead of proceeding with an already-discarded body.
				const retryResponse = await forwardAttempt(retryTransformedRequest);
				discardUpstreamBody(rawResponse);
				rawResponse = retryResponse;
				liveUpstream = rawResponse;
			} else {
				log.warn(
					"Failed to filter thinking blocks or no changes made, proceeding with original error response",
				);
			}
		}

		// Retry without cache_control if provider rejected it (e.g. GLM-5.1 strict validation).
		// Mark (accountId, model) so subsequent requests skip cache_control immediately.
		if (await isCacheControlRejectionError(rawResponse)) {
			const rejectorKey = cacheControlRejectorKey(account.id, transformedModel);
			if (!cacheControlRejectors.has(rejectorKey)) {
				// Mark before retry so subsequent requests pre-strip without a round-trip.
				// The current caller still receives the retried response (or the original
				// 400 if the retry also fails).
				cacheControlRejectors.add(rejectorKey);
				log.info(
					`Provider rejected cache_control for account=${account.name} model=${transformedModel}, retrying without it`,
				);
			}

			try {
				const retryBodyJson = JSON.parse(transformedBodyText);
				stripCacheControlFromOpenAIRequest(retryBodyJson);
				const retryRequest = new Request(transformedRequest.url, {
					method: transformedRequest.method,
					headers: transformedRequest.headers,
					body: JSON.stringify(retryBodyJson),
				});
				// Acquire the retry FIRST: if makeProxyRequest throws, the local
				// catch below continues with the original 400 still intact (its body
				// not yet discarded), preserving the "forward the original 400 on
				// retry failure" contract.
				const retryResponse = await forwardAttempt(retryRequest);
				discardUpstreamBody(rawResponse);
				rawResponse = retryResponse;
				liveUpstream = rawResponse;
			} catch (err) {
				if (err instanceof RoutingPolicyError) throw err;
				if (options?.signal?.aborted || req.signal.aborted) throw err;
				liveUpstream = rawResponse;
				log.warn("Failed to retry without cache_control:", err);
			}
		}

		const routeRestricted = await isModelRouteRestrictedError(rawResponse);
		if (routeRestricted) {
			if (options?.isLastAccountAttempt && !options.isLastAccountAttempt()) {
				return await fail({ kind: "model_route_restricted" }, rawResponse);
			}
			// Preserve the final actionable upstream envelope through normal response handling.
			options?.onOutcome?.({ kind: "model_route_restricted" });
			try {
				await recordLocalRoutingOutcome(
					attemptAudit,
					requestMeta,
					account,
					ctx,
					"model_route_restricted",
					rawResponse.status,
				);
			} catch (error) {
				log.warn("Could not persist routing restriction outcome", error);
			}
		}
		if (!routeRestricted && (await isModelUnavailableError(rawResponse))) {
			// Log 429 response headers for debugging upstream rate-limit info
			if (rawResponse.status === 429) {
				const rlHeaders: Record<string, string> = {};
				rawResponse.headers.forEach((v, k) => {
					const lk = k.toLowerCase();
					if (
						lk.includes("rate") ||
						lk.includes("retry") ||
						lk.includes("limit") ||
						lk.includes("reset") ||
						lk.includes("x-") ||
						lk.includes("quota")
					) {
						rlHeaders[k] = v;
					}
				});
				log.debug(
					`Account ${account.name} received 429 — headers: ${JSON.stringify(rlHeaders)}`,
				);
			}

			let requestedModel: string | null = null;
			if (effectiveBodyBuffer) requestedModel = effectiveBodyContext.getModel();

			const finishQuotaRejection = async (
				response: Response,
				quota: AccountQuota429,
				_model: string | null,
				source: "claims" | "usage",
			): Promise<Response | null> => {
				applyRateLimitCooldown(account, quota, ctx);
				// The helper sets this synchronously, including adaptive no-reset
				// backoff. Outcomes must report the applied deadline, not a default.
				const cooldownUntil = account.rate_limited_until as number;
				// Persist the 429's unified-status header so the dashboard chip
				// reflects the live value rather than the last success.
				persistRateLimitStatusMeta(account, response, ctx, provider);
				log.warn(
					`Account ${account.name} ${quota.binding}-exhausted (429, evidence=${source}) — cooldown until ${new Date(cooldownUntil).toISOString()}, failing over (no burst-retry)`,
				);
				return await fail({ kind: "hard_429", cooldownUntil }, response);
			};
			const liveAccountQuota = !isTrustedProbe("keepalive")
				? resolveLiveAccountQuota429(account, rawResponse)
				: null;

			// Live scoped rejection is newer than even a freshly polled snapshot.
			// Resolve it before the reprobe shortcut as quota can run out mid-hold.
			const liveScopedOnlyRejection =
				rawResponse.status === 429 &&
				account.provider === "anthropic" &&
				!account.custom_endpoint &&
				isScopedOnlyUnifiedRejection(rawResponse.headers);
			const headerFamilyExclusion =
				rawResponse.status === 429 && !isTrustedProbe("any")
					? resolveFamilyWeeklyExclusionFromHeaders(
							account,
							requestedModel,
							rawResponse,
							Date.now(),
						)
					: null;

			if (
				options?.reprobe &&
				!liveAccountQuota &&
				!liveScopedOnlyRejection &&
				rawResponse.status === 429 &&
				!isAnthropicOutOfCredits(rawResponse)
			) {
				// Hold admission does not renew shared evidence. A new upstream
				// burst does, using the same live-evidence classifier as first attempts.
				const now = Date.now();
				const classification = classify429Transient({
					response: rawResponse,
					account,
					now,
					getCapacity: () =>
						getFreshCapacity(
							usageCache,
							account.id,
							account.provider,
							now,
							BURST_RETRY_MAX_USAGE_AGE_MS,
						),
				});
				if (classification.retryable) {
					markAnthropicBurstThrottle(now);
				}
				// Same ceiling as the burst intercept, for the same reason and with
				// more force: a re-probe only happens INSIDE an active hold, so this
				// 429 is by construction one the orchestrator is still treating as
				// transient, and it reaches here without passing the account-wide or
				// family rungs at all (they sit below this short-circuit). Copying a
				// multi-day `retry-after` verbatim would push the held account's
				// in-memory deadline out to that value, which both ends the hold on
				// `cooldownWait > remaining` and — because the give-up terminal
				// derives its client-facing `Retry-After` from this same field — hands
				// the caller a 92-hour retry instruction while describing the
				// condition as brief. See BURST_RETRY_COOLDOWN_CAP_MS.
				const cooldownUntil = Math.min(
					extractCooldownUntil(
						rawResponse,
						account.id,
						usageCache.getRateLimitedUntil.bind(usageCache),
					),
					Date.now() + BURST_RETRY_COOLDOWN_CAP_MS,
				);
				applyRateLimitCooldown(
					account,
					{ resetTime: cooldownUntil, reason: "model_fallback_429" },
					ctx,
					{ reprobe: true },
				);
				// `confidence` here is NOT consumed by the hold orchestrator: a
				// re-probe outcome is collapsed to `Response | null` (see ReprobeFn)
				// before it reaches `holdAndRetryCacheAccount`, which branches solely
				// on the confidence it captured at hold entry. This hardcoded value is
				// therefore inert for orchestration and must not be relied upon for it.
				return await fail(
					{
						kind: "retryable_429",
						confidence: "fresh_headroom",
						cooldownUntil,
					},
					rawResponse,
				);
			}

			if (
				rawResponse.status === 429 &&
				isAnthropicOutOfCredits(rawResponse) &&
				!isTrustedProbe("any")
			) {
				const now = Date.now();
				const windowReset = usageCache.getRateLimitedUntil(account.id);
				const floorUntil = Math.max(
					now + TIME_CONSTANTS.OUT_OF_CREDITS_COOLDOWN_MS,
					windowReset && windowReset > now ? windowReset : 0,
				);
				const reason: RateLimitReason = "out_of_credits";
				// floorUntil bypasses the exponential-backoff min() cap so the long
				// cooldown actually sticks (see applyRateLimitCooldown.floorUntil).
				applyRateLimitCooldown(account, { floorUntil, reason }, ctx);
				// Persist the 429's unified-status header so the dashboard chip
				// doesn't freeze at the last successful response's value.
				persistRateLimitStatusMeta(account, rawResponse, ctx, provider);

				log.warn(
					`Account ${account.name} out_of_credits (429) — long cooldown until ${new Date(floorUntil).toISOString()}, failing over (no burst-retry, no model cycling)`,
				);
				return await fail(
					{ kind: "hard_429", cooldownUntil: floorUntil },
					rawResponse,
				);
			}

			// A current per-claim rejection already names the quota and its reset.
			// Handle it before polling (even mid-hold): fresh cached headroom may
			// lag depletion, and the summary may describe a different scoped claim.
			if (liveAccountQuota) {
				return await finishQuotaRejection(
					rawResponse,
					liveAccountQuota,
					requestedModel,
					"claims",
				);
			}

			// ── One shared usage refresh for every 429 evidence rung ───────────
			// The three rungs below — account-wide exhaustion, the family-weekly
			// safety net, and the transparent burst-retry intercept — all decide
			// from the same usage cache, but they used to reach it at different
			// times: only the burst rung refreshed a stale cache, and it sits LAST.
			// On a stale cache the two rungs above it failed open on missing
			// evidence, the burst rung refreshed, and the fresh headroom it then
			// read got the 429 classified as a transient burst. That is the exact
			// inversion the ladder's ORDER exists to prevent, and it is not a rare
			// window: on 2026-07-30 a fable-weekly 429 arrived 203s after the last
			// poll — 23s past FAMILY_WEEKLY_MAX_USAGE_AGE_MS — and cooled the
			// account ACCOUNT-WIDE for 92 hours instead of failing over for one
			// family. Ordering only protects the rungs if the earlier ones are not
			// evidence-starved relative to the later ones.
			//
			// The trigger is the LOOSEST bound in the ladder
			// (FAMILY_WEEKLY_MAX_USAGE_AGE_MS, 180s) — deliberately not the burst
			// rung's tighter 120s — so this never buys a fetch the old code wouldn't
			// have made. Null at 180s means the two rungs above are about to fail
			// open on missing evidence and hand the 429 to the burst rung, which
			// would then have refreshed anyway: same one fetch, just early enough to
			// be useful. Triggering at 120s instead would fire in the 120-180s band,
			// where the rungs above are still satisfied and may return before the
			// burst rung ever runs — costing a fetch AND up to 5s of latency that
			// the old code did not spend. The burst rung keeps its own lazy refresh
			// for exactly that band, gated on `usageRefreshAttempted` below.
			//
			// refreshNow single-flights and bounds itself (5s timeout, failure →
			// false), so a dead usage endpoint costs one bounded wait and every rung
			// then fails open exactly as it did before. `usageRefreshAttempted`
			// records the ATTEMPT, not its success: a refresh that fails, or that
			// succeeds with content still yielding no capacity, leaves the cache
			// null, and single-flight does not dedupe a second SEQUENTIAL call — so
			// without the flag the burst rung would fetch again and a dead endpoint
			// would cost two bounded waits (~10s) on one request.
			let usageRefreshAttempted = false;
			if (
				rawResponse.status === 429 &&
				!options?.reprobe &&
				!isTrustedProbe("any") &&
				getFreshCapacity(
					usageCache,
					account.id,
					account.provider,
					Date.now(),
					FAMILY_WEEKLY_MAX_USAGE_AGE_MS,
				) === null
			) {
				usageRefreshAttempted = true;
				await usageCache.refreshNow(account.id);
			}

			// ── Cached account-wide exhaustion: fallback when live claims are absent ─────────
			// A 429 on an Anthropic account whose ACCOUNT-WIDE window is already
			// spent (per FRESH usage data) is not a transient burst: the window is
			// spent right now, so holding and re-probing the account only burns
			// latency. Record the truthful reason — `weekly_exhausted_429` when the
			// weekly class binds, `session_exhausted_429` when only the 5h session
			// window is spent — and fail over immediately. Both reasons are
			// quota-derived BY CONSTRUCTION (we read the window ourselves rather
			// than inferring the cause from headers), which is what makes them
			// eligible for the poller's early capacity-restored release.
			//
			// Weekly outranks session (see `accountWideExhaustion`), so whenever the
			// weekly window is spent this behaves exactly as it did when the block
			// was weekly-only; the session-only case is the new behaviour.
			//
			// Cache-only classification retains its existing retry-after deadline.
			// Explicit live 5h/7d rejections were handled above using those claims'
			// own validated resets; a scoped summary cannot override them here.
			//
			// Fails open: with stale/absent usage every existing path behaves
			// exactly as before. Anthropic only — Codex windows belong to
			// the CodexSpendCoordinator. Trusted-probe gated because the marker
			// headers are client-spoofable.
			if (
				rawResponse.status === 429 &&
				account.provider === "anthropic" &&
				!liveScopedOnlyRejection &&
				!options?.reprobe &&
				!isTrustedProbe("any")
			) {
				const now = Date.now();
				// getFreshCapacity is only the 180s FRESHNESS gate here; the
				// exhaustion verdict itself comes from accountWideExhaustion.
				const usageIsFresh =
					getFreshCapacity(
						usageCache,
						account.id,
						account.provider,
						now,
						FAMILY_WEEKLY_MAX_USAGE_AGE_MS,
					) !== null;
				const exhaustion = usageIsFresh
					? accountWideExhaustion(
							usageCache.get(account.id) as AnthropicUsageData | null,
							now,
						)
					: { exhausted: false, binding: null, resetMs: null };
				if (
					exhaustion.exhausted &&
					exhaustion.resetMs !== null &&
					exhaustion.resetMs > now
				) {
					const reason: RateLimitReason =
						exhaustion.binding === "weekly"
							? "weekly_exhausted_429"
							: "session_exhausted_429";
					const cooldownUntil = extractCooldownUntil(
						rawResponse,
						account.id,
						usageCache.getRateLimitedUntil.bind(usageCache),
					);
					return await finishQuotaRejection(
						rawResponse,
						{
							binding: exhaustion.binding === "weekly" ? "weekly" : "session",
							reason,
							resetTime: cooldownUntil,
						},
						requestedModel,
						"usage",
					);
				}
			}

			// ── Reactive family-weekly safety net ───────────────────────────
			// A family-scoped weekly 429 that slipped past the proactive gate (e.g.
			// the usage poll lagged behind the exhaustion). If limits[] confirms the
			// REQUESTED family is weekly-exhausted while unified 5h/7d headroom
			// remains, do NOT apply an account-wide cooldown — that would sideline
			// the account for EVERY family until the weekly reset (the exact bug
			// this feature fixes). Record an audit row and fail over so a sibling
			// serves it; the proactive gate re-excludes this account for the family
			// on the next request from the same cache. Placed BEFORE the burst-retry
			// intercept so a family-exhausted 429 (which keeps unified headroom) is
			// never misclassified as a holdable transient burst. Skipped for
			// synthetic keepalive/internal replays.
			//
			// The LIVE response's unified-status header is authoritative and beats
			// the cache: if it reports a hard ACCOUNT-LEVEL limit (rate_limited /
			// blocked / payment_required), this is a genuine account-wide 429 and we
			// must NOT skip the cooldown, however stale/fresh the cache looks. A true
			// family-scoped weekly 429 keeps unified headroom, so it carries a
			// non-hard unified status — the guard still fires for it.
			if (
				rawResponse.status === 429 &&
				requestedModel &&
				(!options?.reprobe || headerFamilyExclusion !== null) &&
				!isTrustedProbe("any") &&
				!isAnthropicHardLimitStatus(rawResponse) &&
				// Live account-wide evidence outranks EVERY family verdict: when the
				// 429's own unified headers report the 5h/7d window itself rejecting,
				// the account is genuinely spent right now, and a cache- OR
				// header-derived family exclusion (from a cache that merely lags the
				// exhaustion) must not suppress the legitimate cooldown. Bursts carry
				// no unified headers, so they never trip this veto.
				!hasAccountWideUnifiedRejection(rawResponse)
			) {
				const now = Date.now();
				const familyFreshCapacity = getFreshCapacity(
					usageCache,
					account.id,
					account.provider,
					now,
					FAMILY_WEEKLY_MAX_USAGE_AGE_MS,
				);
				const cacheFamilyExclusion = resolveFamilyWeeklyExclusion(
					account,
					requestedModel,
					usageCache.get(account.id),
					familyFreshCapacity,
					now,
				);
				// The response is authoritative: a recent usage poll can still lag a
				// scoped rejection. If it lacks a usable reset, retain the fresh
				// same-family cache reset so the memo still prevents repeat 429s.
				const cachedReset =
					cacheFamilyExclusion &&
					cacheFamilyExclusion.family === headerFamilyExclusion?.family &&
					Number.isFinite(cacheFamilyExclusion.resetAt) &&
					cacheFamilyExclusion.resetAt > now
						? cacheFamilyExclusion.resetAt
						: null;
				const familyExclusion = headerFamilyExclusion
					? {
							...headerFamilyExclusion,
							resetAt: headerFamilyExclusion.resetAt ?? cachedReset ?? now,
						}
					: cacheFamilyExclusion;
				if (familyExclusion) {
					// Remember what this 429 just taught us, so the proactive gate can
					// act on it before the usage poll catches up. Without this the
					// finding died here: the next request re-derived eligibility from a
					// cache still reporting headroom, picked this same account for this
					// same family, and earned this same 429 — eighteen times in seven
					// minutes on 2026-08-17. Family-scoped by construction, so it does
					// not undo the deliberate no-account-wide-cooldown decision below.
					recordFamilyWeeklyExhausted(
						account.id,
						familyExclusion.family,
						familyExclusion.resetAt,
						now,
					);
					completeRateLimitProbe(account, "abandoned");
					// Persist the 429's unified-status header so the dashboard chip
					// reflects the live value rather than the last success.
					persistRateLimitStatusMeta(account, rawResponse, ctx, provider);

					log.warn(
						`Account ${account.name} weekly-exhausted for family=${familyExclusion.family} (429, unified headroom present${headerFamilyExclusion ? "; live scoped header evidence" : ""}) — failing over WITHOUT account-wide cooldown`,
					);
					return await fail(
						{ kind: "other" },
						rawResponse,
						undefined,
						"family_weekly_exhausted_429",
					);
				}
			}

			if (
				rawResponse.status === 429 &&
				!options?.reprobe &&
				!isTrustedProbe("any")
			) {
				const now = Date.now();
				// Read fresh capacity once. When usage is stale/absent
				// (getFreshCapacity → null), ONE best-effort refresh runs before
				// falling back to the `x-should-retry` hint — so a real burst 429
				// doesn't fall through to sibling failover just because the usage
				// cache happened to be cold. This rung's bound (120s) is TIGHTER
				// than the shared refresh's trigger (180s), so it still owns the
				// 120-180s band: there the rungs above are satisfied and no shared
				// refresh ran, but this rung wants tighter evidence before spending
				// the full hold budget. `usageRefreshAttempted` keeps the total at
				// ONE fetch per 429 — above 180s the shared block already tried, and
				// re-trying here would only re-pay a failed endpoint's timeout. The
				// refresh is a single, self-bounded fetch (usageCache.refreshNow
				// handles its own 5s timeout + failure → false); we re-read capacity
				// afterward. The predicate itself stays pure/synchronous: it
				// classifies on the pre-resolved capacity value via the closure
				// below.
				let capacity = getFreshCapacity(
					usageCache,
					account.id,
					account.provider,
					now,
					BURST_RETRY_MAX_USAGE_AGE_MS,
				);
				if (capacity === null && !usageRefreshAttempted) {
					const refreshed = await usageCache.refreshNow(account.id);
					if (refreshed) {
						// Re-read against the same `now` budget; refreshNow updated the
						// cache timestamp so a successful fetch is fresh by definition.
						capacity = getFreshCapacity(
							usageCache,
							account.id,
							account.provider,
							now,
							BURST_RETRY_MAX_USAGE_AGE_MS,
						);
					}
				}
				const classification = classify429Transient({
					response: rawResponse,
					account,
					now,
					// Pre-resolved capacity (refreshed once if it was stale/absent).
					getCapacity: () => capacity,
				});
				if (classification.retryable) {
					// Activate the shared burst marker SYNCHRONOUSLY — at the instant
					// of classification, BEFORE the cooldown write, the audit enqueue,
					// and the `await fail()` body-discard below. This closes a
					// concurrency race (Finding 1): a sibling-Anthropic affinity
					// request that arrives after this account is marked cooled but
					// before the marker is set would otherwise divert to a sibling,
					// breaking the "never sibling on burst" invariant. Hold
					// admission does not renew the marker: only a new upstream 429
					// extends burst evidence, regardless of whether a hold slot is
					// later acquired.
					markAnthropicBurstThrottle(now);
					// Cap the deadline at the burst ceiling. The classification above
					// and `extractCooldownUntil` read different evidence — headroom vs
					// whatever `retry-after` the response carried — and they disagree
					// whenever the window Anthropic rejected on is one the unified
					// headers don't express (a family-scoped weekly, the
					// overage-included seven-day claim). Honouring the header verbatim
					// then writes a multi-day ACCOUNT-WIDE lock off a "transient burst"
					// verdict. A genuine burst carries no reset header at all, so it
					// lands on extractCooldownUntil's shorter 60s fallback and this
					// min() leaves it alone; server hints that fit the hold budget
					// survive too. See BURST_RETRY_COOLDOWN_CAP_MS.
					const cooldownUntil = Math.min(
						extractCooldownUntil(
							rawResponse,
							account.id,
							usageCache.getRateLimitedUntil.bind(usageCache),
						),
						now + BURST_RETRY_COOLDOWN_CAP_MS,
					);
					// Mark the cache account rate-limited via the normal (non-reprobe)
					// cooldown so the affinity strategy holds the pin and concurrent
					// requests resolve to `affinity_hold` (the shared burst marker +
					// hold path then take over in proxy.ts). The audit row is written
					// below in the no-fallback path? No — we short-circuit here, so
					// record the per-attempt audit row explicitly to preserve history.
					applyRateLimitCooldown(
						account,
						{ resetTime: cooldownUntil, reason: "model_fallback_429" },
						ctx,
					);
					// Persist the 429's unified-status header (status/reset/remaining).
					// This short-circuit never reaches processProxyResponse /
					// updateAccountMetadata, so without this the dashboard's
					// rate_limit_status chip freezes at the last successful response's
					// value. Headers only — the body is discarded by fail() below.
					persistRateLimitStatusMeta(account, rawResponse, ctx, provider);

					log.warn(
						`Account ${account.name} hit transient burst 429 (${classification.confidence}) — holding for retry on the resolved target`,
					);
					return await fail(
						{
							kind: "retryable_429",
							confidence: classification.confidence,
							cooldownUntil,
						},
						rawResponse,
					);
				}
			}
			if (isZaiOverloadResponse(rawResponse))
				return await finishZaiOverload(rawResponse);
			// No fallback models configured — fail over to the next account.
			// 429s should never be forwarded to the client when other
			// accounts are available; only genuine model-not-found
			// errors (404/400) warrant returning the upstream response.
			if (rawResponse.status === 429) {
				// Skip cooldown on synthetic cache-keepalive replays. The
				// keepalive scheduler replays warm bodies in waves of
				// up to KEEPALIVE_CONCURRENCY, so its own requests can
				// contend with each other and with live traffic for
				// Anthropic's per-IP burst allowance and 429 several
				// accounts at nearly the same instant. Applying real
				// cooldowns here drains the pool toward zero routable
				// accounts even though no real user-facing rate limit
				// was hit.
				const isKeepalive = isTrustedProbe("keepalive");
				if (isKeepalive) {
					log.warn(
						`Keepalive replay for ${account.name} got 429 — skipping cooldown (synthetic burst, not a real per-account rate limit)`,
					);
					return await fail({ kind: "other" }, rawResponse);
				}

				log.warn(
					`Account ${account.name} rate-limited (429) — failing over within the resolved route`,
				);
				// Residual rung: no corroborating evidence, so the deadline is
				// capped (see capResidualRung429Cooldown) — a claim-scoped 429
				// that slipped past the family rung must not become a multi-day
				// account-wide lock under a non-releasable reason.
				const cooldownUntil = capResidualRung429Cooldown(
					account,
					rawResponse,
					extractCooldownUntil(
						rawResponse,
						account.id,
						usageCache.getRateLimitedUntil.bind(usageCache),
					),
					Date.now(),
				);
				const reason: RateLimitReason = "model_fallback_429";
				// Route through shared helper so the consecutive_rate_limits
				// counter and the audit reason are applied uniformly across all
				// 429 paths. A future cooldownUntil is written as a
				// server-directed deadline (Lever B) — bounded by the cap above,
				// never the raw multi-day retry-after. The audit reason is
				// preserved so saveRequest + DB rate_limited_reason both record
				// the failure-mode-specific tag.
				//
				// Codex accounts route through the single shared observation
				// applicator (cooldown + status-meta + usage-cache/credits/
				// window-roll share one owner). requestAccounting "none": this
				// short-circuit never reached updateAccountMetadata, so no
				// per-request accounting runs here. cooldownUntil drives the
				// cooldown deadline; rateLimitInfo drives the header-only
				// status-meta persistence (a no-op for Codex, which has no
				// unified-status header).
				if (cooldownUntil === null) {
					completeRateLimitProbe(account, "abandoned");
					persistRateLimitStatusMeta(account, rawResponse, ctx, provider);
				} else if (account.provider === "codex") {
					applyCodexObservation(account, rawResponse, ctx, {
						source: "real-traffic",
						rateLimitInfo: provider.parseRateLimit(rawResponse),
						requestAccounting: "none",
						rateLimitAction: { kind: "apply", reason, cooldownUntil },
						successRecovery: "standard",
					});
				} else {
					applyRateLimitCooldown(
						account,
						{ resetTime: cooldownUntil, reason },
						ctx,
					);
					// Persist the 429's unified-status header (status/reset/remaining).
					// This short-circuit never reaches processProxyResponse /
					// updateAccountMetadata, so without this the dashboard's
					// rate_limit_status chip freezes at the last successful response's
					// value. Headers only — the body is discarded by fail() below.
					persistRateLimitStatusMeta(account, rawResponse, ctx, provider);
				}

				return await fail(
					cooldownUntil === null
						? { kind: "other" }
						: { kind: "hard_429", cooldownUntil },
					rawResponse,
				);
			}
			// Codex/ChatGPT entitlement error: the model exists, but THIS
			// account's plan is not entitled to it. That is account-scoped —
			// another account on a different plan can serve the same model — so
			// fail over instead of forwarding the 400. The generic
			// model-not-found below stays a client-facing error: no account can
			// serve a model that doesn't exist, so cycling the pool for it only
			// burns attempts and hides the real cause.
			if (await isCodexEntitlementModelError(rawResponse)) {
				log.warn(
					`Account ${account.name} is not entitled to the requested model (plan-scoped Codex/ChatGPT restriction) — failing over to next account`,
				);
				// Default "native" dispose: this short-circuit runs before any
				// usage-extraction clone exists, so rawResponse is still a plain
				// fetch body that must be drained, not a tee branch.
				return await fail({ kind: "model_not_entitled" }, rawResponse);
			}
			return await fail({ kind: "model_not_found" }, rawResponse);

			// If still unavailable/rate-limited after exhausting the model list,
			// failover to the next account. OpenAI-compatible providers never set
			// isRateLimited:true in parseRateLimit, so we must handle it here.
		}

		// All model/cache-control retries have settled. A confirmed organization
		// restriction removes this account, while the caller's candidate list still
		// enforces API-key account/provider pins. The global force-account path is
		// separate and deliberately never reaches this policy.
		const orgPermissionDenied =
			isClaudeProvider &&
			(await isAnthropicOrgPermissionDenied(rawResponse, req.signal));
		if (orgPermissionDenied) {
			const reason: RateLimitReason = "org_permission_denied";
			// Share the existing escalating cooldown counter deliberately (30s to
			// 5min). Access denials are not quotas; the distinct reason excludes them
			// from quota recovery and transient holds despite sharing that storage.
			applyRateLimitCooldown(account, { reason }, ctx);
			log.warn(
				`Account ${account.name} org_permission_denied (403): organization disabled OAuth/Claude Code access; cooling down this account`,
			);
			if (!options?.isLastAccountAttempt?.()) {
				return await fail({ kind: "org_permission_denied" }, rawResponse);
			}
			// Preserve the actionable upstream 403 when no allowed fallback remains.
			// The normal forwarding path records it exactly once and owns its body.
			options?.onOutcome?.({ kind: "org_permission_denied" });
		}

		// Inject request metadata into response headers so providers can read
		// stream intent and request ID without needing the original request object.
		const responseHeaders = new Headers(rawResponse.headers);
		responseHeaders.set("x-clankermux-request-id", requestMeta.id);
		responseHeaders.set(
			"x-clankermux-resolved-model",
			getAttemptTarget(requestMeta, account).upstreamModel,
		);
		const internalRequestStream = transformedRequest.headers.get(
			"x-clankermux-request-stream",
		);
		if (internalRequestStream === "true" || internalRequestStream === "false") {
			responseHeaders.set("x-clankermux-request-stream", internalRequestStream);
		}
		// Native Responses passthrough: relay the captured native flag onto the
		// response (same channel as x-clankermux-request-stream) so the
		// provider's processResponse can skip the Anthropic back-translation.
		// The boolean was captured BEFORE the internal header was stripped from
		// the outbound request, so the flag never reaches the upstream backend.
		if (nativeUpstreamAttempt) {
			responseHeaders.set(NATIVE_RESPONSES_REQUEST_HEADER, "1");
		}
		const taggedRawResponse = new Response(rawResponse.body, {
			status: rawResponse.status,
			statusText: rawResponse.statusText,
			headers: responseHeaders,
		});
		// rawResponse.body is now transferred into taggedRawResponse; track the
		// new owner so a processResponse throw releases it.
		liveUpstream = taggedRawResponse;

		// No capture here: the raw window/bucket evidence of THIS attempt — and of
		// every attempt that never reached this point — was already recorded at the
		// fetch, by captureAttempt. Capturing on the forwarding path recorded only
		// the responses that survived every retry branch.

		// Process response (transform format, sanitize headers, etc.) using account-specific provider
		const response = await provider.processResponse(
			taggedRawResponse,
			account,
			req.headers,
		);
		liveUpstream = response;

		// Upstream 401 — the access token was rejected. An OAuth access token can be
		// rejected even though it still looks valid by its expiry timestamp (server-
		// side revocation, clock skew, or a refresh that landed a token the upstream
		// won't accept), so the proactive 30-min refresh window never caught it.
		// Failing straight over loses this account's per-request prompt cache and can
		// needlessly burn a healthy sibling. Refresh the token ONCE and retry the SAME
		// account before failing over; only fail over if the retry also 401s or the
		// refresh fails. Skipped for synthetic internal requests (keepalive replays,
		// auto-refresh probes) and for accounts with no refreshable OAuth token.
		if (response.status === 401) {
			const now = Date.now();
			const cooledDown =
				now - (lastStaleTokenRefreshAt.get(account.id) ?? 0) >=
				STALE_TOKEN_REFRESH_COOLDOWN_MS;
			if (
				staleTokenRetryAttempt < STALE_TOKEN_MAX_RETRY &&
				canAttemptStaleTokenRefresh(account) &&
				!isTrustedProbe("any") &&
				cooledDown
			) {
				// The 401 error body is abandoned the moment we choose the refresh
				// path — release it now, BEFORE awaiting the refresh, so a slow or
				// deduped refresh can't pin the socket + ~512 KB native read buffer.
				// discardUpstreamBody is idempotent, so the failover path below can
				// safely discard again.
				discardUpstreamBody(response);
				liveUpstream = null;
				lastStaleTokenRefreshAt.set(account.id, now);
				const tokenBefore = account.access_token;
				let refreshedToken: string | null = null;
				try {
					// Unconditional refresh (dedup + backoff guarded in token-manager);
					// on success it mutates account.access_token in place so the
					// recursion's getValidAccessToken picks up the fresh token. On a
					// terminal invalid_grant it pauses the account and throws → fall over.
					refreshedToken = await refreshAccessTokenSafe(account, ctx);
				} catch (err) {
					if (err instanceof RoutingPolicyError) throw err;
					log.warn(
						`Stale-token refresh failed for account ${account.name}: ${
							err instanceof Error ? err.message : String(err)
						}; failing over`,
					);
				}
				// Only retry if the refresh actually produced a DIFFERENT token. A
				// provider that returns a static credential (or an unchanged token)
				// would just 401 again — fail over instead of burning a round-trip.
				if (refreshedToken && refreshedToken !== tokenBefore) {
					log.info(
						`Refreshed token for account ${account.name} after 401; retrying same account`,
					);
					// The recursion acquires its own admission — release this attempt's
					// lease first, or the retry would suppress itself ("probe-active").
					settleOverloadProbe("abandoned", "stale_token_retry");
					return await proxyWithAccount(
						req,
						url,
						account,
						requestMeta,
						requestBodyBuffer,
						_createBodyStream,
						failoverAttempts,
						ctx,
						modelOverride,
						apiKeyId,
						apiKeyName,
						requestBodyContext,
						returnRateLimitedResponseOnExhaustion,
						options,
						staleTokenRetryAttempt + 1,
					);
				}
			}
			log.warn(
				`Authentication failed (401) for account ${account.name}, failing over to next account`,
			);
			return await fail({ kind: "auth" }, response);
		}

		if (
			isOfficialAnthropicProvider(account.provider) &&
			provider.name === PROVIDER_NAMES.ANTHROPIC &&
			response.status === 529
		) {
			const rateLimitInfo = provider.parseRateLimit(response);
			applyProviderOverloadCooldown(
				account.provider,
				rateLimitInfo.resetTime,
				overloadAttributionModel,
				{ accountName: account.name },
			);
			// Probe verdict: the probe itself hit the overload. The trip above
			// already invalidated the lease on the tripped bucket (generation
			// bump); "reopened" releases any remaining sibling-bucket lease too.
			settleOverloadProbe("reopened", "http_529");

			if (isTerminalAttempt()) {
				log.warn(
					`Provider ${account.provider} returned final 529 overload response — forwarding upstream response instead of pool_exhausted`,
				);
				return forwardToClient(
					{
						clientSignal: req.signal,
						requestId: requestMeta.id,
						method: req.method,
						path: url.pathname,
						account,
						poolCandidates: getPoolHeadroomCandidates(requestMeta),
						internal: requestMeta.internal === true,
						requestHeaders: req.headers,
						requestBody: effectiveBodyBuffer,
						requestedModel: requestMeta.requestedModel,
						fallbackCreditClaimed: requestMeta.fallbackCreditClaimed,
						fallbackFromModel: requestMeta.fallbackFromModel,
						project: requestMeta.project,
						projectAttributionSource: requestMeta.projectAttributionSource,
						contextComposition: requestMeta.contextComposition,
						toolCallStats: requestMeta.toolCallStats,
						reasoningEffort: requestMeta.reasoningEffort,
						sessionKey: requestMeta.sessionKey,
						cachePrefixHashes: requestMeta.cachePrefixHashes,
						response,
						timestamp: requestMeta.timestamp,
						retryAttempt: 0,
						failoverAttempts,
						comboName: requestMeta.comboName,
						apiKeyId,
						apiKeyName,
						routing: requestMeta.routing ?? null,
						upstreamModel: overloadAttributionModel,
						bumpIdleTimeout,
					},
					{ ...ctx, provider },
				);
			}

			log.warn(
				`Provider ${account.provider} overloaded on account ${account.name}; skipping same-provider accounts for this cooldown window`,
			);
			return await fail(
				{ kind: "overload_529", cooldownUntil: rateLimitInfo.resetTime },
				response,
			);
		}

		// Check for rate limit using account-specific provider
		const responseForRateLimitCheck =
			response.status === 529 && isTerminalAttempt()
				? response.clone()
				: response;
		const isRateLimited = orgPermissionDenied
			? false
			: await processProxyResponse(
					responseForRateLimitCheck,
					account,
					{
						...ctx,
						provider,
					},
					requestMeta,
				);
		// processProxyResponse only needed the rate-limit view (headers, or a
		// provider body-parse that consumes it). When it was a distinct clone
		// (final-529 path), release its tee branch now — the original `response`
		// is what gets forwarded/returned below.
		//
		// `responseForRateLimitCheck` has exactly ONE assignment (the ternary
		// above), so `!== response` implies it is a `response.clone()` on every
		// reachable path — i.e. a TEE BRANCH, which must be CANCELLED, not
		// drained: draining it would make the tee keep pulling and buffering for
		// the twin that is about to be streamed to the client. And it must never
		// be awaited — a tee branch's cancel does not settle until BOTH branches
		// cancel, and the twin here is the live response.
		if (responseForRateLimitCheck !== response) {
			discardTeeBranch(responseForRateLimitCheck);
		}
		if (isRateLimited) {
			if (response.status === 529 && isTerminalAttempt()) {
				log.warn(
					`Account ${account.name} returned final 529 overload response — forwarding upstream response instead of pool_exhausted`,
				);
				// A non-official-provider 529 terminal (the official-Anthropic 529
				// was intercepted above): no family trip fires here, and streaming a
				// known-error body yields no health verdict — release the lease.
				settleOverloadProbe("abandoned");
				return forwardToClient(
					{
						clientSignal: req.signal,
						requestId: requestMeta.id,
						method: req.method,
						path: url.pathname,
						account,
						poolCandidates: getPoolHeadroomCandidates(requestMeta),
						internal: requestMeta.internal === true,
						requestHeaders: req.headers,
						requestBody: effectiveBodyBuffer,
						requestedModel: requestMeta.requestedModel,
						fallbackCreditClaimed: requestMeta.fallbackCreditClaimed,
						fallbackFromModel: requestMeta.fallbackFromModel,
						project: requestMeta.project,
						projectAttributionSource: requestMeta.projectAttributionSource,
						contextComposition: requestMeta.contextComposition,
						toolCallStats: requestMeta.toolCallStats,
						reasoningEffort: requestMeta.reasoningEffort,
						sessionKey: requestMeta.sessionKey,
						cachePrefixHashes: requestMeta.cachePrefixHashes,
						response,
						timestamp: requestMeta.timestamp,
						retryAttempt: 0,
						failoverAttempts,
						comboName: requestMeta.comboName,
						apiKeyId,
						apiKeyName,
						routing: requestMeta.routing ?? null,
						upstreamModel: overloadAttributionModel,
						bumpIdleTimeout,
					},
					{ ...ctx, provider },
				);
			}
			// A rate-limited failover that reached processProxyResponse (i.e. NOT a
			// 429 — those are intercepted in the isModelUnavailableError branch
			// above — but a 529/other rate-limit signal): record as hard_429-class
			// so the proxy never treats it as hold-eligible.
			//
			// DRAINED, like every other fail() site. processProxyResponse →
			// updateAccountMetadata reads headers only and never clones, and the
			// final-529 rate-limit-check clone (the one branch that does clone) was
			// already released above and only exists when this branch forwards
			// instead of failing over. So `response` here is an exclusively owned
			// body with no live twin: draining it is what returns the socket and the
			// native read buffer, and cancelling it alone would not.
			return await fail(
				response.status === 529
					? { kind: "overload_529" }
					: { kind: "hard_429" },
				response,
				(drain) =>
					reportAbandonedRateLimitedBody(drain, {
						requestId: requestMeta.id,
						accountName: account.name,
						accountId: account.id,
						provider: account.provider,
						status: response.status,
					}),
			);
		}

		if (
			response.ok &&
			isProtectedFamily(getModelFamily(activeUpstreamModel ?? ""))
		) {
			recordProtectedFamilyDemand(account.id, Date.now());
		}
		if (response.ok) {
			const servedFamily = getModelFamily(activeUpstreamModel ?? "");
			if (servedFamily) {
				clearFamilyWeeklyExhausted(
					account.id,
					servedFamily,
					requestMeta.timestamp,
				);
			}
		}
		const transferredProbeToken = overloadProbeToken;
		overloadProbeToken = null;
		return forwardToClient(
			{
				clientSignal: req.signal,
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account,
				poolCandidates: getPoolHeadroomCandidates(requestMeta),
				internal: requestMeta.internal === true,
				requestHeaders: req.headers,
				requestBody: effectiveBodyBuffer,
				requestedModel: requestMeta.requestedModel,
				fallbackCreditClaimed: requestMeta.fallbackCreditClaimed,
				fallbackFromModel: requestMeta.fallbackFromModel,
				project: requestMeta.project,
				projectAttributionSource: requestMeta.projectAttributionSource,
				contextComposition: requestMeta.contextComposition,
				toolCallStats: requestMeta.toolCallStats,
				reasoningEffort: requestMeta.reasoningEffort,
				sessionKey: requestMeta.sessionKey,
				cachePrefixHashes: requestMeta.cachePrefixHashes,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
				routing: requestMeta.routing ?? null,
				upstreamModel: overloadAttributionModel,
				overloadProbeToken: transferredProbeToken,
				bumpIdleTimeout,
			},
			{ ...ctx, provider },
		);
	} catch (err) {
		if (err instanceof RoutingPolicyError) throw err;
		handleProxyError(err, account, log);
		// Release any upstream body owned at the point of failure so a thrown
		// error (e.g. mid-processResponse) doesn't leak its socket/read buffer.
		// `fail()` also settles the overload-probe lease as "abandoned" and records
		// the outcome, so it must run BEFORE the client-abort terminal below — the
		// disconnect changes the request's verdict, not this attempt's cleanup.
		const failed = await fail({ kind: "network_error" }, liveUpstream);

		// Client disconnect: the throw is the upstream fetch reacting to the
		// client's own signal, so return the terminal 499 rather than signalling
		// failover into a fan-out nobody is waiting for. Keyed on
		// `req.signal.aborted`, NEVER `isAbortError` — the burst / overload /
		// context-window holds compose their own AbortControllers, and a budget
		// deadline must still fail over.
		//
		// The staged-body discard is this function's own responsibility here:
		// proxyWithAccount stages cacheable bodies before fetching, and once this
		// catch returns a Response the caller's candidate loop returns immediately
		// at `if (gated.response)` — so the loop's cleanup AND the request-level
		// tail are both bypassed and nothing else would drop it.
		if (req.signal.aborted) {
			cacheBodyStore.discardStaged(requestMeta.id);
			return createClientAbortResponse();
		}
		return failed;
	}
}

/**
 * Build a local JSON error Response for the forced-account path. Used when the
 * forced forward cannot reach upstream (token unrefreshable, network error,
 * etc.). NEVER returns null — the force contract forbids failover, so a local
 * error Response is the only acceptable failure mode.
 */
function createForcedAccountUnavailableResponse(
	account: Account,
	reason: string,
): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "forced_account_unavailable",
				message: `Forced account '${account.name}' could not serve the request: ${reason}`,
			},
		}),
		{
			status: 502,
			headers: {
				"Content-Type": "application/json",
				"x-clankermux-forced-account": account.id,
			},
		},
	);
}

/**
 * Dedicated minimal forward for the global force-account override (Feature 3).
 *
 * Composes the SAME low-level upstream call + response recording the normal
 * path uses, but HARD-BYPASSES every fallback/retry/cooldown/null branch that
 * `proxyWithAccount` contains (thinking-signature + cache-control pre-retries,
 * model-fallback cycling, 401→null, 529→null/cooldown, processProxyResponse
 * rate-limit cooldown+failover, mid-stream cooldown sniffer). Invariants:
 *
 *   - Resolves the access token via the same `getValidAccessToken` path. If it
 *     THROWS (expired/unrefreshable token), returns a local 502 error Response —
 *     never null, never failover.
 *   - Sends exactly ONE upstream request (applying the account's model mapping
 *     exactly as the normal path does, via the combo-style model override).
 *   - Returns the upstream Response AS-IS for ANY status (200/4xx/429/529/5xx).
 *     Never converts a non-2xx into null. Never triggers cross-account failover.
 *   - Does NOT mark rate_limited_until / provider-overload cooldown /
 *     consecutive_rate_limits. forwardToClient is called with
 *     disableCooldown:true so a streamed 429/529 does not mutate cooldown state.
 *   - STILL emits the normal request-recorder / worker `start` analytics so the
 *     request appears in history (requestMeta.routing is set by the caller).
 *   - catch returns a local 502 error Response, NEVER null.
 *
 * @param req           The incoming client request
 * @param url           The parsed URL
 * @param account       The forced account
 * @param requestMeta   Request metadata (routing already set by caller)
 * @param requestBodyBuffer Buffered request body
 * @param ctx           The proxy context
 * @param modelOverride Optional model override (combo slot); usually null
 * @param apiKeyId      Optional API key id for tracking
 * @param apiKeyName    Optional API key name for tracking
 * @param requestBodyContext Optional pre-parsed request body context
 */
export async function proxyForcedAccount(
	req: Request,
	url: URL,
	account: Account,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	ctx: ProxyContext,
	modelOverride?: string | null,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	requestBodyContext?: RequestBodyContext | null,
): Promise<Response> {
	modelOverride = getAttemptTarget(requestMeta, account).upstreamModel;
	const attemptAudit: RoutingAttemptAudit = { id: null };
	// Hoisted to function scope so the outer catch (which may fire before
	// `provider` is assigned, e.g. a validateProviderPath throw) and the
	// local-error recorder can reference them. effectiveBodyBuffer feeds the
	// recorder's captured request body; provider drives forwardToClient's
	// recordable-request predicate and stream detection.
	let effectiveBodyBuffer: ArrayBuffer | null = null;
	let provider = ctx.provider;
	// The live, undisposed upstream body owned at each stage, so the catch can
	// release it when processResponse / forwardToClient throws after the fetch
	// succeeded (mirrors `liveUpstream` on the normal path). Ownership transfers
	// to forwardToClient on the success path, so it is nulled out there.
	let liveForcedUpstream: Response | null = null;

	// Record a forced-mode LOCAL error (token-resolution throw / outer catch)
	// under the forced account so it appears in Request History, exactly like
	// the forced UPSTREAM response is recorded via the success-path
	// forwardToClient. disableCooldown:true matches the success path — a forced
	// account never mutates cooldown state. forwardToClient handles a synthetic
	// small non-streaming JSON error Response via its tee() read path.
	const recordLocalError = async (reason: string): Promise<Response> => {
		try {
			await recordLocalRoutingOutcome(
				attemptAudit,
				requestMeta,
				account,
				ctx,
				reason,
				502,
			);
		} catch (error) {
			log.warn("Could not persist forced routing outcome", error);
		}
		const errorResponse = createForcedAccountUnavailableResponse(
			account,
			reason,
		);
		return forwardToClient(
			{
				clientSignal: req.signal,
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account,
				internal: requestMeta.internal === true,
				requestHeaders: req.headers,
				requestBody: effectiveBodyBuffer,
				requestedModel: requestMeta.requestedModel,
				fallbackCreditClaimed: requestMeta.fallbackCreditClaimed,
				fallbackFromModel: requestMeta.fallbackFromModel,
				project: requestMeta.project,
				projectAttributionSource: requestMeta.projectAttributionSource,
				contextComposition: requestMeta.contextComposition,
				toolCallStats: requestMeta.toolCallStats,
				reasoningEffort: requestMeta.reasoningEffort,
				sessionKey: requestMeta.sessionKey,
				cachePrefixHashes: requestMeta.cachePrefixHashes,
				response: errorResponse,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts: 0,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
				routing: requestMeta.routing ?? null,
				disableCooldown: true,
			},
			{ ...ctx, provider },
		);
	};

	try {
		const baseBodyContext =
			requestBodyContext ?? new RequestBodyContext(requestBodyBuffer);
		const originalBody = baseBodyContext.getParsedJson();
		if (!originalBody)
			throw new RoutingPolicyError("Cannot parse inference request");
		rejectModelSwitchFields(originalBody);
		const effectiveBodyContext =
			baseBodyContext.withPatchedModel(modelOverride);
		if (!effectiveBodyContext)
			throw new RoutingPolicyError("Cannot apply resolved model");
		effectiveBodyBuffer = effectiveBodyContext.getBuffer();

		// Get the provider for this account
		provider = getProvider(account.provider) || ctx.provider;

		// Validate that the account-specific provider can handle this path
		validateProviderPath(provider, url.pathname);

		// Synthetic local count_tokens never reaches upstream, so — exactly as on
		// the normal path — it must not require or refresh OAuth credentials just
		// to return an advisory local estimate. Without this, force-routing a
		// local-count account with an expired token would return a local auth error
		// instead of the synthesized 200/400.
		const isLocalCountTokens =
			supportsLocalTokenCounting(account.provider, account.custom_endpoint) &&
			url.pathname === "/v1/messages/count_tokens";

		// Resolve the access token via the same path the normal flow uses. If it
		// throws (expired/unrefreshable token), map to a local error Response —
		// NOT null/failover (R2). Routed through forwardToClient so the local
		// failure is recorded under the forced account (history intact).
		let accessToken = "";
		if (!isLocalCountTokens) {
			try {
				accessToken = await getValidAccessToken(account, ctx);
			} catch (tokenErr) {
				// Client disconnect during the refresh: return the terminal 499
				// WITHOUT recording, exactly as the outer catch does. This catch has
				// its own `return`, so it never reaches that check — without this
				// line a disconnect that races a token refresh would still produce a
				// logged forced-account failure, a history row and a 502.
				//
				// Keyed on `req.signal.aborted`, NEVER `isAbortError`: a genuine
				// token-refresh failure (invalid_grant, upstream 5xx, refresh
				// timeout) must still be recorded as a forced-account failure.
				if (req.signal.aborted) return createClientAbortResponse();
				const reason =
					tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
				log.warn(
					`Forced account ${account.name}: token resolution failed — returning local error (no failover): ${reason}`,
				);
				return await recordLocalError(reason);
			}
		}

		// Pre-process request if provider supports it (e.g., to extract model for URL)
		if (provider.prepareRequest) {
			provider.prepareRequest(req, effectiveBodyBuffer, account);
		}

		const headers = provider.prepareHeaders(
			req.headers,
			accessToken,
			account.api_key || undefined,
		);
		// Strip client-supplied synthetic-response markers (same as the normal
		// path) so a client cannot forge a synthetic count_tokens response.
		headers.delete("x-clankermux-synthetic-response");
		headers.delete("x-clankermux-synthetic-status");
		const targetUrl = provider.buildUrl(url.pathname, url.search, account);

		const requestInit: RequestInit & { duplex?: "half" } = {
			method: req.method,
			headers,
		};
		if (effectiveBodyBuffer) {
			requestInit.body = new Uint8Array(effectiveBodyBuffer);
			requestInit.duplex = "half";
		}

		const nativeCtx = getNativeResponsesMetaContext(requestMeta);
		if (nativeCtx && account.provider === "codex") {
			requestInit.body = prepareNativeBody(nativeCtx.nativeBody, modelOverride);
			headers.set(NATIVE_RESPONSES_REQUEST_HEADER, "1");
		}

		const providerRequest = new Request(targetUrl, requestInit);
		const transformedRequest = provider.transformRequestBody
			? await provider.transformRequestBody(providerRequest, account)
			: providerRequest;

		const rawResponse = captureUpstreamAttempt(
			transformedRequest,
			await sendAuthorizedRequest(
				transformedRequest,
				account,
				requestMeta,
				ctx,
				req.signal,
				attemptAudit,
			),
			account,
			requestMeta,
			req.headers,
			ctx,
		);
		liveForcedUpstream = rawResponse;

		// Inject request metadata into response headers so providers can read
		// stream intent and request ID (mirrors the normal path).
		const responseHeaders = new Headers(rawResponse.headers);
		responseHeaders.set("x-clankermux-request-id", requestMeta.id);
		responseHeaders.set(
			"x-clankermux-resolved-model",
			getAttemptTarget(requestMeta, account).upstreamModel,
		);
		const internalRequestStream = transformedRequest.headers.get(
			"x-clankermux-request-stream",
		);
		if (internalRequestStream === "true" || internalRequestStream === "false") {
			responseHeaders.set("x-clankermux-request-stream", internalRequestStream);
		}
		if (transformedRequest.headers.get(NATIVE_RESPONSES_REQUEST_HEADER) === "1")
			responseHeaders.set(NATIVE_RESPONSES_REQUEST_HEADER, "1");

		const taggedRawResponse = new Response(rawResponse.body, {
			status: rawResponse.status,
			statusText: rawResponse.statusText,
			headers: responseHeaders,
		});

		// Process response (format transform, header sanitize) — but do NOT run
		// processProxyResponse (which applies cooldowns + signals failover) and
		// do NOT special-case 401/429/529. Whatever the forced account returns is
		// forwarded as-is.
		const response = await provider.processResponse(
			taggedRawResponse,
			account,
			req.headers,
		);
		liveForcedUpstream = response;

		// A forced 2xx is the same direct evidence an organic one is: this family
		// served on this account, so a past 429's memo about it is stale. Forced
		// routing bypasses selection entirely and so never consults the memo —
		// but that is exactly why it must still clear it, or an operator pinning
		// a request to an account could not demonstrate the family had recovered.
		// disableCooldown above suppresses COOLDOWN mutation on a forced 429; it
		// says nothing about honouring a forced success.
		if (response.ok) {
			const forcedFamily = getModelFamily(requestMeta.requestedModel ?? "");
			if (forcedFamily) {
				clearFamilyWeeklyExhausted(
					account.id,
					forcedFamily,
					requestMeta.timestamp,
				);
			}
		}

		// Forward to client for recording + streaming. disableCooldown:true keeps
		// the mid-stream rate-limit sniffer from mutating cooldown state on a
		// forced 429/529. Ownership of the body transfers to forwardToClient at
		// CALL time, so drop our reference — if forwardToClient itself throws, the
		// catch's discard would be a no-op anyway (locked body).
		liveForcedUpstream = null;
		return forwardToClient(
			{
				clientSignal: req.signal,
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account,
				internal: requestMeta.internal === true,
				requestHeaders: req.headers,
				requestBody: effectiveBodyBuffer,
				requestedModel: requestMeta.requestedModel,
				fallbackCreditClaimed: requestMeta.fallbackCreditClaimed,
				fallbackFromModel: requestMeta.fallbackFromModel,
				project: requestMeta.project,
				projectAttributionSource: requestMeta.projectAttributionSource,
				contextComposition: requestMeta.contextComposition,
				toolCallStats: requestMeta.toolCallStats,
				reasoningEffort: requestMeta.reasoningEffort,
				sessionKey: requestMeta.sessionKey,
				cachePrefixHashes: requestMeta.cachePrefixHashes,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts: 0,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
				routing: requestMeta.routing ?? null,
				disableCooldown: true,
			},
			{ ...ctx, provider },
		);
	} catch (err) {
		if (err instanceof RoutingPolicyError) throw err;
		// Release any upstream body owned at the point of failure (e.g. a
		// processResponse throw after the fetch succeeded) before either terminal
		// below — neither of them forwards it.
		discardUpstreamBody(liveForcedUpstream);

		// Client disconnect: threading `req.signal` into the fetch above means a
		// disconnect now surfaces here as an AbortError. Return the terminal 499
		// WITHOUT logging an error or calling recordLocalError — otherwise
		// threading the signal would have converted every client disconnect into a
		// recorded forced-account failure plus a history row, i.e. traded a leak
		// for a new mis-classification.
		//
		// Keyed on `req.signal.aborted`, NEVER `isAbortError`: makeProxyRequest
		// composes the client signal with its own internal timeout controller, so
		// a genuine upstream timeout also throws an AbortError and must still be
		// recorded as a forced-account failure.
		if (req.signal.aborted) {
			log.debug(
				`Forced account ${account.name}: client disconnected — returning 499 without recording`,
			);
			return createClientAbortResponse();
		}

		// catch returns a local error Response, NEVER null — force forbids failover.
		// Routed through forwardToClient so the local failure is recorded under the
		// forced account (history intact). If recording itself throws (e.g. the
		// error fired before `provider`/body were set up), fall back to the raw
		// local error Response so the force contract's "never null" still holds.
		const reason = err instanceof Error ? err.message : String(err);
		log.error(
			`Forced account ${account.name} forward failed (returning local error, no failover):`,
			err,
		);
		try {
			return await recordLocalError(reason);
		} catch (recordErr) {
			log.error(
				`Forced account ${account.name}: failed to record local error — returning raw error Response:`,
				recordErr,
			);
			return createForcedAccountUnavailableResponse(account, reason);
		}
	}
}

/**
 * Create a 503 Service Unavailable response when the account pool is exhausted.
 * All accounts are paused, rate-limited, or filtered out.
 * @param accounts - All accounts that were considered but are unavailable
 * @returns 503 response with pool_exhausted error and Retry-After header
 */
export function createPoolExhaustedResponse(accounts: Account[]): Response {
	const now = Date.now();

	// Build account info list
	const accountInfos = accounts.map((account) => {
		const reason = account.paused
			? "paused"
			: account.rate_limited_until && account.rate_limited_until > now
				? "rate_limited"
				: "unavailable";

		const availableAt =
			account.rate_limited_until && account.rate_limited_until > now
				? new Date(account.rate_limited_until).toISOString()
				: null;

		return {
			name: account.name,
			reason,
			available_at: availableAt,
		};
	});

	// Calculate next_available_at from earliest rate_limited_until
	const rateLimitedTimes = accounts
		.map((account) => account.rate_limited_until)
		.filter((until): until is number => until != null && until > now);
	const earliestRateLimitedUntil =
		rateLimitedTimes.length > 0 ? Math.min(...rateLimitedTimes) : null;
	const nextAvailableAt =
		earliestRateLimitedUntil !== null
			? new Date(earliestRateLimitedUntil).toISOString()
			: null;

	// Calculate Retry-After header (seconds) directly from numeric min
	const retryAfterSeconds =
		earliestRateLimitedUntil !== null
			? Math.max(1, Math.round((earliestRateLimitedUntil - now) / 1000))
			: 60; // Default 60s if no cooldown info

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "pool_exhausted",
				message: ERROR_MESSAGES.POOL_EXHAUSTED,
				next_available_at: nextAvailableAt,
				accounts: accountInfos,
			},
		}),
		{
			status: 503,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfterSeconds),
				"x-clankermux-pool-status": "exhausted",
			},
		},
	);
}

/**
 * Create a 400 response when a request is too large for every backend that
 * would otherwise have served it. Returned (instead of the 503 pool_exhausted)
 * when the candidate pool was emptied specifically by the context-window gate
 * — i.e. the only reason there's nowhere to route is that the request exceeds
 * the excluded backends' model context windows.
 *
 * @param estimatedTokens  Conservative token estimate for the request
 * @param excludedBackends Codex backends dropped by the size gate
 * @param requestModel     The Anthropic-side model name from the request
 * @param excludeOfficialAnthropic Whether the Codex-CLI floor barred official
 *   Anthropic accounts from this request. It decides WHY nothing else stepped
 *   in: with the floor active they were never candidates, so reporting them as
 *   rate-limited or paused describes a condition nobody checked — and is
 *   routinely false, since the floor applies to healthy accounts too. The
 *   replacement clause claims only exclusion, not that such an account exists
 *   or would have had room.
 */
export interface ContextWindowExcludedBackend {
	account: Account;
	model: string;
}

export function createContextWindowExceededResponse(
	estimatedTokens: number,
	excludedBackends: ContextWindowExcludedBackend[],
	requestModel: string,
	excludeOfficialAnthropic = false,
): Response {
	const backendDescriptions = excludedBackends.map(({ account, model }) => {
		const target = model;
		const window = resolveModelMaxContextWindow(target);
		return {
			name: account.name,
			model: target,
			max_context_window: window ?? null,
		};
	});

	const backendSummary =
		backendDescriptions
			.map(
				(b) =>
					`${b.name} (${b.model}${
						b.max_context_window != null
							? ` caps at ${b.max_context_window}`
							: ""
					})`,
			)
			.join(", ") || "no eligible backend";

	// Say only what the flag establishes. It proves official Anthropic accounts
	// were barred from selection; it does NOT prove any exist, or that one would
	// have fit — Anthropic's 200k window is SMALLER than gpt-5.6-sol's 272k, so
	// claiming they are the larger-context option would be false here.
	const largerContextReason = excludeOfficialAnthropic
		? `Official Anthropic accounts are never eligible for Codex CLI traffic ` +
			`and were not considered.`
		: `Larger-context accounts are currently unavailable (rate-limited or paused).`;

	const message =
		`Request estimated at ~${estimatedTokens} tokens exceeds the context ` +
		`window of every available backend: ${backendSummary}. ` +
		largerContextReason;

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "context_window_exceeded",
				message,
				estimated_tokens: estimatedTokens,
				request_model: requestModel,
				excluded_backends: backendDescriptions,
			},
		}),
		{
			status: 400,
			headers: {
				"Content-Type": "application/json",
				"x-clankermux-pool-status": "context-window-exceeded",
			},
		},
	);
}

/**
 * Create a 503 response when an API-key routing pin strict-failed selection —
 * the pinned account/class had no allowed, available candidate. Returned
 * (instead of the generic 503 pool_exhausted or the storm-hold path) so a
 * pinned key never silently degrades to, or is answered from, a disallowed
 * account. `failure.code` becomes the error `type` so the operator sees exactly
 * which pin rule fired (pinned_account_missing / pinned_account_unavailable /
 * pinned_no_available_account / pinned_header_rejected / pinned_resolution_error).
 */
export function createPinnedTargetUnavailableResponse(failure: {
	code: string;
	message: string;
}): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: failure.code,
				message: failure.message,
			},
		}),
		{
			status: 503,
			headers: {
				"Content-Type": "application/json",
				"x-clankermux-pool-status": "pinned-target-unavailable",
			},
		},
	);
}
