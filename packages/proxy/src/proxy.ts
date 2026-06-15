import {
	codexAccountFitsRequest,
	estimateRequestTokens,
	resolveCodexTargetModel,
	resolveModelContextWindow,
	ServiceUnavailableError,
	trackClientVersion,
} from "@clankermux/core";
import { sanitizeRequestHeaders } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import { getFreshCapacity, usageCache } from "@clankermux/providers";
import {
	type Account,
	getNativeResponsesRequestContext,
	setNativeResponsesMetaContext,
} from "@clankermux/types";
import { cacheBodyStore } from "./cache-body-store";
import { computeContextAndToolStats } from "./context-composition";
import {
	abortableSleep,
	BURST_RETRY_MAX_USAGE_AGE_MS,
	type ContextWindowExcludedBackend,
	createContextWindowExceededResponse,
	createPinnedTargetUnavailableResponse,
	createPoolExhaustedResponse,
	createRequestMetadata,
	createUsageThrottledResponse,
	ERROR_MESSAGES,
	getComboSlotInfo,
	getForcedAccount,
	getUsageThrottleUntil,
	HOLD_OVERFLOW,
	holdAndRetryCacheAccount,
	isAnthropicBurstThrottleActive,
	isOAuthAnthropicAccount,
	isRefreshTokenLikelyExpired,
	type ProxyAttemptOutcome,
	type ProxyContext,
	prepareRequestBody,
	proxyForcedAccount,
	proxyWithAccount,
	RequestBodyContext,
	type RequestJsonBody,
	selectAccountsForRequest,
	setForcedAccount,
	validateProviderPath,
} from "./handlers";
import { resolveProject } from "./project-extraction";
import {
	ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
	getProviderOverloadKey,
	getProviderOverloadUntil,
	isOfficialAnthropicProvider,
	isProviderOverloaded,
} from "./provider-overload-cooldown";
import { parseReasoningEffort } from "./reasoning-effort";
import { extractRequestAffinity } from "./request-affinity";
import type { RecordMeta, RequestRecorder } from "./request-recorder";
import { hashRoutingAffinityKey } from "./routing-telemetry";
import { sessionProjectCache } from "./session-project-cache";
import { shouldRecordRequest } from "./should-record-request";

export type { ProxyContext } from "./handlers";

const log = new Logger("Proxy");

// Max time (ms) the proxy will hold an open connection waiting for a
// rate-limited large-context (non-Codex) account to become available before
// falling back to a 400 context_window_exceeded. Matches BURST_RETRY_MAX_HOLD_MS
// (120s) — both are bounds on how long we hold a live client connection.
const CW_HOLD_MAX_MS = 120_000;
// Small jitter (ms) added to each CW hold sleep to avoid thundering herd.
const CW_HOLD_JITTER_MS = 500;

// ===== REQUEST RECORDER WIRING =====

// The RequestRecorder owns request persistence + the dashboard "summary" event.
// Usage is now computed inline on the main thread (see response-handler.ts +
// usage-collector.ts) — the post-processor worker has been retired entirely, so
// there is no module-scoped controller or onSummary callback to wire anymore.
// server.ts still constructs the recorder and registers it here; the handler
// reads ctx.requestRecorder directly, and the module-level reference is kept
// only for symmetry with the previous wiring (currently unused at module scope).
let requestRecorder: RequestRecorder | null = null;

export function setRequestRecorder(recorder: RequestRecorder): void {
	requestRecorder = recorder;
}

// Read accessor kept so the reference isn't flagged unused; callers use
// ctx.requestRecorder, not this.
export function getRequestRecorder(): RequestRecorder | null {
	return requestRecorder;
}

/**
 * Build a constructed, retryable 429 response for the transparent burst-retry
 * give-up / last-resort-exhausted path. The real upstream 429 body has already
 * been discarded (its socket released) by the time we reach here, so we
 * synthesize a fresh JSON body with a clear message and a `Retry-After` derived
 * from the held account's remaining cooldown.
 *
 * Status 429 (not 503): the condition is a transient per-IP burst throttle the
 * client should simply retry shortly, not a hard pool exhaustion.
 */
function createBurstRetryGiveUpResponse(heldAccount: Account): Response {
	const now = Date.now();
	const until = heldAccount.rate_limited_until ?? now + 30_000;
	const retryAfterSeconds = Math.max(1, Math.round((until - now) / 1000));
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limited",
				message:
					"Upstream is briefly rate-limited (transient burst throttle). " +
					"The request was held and re-probed but the throttle did not clear " +
					"in time, and no fallback backend could serve it. Please retry shortly.",
				retry_after_seconds: retryAfterSeconds,
			},
		}),
		{
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfterSeconds),
				"x-clankermux-burst-retry": "exhausted",
			},
		},
	);
}

/**
 * Synthetic response returned when a transparent burst-retry hold gave up
 * because the CLIENT disconnected mid-hold (Finding 2). The client is already
 * gone, so the body is never read — we only need a terminal Response so the
 * handler stops WITHOUT issuing further sibling/Codex upstream requests for a
 * request nobody is waiting on. Uses 499 (Client Closed Request) so history/logs
 * reflect the disconnect rather than a server-side failure.
 */
function createClientAbortResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "client_closed_request",
				message: "Client disconnected before the request could be served.",
			},
		}),
		{
			status: 499,
			headers: {
				"Content-Type": "application/json",
				"x-clankermux-burst-retry": "client-aborted",
			},
		},
	);
}

/**
 * Burst-hold eligibility guard (Codex High finding): the transparent burst-retry
 * hold may ONLY target an account whose unavailability is a rate-limit cooldown
 * (the storm shape — strategy decision `affinity_hold`) OR an account that is
 * currently available (present in the gated `accounts` list, decision
 * `affinity_hit`). It must NEVER hold an account that was removed by the
 * usage-throttle (`applyUsageThrottling`) or context-window gate — those gates
 * drop accounts that still have positive rate-limit headroom, so holding+probing
 * such an account would issue an upstream call that bypasses the configured
 * pacing throttle / context safety check.
 *
 * `heldAccountId` is set by the routing strategy on BOTH `affinity_hit` (the
 * affined account was available and selected) and `affinity_hold` (the affined
 * account is genuinely cooldown-unavailable). An account that was selected as
 * `affinity_hit` but then gated OUT of `accounts` by usage-throttle/context is
 * therefore NOT eligible — only its presence in `accounts` (still available) or
 * an `affinity_hold` decision (cooldown-unavailable) makes it holdable.
 *
 * @param decision           `requestMeta.routing?.decision`
 * @param heldInGatedAccounts whether the held account is present in the gated
 *                            `accounts` list (i.e. survived every gate)
 */
function isBurstHoldEligible(
	decision: string | undefined,
	heldInGatedAccounts: boolean,
): boolean {
	return heldInGatedAccounts || decision === "affinity_hold";
}

// ===== MAIN HANDLER =====

/**
 * Main proxy handler - orchestrates the entire proxy flow
 *
 * This function coordinates the proxy process by:
 * 1. Creating request metadata for tracking
 * 2. Validating the provider can handle the path
 * 3. Preparing the request body for reuse
 * 4. Selecting accounts based on load balancing strategy
 * 5. Attempting to proxy with each account in order
 * 6. Falling back to unauthenticated proxy if no accounts available
 *
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param ctx - The proxy context containing strategy, database, and provider
 * @param apiKeyId - Optional API key ID for tracking
 * @param apiKeyName - Optional API key name for tracking
 * @returns Promise resolving to the proxied response
 * @throws {ValidationError} If the provider cannot handle the path
 * @throws {ServiceUnavailableError} If all accounts fail to proxy the request
 * @throws {ProviderError} If unauthenticated proxy fails
 */
