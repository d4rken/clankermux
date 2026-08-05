import {
	codexAccountFitsRequestUnmargined,
	consumeRequestStarted,
	getModelFamily,
	isDebugEnabled,
	NETWORK,
	requestEvents,
	ServiceUnavailableError,
} from "@clankermux/core";
import { sanitizeRequestHeaders } from "@clankermux/http-common";
import { Logger, LogLevel } from "@clankermux/logger";
import { getFreshCapacity, usageCache } from "@clankermux/providers";
import type { Account, ComboSlotInfo } from "@clankermux/types";
import {
	createAdmissionGates,
	type ProviderOverloadedAccount,
} from "./admission-gates";
import { cacheBodyStore } from "./cache-body-store";
import {
	BURST_RETRY_MAX_USAGE_AGE_MS,
	createContextWindowExceededResponse,
	createFamilyWeeklyExhaustedResponse,
	createPinnedTargetUnavailableResponse,
	createPoolExhaustedResponse,
	createUsageThrottledResponse,
	ERROR_MESSAGES,
	getComboSlotInfo,
	getForcedAccount,
	isAnthropicBurstThrottleActive,
	isOAuthAnthropicAccount,
	isRefreshTokenLikelyExpired,
	isTrustedSyntheticProbe,
	type ProxyAttemptOutcome,
	type ProxyContext,
	proxyForcedAccount,
	proxyWithAccount,
	resolveFamilyWeeklyExclusion,
	resolveTransientlyCooledFamilySibling,
	selectAccountsForRequest,
	setForcedAccount,
	type TransientlyCooledFamilySibling,
} from "./handlers";
// Direct leaf import (not via the `handlers` barrel) — see the module comment.
import { createClientAbortResponse } from "./handlers/client-abort-response";
import {
	completeRateLimitProbe,
	getRateLimitProbeAdmission,
} from "./handlers/rate-limit-cooldown";
import {
	ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
	getProviderOverloadKey,
	getProviderOverloadUntil,
	isOfficialAnthropicProvider,
} from "./provider-overload-cooldown";
import {
	CW_HOLD_MAX_MS,
	CW_HOLD_MAX_MS_NO_CODEX_FALLBACK,
	createRecoveryHolds,
	FAMILY_WEEKLY_COOLDOWN_HOLD_MAX_MS,
	PIN_HOLD_MAX_MS,
} from "./recovery-holds";
import { type IngressContext, ingestProxyRequest } from "./request-ingress";
import type { RecordMeta, RequestRecorder } from "./request-recorder";
import { hashRoutingAffinityKey } from "./routing-telemetry";
import {
	isIngressRecordable,
	shouldRecordRequest,
} from "./should-record-request";

export type { ProxyContext } from "./handlers";

const log = new Logger("Proxy");

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

/** Outcome of {@link attemptThroughProbeGate}. */
type GatedAttempt = {
	/** The upstream response, or null when the attempt produced none. */
	response: Response | null;
	/**
	 * True when another request already holds this account's single-flight probe
	 * lease. NOTHING was attempted — the caller must skip this candidate (and NOT
	 * count it as a failure) and move on to the next one.
	 */
	suppressed: boolean;
};

/**
 * THE single chokepoint for every non-forced upstream attempt in this file.
 *
 * It owns the recovery-probe gate end to end: admission before the attempt, and
 * the lease for the WHOLE attempt (including `proxyWithAccount`'s internal
 * stale-token 401 retry recursion), released on EVERY terminal outcome —
 * success, a reapplied cooldown, an exception, or any early return — via the
 * try/finally below. `completeRateLimitProbe` is idempotent, so the release is
 * safe even when an inner path (a fresh 429 → `cooldown_reapplied`, or the
 * response processor's `recovered`/`abandoned`) already released it.
 *
 * Why a single chokepoint: `proxyWithAccount` has several call sites (the two
 * candidate loops, the affinity-first attempt, the two hold re-attempt paths and
 * the context-window last resort). When only the loops consulted the gate, every
 * other path stampeded a freshly-recovered account — and, because no lease was
 * ever taken, a success on those paths hit `completeRateLimitProbe`'s no-lease
 * no-op and could not clear the capacity-restored marker either.
 *
 * Deliberately NOT routed through here:
 *  - the global force-account override (`proxyForcedAccount`), an operator
 *    escape hatch that bypasses account selection entirely — so the "exactly one
 *    upstream probe" guarantee explicitly excludes it;
 *  - the local count_tokens synthesis attempt, which is a synthetic request that
 *    must not consume an account's single recovery probe.
 */
async function attemptThroughProbeGate(
	account: Account,
	attempt: () => Promise<Response | null>,
): Promise<GatedAttempt> {
	const admission = getRateLimitProbeAdmission(account);
	if (admission === "suppressed") {
		return { response: null, suppressed: true };
	}
	try {
		return { response: await attempt(), suppressed: false };
	} finally {
		if (admission === "admitted") {
			completeRateLimitProbe(account, "abandoned");
		}
	}
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
	/**
	 * Deterministic-timing seam for the burst-retry hold, forwarded verbatim to
	 * {@link holdAndRetryCacheAccount} (its `maxHoldMs`/`now`/`jitterMs` overrides).
	 * Production never passes this — the hold uses its fixed source-level defaults.
	 * It exists purely so integration tests can force a short, deterministic hold
	 * without touching wall-clock time (same rationale as the injectable `now`
	 * clock on the hold itself). NOT a global, NOT an env var, NOT test-only state
	 * read from inside the hold — an explicit, opt-in override on the entry point.
	 */
	burstHoldTimingOverride?: {
		maxHoldMs?: number;
		now?: () => number;
		jitterMs?: number;
	},
): Promise<Response> {
	const ingress = await ingestProxyRequest(req, url, ctx, apiKeyId, isInternal);
	if (ingress.kind === "response") {
		// Rejected during ingestion (bad path, unparseable body, context-window
		// gate). Nothing was announced, so there is nothing to retract — and
		// these requests are never written to Request History either.
		return ingress.response;
	}

	const { requestMeta } = ingress.context;

	// Tell the live dashboard the request EXISTS, before an account has been
	// picked or the upstream called. Without this, a request is invisible until
	// the upstream returns headers, so the Overview's activity lanes would read
	// as idle during exactly the wait the operator wants to see.
	const announced = isIngressRecordable({
		method: requestMeta.method,
		path: requestMeta.path,
		internal: isInternal,
		getHeader: (name) => req.headers.get(name),
	});
	if (announced) {
		requestEvents.emit("event", {
			type: "ingress",
			id: requestMeta.id,
			timestamp: requestMeta.timestamp,
			method: requestMeta.method,
			path: requestMeta.path,
			project: requestMeta.project ?? null,
			model: requestMeta.requestedModel ?? null,
		});
	}

	/**
	 * Retract the announcement for a request that never reached
	 * `forwardToClient` and so will never be summarized: an admission
	 * rejection, a forced-account failure, a pinned-target refusal, a probe the
	 * recorder filters out.
	 *
	 * The `hasRequestStarted` guard is load-bearing. This runs when the Response
	 * OBJECT is returned, which for a streaming response is long before its body
	 * ends — without the guard every stream would be retracted mid-flight. It
	 * also has to read a marker that OUTLIVES the request, because a
	 * non-streaming response can be fully summarized before we get here.
	 */
	const retractIfNeverStarted = (statusCode: number | null): void => {
		if (!announced) return;
		if (consumeRequestStarted(requestMeta.id)) return;
		requestEvents.emit("event", {
			type: "ingress-end",
			id: requestMeta.id,
			statusCode,
		});
	};

	try {
		const response = await handleIngestedProxy(
			ingress.context,
			req,
			url,
			ctx,
			apiKeyId,
			apiKeyName,
			isInternal,
			burstHoldTimingOverride,
		);
		retractIfNeverStarted(response.status);
		return response;
	} catch (error) {
		// No response was ever produced; `null` says so rather than inventing a
		// status the client never saw.
		retractIfNeverStarted(null);
		throw error;
	}
}

