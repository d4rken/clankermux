import {
	codexAccountFitsRequest,
	estimateRequestTokens,
	getBurstRetryMaxUsageAgeMs,
	isBurstRetryEnabled,
	mapModelName,
	resolveModelContextWindow,
	ServiceUnavailableError,
	trackClientVersion,
} from "@clankermux/core";
import { sanitizeRequestHeaders } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import { getFreshCapacity, usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import { cacheBodyStore } from "./cache-body-store";
import {
	type ContextWindowExcludedBackend,
	createContextWindowExceededResponse,
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
import { sanitizeProjectName } from "./project-name";
import {
	ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
	getProviderOverloadKey,
	getProviderOverloadUntil,
	isOfficialAnthropicProvider,
	isProviderOverloaded,
} from "./provider-overload-cooldown";
import { extractRequestAffinity } from "./request-affinity";
import type { RecordMeta, RequestRecorder } from "./request-recorder";
import { hashRoutingAffinityKey } from "./routing-telemetry";
import { shouldRecordRequest } from "./should-record-request";

export type { ProxyContext } from "./handlers";

const log = new Logger("Proxy");

function extractSystemPrompt(body: RequestJsonBody | null): string | null {
	if (!body) return null;
	const system = body.system;

	if (typeof system === "string") {
		return system;
	}

	if (Array.isArray(system)) {
		return system
			.filter(
				(item): item is { type?: string; text: string } =>
					typeof item === "object" &&
					item !== null &&
					(item as { type?: string }).type === "text" &&
					typeof (item as { text?: unknown }).text === "string",
			)
			.map((item) => item.text)
			.join("\n");
	}

	return null;
}

function extractProjectFromRequest(
	method: string,
	path: string,
	headers: Headers,
	body: RequestJsonBody | null,
): string | null {
	if (method !== "POST" || path !== "/v1/messages") return null;

	const headerProject = headers.get("x-project");
	const sanitizedHeader = sanitizeProjectName(headerProject);
	if (sanitizedHeader) return sanitizedHeader;

	const systemPrompt = extractSystemPrompt(body);
	if (!systemPrompt) return null;

	const pathMatch = systemPrompt.match(
		/\/(?:Users|home)\/[^/]+\/(?:(?:Desktop|projects|repos|src)\/)?([^/\s]+)\//,
	);
	const sanitizedPath = sanitizeProjectName(pathMatch?.[1]);
	if (sanitizedPath) return sanitizedPath;

	const headingMatch = systemPrompt.match(/^#\s+([^\n\r]{1,100})/m);
	if (headingMatch) {
		const heading = sanitizeProjectName(headingMatch[1]);
		if (heading && !heading.toLowerCase().startsWith("claude")) {
			return heading;
		}
	}

	return null;
}

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
	const project = extractProjectFromRequest(
		req.method,
		url.pathname,
		req.headers,
		parsedBody,
	);
	const affinity = extractRequestAffinity(req.headers);

	// Conservative token estimate for context-window-aware routing (B1).
	// Computed once; used to gate Codex accounts whose mapped model can't fit
	// the request (B3) and to build the context_window_exceeded error (B4).
	const requestTokenEstimate = estimateRequestTokens(parsedBody);

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

	const finalBodyBuffer = requestBodyContext.getBuffer();
	const finalCreateBodyStream = () => {
		if (!finalBodyBuffer) return undefined;
		return new Response(finalBodyBuffer).body ?? undefined;
	};

	const effectiveRequestModel = requestBodyContext.getModel() ?? requestModel;

	// 4. Create request metadata
	const requestMeta = createRequestMetadata(req, url);
	requestMeta.internal = isInternal;
	requestMeta.affinityKey = affinity.key;
	requestMeta.affinityScope = affinity.scope;
	requestMeta.affinityPartition = apiKeyId ? `api_key:${apiKeyId}` : null;
	requestMeta.project = project;

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
				const target = mapModelName(modelForGate, account);
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

	// 7. Handle no accounts case
	if (accounts.length === 0) {
		// If the pool was emptied specifically by the context-window gate
		// (and there were Codex accounts that would have been available
		// otherwise), return a 400 context_window_exceeded instead of 503.
		if (contextExcludedAccounts.length > 0 && throttledAccounts.length === 0) {
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

	// 9a. Transparent burst-retry decide-before-loop (OAuth-Anthropic, non-combo).
	//
	// Anthropic's 429 is a per-IP burst throttle, not per-account quota: failing
	// over to a sibling Anthropic account is futile (same egress IP/window) and
	// wasteful (cold prompt cache). When the cache-affinity account is an
	// OAuth-Anthropic account, we instead HOLD and re-probe it before iterating
	// siblings. Gated entirely on isBurstRetryEnabled() — when off, the loop below
	// runs exactly as before.
	// When the burst-retry first attempt tries the held account and it fails
	// non-retryably (e.g. a hard 429 / 401), we fall through to the normal loop
	// below — but the held account has already been attempted, so the loop must
	// skip it to avoid a wasteful duplicate request. Null when no first attempt
	// was made (marker-active path, or feature off).
	let burstAttemptedAccountId: string | null = null;
	const burstHeldId = requestMeta.routing?.heldAccountId ?? null;
	if (isBurstRetryEnabled() && !filteredComboInfo?.comboName && burstHeldId) {
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
			// Reprobe closure: re-attempt the held account in reprobe mode (cooldown
			// gate bypassed, no re-staging, no streak escalation) with the client's
			// AbortSignal so a disconnect releases the hold promptly.
			const reprobe = async (
				probeAccount: Account,
				signal: AbortSignal,
			): Promise<Response | null> => {
				// Re-check paused/existence at probe time (the held account may have
				// been paused/removed between probes); skip if gone.
				return proxyWithAccount(
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
			};

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

			if (isAnthropicBurstThrottleActive()) {
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
					getBurstRetryMaxUsageAgeMs(),
				);
				if (heldCapacity !== null && heldCapacity.minHeadroom <= 0) {
					log.warn(
						`Burst marker active but held account ${heldAccount.name} shows real exhaustion (minHeadroom=${heldCapacity.minHeadroom}) — NOT holding, falling through to normal failover`,
					);
				} else {
					enterHold = true;
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

			if (enterHold) {
				const holdResult = await holdAndRetryCacheAccount({
					account: heldAccount,
					confidence: holdConfidence,
					signal: req.signal,
					reprobe,
				});

				if (holdResult instanceof Response) {
					return holdResult;
				}

				// Hold gave up (null) or overflowed (HOLD_OVERFLOW): LAST RESORT.
				// Never divert to a sibling Anthropic account — try only non-Anthropic
				// candidates (Codex/other) that already survived the context-window
				// gate, then fall back to a constructed retryable response. Discard the
				// held account's staged body first so a later success can't promote
				// cache bookkeeping under the wrong account.
				cacheBodyStore.discardStaged(requestMeta.id);
				const overflow = holdResult === HOLD_OVERFLOW;
				log.warn(
					`Burst-retry ${overflow ? "overflow" : "give-up"} for held account ${heldAccount.name} — trying non-Anthropic last-resort candidates`,
				);

				// Exclude EVERY Anthropic-direct provider (OAuth `anthropic` AND the
				// pay-as-you-go `claude-console-api`) — both hit api.anthropic.com over
				// the same egress IP and share the per-IP burst throttle, so a
				// last-resort attempt on either is futile and can prolong the window.
				// isOfficialAnthropicProvider() is the single source of truth for
				// "shares the Anthropic per-IP throttle" (also used by the
				// provider-overload cooldown keying). Genuinely-different providers
				// (codex/openai, custom-endpoint compatibles) stay eligible. The
				// candidates already survived the context-window gate, so "Codex if it
				// fits" is satisfied.
				const lastResortCandidates = accounts.filter(
					(a) =>
						!isOfficialAnthropicProvider(a.provider) && a.id !== heldAccount.id,
				);
				for (let j = 0; j < lastResortCandidates.length; j++) {
					const candidate = lastResortCandidates[j];
					const overloadedUntil = getProviderOverloadUntil(candidate.provider);
					if (overloadedUntil) {
						log.debug(
							`Burst last-resort skipping ${candidate.name}; provider ${candidate.provider} overloaded until ${new Date(overloadedUntil).toISOString()}`,
						);
						continue;
					}
					// Recompute the last-account flag against THIS candidate list (do
					// not reuse the original loop indices). The loop `continue`s past
					// provider-overloaded candidates, so the last-by-index candidate is
					// not necessarily the last one ACTUALLY attempted. Treat this as the
					// last attempt when every remaining candidate would be skipped for
					// provider overload — otherwise a 529 from the truly-last attempt
					// could be swallowed instead of forwarded.
					const isLast = lastResortCandidates
						.slice(j + 1)
						.every((c) => !!getProviderOverloadUntil(c.provider));
					const lastResortResponse = await proxyWithAccount(
						req,
						url,
						candidate,
						requestMeta,
						finalBodyBuffer,
						finalCreateBodyStream,
						j,
						ctx,
						null,
						apiKeyId,
						apiKeyName,
						requestBodyContext,
						isLast ||
							shouldForwardProviderOverloadIfNoCrossProviderFallback(
								lastResortCandidates,
								j,
							),
						{ signal: req.signal },
					);
					if (lastResortResponse) {
						return lastResortResponse;
					}
				}

				// No eligible/successful non-Anthropic candidate → constructed
				// retryable response (the upstream 429 body was discarded). Recorded
				// via the synthetic-error path so history stays intact.
				//
				// Re-discard the staged body here: each last-resort proxyWithAccount
				// call above runs WITHOUT reprobe mode, so it RE-stages this
				// requestMeta.id (proxy-operations stageRequest, a ~0.5–1.5 MB Buffer
				// copy). The earlier discardStaged (before the last-resort loop) only
				// cleared the held account's entry; if every candidate returned null we
				// reach this terminal return — which emits no onSummary — so without a
				// final discard the last candidate's staged body would leak until the
				// age sweep. discardStaged is idempotent, so a redundant call (no
				// candidate re-staged) is harmless.
				cacheBodyStore.discardStaged(requestMeta.id);
				const giveUpResponse = createBurstRetryGiveUpResponse(heldAccount);
				recordSyntheticErrorResponse(giveUpResponse, "burst_retry_exhausted");
				return giveUpResponse;
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
		// Quote account names to prevent command injection (defense-in-depth)
		const reauthCommands = needsReauth
			.map(
				(acc) =>
					`bun run cli --reauthenticate "${acc.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
			)
			.join("\n  ");
		throw new ServiceUnavailableError(
			`All accounts failed to proxy the request. OAuth tokens have expired for accounts: ${needsReauth.map((acc) => acc.name).join(", ")}.\n\nPlease re-authenticate:\n  ${reauthCommands}`,
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
