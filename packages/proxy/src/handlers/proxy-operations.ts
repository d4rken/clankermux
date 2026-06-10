import {
	getModelList,
	logError,
	ProviderError,
	resolveCodexTargetModel,
	resolveModelContextWindow,
	TIME_CONSTANTS,
} from "@clankermux/core";
import { withSanitizedProxyHeaders } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import { stripCacheControlFromOpenAIRequest } from "@clankermux/openai-formats";
import {
	getFreshCapacity,
	getProvider,
	usageCache,
} from "@clankermux/providers";
import {
	type Account,
	getNativeResponsesMetaContext,
	NATIVE_RESPONSES_REQUEST_HEADER,
	PROVIDER_NAMES,
	type RateLimitReason,
	type RequestMeta,
} from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import {
	applyProviderOverloadCooldown,
	isOfficialAnthropicProvider,
} from "../provider-overload-cooldown";
import { RequestBodyContext } from "../request-body-context";
import { forwardToClient } from "../response-handler";
import { markAnthropicBurstThrottle } from "./burst-cooldown";
import { ERROR_MESSAGES, type ProxyContext } from "./proxy-types";
import { applyRateLimitCooldown } from "./rate-limit-cooldown";
import { makeProxyRequest, validateProviderPath } from "./request-handler";
import { handleProxyError, processProxyResponse } from "./response-processor";
import { getValidAccessToken } from "./token-manager";
import {
	BURST_RETRY_MAX_USAGE_AGE_MS,
	classify429Transient,
} from "./transparent-retry";

const log = new Logger("ProxyOperations");

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
	| { kind: "overload_529"; cooldownUntil?: number }
	| { kind: "model_not_found" }
	| { kind: "network_error" }
	| { kind: "other" };

/**
 * Optional, behaviour-only extension bag for {@link proxyWithAccount}. Every
 * field is optional and defaults to today's behaviour, so existing positional
 * callers and tests are unaffected.
 */
export interface ProxyAttemptOptions {
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
}

export function isSyntheticInternalRequest(headers: Headers): boolean {
	return (
		!!headers.get("x-clankermux-keepalive") ||
		!!headers.get("x-clankermux-auto-refresh")
	);
}

/**
 * Determines the absolute epoch timestamp (ms since epoch) until which an account
 * should be marked rate-limited after model exhaustion. Priority:
 *   1. retry-after / x-ratelimit-reset response header (actual upstream backoff)
 *   2. getRateLimitedUntil — usage-window reset time if known
 *   3. probe-cooldown default (TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS,
 *      60s by default, overridable via CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) as
 *      last resort. Was a 1-hour ban prior to v3.5.x — that locked accounts
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
	// Use `||` (not `??`) so empty-string and non-numeric env values
	// (Number("") === 0, Number("abc") === NaN) fall through to the
	// default — `??` would coalesce the empty string to 0 and silently
	// disable the cooldown entirely.
	const DEFAULT_COOLDOWN_MS =
		Number(process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) ||
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

/**
 * Checks if a response error indicates the requested model is unavailable.
 * Covers Anthropic (not_found_error), OpenAI-compat (model_not_found),
 * and generic messages.
 */
export async function isModelUnavailableError(
	response: Response,
): Promise<boolean> {
	if (
		response.status !== 404 &&
		response.status !== 400 &&
		response.status !== 429
	)
		return false;

	// 429s always trigger slot failover regardless of content-type.
	// Providers like Qwen return 429 without application/json bodies, and
	// the content-type guard below would otherwise short-circuit before reaching
	// this check, causing the 429 to be forwarded to the client instead of
	// failing over to the next combo slot.
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
	} catch {
		// Ignore parse errors
	}

	return false;
}