export async function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	isInternal = false,
): Promise<Response> {
	// 0. Silently ignore Claude Code internal endpoints (non-critical, not supported by all providers)
	if (
		url.pathname === "/api/event_logging/batch" ||
		url.pathname === "/api/system/package-manager"
	) {
		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	// 1. Track client version from user-agent for use in auto-refresh
	trackClientVersion(req.headers.get("user-agent"));

	// 2. Validate provider can handle path
	validateProviderPath(ctx.provider, url.pathname);

	// 3. Prepare request body
	const { buffer: requestBodyBuffer } = await prepareRequestBody(req);
	const requestBodyContext = new RequestBodyContext(requestBodyBuffer);

	// 3b. Optionally inject 1h TTL into system prompt cache_control blocks
	if (ctx.config.getSystemPromptCacheTtl1h() && requestBodyBuffer) {
		injectSystemCacheTtl(requestBodyContext);
	}

	// Extract model from request body for family detection (used by combo routing)
	// and reuse parsed body for /v1/messages validation (consolidate parses)
	const parsedBody = requestBodyContext.getParsedJson();
	const requestModel = requestBodyContext.getModel();
	const resolved = resolveProject(
		req.method,
		url.pathname,
		req.headers,
		parsedBody,
		apiKeyId ?? null,
		sessionProjectCache,
	);
	const project = resolved.project;
	// Ingest-time context composition + per-tool call/error stats: walk the
	// already-parsed body once (no second JSON.parse) for proxied /v1/messages
	// requests only. null for other endpoints / unparseable bodies → context_*
	// columns stay NULL and no tool-call rows are written.
	const { composition: contextComposition, toolStats: toolCallStats } =
		req.method === "POST" && url.pathname === "/v1/messages"
			? computeContextAndToolStats(parsedBody)
			: { composition: null, toolStats: null };
	const affinity = extractRequestAffinity(req.headers);

	// Conservative token estimate for context-window-aware routing (B1).
	// Computed once; used to gate Codex accounts whose mapped model can't fit
	// the request (B3) and to build the context_window_exceeded error (B4).
	const requestTokenEstimate = estimateRequestTokens(
		parsedBody,
		contextComposition,
	);

	// 3a. Validate request body for /v1/messages endpoint
	if (url.pathname === "/v1/messages" && requestBodyBuffer) {
		if (parsedBody) {
			// Reject requests without messages field (e.g., Claude Code internal events)
			if (!parsedBody.messages || !Array.isArray(parsedBody.messages)) {
				log.warn(
					`Rejected invalid request to /v1/messages without messages field`,
					{
						event_type: parsedBody.event_type,
						event_name: (
							parsedBody.event_data as Record<string, unknown> | undefined
						)?.event_name,
					},
				);
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message:
								"messages: Field required for /v1/messages endpoint. Internal events should not be proxied.",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		} else {
			// If we can't parse the body, let it through and let the provider handle it
			log.debug("Could not parse request body for validation");
		}
	}

	// 3c. Tier-4 seed commit: the request survived validation (can no longer be
	// 400-rejected above), so it's safe to remember session → project for
	// signal-less sibling requests (sidechains, title generation, count_tokens).
	if (resolved.source === "anchored" && resolved.sessionKey && project) {
		const previousProject = sessionProjectCache.set(
			resolved.sessionKey,
			project,
		);
		if (previousProject !== null && previousProject !== project) {
			log.debug(
				`Session ${resolved.sessionKey} transitioned projects: ${previousProject} -> ${project}`,
			);
		}
	}

	const finalBodyBuffer = requestBodyContext.getBuffer();
	const finalCreateBodyStream = () => {
		if (!finalBodyBuffer) return undefined;
		return new Response(finalBodyBuffer).body ?? undefined;
	};

	const effectiveRequestModel = requestBodyContext.getModel() ?? requestModel;

	// 4. Create request metadata
	const requestMeta = createRequestMetadata(req, url);
	// Native Responses passthrough: re-key the adapter's Request-scoped context
	// onto the RequestMeta so it reaches each per-account attempt downstream.
	const nativeResponsesCtx = getNativeResponsesRequestContext(req);
	if (nativeResponsesCtx) {
		setNativeResponsesMetaContext(requestMeta, nativeResponsesCtx);
	}
	requestMeta.internal = isInternal;
	requestMeta.affinityKey = affinity.key;
	requestMeta.affinityScope = affinity.scope;
	requestMeta.affinityPartition = apiKeyId ? `api_key:${apiKeyId}` : null;
	requestMeta.project = project;
	requestMeta.contextComposition = contextComposition;
	requestMeta.toolCallStats = toolCallStats;
	// Per-request reasoning effort, derived once for all failover attempts. The
	// Codex path's translated Anthropic body loses reasoning.effort, so fall
	// back to the value captured from the ORIGINAL Responses body (Stage A).
	requestMeta.reasoningEffort =
		parseReasoningEffort(parsedBody) ??
		nativeResponsesCtx?.reasoningEffort ??
		null;
	// Unconditional floor for Codex-CLI traffic: the /v1/responses adapter sets
	// this header on every request it forwards. When set, the request may never
	// be routed to (or burst-held on) an official Claude account — independent of
	// any API-key pin or auth config.
	requestMeta.excludeOfficialAnthropic =
		req.headers.get("x-clankermux-deny-official-anthropic") === "1";

	// 4b. Global force-account override (Feature 3). When a forced account is
	// set, EVERY non-internal client request goes straight to that account:
	// account selection, ALL gates (provider-overload / usage-throttle /
	// context-window), and ALL failover/retry are skipped entirely. The forced
	// account's response — including errors (429/529/5xx) — is returned as-is.
	// Internal auto-refresh/probe requests bypass force so other accounts keep
	// their tokens/usage warm (Q1).
	const forcedId = getForcedAccount();
	if (forcedId && !isInternal) {
		const forcedAccount = await ctx.dbOps.getAccount(forcedId);
		if (!forcedAccount) {
			// Defensive: a forced account deleted mid-flight must not brick all
			// traffic. Clear the force so subsequent requests route normally, but
			// return an explicit 503 for THIS request rather than silently falling
			// back — that would violate the absolute-force contract (R2).
			//
			// NOTE: this rarest case (forced account deleted between selection and
			// dispatch) is intentionally left UNRECORDED. recordSyntheticErrorResponse
			// is defined further below; relocating this early-return past it would
			// require splitting the forced block (the success path returns above,
			// before that definition) and reordering it past account selection / the
			// gate logic — an ordering hazard not worth taking for a case that fires
			// only when an operator deletes the forced account in the request window.
			// The high-value forced-mode local errors (dead-token throw, outer catch)
			// ARE recorded under the forced account via forwardToClient in
			// proxyForcedAccount.
			log.error(
				`Forced account ${forcedId} not found — clearing force and returning 503`,
			);
			setForcedAccount(null);
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "forced_account_missing",
						message: `The forced account (${forcedId}) no longer exists. Force has been cleared; retry the request.`,
					},
				}),
				{
					status: 503,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Codex-CLI floor (API-key pin backstop) overrides the global force: a
		// /v1/responses request carrying excludeOfficialAnthropic must NEVER be
		// routed to an official Claude account, even under an operator force-route
		// (ban risk + not a cross-model review). Fail closed. Left UNRECORDED for
		// the same ordering reason as the forced-missing case above
		// (recordSyntheticErrorResponse isn't defined this early).
		if (
			requestMeta.excludeOfficialAnthropic &&
			isOfficialAnthropicProvider(forcedAccount.provider)
		) {
			log.warn(
				`Force-account ${forcedAccount.name} is an official Anthropic account; refusing a deny-official-anthropic (Codex CLI) request`,
			);
			return createPinnedTargetUnavailableResponse({
				code: "anthropic_excluded_no_account",
				message:
					"Codex CLI traffic may not be routed to a Claude/Anthropic account; the globally forced account is a Claude account.",
			});
		}

		requestMeta.routing = {
			strategy: "forced",
			decision: "force_account_global",
			selectedAccountId: forcedAccount.id,
			candidatesCount: 1,
			affinityScope: null,
			affinityKey: null,
			previousAccountId: null,
			failoverReason: null,
		};

		log.info(
			`Force-account override active: routing to ${forcedAccount.name} (${forcedAccount.provider}) — bypassing selection, gates, and failover`,
		);

		return await proxyForcedAccount(
			req,
			url,
			forcedAccount,
			requestMeta,
			finalBodyBuffer,
			ctx,
			null,
			apiKeyId,
			apiKeyName,
			requestBodyContext,
		);
	}

	// Resolve the per-key routing pin (Feature: API-key→account/class pin). Only
	// for authenticated client requests; internal probes carry no apiKeyId and
	// must stay unconstrained. On a DB error we FAIL CLOSED — refuse the request
	// (pinned_resolution_error) rather than silently routing a pinned key to a
	// disallowed account. For a Codex-pinned key, routing unpinned could answer
	// from a Claude OAuth account (ban risk + not the intended cross-model path),
	// so "can't tell what the pin is" must never degrade to "ignore the pin".
	if (apiKeyId && !isInternal) {
		try {
			const pin = await ctx.dbOps.getApiKeyPin(apiKeyId);
			if (pin?.malformed) {
				// The pin is stored but unparseable (corruption / manual tampering).
				// Fail closed — treating it as "unpinned" could route a Codex-pinned
				// key to a Claude account (ban risk + wrong model).
				requestMeta.pinFailure = {
					code: "pinned_resolution_error",
					message:
						"The API key routing pin is stored in an invalid form. Refusing to route to avoid violating the pin.",
				};
			} else if (
				pin &&
				(pin.pinnedAccountId ||
					(pin.pinnedProviders && pin.pinnedProviders.length > 0))
			) {
				requestMeta.pin = {
					accountId: pin.pinnedAccountId,
					providers: pin.pinnedProviders,
				};
			}
		} catch (err) {
			log.error(
				"Failed to resolve API key pin; failing closed to avoid routing a pinned key to a disallowed account",
				err,
			);
			requestMeta.pinFailure = {
				code: "pinned_resolution_error",
				message:
					"Could not resolve the API key routing pin (database error). Refusing to route to avoid violating the pin.",
			};
		}
	}

	// 5. Select accounts
	const selectedAccounts = await selectAccountsForRequest(
		requestMeta,
		ctx,
		effectiveRequestModel ?? undefined,
	);

	type ProviderOverloadedAccount = { account: Account; until: number };

	const providerOverloadResponseLabel = (overloadKey: string): string =>
		overloadKey === ANTHROPIC_UPSTREAM_OVERLOAD_KEY ? "anthropic" : overloadKey;

	const recordSyntheticErrorResponse = (
		response: Response,
		error: string,
	): void => {
		// Same recordable-request predicate as forwardToClient (S1) — keeps
		// synthetic pool/provider-exhaustion rows out of history for the same
		// filtered set (auto-refresh probes, etc.).
		if (
			!shouldRecordRequest({
				method: req.method,
				path: url.pathname,
				providerName: ctx.provider.name,
				responseStatus: response.status,
				getHeader: (name) => req.headers.get(name),
			})
		) {
			return;
		}

		// Synthetic terminal responses (pool/provider-exhaustion) write a request
		// row directly via the recorder — the slim worker no longer persists, so
		// posting start/end to it would vanish (amendment B1). No body, no usage.
		const meta: RecordMeta = {
			requestId: requestMeta.id,
			method: req.method,
			path: url.pathname,
			accountId: null,
			accountName: null,
			responseStatus: response.status,
			responseHeaders: Object.fromEntries(response.headers.entries()),
			requestHeaders: Object.fromEntries(
				sanitizeRequestHeaders(req.headers).entries(),
			),
			isStream: false,
			providerName: ctx.provider.name,
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: 0,
			authed: false,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			comboName: null,
			project: project ?? null,
			reasoningEffort: requestMeta.reasoningEffort ?? null,
			routing: requestMeta.routing
				? {
						strategy: requestMeta.routing.strategy,
						decision: requestMeta.routing.decision,
						affinityScope: requestMeta.routing.affinityScope ?? null,
						affinityKeyHash: hashRoutingAffinityKey(
							requestMeta.routing.affinityKey,
						),
						selectedAccountId: requestMeta.routing.selectedAccountId ?? null,
						previousAccountId: requestMeta.routing.previousAccountId ?? null,
						candidatesCount: requestMeta.routing.candidatesCount ?? null,
						failoverReason: requestMeta.routing.failoverReason ?? null,
					}
				: null,
			timestamp: requestMeta.timestamp,
			requestBody: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};
		ctx.requestRecorder.recordSynthetic(meta, "error", error);
	};

	const createProviderOverloadedResponse = (
		overloaded: ProviderOverloadedAccount[],
	): Response => {
		const now = Date.now();
		const nextAvailableAt = Math.min(...overloaded.map(({ until }) => until));
		const retryAfterSeconds = Math.max(
			1,
			Math.ceil((nextAvailableAt - now) / 1000),
		);
		const providers = Array.from(
			new Set(
				overloaded.map(({ account }) =>
					providerOverloadResponseLabel(
						getProviderOverloadKey(account.provider),
					),
				),
			),
		);
		const response = new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "overloaded_error",
					message: `Provider temporarily overloaded: ${providers.join(", ")}`,
					providers,
					next_available_at: new Date(nextAvailableAt).toISOString(),
				},
			}),
			{
				status: 529,
				headers: {
					"Content-Type": "application/json",
					"Retry-After": String(retryAfterSeconds),
				},
			},
		);
		recordSyntheticErrorResponse(response, "provider_overloaded");
		return response;
	};

	const applyProviderOverloadGate = (accounts: Account[]) => {
		const now = Date.now();
		const available: Account[] = [];
		const overloaded: ProviderOverloadedAccount[] = [];

		for (const account of accounts) {
			const overloadedUntil = getProviderOverloadUntil(account.provider, now);
			if (overloadedUntil) {
				overloaded.push({ account, until: overloadedUntil });
				continue;
			}
			available.push(account);
		}

		if (overloaded.length > 0) {
			const providers = Array.from(
				new Set(
					overloaded.map(
						({ account, until }) =>
							`${getProviderOverloadKey(account.provider)} until ${new Date(until).toISOString()}`,
					),
				),
			);
			log.debug(
				`Provider-overload gate excluded ${overloaded.length} account(s): ${providers.join(", ")}`,
			);
		}

		return { available, overloaded };
	};

	const shouldForwardProviderOverloadIfNoCrossProviderFallback = (
		candidates: Account[],
		index: number,
	): boolean => {
		const current = candidates[index];
		if (
			!current ||
			getProviderOverloadKey(current.provider) !==
				ANTHROPIC_UPSTREAM_OVERLOAD_KEY
		) {
			return false;
		}
		const currentOverloadKey = getProviderOverloadKey(current.provider);
		return !candidates
			.slice(index + 1)
			.some(
				(account) =>
					getProviderOverloadKey(account.provider) !== currentOverloadKey &&
					!isProviderOverloaded(account.provider),
			);
	};

	const {
		available: providerAvailableAccounts,
		overloaded: providerOverloadedAccounts,
	} = applyProviderOverloadGate(selectedAccounts);

	const applyUsageThrottling = (accounts: Account[]) => {
		const settings = {
			fiveHourEnabled: ctx.config.getUsageThrottlingFiveHourEnabled(),
			weeklyEnabled: ctx.config.getUsageThrottlingWeeklyEnabled(),
		};
		if (!settings.fiveHourEnabled && !settings.weeklyEnabled) {
			return { available: accounts, throttled: [] as Account[] };
		}

		const now = Date.now();
		const available: Account[] = [];
		const throttled: Account[] = [];

		for (const account of accounts) {
			const throttleUntil = getUsageThrottleUntil(
				usageCache.get(account.id),
				settings,
				now,
			);
			if (throttleUntil && throttleUntil > now) {
				throttled.push(account);
				continue;
			}
			available.push(account);
		}

		if (throttled.length > 0) {
			log.info(
				`Usage-throttled ${throttled.length} account(s): ${throttled.map((account) => account.name).join(", ")}`,
			);
		}

		return { available, throttled };
	};

	const { available: postThrottleAccounts, throttled: throttledAccounts } =
		applyUsageThrottling(providerAvailableAccounts);

	// 6b. Context-window gate — exclude Codex accounts whose mapped model
	// can't fit the request (B3). Non-codex accounts always pass. When a combo
	// slot is active for the account, the gate evaluates against the slot's
	// model override instead of the request's family model (review C3). Force-
	// routed requests are gated too — force-route bypasses account *selection*,
	// not the size safety check.
	const contextExcludedAccounts: ContextWindowExcludedBackend[] = [];

	/**
	 * Apply context-window gate to a list of accounts.
	 * @param candidates Candidate accounts to filter
	 * @param comboInfo  Optional combo slot info for model override lookup
	 * @returns Accounts that pass the gate
	 */
	const applyContextWindowGate = (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	): Account[] => {
		const passed: Account[] = [];
		for (const account of candidates) {
			if (account.provider !== "codex") {
				passed.push(account);
				continue;
			}

			// Determine the effective model for this account: combo slot
			// override if available, otherwise the request model.
			let modelForGate =
				effectiveRequestModel ??
				"claude-sonnet-4-5"; /* safe fallback — family match */
			if (comboInfo) {
				const slot = comboInfo.slots.find((s) => s.accountId === account.id);
				if (slot?.modelOverride) {
					modelForGate = slot.modelOverride;
				}
			}

			if (
				!codexAccountFitsRequest(account, modelForGate, requestTokenEstimate)
			) {
				const target = resolveCodexTargetModel(modelForGate, account);
				const window = resolveModelContextWindow(target);
				log.info(
					`Context-window gate: excluding Codex account "${account.name}" ` +
						`(model=${modelForGate}, target=${target}, window=${window ?? "unknown"}, ` +
						`estimate=${requestTokenEstimate})`,
				);
				// Track for error-response purposes (deduplicate by id)
				if (
					!contextExcludedAccounts.some(
						(excluded) => excluded.account.id === account.id,
					)
				) {
					contextExcludedAccounts.push({ account, model: modelForGate });
				}
				continue;
			}
			passed.push(account);
		}
		return passed;
	};

	// Combo slot info (if any) is populated by selectAccountsForRequest above,
	// so it's available to the gate for combo-aware model override evaluation.
	const initialComboInfo = getComboSlotInfo(requestMeta);
	const accounts = applyContextWindowGate(
		postThrottleAccounts,
		initialComboInfo,
	);
	if (requestMeta.routing) {
		requestMeta.routing.selectedAccountId =
			accounts[0]?.id ?? requestMeta.routing.selectedAccountId ?? null;
		requestMeta.routing.candidatesCount = accounts.length;
	}

	// Transparent burst-retry hold state + orchestration (OAuth-Anthropic). These
	// are declared HERE — before the no-accounts terminal — because the
	// zero-accounts storm-degrade hold (Finding 1) runs inside that terminal, and
	// the normal decide-before-loop (section 9a below) runs after account
	// selection. Both reuse the SAME orchestration so it is defined exactly once.
	//
	// When the burst-retry first attempt tries the held account and it fails
	// non-retryably (e.g. a hard 429 / 401), we fall through to the normal loop
	// below — but the held account has already been attempted, so the loop must
	// skip it to avoid a wasteful duplicate request. Null when no first attempt
	// was made (marker-active path).
	let burstAttemptedAccountId: string | null = null;
	// Set when a burst hold was entered then declined/gave-up/overflowed. The
	// request then falls through to the normal failover loop (healthy siblings
	// first, then Codex-if-fits); if that loop ALSO produces no response, the
	// terminal error is the constructed burst-retry give-up 429 (built from
	// `burstHeldAccountForGiveUp`) rather than the generic ALL_ACCOUNTS_FAILED.
	let burstHoldDeclined = false;
	let burstHeldAccountForGiveUp: Account | null = null;
	// The cache-affinity-pinned account id recorded by the routing strategy (set
	// on affinity_hit, affinity_hold, and the zero-siblings storm-degrade hold).
	// The burst-hold only ever serves an OAuth-Anthropic account, so for a
	// Codex-CLI (excludeOfficialAnthropic) request it MUST be disabled — otherwise
	// the hold could serve a Claude account that selection deliberately excluded.
	const burstHeldId = requestMeta.excludeOfficialAnthropic
		? null
		: (requestMeta.routing?.heldAccountId ?? null);

	// Shared reprobe closure: re-attempt the given (held) account in reprobe mode
	// (cooldown gate bypassed, no re-staging, no streak escalation) with a supplied
	// AbortSignal so a client disconnect releases the hold promptly.
	// `holdAndRetryCacheAccount` always invokes this with the held account, so the
	// closure is generic over the account it is handed. Shared by the normal
	// decide-before-loop and the zero-accounts storm-degrade hold (Finding 1) so
	// both re-probe identically.
	const reprobe = async (
		probeAccount: Account,
		signal: AbortSignal,
	): Promise<Response | null> =>
		proxyWithAccount(
			req,
			url,
			probeAccount,
			requestMeta,
			finalBodyBuffer,
			finalCreateBodyStream,
			0,
			ctx,
			null,
			apiKeyId,
			apiKeyName,
			requestBodyContext,
			false,
			{ reprobe: true, signal },
		);

	// Outcome of a burst hold once it has run. `served` carries the real upstream
	// Response; `aborted` means the client disconnected mid-hold (Finding 2) and
	// the caller must NOT fall through to more upstream requests; `gave-up` means
	// the hold declined/exhausted/overflowed and the caller may fall through to
	// its normal failover (when siblings exist) or degrade to the constructed
	// give-up terminal (storm).
	type BurstHoldOutcome =
		| { kind: "served"; response: Response }
		| { kind: "aborted" }
		| { kind: "gave-up" };

	// Run the hold on `heldAccount` and apply the shared give-up machinery
	// (staged-body discard, double-attempt guard, give-up bookkeeping). Reused by
	// BOTH the normal decide-before-loop (siblings present) and the zero-accounts
	// storm-degrade path (Finding 1) so the orchestration is defined once.
	const runBurstHold = async (
		heldAccount: Account,
		confidence: "fresh_headroom" | "stale_should_retry",
	): Promise<BurstHoldOutcome> => {
		const holdResult = await holdAndRetryCacheAccount({
			account: heldAccount,
			confidence,
			signal: req.signal,
			reprobe,
		});

		if (holdResult instanceof Response) {
			return { kind: "served", response: holdResult };
		}

		// Hold declined/gave up (null) or overflowed (HOLD_OVERFLOW). Discard the
		// held account's staged body so a later success on a sibling/Codex can't
		// promote cache bookkeeping under the wrong account.
		cacheBodyStore.discardStaged(requestMeta.id);
		burstHoldDeclined = true;
		burstHeldAccountForGiveUp = heldAccount;
		// Double-attempt guard: the held account was just re-probed by the hold. If
		// its cooldown lapsed it may now be back in `accounts`, so mark it attempted
		// to make the normal loop skip it (no wasteful duplicate request at the same
		// throttled per-IP window).
		burstAttemptedAccountId = heldAccount.id;
		const overflow = holdResult === HOLD_OVERFLOW;

		// Finding 2: if the give-up was caused by a CLIENT ABORT (the client
		// disconnected mid-hold), do NOT fall through to the normal failover loop /
		// last-resort — issuing sibling/Codex upstream requests for a disconnected
		// client is wasteful. Signal `aborted` so the caller stops here. A
		// non-abort give-up (budget/attempts/overflow) keeps the intended
		// fall-through.
		if (req.signal.aborted) {
			log.info(
				`Burst-retry hold gave up due to client abort for ${heldAccount.name} — not falling through to siblings/Codex`,
			);
			return { kind: "aborted" };
		}

		log.warn(
			`Burst-retry ${overflow ? "overflow" : "give-up"} for held account ${heldAccount.name} — falling through to normal failover (healthy siblings first, then Codex-if-fits)`,
		);
		return { kind: "gave-up" };
	};

	// 7. Handle no accounts case
	if (accounts.length === 0) {
		// A pin strict-failed selection (pinned account/class had no allowed,
		// available candidate). Return a clean terminal error rather than degrading
		// to storm-hold / pool_exhausted — never silently answer from a disallowed
		// account. The /v1/responses adapter converts this non-200 to the OpenAI
		// error shape, so the Codex CLI surfaces a real error.
		if (requestMeta.pinFailure) {
			const pinnedResponse = createPinnedTargetUnavailableResponse(
				requestMeta.pinFailure,
			);
			recordSyntheticErrorResponse(pinnedResponse, requestMeta.pinFailure.code);
			return pinnedResponse;
		}

		// STORM-DEGRADE hold (Finding 1): in the worst burst moment the pinned
		// cache account AND every sibling are cooled, so the strategy returned ZERO
		// candidates. Before degrading to the pool_exhausted / throttled / context
		// terminal, run the transparent burst-retry HOLD on the cache (affinity)
		// account when it is genuinely a transient per-IP burst — exactly when
		// holding the warm cache account matters most. Gate identically to the
		// marker-active branch of the normal decide-before-loop: the held account
		// must be OAuth-Anthropic, not paused, the shared burst marker active, and
		// NOT showing fresh real exhaustion (minHeadroom <= 0 — a genuine quota
		// wall, not a burst). On served → return it; on give-up/abort → fall through
		// to the existing terminals below (there are no siblings, so the normal loop
		// is empty; a non-abort give-up degrades to the constructed give-up 429).
		// `accounts` is empty here so there is no combo slot to honor — gate on the
		// request's own comboName (filteredComboInfo isn't built until section 9).
		if (
			!requestMeta.comboName &&
			burstHeldId &&
			// Codex High finding: never hold an account that was gated out by the
			// usage-throttle / context-window gate. `accounts` is empty here, so the
			// held account is NOT available — it must be a genuine cooldown
			// (`affinity_hold`). An account that was `affinity_hit` (available, then
			// usage-throttled / context-gated out) must fall to the
			// createUsageThrottledResponse / context / pool_exhausted terminal below.
			isBurstHoldEligible(requestMeta.routing?.decision, false)
		) {
			const heldAccount =
				selectedAccounts.find((a) => a.id === burstHeldId) ??
				(await ctx.dbOps.getAccount(burstHeldId));
			if (
				heldAccount &&
				!heldAccount.paused &&
				isOAuthAnthropicAccount(heldAccount) &&
				isAnthropicBurstThrottleActive()
			) {
				const heldCapacity = getFreshCapacity(
					usageCache,
					heldAccount.id,
					heldAccount.provider,
					Date.now(),
					BURST_RETRY_MAX_USAGE_AGE_MS,
				);
				if (heldCapacity !== null && heldCapacity.minHeadroom <= 0) {
					log.warn(
						`Storm-degrade: burst marker active but held account ${heldAccount.name} shows real exhaustion (minHeadroom=${heldCapacity.minHeadroom}) — NOT holding, degrading to terminal`,
					);
				} else {
					// Null capacity (usage stale/absent) ⇒ stale_should_retry (single
					// probe); fresh positive headroom ⇒ fresh_headroom (full budget).
					const holdConfidence: "fresh_headroom" | "stale_should_retry" =
						heldCapacity === null ? "stale_should_retry" : "fresh_headroom";
					log.warn(
						`Storm-degrade: all accounts cooled — holding the cache account ${heldAccount.name} (confidence=${holdConfidence}) instead of immediate pool_exhausted`,
					);
					const outcome = await runBurstHold(heldAccount, holdConfidence);
					if (outcome.kind === "served") {
						return outcome.response;
					}
					// Finding 2: client disconnected mid-hold — stop, don't degrade to a
					// terminal that does more work; return the abort marker.
					if (outcome.kind === "aborted") {
						return createClientAbortResponse();
					}
					// gave-up: fall through to the terminals below. `burstHoldDeclined` +
					// `burstHeldAccountForGiveUp` are now set, so the constructed
					// burst-retry give-up 429 (preferred over generic pool_exhausted) is
					// returned at the end of this block.
				}
			}
		}

		// If a storm-degrade hold gave up above, return the constructed retryable
		// burst-retry give-up 429 (consistent history/headers:
		// `x-clankermux-burst-retry: exhausted`) rather than the generic
		// pool_exhausted 503. There are no siblings in this zero-accounts case, so
		// there is no normal failover loop to run first.
		if (burstHoldDeclined && burstHeldAccountForGiveUp) {
			cacheBodyStore.discardStaged(requestMeta.id);
			const giveUpResponse = createBurstRetryGiveUpResponse(
				burstHeldAccountForGiveUp,
			);
			recordSyntheticErrorResponse(giveUpResponse, "burst_retry_exhausted");
			return giveUpResponse;
		}

		// If the pool was emptied specifically by the context-window gate
		// (and there were Codex accounts that would have been available
		// otherwise), hold the connection until a large-context account becomes
		// available — up to CW_HOLD_MAX_MS — before returning 400.
		if (contextExcludedAccounts.length > 0 && throttledAccounts.length === 0) {
			const cwHoldStart = Date.now();

			while (true) {
				const nowMs = Date.now();
				const elapsed = nowMs - cwHoldStart;
				if (elapsed >= CW_HOLD_MAX_MS) break;
				const remaining = CW_HOLD_MAX_MS - elapsed;

				// Find non-Codex, non-paused, actively rate-limited accounts.
				const allAccs = await ctx.dbOps.getAllAccounts();
				const cwRateLimited = allAccs.filter(
					(a) =>
						!a.paused &&
						a.provider !== "codex" &&
						a.rate_limited_until !== null &&
						a.rate_limited_until > nowMs,
				);

				if (cwRateLimited.length === 0) break; // nothing to wait for

				const soonest = Math.min(
					...cwRateLimited.map((a) => a.rate_limited_until as number),
				);
				const waitMs =
					Math.max(0, soonest - nowMs) +
					Math.floor(Math.random() * CW_HOLD_JITTER_MS);

				if (waitMs > remaining) break; // soonest expiry is beyond budget

				log.info(
					`CW hold: waiting ${waitMs}ms for large-context account(s): ${cwRateLimited.map((a) => a.name).join(", ")}`,
				);

				const completed = await abortableSleep(waitMs, req.signal);
				if (!completed) {
					log.info("CW hold: client disconnected during wait");
					return createClientAbortResponse();
				}

				// Re-run full account selection with the same gates.
				const cwSelected = await selectAccountsForRequest(
					requestMeta,
					ctx,
					effectiveRequestModel ?? undefined,
				);
				const { available: cwAvailable } =
					applyProviderOverloadGate(cwSelected);
				const { available: cwPostThrottle } = applyUsageThrottling(cwAvailable);
				// Non-Codex accounts always pass the context-window gate.
				const cwCandidates = cwPostThrottle.filter(
					(a) => a.provider !== "codex",
				);

				if (cwCandidates.length === 0) continue; // still unavailable

				log.info(
					`CW hold: ${cwCandidates.length} non-Codex account(s) now available, retrying`,
				);

				for (let i = 0; i < cwCandidates.length; i++) {
					const r = await proxyWithAccount(
						req,
						url,
						cwCandidates[i],
						requestMeta,
						finalBodyBuffer,
						finalCreateBodyStream,
						i,
						ctx,
						undefined,
						apiKeyId,
						apiKeyName,
						requestBodyContext,
						// Don't forward rate-limit response on last candidate —
						// loop back instead to check for another available account.
						false,
					);
					if (r) return r;
				}
				// All candidates returned null — loop back to recheck.
			}

			// Budget exhausted or no eligible accounts: discard any staged body
			// and return the original context_window_exceeded 400.
			cacheBodyStore.discardStaged(requestMeta.id);
			return createContextWindowExceededResponse(
				requestTokenEstimate,
				contextExcludedAccounts,
				effectiveRequestModel ?? "unknown",
			);
		}

		if (throttledAccounts.length > 0) {
			return createUsageThrottledResponse(throttledAccounts);
		}

		if (
			selectedAccounts.length > 0 &&
			providerAvailableAccounts.length === 0 &&
			providerOverloadedAccounts.length > 0
		) {
			return createProviderOverloadedResponse(providerOverloadedAccounts);
		}

		// A pin or the Codex-CLI Anthropic floor was active but post-selection
		// gates removed every allowed candidate (and no more-specific terminal
		// above applied). Return the pinned terminal rather than a generic
		// pool_exhausted that reports the wrong (provider-default) accounts — and
		// never silently fall through to other handling.
		if (
			(requestMeta.pin || requestMeta.excludeOfficialAnthropic) &&
			!requestMeta.pinFailure
		) {
			const pinnedResponse = createPinnedTargetUnavailableResponse({
				code: "pinned_target_unavailable",
				message:
					"The account/provider pinned to this API key has no available account for this request.",
			});
			recordSyntheticErrorResponse(pinnedResponse, "pinned_target_unavailable");
			return pinnedResponse;
		}

		log.error(ERROR_MESSAGES.POOL_EXHAUSTED);

		// Log to request history via worker
		// Re-fetch from DB — selectedAccounts is empty here (strategy already
		// filtered out unavailable accounts), so we need fresh data to populate
		// per-account cooldown info in the 503 body.
		const allAccounts = (await ctx.dbOps.getAllAccounts()).filter(
			(a) => a.provider === ctx.provider.name,
		);

		const poolExhaustedResponse = createPoolExhaustedResponse(allAccounts);

		// Skip request-history logging for synthetic auto-refresh probes that
		// 503 because their target account is on a known cooldown. Logging
		// these as user-facing 503s inflates the dashboard fail-rate without
		// reflecting any real client impact (issue #199, bug 2). The keepalive
		// scheduler already gets the equivalent treatment via its loop-prevention
		// header path; this brings auto-refresh in line.
		recordSyntheticErrorResponse(poolExhaustedResponse, "pool_exhausted");

		return poolExhaustedResponse;
	}

	// 8. Log selected accounts
	log.info(
		`Selected ${accounts.length} accounts: ${accounts.map((a) => a.name).join(", ")}`,
	);
	if (
		process.env.DEBUG?.includes("proxy") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		log.info(`Request: ${req.method} ${url.pathname}`);
	}

	// 9. Try each account
	const comboInfo = getComboSlotInfo(requestMeta);
	const allowedAccountIds = new Set(accounts.map((account) => account.id));
	const filteredComboInfo = comboInfo
		? {
				...comboInfo,
				slots: comboInfo.slots.filter((slot) =>
					allowedAccountIds.has(slot.accountId),
				),
			}
		: null;
	let response: Response | null = null;

	// Codex High finding: the held account may only enter the hold when it is
	// EITHER present in the gated `accounts` list (still available — fine to
	// probe) OR genuinely cooldown-unavailable (`affinity_hold`). If it is absent
	// from `accounts` AND the decision was `affinity_hit` (i.e. it was selected as
	// available but then removed by the usage-throttle / context-window gate),
	// holding+probing it would bypass the configured pacing throttle / context
	// safety — so do NOT hold; fall through to today's normal-loop behavior.
	const heldInGatedAccounts = burstHeldId
		? accounts.some((a) => a.id === burstHeldId)
		: false;
	if (
		!filteredComboInfo?.comboName &&
		burstHeldId &&
		isBurstHoldEligible(requestMeta.routing?.decision, heldInGatedAccounts)
	) {
		// Resolve the held (cache) account object. It may not be in `accounts`
		// (an affinity_hold serves a sibling because the pinned account is cooled),
		// so fall back to the DB. We re-probe it directly, bypassing the
		// availability gate, re-checking only paused/existence below.
		const heldAccount =
			accounts.find((a) => a.id === burstHeldId) ??
			selectedAccounts.find((a) => a.id === burstHeldId) ??
			(await ctx.dbOps.getAccount(burstHeldId));

		if (
			heldAccount &&
			!heldAccount.paused &&
			isOAuthAnthropicAccount(heldAccount)
		) {
			// The hold uses the shared `reprobe` closure defined above.

			// Decide whether to enter the hold. Two triggers:
			//  (a) the shared burst marker is already active (a concurrent request
			//      tripped it) — the held account is known-throttled, go straight to
			//      the hold without a wasted first attempt;
			//  (b) otherwise, try the held account ONCE; if it returns a
			//      `retryable_429`, enter the hold. A real Response is returned
			//      as-is; a non-retryable outcome falls through to normal failover.
			let enterHold = false;
			let holdConfidence: "fresh_headroom" | "stale_should_retry" =
				"fresh_headroom";
			// Decision-point logging inputs (Part 5). markerActive is snapshotted at
			// branch-entry; heldMinHeadroom is the freshly-read held-account headroom
			// when known (marker-active path reads it), else null (unknown/not read).
			const markerActive = isAnthropicBurstThrottleActive();
			let heldMinHeadroom: number | null = null;

			if (markerActive) {
				// Marker-active path: a CONCURRENT request tripped the global (per-IP)
				// burst marker. The marker is provider-family-wide, NOT per-account —
				// so before suppressing this request's normal failover and burning the
				// whole hold budget, re-validate that THIS held account is plausibly
				// transient. If it shows fresh, real exhaustion (zero/negative
				// headroom — e.g. a genuine 5h/7d quota wall), a global marker set by a
				// different account must not pin it: fall through to normal failover.
				// Unknown/stale capacity (null) is left eligible — the marker implies a
				// prior fresh/stale burst classification, so an ambiguous account is
				// treated as plausibly transient (consistent with classify429Transient,
				// which holds on fresh minHeadroom>0 and on stale + retry hint).
				const heldCapacity = getFreshCapacity(
					usageCache,
					heldAccount.id,
					heldAccount.provider,
					Date.now(),
					BURST_RETRY_MAX_USAGE_AGE_MS,
				);
				heldMinHeadroom = heldCapacity?.minHeadroom ?? null;
				if (heldCapacity !== null && heldCapacity.minHeadroom <= 0) {
					log.warn(
						`Burst marker active but held account ${heldAccount.name} shows real exhaustion (minHeadroom=${heldCapacity.minHeadroom}) — NOT holding, falling through to normal failover`,
					);
				} else {
					enterHold = true;
					// Null capacity (usage stale/absent) is the SAME condition under which
					// classify429Transient would only grant `stale_should_retry` — so cap
					// the hold at a single probe rather than burning the full attempt
					// budget against a possibly-exhausted account. Fresh, positive
					// headroom keeps the default `fresh_headroom` (full budget).
					holdConfidence =
						heldCapacity === null ? "stale_should_retry" : "fresh_headroom";
				}
			} else if (accounts.some((a) => a.id === heldAccount.id)) {
				// The held account is available (affinity_hit) — attempt it first.
				// Record it so the normal loop below skips a duplicate attempt if we
				// fall through (non-retryable outcome).
				burstAttemptedAccountId = heldAccount.id;
				let firstOutcome: ProxyAttemptOutcome | null = null;
				const firstResponse = await proxyWithAccount(
					req,
					url,
					heldAccount,
					requestMeta,
					finalBodyBuffer,
					finalCreateBodyStream,
					0,
					ctx,
					null,
					apiKeyId,
					apiKeyName,
					requestBodyContext,
					false,
					{
						signal: req.signal,
						onOutcome: (o) => {
							firstOutcome = o;
						},
					},
				);
				if (firstResponse) {
					return firstResponse;
				}
				// `firstOutcome` is assigned synchronously inside proxyWithAccount via
				// the onOutcome sink before it returns; the cast narrows the inferred
				// `never` from the closure-only assignment.
				const outcome = firstOutcome as ProxyAttemptOutcome | null;
				if (outcome?.kind === "retryable_429") {
					enterHold = true;
					holdConfidence = outcome.confidence;
				}
				// Any other outcome → fall through to the normal failover loop below
				// (the held account already failed; the loop will skip it as cooled).
			}
			// If the marker is active but the held account is currently in `accounts`
			// AND not the trigger path above, holdConfidence stays fresh_headroom
			// (marker activation always implies a prior fresh/stale classification;
			// a concurrent request can only over-probe by one short cycle).

			// Snapshot at hold-entry: does a non-Anthropic candidate that survived the
			// context-window gate exist for this request? Used ONLY for the
			// decision-point DEBUG log below (it no longer shortens the hold budget —
			// see Part 3). A Codex account gated out by an oversized request is
			// correctly absent here (it never entered `accounts`).
			const hasViableFallback = accounts.some(
				(a) =>
					!isOfficialAnthropicProvider(a.provider) && a.id !== heldAccount.id,
			);

			// Part 5: one concise DEBUG capturing every path's decision once. Closes
			// over the branch-entry inputs (decision/marker/headroom/fallback) so the
			// only per-call argument is the branch outcome.
			const logBurstDecision = (
				outcome:
					| "entered-hold"
					| "served-sibling-no-marker"
					| "declined-fell-through",
			) => {
				log.debug(
					`Burst decide: decision=${requestMeta.routing?.decision ?? "?"} held=${heldAccount.name} markerActive=${markerActive} heldMinHeadroom=${heldMinHeadroom ?? "unknown"} hasViableFallback=${hasViableFallback} outcome=${outcome}`,
				);
			};

			if (enterHold) {
				const outcome = await runBurstHold(heldAccount, holdConfidence);

				if (outcome.kind === "served") {
					logBurstDecision("entered-hold");
					return outcome.response;
				}

				// Finding 2: the hold gave up because the CLIENT disconnected mid-hold.
				// Stop here — do NOT fall through to the normal failover loop /
				// last-resort and issue sibling/Codex upstream requests for a request
				// nobody is waiting on. (The staged body was already discarded inside
				// runBurstHold.)
				if (outcome.kind === "aborted") {
					return createClientAbortResponse();
				}

				// Hold declined/gave up (null) or overflowed (HOLD_OVERFLOW). Rather
				// than jumping straight to the Codex-if-fits last-resort (which would
				// wrongly skip a HEALTHY Anthropic sibling — a cache miss but still
				// Opus), FALL THROUGH to the normal failover loop below over the gated
				// `accounts`. That loop attempts healthy Anthropic siblings first, then
				// any non-Anthropic candidate (Codex if it fits); only its exhaustion
				// reaches the constructed burst-retry give-up 429 (see
				// `burstHoldDeclined` after the loop). During a true storm no healthy
				// siblings remain in `accounts` (all cooled) so the loop is empty and we
				// degrade straight to that constructed error — same terminal outcome as
				// before. (The staged-body discard + give-up bookkeeping happened inside
				// runBurstHold.)
				logBurstDecision("declined-fell-through");
			} else {
				// Marker inactive (no recent burst) or a non-retryable first attempt:
				// the held account is being served from a sibling this request (today's
				// affinity_hold behavior). The normal loop handles it.
				logBurstDecision("served-sibling-no-marker");
			}
		}
	}

	for (let i = 0; i < accounts.length; i++) {
		// Skip the held account if the burst-retry first attempt already tried it
		// (and fell through non-retryably) — avoid a wasteful duplicate request.
		if (burstAttemptedAccountId && accounts[i].id === burstAttemptedAccountId) {
			continue;
		}
		const overloadedUntil = getProviderOverloadUntil(accounts[i].provider);
		if (overloadedUntil) {
			log.debug(
				`Skipping account ${accounts[i].name}; provider ${accounts[i].provider} is overloaded until ${new Date(overloadedUntil).toISOString()}`,
			);
			continue;
		}

		// For combo routing: enrich metadata with slot index and look up model override
		let modelOverride: string | null = null;
		if (filteredComboInfo?.slots[i]) {
			const slot = filteredComboInfo.slots[i];
			if (slot.accountId !== accounts[i].id) {
				log.error(
					`Combo slot/account desync: slot ${i} expects account ${slot.accountId} but got ${accounts[i].id}`,
				);
			} else {
				modelOverride = slot.modelOverride;
			}
			requestMeta.comboSlotIndex = i;
			log.info(
				`Attempting combo slot ${i}/${accounts.length - 1} on account ${accounts[i].name} with model "${modelOverride}"`,
			);
		}

		response = await proxyWithAccount(
			req,
			url,
			accounts[i],
			requestMeta,
			finalBodyBuffer,
			finalCreateBodyStream,
			i,
			ctx,
			modelOverride,
			apiKeyId,
			apiKeyName,
			requestBodyContext,
			!filteredComboInfo?.comboName &&
				(i === accounts.length - 1 ||
					shouldForwardProviderOverloadIfNoCrossProviderFallback(accounts, i)),
		);

		if (response) {
			return response;
		}

		// Log combo slot failure
		if (filteredComboInfo) {
			log.info(
				`Combo slot ${i} failed on account ${accounts[i].name}${i < accounts.length - 1 ? ", trying next slot" : ", all combo slots exhausted"}`,
			);
		}
	}

	// Part 4 terminal: a burst hold was entered then declined/gave-up, AND the
	// normal failover loop above (healthy Anthropic siblings + Codex-if-fits) also
	// produced no response. Return the constructed retryable burst-retry give-up
	// 429 — NOT the generic ALL_ACCOUNTS_FAILED — so history/headers stay
	// consistent (`x-clankermux-burst-retry: exhausted`). During a true storm the
	// loop was empty (all siblings cooled, Codex gated out) so we reach here
	// directly, the same terminal outcome as before the give-up-fall-through
	// change. The normal loop re-stages requestMeta.id on every attempt (no
	// reprobe mode); discard once more so the last attempt's staged body doesn't
	// leak (idempotent if nothing re-staged).
	if (burstHoldDeclined && burstHeldAccountForGiveUp) {
		cacheBodyStore.discardStaged(requestMeta.id);
		const giveUpResponse = createBurstRetryGiveUpResponse(
			burstHeldAccountForGiveUp,
		);
		recordSyntheticErrorResponse(giveUpResponse, "burst_retry_exhausted");
		return giveUpResponse;
	}

	// 10. Combo fallback: if combo routing was active and all slots failed,
	//     fall back to normal SessionStrategy routing (REQ-14)
	let fallbackAccounts: Account[] | null = null;
	if (filteredComboInfo?.comboName) {
		log.warn(
			`All combo slots failed for combo "${filteredComboInfo.comboName}", falling back to SessionStrategy routing`,
		);
		// Clear combo info and retry with normal routing
		requestMeta.comboName = null;
		requestMeta.comboSlotIndex = null;
		const selectedFallbackAccounts = await selectAccountsForRequest(
			requestMeta,
			ctx,
		);
		const {
			available: providerFallbackAccounts,
			overloaded: providerFallbackOverloadedAccounts,
		} = applyProviderOverloadGate(selectedFallbackAccounts);
		const {
			available: filteredFallbackAccounts,
			throttled: throttledFallbackAccounts,
		} = applyUsageThrottling(providerFallbackAccounts);
		fallbackAccounts = applyContextWindowGate(filteredFallbackAccounts);
		if (requestMeta.routing) {
			requestMeta.routing.selectedAccountId =
				fallbackAccounts[0]?.id ??
				requestMeta.routing.selectedAccountId ??
				null;
			requestMeta.routing.candidatesCount = fallbackAccounts.length;
			requestMeta.routing.failoverReason = "combo_fallback";
		}

		if (fallbackAccounts.length > 0) {
			log.info(
				`Fallback: trying ${fallbackAccounts.length} SessionStrategy accounts`,
			);
			for (let i = 0; i < fallbackAccounts.length; i++) {
				const overloadedUntil = getProviderOverloadUntil(
					fallbackAccounts[i].provider,
				);
				if (overloadedUntil) {
					log.debug(
						`Skipping fallback account ${fallbackAccounts[i].name}; provider ${fallbackAccounts[i].provider} is overloaded until ${new Date(overloadedUntil).toISOString()}`,
					);
					continue;
				}

				response = await proxyWithAccount(
					req,
					url,
					fallbackAccounts[i],
					requestMeta,
					finalBodyBuffer,
					finalCreateBodyStream,
					i,
					ctx,
					undefined, // No model override for fallback path
					apiKeyId,
					apiKeyName,
					requestBodyContext,
					i === fallbackAccounts.length - 1 ||
						shouldForwardProviderOverloadIfNoCrossProviderFallback(
							fallbackAccounts,
							i,
						),
				);

				if (response) {
					return response;
				}
			}
		} else if (throttledFallbackAccounts.length > 0) {
			// Combo slots staged a body but all failed, and the fallback found only
			// throttled accounts — this terminal return emits no worker summary, so
			// drop the staged body now (mirrors the all-accounts-failed cleanup).
			cacheBodyStore.discardStaged(requestMeta.id);
			return createUsageThrottledResponse(throttledFallbackAccounts);
		} else if (
			selectedFallbackAccounts.length > 0 &&
			providerFallbackAccounts.length === 0 &&
			providerFallbackOverloadedAccounts.length > 0
		) {
			cacheBodyStore.discardStaged(requestMeta.id);
			return createProviderOverloadedResponse(
				providerFallbackOverloadedAccounts,
			);
		}
	}

	// 11. All accounts failed. This request was staged for cache-keepalive in
	// proxyWithAccount, but no worker "end"/summary is emitted on this throw
	// path — drop its staged body now instead of waiting for the age sweep.
	cacheBodyStore.discardStaged(requestMeta.id);

	// Check if OAuth token issues are the cause
	const allAttemptedAccounts = filteredComboInfo
		? [...accounts, ...(fallbackAccounts ?? [])]
		: accounts;
	const oauthAccounts = allAttemptedAccounts.filter((acc) => acc.refresh_token);
	const needsReauth = oauthAccounts.filter((acc) =>
		isRefreshTokenLikelyExpired(acc),
	);

	if (needsReauth.length > 0) {
		const accountNames = needsReauth.map((acc) => acc.name).join(", ");
		throw new ServiceUnavailableError(
			`All accounts failed to proxy the request. OAuth tokens have expired for accounts: ${accountNames}.\n\nRe-authenticate these account(s) from the dashboard (Accounts tab).`,
			ctx.provider.name,
		);
	}

	throw new ServiceUnavailableError(
		`${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${allAttemptedAccounts.length} attempted)`,
		ctx.provider.name,
	);
}