/**
 * Everything `handleProxy` does after ingestion: account selection, gates,
 * dispatch, failover and the terminal error paths.
 *
 * Split out purely so `handleProxy` can bracket it with the live-dashboard
 * announce/retract pair above — this function's body is unchanged.
 */
async function handleIngestedProxy(
	ingressContext: IngressContext,
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId: string | null | undefined,
	apiKeyName: string | null | undefined,
	isInternal: boolean,
	burstHoldTimingOverride?: {
		maxHoldMs?: number;
		now?: () => number;
		jitterMs?: number;
	},
): Promise<Response> {
	const {
		requestBodyContext,
		finalBodyBuffer,
		finalCreateBodyStream,
		effectiveRequestModel,
		gateTokenEstimate,
		project,
		projectAttributionSource,
		requestMeta,
		bumpIdleTimeout,
	} = ingressContext;

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

	// Combo slot info (if any) is populated by selectAccountsForRequest above.
	// Hoisted before the provider-overload gate so every per-account model
	// resolution (overload gate, context-window gate, family-weekly gate) can
	// honor a combo slot's model override.
	const initialComboInfo = getComboSlotInfo(requestMeta);

	// Synthetic auto-refresh / keepalive probes must reach their force-routed
	// account even when it is usage-throttled: throttling them yields a synthetic
	// 529 that the scheduler would miscount as a broken-endpoint failure and
	// eventually false-auto-pause the account. Gate on requestMeta.internal (the
	// trusted in-process dispatch flag, set from isInternal at the entry point) AND
	// the probe header — the header alone is client-spoofable, so an external
	// request cannot use it to dodge operator-configured usage throttling.
	const isSyntheticProbeRequest = isTrustedSyntheticProbe(
		req.headers,
		requestMeta.internal === true,
		"any",
	);

	// Per-request admission gates (provider-overload / usage-throttle /
	// context-window / family-weekly / soft-demotion reorder) plus the
	// per-account model resolution they share. Built ONCE per request because
	// two of them accumulate exclusion state that the zero-accounts terminals
	// read after every pass (main, both hold wakes, combo fallback) has run.
	const gates = createAdmissionGates({
		requestMeta,
		initialComboInfo,
		effectiveRequestModel: effectiveRequestModel ?? null,
		gateTokenEstimate,
		isSyntheticProbeRequest,
		config: ctx.config,
	});

	const providerOverloadResponseLabel = (overloadKey: string): string =>
		overloadKey === ANTHROPIC_UPSTREAM_OVERLOAD_KEY ? "anthropic" : overloadKey;

	const recordSyntheticErrorResponse = async (
		response: Response,
		error: string,
	): Promise<void> => {
		// Same recordable-request predicate as forwardToClient (S1) — keeps
		// synthetic pool/provider-exhaustion rows out of history for the same
		// filtered set (auto-refresh probes, etc.).
		if (
			!shouldRecordRequest({
				method: req.method,
				path: url.pathname,
				providerName: ctx.provider.name,
				responseStatus: response.status,
				internal: requestMeta.internal === true,
				getHeader: (name) => req.headers.get(name),
			})
		) {
			return;
		}

		// Synthetic terminal responses (pool/provider-exhaustion) write a request
		// row directly via the recorder. Preserve the already-buffered incoming body
		// and the small local response when payload storage is enabled so the details
		// modal can explain the rejection. There is still no provider usage/account.
		const storePayloads = ctx.config.getStorePayloads?.() ?? true;
		let responseBody: ArrayBuffer | null = null;
		if (storePayloads) {
			try {
				responseBody = await response.clone().arrayBuffer();
			} catch {
				// Metadata/model attribution is still valuable if cloning ever fails.
			}
		}
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
			requestedModel: effectiveRequestModel ?? null,
			synthetic: true,
			failureSource:
				error === "provider_overloaded"
					? "local_provider_cooldown"
					: "local_proxy_rejection",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: 0,
			authed: false,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			comboName: null,
			project: project ?? null,
			projectAttributionSource,
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
			requestBody: storePayloads ? finalBodyBuffer : null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};
		ctx.requestRecorder.recordSynthetic(meta, "error", error, {
			responseBody,
		});
	};

	const createProviderOverloadedResponse = async (
		overloaded: ProviderOverloadedAccount[],
	): Promise<Response> => {
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
		// Name the gated family when the request resolves to one — during a
		// family-scoped incident (e.g. a Haiku-only 529 storm) the client sees
		// which family is blocked, not just the provider. Response shape /
		// status / headers are otherwise unchanged.
		const gatedFamily = effectiveRequestModel
			? getModelFamily(effectiveRequestModel)
			: null;
		const response = new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "overloaded_error",
					message: `Provider temporarily overloaded: ${providers.join(", ")}${gatedFamily ? ` (${gatedFamily})` : ""}`,
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
		await recordSyntheticErrorResponse(response, "provider_overloaded");
		return response;
	};

	const {
		available: providerAvailableAccounts,
		overloaded: providerOverloadedAccounts,
	} = gates.applyProviderOverloadGate(selectedAccounts);

	const { available: postThrottleAccounts, throttled: throttledAccounts } =
		gates.applyUsageThrottling(providerAvailableAccounts);

	const postFamilyGateAccounts = gates.applyFamilyWeeklyGate(
		postThrottleAccounts,
		initialComboInfo,
	);
	const accounts = gates.applySoftDemotionReorder(
		gates.applyContextWindowGate(postFamilyGateAccounts, initialComboInfo),
		initialComboInfo,
	);
	if (requestMeta.routing) {
		requestMeta.routing.selectedAccountId =
			accounts[0]?.id ?? requestMeta.routing.selectedAccountId ?? null;
		requestMeta.routing.candidatesCount = accounts.length;
		// Post-gate FIRST attempt, set after every gate and reorder has run.
		// Consumers that must respect a soft-demotion reorder test POSITION
		// against this, not membership in `accounts`.
		requestMeta.routing.primaryAttemptAccountId = accounts[0]?.id ?? null;
	}

	// Post-gate routing evidence, emitted EXACTLY ONCE per request at the moment
	// an attempt is ADMITTED — never before. SessionStrategy.logSelection() runs
	// BEFORE these gates, so it shows the strategy's ranking, not the order
	// clients actually follow; this line records the FINAL candidate order with
	// each account's soft-demotion reason (if any) plus the account whose attempt
	// was admitted first. It is the only runtime signal that a soft demotion bound.
	//
	// BOUNDARY: "first admitted attempt" means the first account admitted past
	// the routing gates and the single-flight probe gate — NOT the first account
	// to reach the network. Admission still precedes request preparation and the
	// authoritative overload admission inside proxy-operations.ts, either of which
	// can fail over before any bytes leave. That is deliberate: what this line
	// exists to verify is WHICH ACCOUNT ROUTING ATTEMPTED FIRST, and a
	// soft-demoted account being attempted first is the defect regardless of
	// whether that attempt reached the network.
	//
	// Why the ADMITTED account and not `primaryAttemptAccountId`: the latter is
	// post-gate LIST POSITION, and at least three paths make the real first
	// admitted attempt differ from it — the marker-active burst hold reprobes the
	// affinity-pinned account regardless of position, the single-flight probe gate
	// can suppress accounts[0], and the late provider-overload check skips it
	// before any upstream call. Reporting position would misdescribe exactly the
	// cases this line exists to diagnose, so it is called from the admission
	// points themselves (every probe-gate callback body, plus every direct
	// proxyWithAccount call site); the once-flag makes the extra call sites free.
	// The gated primary is still reported alongside, labelled as position.
	// Built only when DEBUG is on (mirrors logSelection's guard).
	let finalOrderLogged = false;
	const logFinalOrderOnce = (actualAccountId: string): void => {
		if (finalOrderLogged) return;
		if (log.getLevel() > LogLevel.DEBUG) return;
		finalOrderLogged = true;
		const order = accounts
			.map((a) => {
				const reason = gates.softDemotionReasons.get(a.id);
				return reason ? `${a.name}(demoted:${reason})` : a.name;
			})
			.join(" > ");
		log.debug(
			`Final candidate order: ${order || "none"} — first admitted attempt: ` +
				`${actualAccountId} (gated primary by position: ` +
				`${requestMeta.routing?.primaryAttemptAccountId ?? "none"})`,
		);
	};

	// Every hold that parks a live client connection and re-attempts is built ONCE
	// per request here (see recovery-holds.ts): the overload hold, the shared
	// non-Codex wait+retry hold behind the context-window / family-weekly / pin
	// terminals, and the transparent burst-retry hold. The burst give-up
	// bookkeeping it accumulates is read back by the failover loop and by the
	// give-up terminal, so it must outlive every individual pass.
	const holds = createRecoveryHolds({
		req,
		url,
		ctx,
		apiKeyId,
		apiKeyName,
		requestMeta,
		requestBodyContext,
		finalBodyBuffer,
		finalCreateBodyStream,
		effectiveRequestModel,
		gates,
		bumpIdleTimeout,
		burstHoldTimingOverride,
		logFinalOrderOnce,
		attemptThroughProbeGate,
	});

	// 7. Handle no accounts case
	if (accounts.length === 0) {
		// Pin-transient hold: the pin strict-failed selection ONLY because every
		// pin-ALLOWED account is on a short transient cooldown (a per-account 429 or
		// a provider-wide 529 overload) that will clear within the hold budget — NOT
		// a long 5h/7d usage wall. Rather than fast-fail a burst of 503s to the
		// client (the reported incident), hold the connection and re-probe until a
		// pinned account recovers. The hold's re-selection re-enforces the pin every
		// iteration, so a disallowed account is never served. On give-up (or a long
		// wall whose recovery is beyond budget), fall through to the pinned terminal.
		//
		// SKIP count_tokens: it is an advisory "how big is this?" probe answered
		// locally/quickly (see the count_tokens last-resort below) — holding a live
		// connection up to 120s for it would be wrong; it keeps its fast terminal.
		const activePin = requestMeta.pin;
		if (
			url.pathname !== "/v1/messages/count_tokens" &&
			requestMeta.pinFailure &&
			(requestMeta.pinFailure.code === "pinned_no_available_account" ||
				requestMeta.pinFailure.code === "pinned_account_unavailable") &&
			activePin &&
			(activePin.accountId ||
				(activePin.providers && activePin.providers.length > 0))
		) {
			const isPinAllowed = (a: Account): boolean =>
				activePin.accountId
					? a.id === activePin.accountId
					: (activePin.providers ?? []).includes(a.provider);
			const nowMs = Date.now();
			let hasHoldCandidate = false;
			try {
				const allAccs = await ctx.dbOps.getAllAccounts();
				hasHoldCandidate = allAccs.some((a) => {
					if (a.paused || !isPinAllowed(a)) return false;
					const rl =
						a.rate_limited_until && a.rate_limited_until > nowMs
							? a.rate_limited_until
							: 0;
					const ov =
						getProviderOverloadUntil(
							a.provider,
							nowMs,
							effectiveRequestModel ?? null,
						) ?? 0;
					const availableAt = Math.max(rl, ov);
					// Only hold when the transient cooldown clears within budget; a
					// long 5h/7d wall (or nothing cooled) fails fast at the terminal.
					return availableAt > nowMs && availableAt - nowMs <= PIN_HOLD_MAX_MS;
				});
			} catch (err) {
				// DB error probing accounts — don't hold, fall through to the terminal.
				log.warn("Pin hold: failed to probe accounts, skipping hold", err);
			}
			if (hasHoldCandidate) {
				const savedPinFailure = requestMeta.pinFailure;
				// Re-arm the connection's idle timer while we hold (the base 180s
				// timeout would otherwise reap a silently-held connection).
				bumpIdleTimeout();
				const pinRearm = setInterval(
					bumpIdleTimeout,
					NETWORK.IDLE_REARM_INTERVAL_MS,
				);
				try {
					const held = await holds.holdForNonCodexRecovery(
						PIN_HOLD_MAX_MS,
						"Pin hold",
						{
							eligible: isPinAllowed,
							clearPinFailure: true,
						},
					);
					if (held) return held;
				} finally {
					clearInterval(pinRearm);
				}
				// Hold gave up (budget/soonest-expiry exhausted). A mid-hold
				// re-selection may have cleared pinFailure — restore the original so
				// the terminal below still fires with the right code/message.
				if (!requestMeta.pinFailure) {
					requestMeta.pinFailure = savedPinFailure;
				}
			}
		}

		// A pin strict-failed selection (pinned account/class had no allowed,
		// available candidate). Return a clean terminal error rather than degrading
		// to storm-hold / pool_exhausted — never silently answer from a disallowed
		// account. The /v1/responses adapter converts this non-200 to the OpenAI
		// error shape, so the Codex CLI surfaces a real error.
		if (requestMeta.pinFailure) {
			const pinnedResponse = createPinnedTargetUnavailableResponse(
				requestMeta.pinFailure,
			);
			await recordSyntheticErrorResponse(
				pinnedResponse,
				requestMeta.pinFailure.code,
			);
			return pinnedResponse;
		}

		// count_tokens last-resort: it is advisory and answered LOCALLY by Codex
		// (CodexProvider synthesizes { input_tokens } with no upstream call). When
		// every account has been gated out — provider-overload, usage-throttle, or
		// the context-window gate — a count_tokens probe would otherwise return a
		// capacity terminal (503 pool_exhausted / 429 throttled / 400 context). That
		// is wrong for a purely local "how big is this?" call; ironically the
		// context-window gate could 400 it for being too big. Synthesize from any
		// non-paused Codex account instead. We DON'T do this for openai-compatible
		// (its count_tokens may hit a real upstream) or respect a pin failure
		// (handled above) — and we honor operator pause, but ignore rate-limit /
		// throttle / context state because local synthesis needs no capacity.
		if (url.pathname === "/v1/messages/count_tokens") {
			// `selectedAccounts` is already filtered by the API-key pin (an
			// Anthropic-pinned key never contains a Codex account here), so it is
			// always a safe source. The broader getAllAccounts() net IGNORES pins,
			// so only consult it for UNPINNED requests — otherwise an Anthropic-
			// pinned key whose candidates were gated out would be wrongly answered
			// from an unrelated Codex account instead of falling through to the
			// pinned terminal below.
			//
			// Known, intentional limitation: a key pinned to a *specific* Codex
			// account that is itself rate-limited gets `pinFailure` set during
			// selection and returns the pinned terminal above (line ~982) before
			// reaching here, so count_tokens yields 503 rather than a local
			// estimate in that one config. Honoring it would require a second
			// synthesis site BEFORE the fail-closed pinFailure boundary; that
			// boundary's job is to never answer a pinned key from the wrong place,
			// and the edge (specific-Codex pin + that account rate-limited +
			// count_tokens, a 503 the client already handles) does not justify
			// reordering it.
			const isPinned = Boolean(requestMeta.pin);
			const codexForSynthesis =
				selectedAccounts.find((a) => !a.paused && a.provider === "codex") ??
				(isPinned
					? undefined
					: (await ctx.dbOps.getAllAccounts()).find(
							(a) => !a.paused && a.provider === "codex",
						));
			if (codexForSynthesis) {
				log.info(
					`count_tokens: all accounts gated out — synthesizing a local estimate from Codex account ${codexForSynthesis.name} instead of a capacity terminal`,
				);
				// Deliberately NOT routed through attemptThroughProbeGate: this is a
				// synthetic, locally-answered request (no upstream call), so it must
				// neither consume an account's single recovery probe nor be suppressed
				// by another request holding it.
				const syntheticResponse = await proxyWithAccount(
					req,
					url,
					codexForSynthesis,
					requestMeta,
					finalBodyBuffer,
					finalCreateBodyStream,
					0,
					ctx,
					null,
					apiKeyId,
					apiKeyName,
					requestBodyContext,
					true,
				);
				if (syntheticResponse) return syntheticResponse;
			}
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
			holds.burstHeldId &&
			// Codex High finding: never hold an account that was gated out by the
			// usage-throttle / context-window gate. `accounts` is empty here, so the
			// held account is NOT available — it must be a genuine cooldown
			// (`affinity_hold`). An account that was `affinity_hit` (available, then
			// usage-throttled / context-gated out) must fall to the
			// createUsageThrottledResponse / context / pool_exhausted terminal below.
			isBurstHoldEligible(requestMeta.routing?.decision, false)
		) {
			const heldAccount =
				selectedAccounts.find((a) => a.id === holds.burstHeldId) ??
				(await ctx.dbOps.getAccount(holds.burstHeldId));
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
				} else if (
					resolveFamilyWeeklyExclusion(
						heldAccount,
						effectiveRequestModel,
						usageCache.get(heldAccount.id),
						heldCapacity,
						Date.now(),
					) !== null
				) {
					// The held account's weekly quota for the REQUESTED family is
					// exhausted (with unified headroom) — the family window won't clear
					// within the hold budget, so holding would only re-probe into another
					// family 429. Degrade to the terminal instead of burning the hold.
					log.warn(
						`Storm-degrade: held account ${heldAccount.name} is weekly-exhausted for the requested family — NOT holding, degrading to terminal`,
					);
				} else {
					// Null capacity (usage stale/absent) ⇒ stale_should_retry (single
					// probe); fresh positive headroom ⇒ fresh_headroom (full budget).
					const holdConfidence: "fresh_headroom" | "stale_should_retry" =
						heldCapacity === null ? "stale_should_retry" : "fresh_headroom";
					log.warn(
						`Storm-degrade: all accounts cooled — holding the cache account ${heldAccount.name} (confidence=${holdConfidence}) instead of immediate pool_exhausted`,
					);
					const outcome = await holds.runBurstHold(heldAccount, holdConfidence);
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
		if (holds.burstHoldDeclined && holds.burstHeldAccountForGiveUp) {
			cacheBodyStore.discardStaged(requestMeta.id);
			const giveUpResponse = createBurstRetryGiveUpResponse(
				holds.burstHeldAccountForGiveUp,
			);
			await recordSyntheticErrorResponse(
				giveUpResponse,
				"burst_retry_exhausted",
			);
			return giveUpResponse;
		}

		// If the pool was emptied specifically by the context-window gate
		// (and there were Codex accounts that would have been available
		// otherwise), hold the connection until a large-context account becomes
		// available — up to CW_HOLD_MAX_MS — before returning 400, then (E) fall
		// back to attempting an excluded Codex account against its full window.
		//
		// Deliberately gated on `throttledAccounts.length === 0`: a usage-throttle
		// terminal (the user is over their quota window) takes precedence and is
		// surfaced below. We only reach the CW hold / last-resort path when the
		// large-context accounts are unavailable for non-throttle reasons (paused,
		// rate-limited) — which is the incident this path was built for.
		if (
			gates.contextExcludedAccounts.length > 0 &&
			throttledAccounts.length === 0
		) {
			// Pre-compute the last-resort relaxation candidates (Codex accounts that
			// fit the FULL/unmargined window) so we can both (a) pick the hold budget
			// and (b) reuse them in the relaxation block below without re-filtering.
			const relaxCandidates = gates.contextExcludedAccounts.filter(
				({ account, model }) =>
					codexAccountFitsRequestUnmargined(account, model, gateTokenEstimate),
			);
			// If a Codex account can serve as last resort, keep the original 120s
			// behavior (Codex is the fallback). If NOT, the only path to success is
			// waiting out the rate-limited large-context accounts, so hold longer.
			const cwHoldBudget =
				relaxCandidates.length > 0
					? CW_HOLD_MAX_MS
					: CW_HOLD_MAX_MS_NO_CODEX_FALLBACK;

			// Re-arm the connection's idle timer while we wait (the base 180s timeout
			// would otherwise reap a connection held silently for up to 330s). An
			// immediate bump keeps the timer fresh before the first sleep too.
			bumpIdleTimeout();
			const cwRearm = setInterval(
				bumpIdleTimeout,
				NETWORK.IDLE_REARM_INTERVAL_MS,
			);
			try {
				const held = await holds.holdForNonCodexRecovery(
					cwHoldBudget,
					"CW hold",
				);
				if (held) return held;

				// Last-resort relaxation (E): the CW hold found no large-context
				// account and the only backends that could serve are the Codex
				// accounts the gate excluded. Rather than 400 a request that may
				// actually fit the real window, attempt any excluded Codex account
				// whose estimate fits the FULL window (no SAFETY_MARGIN —
				// pre-computed as relaxCandidates above). Codex is the genuine last
				// resort here, so we drop the guard band; if the estimate still
				// undercounts, Codex returns its own context-length error.
				if (req.signal?.aborted) {
					cacheBodyStore.discardStaged(requestMeta.id);
					return createClientAbortResponse();
				}
				let relaxAttempted = false;
				let relaxSuppressed = 0;
				for (let i = 0; i < relaxCandidates.length; i++) {
					const { account } = relaxCandidates[i];
					// Re-derive the combo slot's model override exactly as the gate
					// did, so we send the same model the unmargined check sized
					// against.
					const slot = initialComboInfo?.slots.find(
						(s) => s.accountId === account.id,
					);
					log.info(
						`Context-window last-resort: attempting excluded Codex account ` +
							`"${account.name}" against full window (estimate=${gateTokenEstimate})`,
					);
					// Through the same single-flight probe gate: this is a real upstream
					// attempt on a real account, so a freshly-recovered one still gets
					// exactly one probe. Suppressed → skip to the next candidate;
					// nothing was attempted, so it counts as neither a relaxation
					// attempt nor (crucially) as evidence about the request's SIZE.
					const gated = await attemptThroughProbeGate(account, () => {
						logFinalOrderOnce(account.id);
						relaxAttempted = true;
						return proxyWithAccount(
							req,
							url,
							account,
							requestMeta,
							finalBodyBuffer,
							finalCreateBodyStream,
							i,
							ctx,
							slot?.modelOverride,
							apiKeyId,
							apiKeyName,
							requestBodyContext,
							// On the last candidate, forward a real upstream
							// rate-limit/overload as the honest terminal rather than
							// collapsing it to null.
							i === relaxCandidates.length - 1,
							// Thread the client signal so a disconnect aborts the in-flight
							// attempt instead of waiting for the upstream timeout.
							{ signal: req.signal },
						);
					});
					if (gated.suppressed) {
						relaxSuppressed += 1;
						continue;
					}
					const r = gated.response;
					if (r) return r;
					// A null here can mean the client disconnected mid-attempt (the
					// threaded signal aborts the fetch, which proxyWithAccount reports
					// as a network_error null). Surface that as a client abort rather
					// than continuing to the next candidate or the fall-through
					// terminal.
					if (req.signal?.aborted) {
						cacheBodyStore.discardStaged(requestMeta.id);
						return createClientAbortResponse();
					}
				}

				// Done with the staged body either way (a successful attempt already
				// returned above).
				cacheBodyStore.discardStaged(requestMeta.id);

				// The size verdict is a property of the CANDIDATE SET, not of whether
				// an upstream attempt happened to run: only "no excluded account fits
				// even the full window" proves the request is too big for every
				// backend. Keying the 400 on "nothing was attempted" told a client its
				// request was too large whenever every fitting candidate was merely
				// probe-suppressed — a non-retryable answer to a purely temporary,
				// retryable condition.
				if (relaxCandidates.length === 0) {
					return createContextWindowExceededResponse(
						gateTokenEstimate,
						[...gates.contextExcludedAccounts],
						effectiveRequestModel ?? "unknown",
					);
				}
				if (!relaxAttempted && relaxSuppressed > 0) {
					log.info(
						`Context-window last-resort: all ${relaxSuppressed} fitting account(s) were recovery-probe suppressed — deferring to an availability terminal, NOT a context_window_exceeded 400`,
					);
				}
				// The request fit the true window but every last-resort Codex candidate
				// either failed for availability (429/5xx/network → null) or was
				// suppressed behind an in-flight recovery probe. Neither is a size
				// problem, so fall through to the generic terminals below —
				// pool_exhausted / provider-overloaded, or pinned_target_unavailable
				// when a pin / Codex-CLI floor is active (all honest, retryable 503s)
				// — rather than a misleading context_window_exceeded 400.
			} finally {
				// Stop re-arming on EVERY exit path: success returns, relaxation
				// returns, the 400, client-abort returns, and the fall-through.
				clearInterval(cwRearm);
			}
		}

		// Family-weekly terminal — fire ONLY when a family-weekly exclusion is the
		// sole reason the candidate pool emptied (no context-window exclusion, no
		// usage throttle applied). A genuine account-wide quota/throttle takes
		// precedence and is surfaced by the checks around it. Returns a 429 with a
		// Retry-After from the soonest family reset rather than routing to an
		// account that will just 429.
		if (
			gates.familyWeeklyExcludedAccounts.length > 0 &&
			gates.contextExcludedAccounts.length === 0 &&
			throttledAccounts.length === 0
		) {
			const family = gates.familyWeeklyExcludedAccounts[0].family;

			// The pool emptied because the requested family is weekly-exhausted on
			// the reachable account(s). But a DIFFERENT Anthropic account that still
			// HAS this family's weekly quota may be momentarily out of the pool only
			// because of a short transient cooldown (a per-account 429 or a provider
			// 529 overload). Incident: a Fable-free sibling briefly 529-cooled emptied
			// the pool to a Fable-exhausted account, surfacing a misleading 5-day
			// family-exhausted 429. Detect such siblings and hold for the cooldown to
			// lapse (bounded) rather than returning that error.
			//
			// SKIP this for a pinned request (API-key→account/class pin): a cooled
			// sibling may lie OUTSIDE the pin's allowed set. The hold's re-selection
			// re-enforces the pin (so it would never be served — no fail-closed
			// break), but holding for it wastes the budget and the response would name
			// an account the key isn't allowed to use. Fall through to the genuine
			// family-exhausted terminal instead. (excludeOfficialAnthropic / Codex-CLI
			// requests never populate familyWeeklyExcludedAccounts, so `pin` is the
			// only live case here.)
			const nowGate = Date.now();
			const cooledSiblings = requestMeta.pin
				? []
				: (await ctx.dbOps.getAllAccounts())
						.map((a) =>
							resolveTransientlyCooledFamilySibling(
								a,
								family,
								usageCache.get(a.id),
								a.rate_limited_until,
								getProviderOverloadUntil(
									a.provider,
									nowGate,
									effectiveRequestModel ?? null,
								),
								nowGate,
							),
						)
						.filter((s): s is TransientlyCooledFamilySibling => s !== null);

			if (cooledSiblings.length > 0) {
				const soonestSibling = cooledSiblings.reduce((min, s) =>
					s.availableAt < min.availableAt ? s : min,
				);
				// Only hold when the soonest recovery lands within the bounded budget;
				// a longer cooldown (e.g. a 5-min 529 overload) is reported directly
				// with a cooldown-scaled Retry-After instead of pinning the connection.
				if (
					soonestSibling.availableAt - nowGate <=
					FAMILY_WEEKLY_COOLDOWN_HOLD_MAX_MS
				) {
					bumpIdleTimeout();
					const famRearm = setInterval(
						bumpIdleTimeout,
						NETWORK.IDLE_REARM_INTERVAL_MS,
					);
					try {
						const held = await holds.holdForNonCodexRecovery(
							FAMILY_WEEKLY_COOLDOWN_HOLD_MAX_MS,
							"Family-weekly hold",
						);
						if (held) return held;
					} finally {
						clearInterval(famRearm);
					}
				}

				// The hold expired (or the cooldown was beyond budget) and a
				// family-capable sibling is still cooling down: report the SIBLING's
				// cooldown reset (~seconds/minutes), NOT the multi-day family window,
				// so the client retries when the sibling actually recovers.
				const familyResponse = createFamilyWeeklyExhaustedResponse(
					[...gates.familyWeeklyExcludedAccounts],
					family,
					effectiveRequestModel,
					Date.now(),
					{
						name: soonestSibling.account.name,
						availableAt: soonestSibling.availableAt,
					},
				);
				await recordSyntheticErrorResponse(
					familyResponse,
					"family_weekly_exhausted",
				);
				return familyResponse;
			}

			// No transiently-cooled family-capable sibling — the pool is genuinely
			// exhausted for this family. Original behavior.
			const familyResponse = createFamilyWeeklyExhaustedResponse(
				[...gates.familyWeeklyExcludedAccounts],
				family,
				effectiveRequestModel,
				Date.now(),
			);
			await recordSyntheticErrorResponse(
				familyResponse,
				"family_weekly_exhausted",
			);
			return familyResponse;
		}

		if (throttledAccounts.length > 0) {
			return createUsageThrottledResponse(throttledAccounts);
		}

		if (
			selectedAccounts.length > 0 &&
			providerAvailableAccounts.length === 0 &&
			providerOverloadedAccounts.length > 0
		) {
			// Hold (bounded, capped) for the family to recover instead of bouncing
			// the synthetic 529 — see holdForOverloadRecovery above.
			const held = await holds.holdForOverloadRecovery(
				providerOverloadedAccounts,
			);
			if (held) return held;
			return await createProviderOverloadedResponse(
				holds.refreshOverloadUntils(providerOverloadedAccounts),
			);
		}

		// The client hung up while account selection was running. Both terminals
		// below (pinned_target_unavailable and pool_exhausted) call
		// recordSyntheticErrorResponse — and pool_exhausted additionally logs at
		// ERROR — so letting an aborted request reach them writes a bogus 503 row
		// into request history (skewing the dashboard fail rate) and shouts about a
		// pool exhaustion nobody is waiting on. One guard covers both same-class
		// terminals; skipping a synthetic history row for a departed client is
		// correct in either case.
		//
		// No discardStaged is needed here: staging happens inside proxyWithAccount,
		// and every path in this zero-accounts block that can reach it (the
		// storm-degrade burst hold, the CW hold + last-resort) either returns before
		// this point or already discarded its staged body.
		if (req.signal.aborted) return createClientAbortResponse();

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
			await recordSyntheticErrorResponse(
				pinnedResponse,
				"pinned_target_unavailable",
			);
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
		await recordSyntheticErrorResponse(poolExhaustedResponse, "pool_exhausted");

		return poolExhaustedResponse;
	}

	// 8. Log selected accounts
	log.info(
		`Selected ${accounts.length} accounts: ${accounts.map((a) => a.name).join(", ")}`,
	);
	if (isDebugEnabled("proxy") || process.env.NODE_ENV === "development") {
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

	// Codex High finding: the held account may only enter the hold when it is
	// EITHER present in the gated `accounts` list (still available — fine to
	// probe) OR genuinely cooldown-unavailable (`affinity_hold`). If it is absent
	// from `accounts` AND the decision was `affinity_hit` (i.e. it was selected as
	// available but then removed by the usage-throttle / context-window gate),
	// holding+probing it would bypass the configured pacing throttle / context
	// safety — so do NOT hold; fall through to today's normal-loop behavior.
	const heldInGatedAccounts = holds.burstHeldId
		? accounts.some((a) => a.id === holds.burstHeldId)
		: false;
	if (
		!filteredComboInfo?.comboName &&
		holds.burstHeldId &&
		isBurstHoldEligible(requestMeta.routing?.decision, heldInGatedAccounts)
	) {
		// Resolve the held (cache) account object. It may not be in `accounts`
		// (an affinity_hold serves a sibling because the pinned account is cooled),
		// so fall back to the DB. We re-probe it directly, bypassing the
		// availability gate, re-checking only paused/existence below.
		const heldAccount =
			accounts.find((a) => a.id === holds.burstHeldId) ??
			selectedAccounts.find((a) => a.id === holds.burstHeldId) ??
			(await ctx.dbOps.getAccount(holds.burstHeldId));

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
				} else if (
					resolveFamilyWeeklyExclusion(
						heldAccount,
						effectiveRequestModel,
						usageCache.get(heldAccount.id),
						heldCapacity,
						Date.now(),
					) !== null
				) {
					// Held account's weekly quota for the REQUESTED family is exhausted
					// (with unified headroom) — the family window won't clear within the
					// hold budget, so fall through to normal failover (siblings) rather
					// than pinning this request to an account that will only 429 again.
					log.warn(
						`Burst marker active but held account ${heldAccount.name} is weekly-exhausted for the requested family — NOT holding, falling through to normal failover`,
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
			} else if (
				requestMeta.routing?.primaryAttemptAccountId === heldAccount.id
			) {
				// The held account is available (affinity_hit) AND is still the GATED
				// PRIMARY — attempt it first, through the SAME single-flight probe gate
				// as every other upstream attempt. Without the gate, concurrent
				// affinity requests all reached a freshly-recovered account at once;
				// and because no lease was held, a success here could not clear its
				// capacity-restored marker either.
				//
				// POSITION, not membership: this branch bypasses the ordinary attempt
				// loop, so testing `accounts.some(...)` would attempt the affinity-held
				// account first even after a soft-demotion reorder moved it to the back
				// — silently bypassing every soft demotion on affinity_hit traffic,
				// which is the dominant path. Once it is no longer the primary, fall
				// through to the normal failover loop, which honors the reorder.
				let firstOutcome: ProxyAttemptOutcome | null = null;
				const gatedFirst = await attemptThroughProbeGate(heldAccount, () => {
					logFinalOrderOnce(heldAccount.id);
					// Record the attempt (only when it actually happens) so the normal
					// loop below skips a duplicate if we fall through.
					holds.noteBurstAttempt(heldAccount.id);
					return proxyWithAccount(
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
								// The normal loop below skips the held account (attempted-id
								// guard), so its suppression must be recorded here.
								holds.noteOverloadSuppression(heldAccount, o);
							},
						},
					);
				});
				if (gatedFirst.response) {
					return gatedFirst.response;
				}
				// Suppressed: another request is already probing this account. Nothing
				// was attempted, so do NOT enter the hold — fall through to the normal
				// failover loop (which suppresses it again and moves to a sibling).
				if (!gatedFirst.suppressed) {
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
				const outcome = await holds.runBurstHold(heldAccount, holdConfidence);

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

	// --- Attempt loop --------------------------------------------------------
	//
	// A candidate the single-flight recovery-probe gate SUPPRESSES was never
	// attempted: another request holds its probe lease. The loop skips it and
	// falls through to the next candidate, exactly as it always has.
	/**
	 * The ONE attempt loop, shared by the main pass and the combo-fallback pass.
	 *
	 * EQUIVALENCE NOTE (verified against the two hand-written loops this replaced):
	 *  - ORDER: the caller passes the already-gated list; iteration is the same
	 *    ascending index walk, and `i` is still the `failoverAttempts` argument.
	 *  - GATING: the burst-attempted skip (`skipAccountId` — previously
	 *    `burstAttemptedAccountId`, only ever set on the main pass), the combo
	 *    slot/account desync check, the slot model override and the late
	 *    provider-overload skip are byte-for-byte the previous logic; only the
	 *    log noun is parameterised (`label`, defaulting to the main pass's
	 *    "account").
	 *  - TERMINAL FLAG: `!comboInfo?.comboName && (last || no-cross-provider ||
	 *    every-remaining-unattemptable)`. The fallback pass previously omitted the
	 *    `!comboName` conjunct because its combo was already cleared — with
	 *    `comboInfo === null` the conjunct is vacuously true, so it is the same
	 *    value. (`everyRemainingCandidateUnattemptable` is a separate, deliberate
	 *    addition made for both passes.)
	 *  - AFFINITY: unchanged — the burst preflight still attempts the held account
	 *    outside this loop and hands its id in as `skipAccountId`; nothing here
	 *    reads or writes affinity state.
	 *  - OVERLOAD ACCOUNTING: every attempt still passes
	 *    `onOutcome: noteOverloadSuppression`, and `logFinalOrderOnce` is still
	 *    called from inside the probe-gate callback (the admission point).
	 *  - The fallback pass now passes `modelOverride: null` where it previously
	 *    passed `undefined`; every consumer is truthiness-based, so this is inert.
	 */
	const runCandidateLoop = async (
		list: Account[],
		comboInfo: ComboSlotInfo | null,
		options: { skipAccountId?: string | null; label?: string } = {},
	): Promise<Response | null> => {
		const label = options.label ?? "account";
		for (let i = 0; i < list.length; i++) {
			// Client-disconnect terminal, mirroring the hold loop's pattern above.
			// Placed at the TOP of the loop BODY, so it fires both before the FIRST
			// candidate can stage a cacheable body or acquire a probe lease, and
			// between every pair of candidates. Without it a disconnect mid-attempt
			// fanned the request out across every remaining sibling — cooldowns,
			// probe leases and upstream traffic for a client that is already gone.
			//
			// The discriminator is `req.signal.aborted`, NEVER `isAbortError`: the
			// burst / overload / context-window holds each compose their OWN
			// AbortController via AbortSignal.any, so a budget deadline surfaces as
			// an AbortError while the client is still waiting and must keep failing
			// over.
			//
			// A 499 return emits no worker end/summary, so any body staged by an
			// earlier candidate has to be discarded here or it leaks.
			if (req.signal.aborted) {
				cacheBodyStore.discardStaged(requestMeta.id);
				return createClientAbortResponse();
			}
			// Skip the held account if the burst-retry first attempt already tried it
			// (and fell through non-retryably) — avoid a wasteful duplicate request.
			if (options.skipAccountId && list[i].id === options.skipAccountId) {
				continue;
			}
			// For combo routing: resolve the slot's model override FIRST so the
			// overload skip below gates on the model this attempt actually sends
			// upstream (a slot override can land in a different family than the
			// request model).
			let modelOverride: string | null = null;
			if (comboInfo?.slots[i]) {
				const slot = comboInfo.slots[i];
				if (slot.accountId !== list[i].id) {
					log.error(
						`Combo slot/account desync: slot ${i} expects account ${slot.accountId} but got ${list[i].id}`,
					);
				} else {
					modelOverride = slot.modelOverride;
				}
			}

			const overloadedUntil = getProviderOverloadUntil(
				list[i].provider,
				Date.now(),
				modelOverride ?? effectiveRequestModel ?? null,
			);
			if (overloadedUntil) {
				log.debug(
					`Skipping ${label} ${list[i].name}; provider ${list[i].provider} is overloaded until ${new Date(overloadedUntil).toISOString()}`,
				);
				continue;
			}

			if (comboInfo?.slots[i]) {
				requestMeta.comboSlotIndex = i;
				log.info(
					`Attempting combo slot ${i}/${list.length - 1} on account ${list[i].name} with model "${modelOverride}"`,
				);
			}

			// Single-flight recovery probe gate (see attemptThroughProbeGate): a
			// freshly-recovered account admits exactly ONE probe. Concurrent requests
			// that would re-select it are suppressed and skip to the next candidate
			// instead of stampeding it.
			const gated = await attemptThroughProbeGate(list[i], () => {
				logFinalOrderOnce(list[i].id);
				return proxyWithAccount(
					req,
					url,
					list[i],
					requestMeta,
					finalBodyBuffer,
					finalCreateBodyStream,
					i,
					ctx,
					modelOverride,
					apiKeyId,
					apiKeyName,
					requestBodyContext,
					// Evaluated when the 529 ARRIVES, not now: a later candidate can
					// become attemptable while this attempt is in flight (a sibling's
					// recovery-probe lease is released, an overload bucket closes), and
					// a pre-fetch snapshot would forward the 529 to the client instead
					// of failing over to it.
					() =>
						!comboInfo?.comboName &&
						(i === list.length - 1 ||
							gates.shouldForwardProviderOverloadIfNoCrossProviderFallback(
								list,
								i,
							) ||
							gates.everyRemainingCandidateUnattemptable(list, i)),
					{
						// Thread the CLIENT's signal into the upstream fetch, mirroring
						// the burst-hold loop. Without it `options?.signal` was undefined
						// here and the fetch was armed with the internal timeout
						// controller alone, so a disconnect left the upstream request
						// running to completion. This loop serves both the main pass and
						// the combo-fallback pass.
						signal: req.signal,
						onOutcome: (o) => holds.noteOverloadSuppression(list[i], o),
					},
				);
			});
			if (gated.suppressed) {
				continue;
			}
			if (gated.response) {
				return gated.response;
			}

			// Log combo slot failure
			if (comboInfo) {
				log.info(
					`Combo slot ${i} failed on account ${list[i].name}${i < list.length - 1 ? ", trying next slot" : ", all combo slots exhausted"}`,
				);
			}
		}
		return null;
	};

	// The burst preflight attempts `heldAccount` OUTSIDE this loop; the loop then
	// skips it via `skipAccountId`.
	const mainResponse = await runCandidateLoop(accounts, filteredComboInfo, {
		skipAccountId: holds.burstAttemptedAccountId,
	});
	if (mainResponse) return mainResponse;

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
	if (holds.burstHoldDeclined && holds.burstHeldAccountForGiveUp) {
		cacheBodyStore.discardStaged(requestMeta.id);
		const giveUpResponse = createBurstRetryGiveUpResponse(
			holds.burstHeldAccountForGiveUp,
		);
		await recordSyntheticErrorResponse(giveUpResponse, "burst_retry_exhausted");
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
		} = gates.applyProviderOverloadGate(selectedFallbackAccounts);
		const {
			available: filteredFallbackAccounts,
			throttled: throttledFallbackAccounts,
		} = gates.applyUsageThrottling(providerFallbackAccounts);
		// (soft-demotion reorder — family reservation AND pool liveness —
		// intentionally omitted on the failover/fallback tail: already-degraded
		// path. For pool liveness this is largely self-enforcing anyway: rule 4
		// requires an absorbable peer, and on a degraded path there is none, so
		// the reserve fails open regardless.)
		fallbackAccounts = gates.applyContextWindowGate(
			gates.applyFamilyWeeklyGate(filteredFallbackAccounts),
		);
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
			// No combo override on the fallback path (the combo was cleared above),
			// so the request model is the effective model and the terminal-attempt
			// flag reduces to the loop's own last-candidate / no-cross-provider test.
			const fallbackResponse = await runCandidateLoop(fallbackAccounts, null, {
				label: "fallback account",
			});
			if (fallbackResponse) return fallbackResponse;
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
			// Hold (bounded, capped) for recovery instead of bouncing the synthetic
			// 529 — same treatment as the other two overload terminals. The combo
			// was already cleared above, so the hold's re-selection runs plain
			// SessionStrategy routing.
			const held = await holds.holdForOverloadRecovery(
				providerFallbackOverloadedAccounts,
			);
			if (held) return held;
			// Terminal return emits no worker summary — drop the staged body
			// (mirrors the all-accounts-failed cleanup).
			cacheBodyStore.discardStaged(requestMeta.id);
			return await createProviderOverloadedResponse(
				holds.refreshOverloadUntils(providerFallbackOverloadedAccounts),
			);
		}
	}

	// Suppressed-only correctness: at least one candidate was refused by the
	// half-open overload-probe admission (a probe is in flight, or an open
	// bucket won a race against the gate) and nothing else served the request.
	// Surface the provider-overloaded 529 with a short Retry-After — the probe
	// resolves within seconds — instead of the misleading ALL_ACCOUNTS_FAILED.
	if (holds.overloadSuppressedAttempts.length > 0) {
		// Hold (bounded, capped) behind the in-flight probe instead of bouncing
		// the short-Retry-After 529; overflow and budget expiry fall back to it.
		const held = await holds.holdForOverloadRecovery(
			holds.overloadSuppressedAttempts,
		);
		if (held) return held;
		cacheBodyStore.discardStaged(requestMeta.id);
		return await createProviderOverloadedResponse(
			holds.refreshOverloadUntils(holds.overloadSuppressedAttempts),
		);
	}

	// 11. All accounts failed. This request was staged for cache-keepalive in
	// proxyWithAccount, but no worker "end"/summary is emitted on this throw
	// path — drop its staged body now instead of waiting for the age sweep.
	cacheBodyStore.discardStaged(requestMeta.id);

	// The client hung up while the last candidate was in flight. proxyWithAccount's
	// abort path returns null (handleProxyError logs "not a failure" and returns —
	// which suppresses the log line, not the control flow), so an aborted request
	// would otherwise fall through to BOTH terminals below and be reported as
	// ALL_ACCOUNTS_FAILED — the exact string an operator greps for during a real
	// outage — or, worse, as "re-authenticate your accounts".
	//
	// Keyed on req.signal, NEVER on isAbortError: a hold-budget deadline is also an
	// AbortError but is NOT a client disconnect and must still fail loudly (pinned
	// by overload-hold.test.ts, "falls back to the synthetic 529 (not 499)"). Every
	// budget abort builds its OWN controller and composes it via AbortSignal.any,
	// so it can never mutate req.signal.
	//
	// POLICY, stated rather than overclaimed — "client disconnect wins at request
	// level". This does NOT prove nothing is masked: a genuine 401/429/network
	// failure can complete in the same tick the client hangs up, and this guard
	// then returns 499 instead of the aggregate 503. That is deliberate and safe
	// because every per-ATTEMPT effect already happened before the terminal was
	// reached (cooldowns applied, upstream bodies drained, probe leases settled,
	// per-attempt diagnostics logged); only the aggregate request-level verdict
	// changes, and there is no client left to receive it.
	//
	// Placement is load-bearing: AFTER the staged-body discard above (so a 499
	// return, which emits no worker end/summary, cannot leak it) and BEFORE the
	// attempted-accounts computation below (so it covers the needsReauth throw too).
	if (req.signal.aborted) return createClientAbortResponse();

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