/**
 * Cancel an abandoned upstream response body so Bun releases its socket and the
 * ~512 KB native read buffer immediately.
 *
 * A `fetch()` Response body that is neither read to EOF nor cancelled keeps that
 * memory committed indefinitely (Bun 1.3.x). On the proxy's failover/retry paths
 * we obtain an upstream Response and then discard it — return `null` to try the
 * next account, or overwrite `rawResponse` with a retry — without ever consuming
 * its body. Each dropped body is a ~512 KB off-heap leak that ratchets up with
 * every 429/401/529 failover under load (observed live: ~1.6 GB/h). Calling this
 * before every such drop releases the buffer.
 *
 * Safe to call with any Response/null: skips a `null`/locked body (locked means
 * a reader already owns it — it will be drained or was cloned) and swallows the
 * harmless error from a body that is already cancelled/errored.
 */
async function discardUpstreamBody(
	response: Response | null | undefined,
): Promise<void> {
	const body = response?.body;
	if (!body || body.locked) return;
	try {
		await body.cancel();
	} catch {
		// Body already cancelled/errored — nothing left to release.
	}
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
	modelOverride: string | null | undefined,
): string | null {
	try {
		const parsed = JSON.parse(nativeBody) as Record<string, unknown>;
		if (!modelOverride) return nativeBody;
		parsed.model = modelOverride;
		return JSON.stringify(parsed);
	} catch {
		return null;
	}
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
export async function proxyUnauthenticated(
	req: Request,
	url: URL,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<Response> {
	log.warn(ERROR_MESSAGES.NO_ACCOUNTS);

	const targetUrl = ctx.provider.buildUrl(url.pathname, url.search);
	const headers = ctx.provider.prepareHeaders(
		req.headers,
		undefined,
		undefined,
	);

	try {
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
		);

		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account: null,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				project: requestMeta.project,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts: 0,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
				routing: requestMeta.routing ?? null,
			},
			ctx,
		);
	} catch (error) {
		logError(error, log);
		throw new ProviderError(
			ERROR_MESSAGES.UNAUTHENTICATED_FAILED,
			ctx.provider.name,
			502,
			{
				originalError: error instanceof Error ? error.message : String(error),
			},
		);
	}
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
	returnRateLimitedResponseOnExhaustion = false,
	options?: ProxyAttemptOptions,
): Promise<Response | null> {
	// Single helper that records a categorical outcome into the optional sink AND
	// cancels the upstream body, so the many failover (`return null`) paths can't
	// let recording and body-cancel drift apart (Codex's anti-drift requirement).
	// Returns `null` so call sites can `return fail(...)` directly.
	const fail = async (
		outcome: ProxyAttemptOutcome,
		response?: Response | null,
	): Promise<null> => {
		options?.onOutcome?.(outcome);
		await discardUpstreamBody(response);
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
	try {
		if (
			process.env.DEBUG?.includes("proxy") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.info(
				`Attempting request with account: ${account.name} (provider: ${account.provider})`,
			);
		}

		// Apply model override from combo slot (per D-04, REQ-12)
		const baseBodyContext =
			requestBodyContext ?? new RequestBodyContext(requestBodyBuffer);
		let effectiveBodyContext = baseBodyContext;
		let effectiveBodyBuffer = baseBodyContext.getBuffer();
		if (modelOverride && effectiveBodyBuffer) {
			const overriddenContext = baseBodyContext.withPatchedModel(modelOverride);
			if (overriddenContext) {
				effectiveBodyContext = overriddenContext;
				effectiveBodyBuffer = overriddenContext.getBuffer();

				if (
					process.env.DEBUG?.includes("proxy") ||
					process.env.DEBUG === "true" ||
					process.env.NODE_ENV === "development"
				) {
					log.info(
						`Combo model override: applying model "${modelOverride}" for account ${account.name}`,
					);
				}
			} else {
				log.warn(
					"Failed to patch request body with model override, using original body",
				);
				effectiveBodyBuffer = baseBodyContext.getBuffer();
			}
		}

		// Stage the original request body + headers for cache keepalive replay.
		// Uses the pre-transform body (effectiveBodyBuffer may have a model override
		// patched in, so use the original requestBodyBuffer for a faithful replay).
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
		if (!isSyntheticInternalRequest(req.headers) && !options?.reprobe) {
			cacheBodyStore.stageRequest(
				requestMeta.id,
				account.id,
				baseBodyContext.getBuffer(),
				req.headers,
				url.pathname,
			);
		}

		// Get the provider for this account
		const provider = getProvider(account.provider) || ctx.provider;

		// Validate that the account-specific provider can handle this path
		validateProviderPath(provider, url.pathname);

		// Get valid access token
		const accessToken = await getValidAccessToken(account, ctx);

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
		const targetUrl = provider.buildUrl(url.pathname, url.search, account);

		// ── Native Responses passthrough (Stage A, request leg) ────────────────
		// When the client request was an OpenAI-Responses call (the adapter
		// attached a NativeResponsesContext), this attempt targets a codex account
		// AND the client asked for streaming, forward the ORIGINAL Responses body
		// instead of the double-translated Anthropic body. The decision is strictly
		// per-attempt: the translated effectiveBodyBuffer stays untouched, so a
		// failover to a non-codex account re-enters here and picks it up.
		const nativeCtx = getNativeResponsesMetaContext(requestMeta);
		const useNative =
			nativeCtx?.clientStream === true && account.provider === "codex";
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

		// Make the request. Thread the caller's AbortSignal (if any) into the
		// upstream fetch so a client disconnect aborts it immediately — essential
		// in re-probe mode so a disconnect releases the hold slot promptly. When
		// absent, makeProxyRequest installs its own timeout controller as before.
		let rawResponse = await makeProxyRequest(
			transformedRequest,
			undefined,
			undefined,
			undefined,
			undefined,
			options?.signal,
		);
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

				// Acquire the retry FIRST, then cancel the original body so its
				// socket + ~512 KB read buffer is released. Acquiring first means a
				// throw here leaves the original intact for the outer catch/failover
				// instead of proceeding with an already-cancelled body.
				const retryResponse = await makeProxyRequest(
					retryTransformedRequest,
					undefined,
					undefined,
					undefined,
					undefined,
					options?.signal,
				);
				await discardUpstreamBody(rawResponse);
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
				// not yet cancelled), preserving the "forward the original 400 on
				// retry failure" contract.
				const retryResponse = await makeProxyRequest(
					retryRequest,
					undefined,
					undefined,
					undefined,
					undefined,
					options?.signal,
				);
				await discardUpstreamBody(rawResponse);
				rawResponse = retryResponse;
				liveUpstream = rawResponse;
			} catch (err) {
				log.warn("Failed to retry without cache_control:", err);
			}
		}

		// On model unavailable / rate-limited: cycle through the model list for
		// this account. getModelList returns [primary, ...fallbacks] merged from
		// model_mappings arrays and legacy model_fallbacks. We already tried index 0
		// (the primary), so start at index 1.
		if (await isModelUnavailableError(rawResponse)) {
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

			// ── Transparent burst-retry: re-probe mode ──────────────────────────
			// A re-probe of a held account that came back 429 (still throttled):
			// apply the no-streak/no-anchor cooldown and signal "still throttled"
			// to the hold orchestrator WITHOUT cycling model fallbacks at the
			// throttled IP. The orchestrator decides whether to wait and re-probe
			// again or give up. Non-429 responses fall through to the normal path.
			if (options?.reprobe && rawResponse.status === 429) {
				const cooldownUntil = extractCooldownUntil(
					rawResponse,
					account.id,
					usageCache.getRateLimitedUntil.bind(usageCache),
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

			// ── Transparent burst-retry: first-attempt early intercept ──────────
			// Before cycling this account's model fallbacks (which would fire more
			// requests at the already-throttled per-IP window), classify an
			// OAuth-Anthropic 429. If it is a retryable transient burst throttle,
			// record `retryable_429` and fail over WITHOUT model cycling so the
			// proxy.ts decide-before-loop can hold-and-retry the cache account.
			// Skipped for: non-429, synthetic keepalive/auto-refresh replays (their
			// own per-IP-burst handling lives below), and re-probe mode (handled
			// above). Non-retryable / non-OAuth-Anthropic 429s fall through to
			// today's model-fallback + failover behaviour unchanged.
			if (
				rawResponse.status === 429 &&
				!options?.reprobe &&
				!isSyntheticInternalRequest(req.headers)
			) {
				const now = Date.now();
				// Read fresh capacity once. When usage is stale/absent
				// (getFreshCapacity → null), the plan calls for ONE best-effort
				// usage refresh before falling back to the `x-should-retry` hint —
				// so a real burst 429 doesn't fall through to sibling failover just
				// because the usage cache happened to be cold. The refresh is a
				// single, self-bounded fetch (usageCache.refreshNow handles its own
				// 5s timeout + failure → false); we re-read capacity afterward. The
				// predicate itself stays pure/synchronous: it classifies on the
				// pre-resolved capacity value via the closure below.
				let capacity = getFreshCapacity(
					usageCache,
					account.id,
					account.provider,
					now,
					BURST_RETRY_MAX_USAGE_AGE_MS,
				);
				if (capacity === null) {
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
					// breaking the "never sibling on burst" invariant. The hold
					// orchestrator also sets the marker (extends-never-shortens, so a
					// double set is harmless), but the authoritative set must happen
					// here, regardless of whether a hold slot is later acquired.
					markAnthropicBurstThrottle(now);
					const cooldownUntil = extractCooldownUntil(
						rawResponse,
						account.id,
						usageCache.getRateLimitedUntil.bind(usageCache),
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
					const responseTime = Date.now() - requestMeta.timestamp;
					ctx.asyncWriter.enqueue(() =>
						ctx.dbOps.saveRequest(
							crypto.randomUUID(),
							req.method,
							url.pathname,
							account.id,
							429,
							false,
							"model_fallback_429",
							responseTime,
							failoverAttempts,
							undefined,
							apiKeyId ?? undefined,
							apiKeyName ?? undefined,
							requestMeta.project ?? null,
							undefined,
							requestMeta.comboName ?? null,
						),
					);
					log.warn(
						`Account ${account.name} hit transient burst 429 (${classification.confidence}) — intercepting before model-fallback cycling for hold-and-retry`,
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

			let requestedModel: string | null = null;
			if (effectiveBodyBuffer) requestedModel = effectiveBodyContext.getModel();

			if (requestedModel) {
				const modelList = getModelList(requestedModel, account);
				if (!modelList || modelList.length <= 1) {
					// No fallback models configured — fail over to the next account.
					// 429s should never be forwarded to the client when other
					// accounts are available; only genuine model-not-found
					// errors (404/400) warrant returning the upstream response.
					if (rawResponse.status === 429) {
						// Skip cooldown on synthetic cache-keepalive replays. The
						// keepalive scheduler fires parallel requests to every
						// cached account; a burst of 4+ simultaneous requests
						// trips Anthropic's per-IP burst limit and 429s every
						// account at the same instant. Applying real cooldowns
						// here drains the pool to zero routable accounts even
						// though no real user-facing rate limit was hit.
						const isKeepalive =
							req.headers.get("x-clankermux-keepalive") === "true";
						if (isKeepalive) {
							log.warn(
								`Keepalive replay for ${account.name} got 429 — skipping cooldown (synthetic burst, not a real per-account rate limit)`,
							);
							return await fail({ kind: "other" }, rawResponse);
						}

						log.warn(
							`Account ${account.name} rate-limited (429), no model fallbacks — failing over to next account`,
						);
						const cooldownUntil = extractCooldownUntil(
							rawResponse,
							account.id,
							usageCache.getRateLimitedUntil.bind(usageCache),
						);
						const reason: RateLimitReason = "model_fallback_429";
						// Route through shared helper so the consecutive_rate_limits
						// counter and exponential backoff are applied uniformly across
						// all 429 paths. Pass cooldownUntil as resetTime — the helper
						// caps via min(resetTime, now + backoff). The audit reason is
						// preserved so saveRequest + DB rate_limited_reason both record
						// the failure-mode-specific tag.
						applyRateLimitCooldown(
							account,
							{ resetTime: cooldownUntil, reason },
							ctx,
						);
						const responseTime = Date.now() - requestMeta.timestamp;
						// Deliberate direct audit row (one per failed attempted
						// account, synthetic UUID id) — NOT owned by RequestRecorder
						// (S2). The recorder records the single final outcome under
						// requestMeta.id; these capture each individual failed attempt.
						ctx.asyncWriter.enqueue(() =>
							ctx.dbOps.saveRequest(
								crypto.randomUUID(),
								req.method,
								url.pathname,
								account.id,
								429,
								false,
								reason,
								responseTime,
								failoverAttempts,
								undefined,
								apiKeyId ?? undefined,
								apiKeyName ?? undefined,
								requestMeta.project ?? null,
								undefined,
								requestMeta.comboName ?? null,
							),
						);
						return await fail({ kind: "hard_429", cooldownUntil }, rawResponse);
					}
					// Model-not-found (404/400) is forwarded to the client so it can
					// surface the real error. Strip content-encoding/content-length
					// first: Bun's fetch already decompressed the body, so leaving the
					// upstream `content-encoding: gzip` header makes the client try to
					// gunzip plaintext → "Decompression error: ZlibError".
					//
					// This is a DIRECT return that bypasses forwardToClient, so no
					// onSummary/discardStaged staging signal would ever fire for this
					// request id. Drop the staged body now or it leaks until the age
					// sweep (B4) — every other return path either routes through
					// forwardToClient (→ onSummary) or is a `return null` failover the
					// proxy.ts caller cleans up via discardStaged.
					cacheBodyStore.discardStaged(requestMeta.id);
					options?.onOutcome?.({ kind: "model_not_found" });
					return withSanitizedProxyHeaders(rawResponse);
				}

				for (let i = 1; i < modelList.length; i++) {
					const nextModel = modelList[i];
					log.info(
						`Model '${modelList[i - 1]}' unavailable/rate-limited on account ${account.name}, ` +
							`retrying with: ${nextModel} (${i}/${modelList.length - 1})`,
					);

					// Patch the original request body with the next model name, then let
					// transformRequestBody handle format conversion (e.g. Anthropic→OpenAI).
					// After that, re-patch the model name because transformRequestBody calls
					// mapModelName internally which remaps non-Claude names back to the primary
					// model (no family match → sonnet fallback). We always want nextModel to
					// reach the upstream provider verbatim.
					const patchedContext =
						effectiveBodyContext.withPatchedModel(nextModel);
					const patchedBody = patchedContext?.getBuffer() ?? null;
					if (!patchedBody) {
						log.warn("Failed to patch request body for model retry");
						break;
					}

					const retryRequestInit: RequestInit & { duplex?: "half" } = {
						method: req.method,
						headers,
						body: new Uint8Array(patchedBody),
						duplex: "half",
					};

					const retryProviderRequest = new Request(targetUrl, retryRequestInit);
					let retryTransformedRequest = provider.transformRequestBody
						? await provider.transformRequestBody(retryProviderRequest, account)
						: retryProviderRequest;

					// Re-patch model after transformRequestBody — the provider's conversion
					// (e.g. convertAnthropicRequestToOpenAI) calls mapModelName which can
					// remap nextModel back to the primary model if it has no Claude family
					// pattern. Force nextModel into the final request body.
					try {
						const transformedText = await retryTransformedRequest
							.clone()
							.text();
						const transformedBody = JSON.parse(transformedText);
						if (transformedBody.model !== nextModel) {
							transformedBody.model = nextModel;
							const repatchedHeaders = new Headers(
								retryTransformedRequest.headers,
							);
							retryTransformedRequest = new Request(
								retryTransformedRequest.url,
								{
									method: retryTransformedRequest.method,
									headers: repatchedHeaders,
									body: JSON.stringify(transformedBody),
								},
							);
						}
					} catch {
						// If re-patching fails, proceed with the transformed request as-is
					}

					// Acquire the retry first, then cancel the previous attempt's
					// body — a throw here leaves the prior body for the outer catch.
					const retryResponse = await makeProxyRequest(
						retryTransformedRequest,
						undefined,
						undefined,
						undefined,
						undefined,
						options?.signal,
					);
					await discardUpstreamBody(rawResponse);
					rawResponse = retryResponse;
					liveUpstream = rawResponse;

					// Pass rawResponse directly (not a .clone()): the helper clones
					// internally only when it must parse a 400/404 JSON body, and
					// returns early for 429 without touching the body. An outer
					// .clone() here would orphan an unconsumed tee branch on 429.
					if (!(await isModelUnavailableError(rawResponse))) {
						break; // Success — stop cycling
					}
				}
			}

			// If still unavailable/rate-limited after exhausting the model list,
			// failover to the next account. OpenAI-compatible providers never set
			// isRateLimited:true in parseRateLimit, so we must handle it here.
			if (await isModelUnavailableError(rawResponse)) {
				log.warn(
					`All models exhausted on account ${account.name}, failing over to next account`,
				);
				// Mark account rate-limited so that isAccountAvailable() excludes it
				// from future requests until the cooldown expires. The shared
				// applyRateLimitCooldown helper computes a capped exponential-backoff
				// cooldown and writes it to the DB; without it the same account would
				// be retried on every subsequent request.
				// Only fire for genuine rate-limit responses (429); model-not-found
				// (404/400) is a configuration issue, not account exhaustion.
				if (rawResponse.status === 429) {
					// Same keepalive-skip as the no-fallback path above: synthetic
					// keepalive bursts can trip Anthropic's per-IP limit even when
					// individual accounts are healthy.
					const isKeepalive =
						req.headers.get("x-clankermux-keepalive") === "true";
					if (isKeepalive) {
						log.warn(
							`Keepalive replay for ${account.name} got 429 (post-model-list) — skipping cooldown`,
						);
					} else {
						const cooldownUntil = extractCooldownUntil(
							rawResponse,
							account.id,
							usageCache.getRateLimitedUntil.bind(usageCache),
						);
						const reason: RateLimitReason = "all_models_exhausted_429";
						// Route through shared helper so the consecutive_rate_limits
						// counter and exponential backoff are applied uniformly across
						// all 429 paths. Pass cooldownUntil as resetTime — the helper
						// caps via min(resetTime, now + backoff). The audit reason is
						// preserved so saveRequest + DB rate_limited_reason both record
						// the failure-mode-specific tag.
						applyRateLimitCooldown(
							account,
							{ resetTime: cooldownUntil, reason },
							ctx,
						);
						const responseTime = Date.now() - requestMeta.timestamp;
						// Deliberate direct audit row (one per failed attempted
						// account, synthetic UUID id) — NOT owned by RequestRecorder
						// (S2). The recorder records the single final outcome under
						// requestMeta.id; these capture each individual failed attempt.
						ctx.asyncWriter.enqueue(() =>
							ctx.dbOps.saveRequest(
								crypto.randomUUID(),
								req.method,
								url.pathname,
								account.id,
								429,
								false,
								reason,
								responseTime,
								failoverAttempts,
								undefined,
								apiKeyId ?? undefined,
								apiKeyName ?? undefined,
								requestMeta.project ?? null,
								undefined,
								requestMeta.comboName ?? null,
							),
						);
					}
				}
				return await fail(
					rawResponse.status === 429
						? { kind: "hard_429" }
						: { kind: "model_not_found" },
					rawResponse,
				);
			}
		}

		// Inject request metadata into response headers so providers can read
		// stream intent and request ID without needing the original request object.
		const responseHeaders = new Headers(rawResponse.headers);
		responseHeaders.set("x-clankermux-request-id", requestMeta.id);
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

		// Process response (transform format, sanitize headers, etc.) using account-specific provider
		const response = await provider.processResponse(
			taggedRawResponse,
			account,
			req.headers,
		);
		liveUpstream = response;

		// Failover to next account on upstream 401 — credentials are invalid/expired
		if (response.status === 401) {
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
			applyProviderOverloadCooldown(account.provider, rateLimitInfo.resetTime);

			if (returnRateLimitedResponseOnExhaustion) {
				log.warn(
					`Provider ${account.provider} returned final 529 overload response — forwarding upstream response instead of pool_exhausted`,
				);
				return forwardToClient(
					{
						requestId: requestMeta.id,
						method: req.method,
						path: url.pathname,
						account,
						requestHeaders: req.headers,
						requestBody: effectiveBodyBuffer,
						project: requestMeta.project,
						response,
						timestamp: requestMeta.timestamp,
						retryAttempt: 0,
						failoverAttempts,
						comboName: requestMeta.comboName,
						apiKeyId,
						apiKeyName,
						routing: requestMeta.routing ?? null,
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
			returnRateLimitedResponseOnExhaustion && response.status === 529
				? response.clone()
				: response;
		const isRateLimited = await processProxyResponse(
			responseForRateLimitCheck,
			account,
			{
				...ctx,
				provider,
			},
			requestMeta.id,
			requestMeta,
		);
		// processProxyResponse only needed the rate-limit view (headers, or a
		// provider body-parse that consumes it). When it was a distinct clone
		// (final-529 path), release its possibly tee-buffered branch now — the
		// original `response` is what gets forwarded/returned below.
		if (responseForRateLimitCheck !== response) {
			await discardUpstreamBody(responseForRateLimitCheck);
		}
		if (isRateLimited) {
			if (returnRateLimitedResponseOnExhaustion && response.status === 529) {
				log.warn(
					`Account ${account.name} returned final 529 overload response — forwarding upstream response instead of pool_exhausted`,
				);
				return forwardToClient(
					{
						requestId: requestMeta.id,
						method: req.method,
						path: url.pathname,
						account,
						requestHeaders: req.headers,
						requestBody: effectiveBodyBuffer,
						project: requestMeta.project,
						response,
						timestamp: requestMeta.timestamp,
						retryAttempt: 0,
						failoverAttempts,
						comboName: requestMeta.comboName,
						apiKeyId,
						apiKeyName,
						routing: requestMeta.routing ?? null,
					},
					{ ...ctx, provider },
				);
			}
			// A rate-limited failover that reached processProxyResponse (i.e. NOT a
			// 429 — those are intercepted in the isModelUnavailableError branch
			// above — but a 529/other rate-limit signal): record as hard_429-class
			// so the proxy never treats it as hold-eligible.
			return await fail(
				response.status === 529
					? { kind: "overload_529" }
					: { kind: "hard_429" },
				response,
			);
		}

		// Forward response to client
		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account,
				requestHeaders: req.headers,
				requestBody: effectiveBodyBuffer,
				project: requestMeta.project,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
				routing: requestMeta.routing ?? null,
			},
			{ ...ctx, provider },
		);
	} catch (err) {
		handleProxyError(err, account, log);
		// Release any upstream body owned at the point of failure so a thrown
		// error (e.g. mid-processResponse) doesn't leak its socket/read buffer.
		return await fail({ kind: "network_error" }, liveUpstream);
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
	// Hoisted to function scope so the outer catch (which may fire before
	// `provider` is assigned, e.g. a validateProviderPath throw) and the
	// local-error recorder can reference them. effectiveBodyBuffer feeds the
	// recorder's captured request body; provider drives forwardToClient's
	// recordable-request predicate and stream detection.
	let effectiveBodyBuffer: ArrayBuffer | null = null;
	let provider = ctx.provider;

	// Record a forced-mode LOCAL error (token-resolution throw / outer catch)
	// under the forced account so it appears in Request History, exactly like
	// the forced UPSTREAM response is recorded via the success-path
	// forwardToClient. disableCooldown:true matches the success path — a forced
	// account never mutates cooldown state. forwardToClient handles a synthetic
	// small non-streaming JSON error Response via its tee() read path.
	const recordLocalError = (reason: string): Promise<Response> => {
		const errorResponse = createForcedAccountUnavailableResponse(
			account,
			reason,
		);
		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account,
				requestHeaders: req.headers,
				requestBody: effectiveBodyBuffer,
				project: requestMeta.project,
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
		// Apply the account's model mapping exactly as the normal path does. The
		// combo-style modelOverride patches the request body's `model` field;
		// when absent, transformRequestBody's mapModelName does the family map.
		const baseBodyContext =
			requestBodyContext ?? new RequestBodyContext(requestBodyBuffer);
		let _effectiveBodyContext = baseBodyContext;
		effectiveBodyBuffer = baseBodyContext.getBuffer();
		if (modelOverride && effectiveBodyBuffer) {
			const overriddenContext = baseBodyContext.withPatchedModel(modelOverride);
			if (overriddenContext) {
				_effectiveBodyContext = overriddenContext;
				effectiveBodyBuffer = overriddenContext.getBuffer();
			}
		}

		// Get the provider for this account
		provider = getProvider(account.provider) || ctx.provider;

		// Validate that the account-specific provider can handle this path
		validateProviderPath(provider, url.pathname);

		// Resolve the access token via the same path the normal flow uses. If it
		// throws (expired/unrefreshable token), map to a local error Response —
		// NOT null/failover (R2). Routed through forwardToClient so the local
		// failure is recorded under the forced account (history intact).
		let accessToken: string;
		try {
			accessToken = await getValidAccessToken(account, ctx);
		} catch (tokenErr) {
			const reason =
				tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
			log.warn(
				`Forced account ${account.name}: token resolution failed — returning local error (no failover): ${reason}`,
			);
			return await recordLocalError(reason);
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
		const targetUrl = provider.buildUrl(url.pathname, url.search, account);

		const requestInit: RequestInit & { duplex?: "half" } = {
			method: req.method,
			headers,
		};
		if (effectiveBodyBuffer) {
			requestInit.body = new Uint8Array(effectiveBodyBuffer);
			requestInit.duplex = "half";
		}

		const providerRequest = new Request(targetUrl, requestInit);
		const transformedRequest = provider.transformRequestBody
			? await provider.transformRequestBody(providerRequest, account)
			: providerRequest;

		// Exactly ONE upstream request. No thinking-signature / cache-control
		// pre-retries, no model-fallback cycling.
		const rawResponse = await makeProxyRequest(transformedRequest);

		// Inject request metadata into response headers so providers can read
		// stream intent and request ID (mirrors the normal path).
		const responseHeaders = new Headers(rawResponse.headers);
		responseHeaders.set("x-clankermux-request-id", requestMeta.id);
		const internalRequestStream = transformedRequest.headers.get(
			"x-clankermux-request-stream",
		);
		if (internalRequestStream === "true" || internalRequestStream === "false") {
			responseHeaders.set("x-clankermux-request-stream", internalRequestStream);
		}
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

		// Forward to client for recording + streaming. disableCooldown:true keeps
		// the mid-stream rate-limit sniffer from mutating cooldown state on a
		// forced 429/529.
		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account,
				requestHeaders: req.headers,
				requestBody: effectiveBodyBuffer,
				project: requestMeta.project,
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
 */
export interface ContextWindowExcludedBackend {
	account: Account;
	model: string;
}

export function createContextWindowExceededResponse(
	estimatedTokens: number,
	excludedBackends: ContextWindowExcludedBackend[],
	requestModel: string,
): Response {
	const backendDescriptions = excludedBackends.map(({ account, model }) => {
		const target = resolveCodexTargetModel(model, account);
		const window = resolveModelContextWindow(target);
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

	const message =
		`Request estimated at ~${estimatedTokens} tokens exceeds the context ` +
		`window of every available backend: ${backendSummary}. ` +
		`Larger-context accounts are currently unavailable (rate-limited or paused).`;

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