/**
 * Injects `ttl: "1h"` into system-level cache_control blocks that are missing a TTL.
 * ArrayBuffer overload: returns modified buffer or null (no changes).
 * RequestBodyContext overload: mutates in-place via markDirty(); return value unused.
 */
export function injectSystemCacheTtl(buf: ArrayBuffer): ArrayBuffer | null;
export function injectSystemCacheTtl(context: RequestBodyContext): void;
export function injectSystemCacheTtl(
	input: ArrayBuffer | RequestBodyContext,
): ArrayBuffer | null {
	const bodyContext =
		input instanceof RequestBodyContext ? input : new RequestBodyContext(input);
	try {
		const body = bodyContext.getParsedJson() as
			| (RequestJsonBody & {
					system?: Array<{ cache_control?: { type?: string; ttl?: string } }>;
			  })
			| null;
		if (!body) return null;
		if (!Array.isArray(body.system)) return null;
		const blocksToUpdate = body.system.filter(
			(block) =>
				block.cache_control?.type === "ephemeral" && !block.cache_control.ttl,
		);
		if (blocksToUpdate.length === 0) return null;
		bodyContext.mutateParsedJson((b) => {
			const typedBody = b as RequestJsonBody & {
				system: Array<{ cache_control?: { type?: string; ttl?: string } }>;
			};
			for (const block of typedBody.system) {
				if (
					block.cache_control?.type === "ephemeral" &&
					!block.cache_control.ttl
				) {
					block.cache_control.ttl = "1h";
				}
			}
		});
		return bodyContext.getBuffer();
	} catch {
		return null;
	}
}
