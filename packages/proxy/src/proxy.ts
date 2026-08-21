import {
	consumeRequestStarted,
	getModelFamily,
	isDebugEnabled,
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
import {
	createBurstRetryGiveUpResponse,
	isBurstHoldEligible,
} from "./burst-retry-policy";
import { cacheBodyStore } from "./cache-body-store";
import { isFamilyWeeklyMemoExhausted } from "./family-weekly-memo";
import {
	BURST_RETRY_MAX_USAGE_AGE_MS,
	createPinnedTargetUnavailableResponse,
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
	selectAccountsForRequest,
	setForcedAccount,
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
import { createRecoveryHolds } from "./recovery-holds";
import { type IngressContext, ingestProxyRequest } from "./request-ingress";
import type { RecordMeta, RequestRecorder } from "./request-recorder";
import { hashRoutingAffinityKey } from "./routing-telemetry";
import {
	isIngressRecordable,
	shouldRecordRequest,
} from "./should-record-request";
import { resolveZeroAccountsOutcome } from "./zero-accounts-terminal";

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
		opts?: { failoverAttempts?: number },
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
			// Most synthetic terminals fire before anything was attempted; the
			// give-up terminal passes the attempts it really made.
			failoverAttempts: opts?.failoverAttempts ?? 0,
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
	// The memo demotion is applied LAST, after every gate and reorder — running
	// it earlier lets the soft-demotion partition promote a 429-refused account
	// back to the front (see applyFamilyMemoDemotion).
	const accounts = gates.applyFamilyMemoDemotion(
		gates.applySoftDemotionReorder(
			gates.applyContextWindowGate(postFamilyGateAccounts, initialComboInfo),
			initialComboInfo,
		),
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

	// Real upstream attempts made for this request, counted at the probe-gate
	// callback — the last point before `proxyWithAccount` runs. Candidates that
	// were never attempted (probe-gate suppressed, overload-skipped, burst
	// double-attempt guard, path-incompatible before any network work) do not
	// increment it, so it is the honest denominator for the give-up terminal:
	// neither `recordSyntheticErrorResponse`'s hardcoded 0 nor the candidate-list
	// length the thrown message quotes.
	let upstreamAttempts = 0;
	const countedAttemptThroughProbeGate = (
		account: Account,
		attempt: () => Promise<Response | null>,
	): Promise<{ response: Response | null; suppressed: boolean }> =>
		attemptThroughProbeGate(account, () => {
			upstreamAttempts++;
			return attempt();
		});

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
		attemptThroughProbeGate: countedAttemptThroughProbeGate,
	});

	// 7. Handle no accounts case
	if (accounts.length === 0) {
		return resolveZeroAccountsOutcome({
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
			gateTokenEstimate,
			initialComboInfo,
			selectedAccounts,
			throttledAccounts,
			providerAvailableAccounts,
			providerOverloadedAccounts,
			bumpIdleTimeout,
			gates,
			holds,
			recordSyntheticErrorResponse,
			createProviderOverloadedResponse,
			logFinalOrderOnce,
			attemptThroughProbeGate: countedAttemptThroughProbeGate,
		});
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
					) !== null ||
					isFamilyWeeklyMemoExhausted(
						heldAccount,
						effectiveRequestModel,
						Date.now(),
					)
				) {
					// Held account's weekly quota for the REQUESTED family is exhausted
					// (with unified headroom) — the family window won't clear within the
					// hold budget, so fall through to normal failover (siblings) rather
					// than pinning this request to an account that will only 429 again.
					//
					// The memo is consulted alongside the usage-derived check, for the
					// same reason and on better evidence: this branch runs BEFORE the
					// candidate list is built, so the memo demotion has not applied yet,
					// and the memo exists precisely when the usage cache is lagging or
					// absent — exactly when the check above returns null and would let
					// the pin stand. Without it a burst marker, which stays active for
					// up to two minutes, re-pins every request to the account a 429 just
					// refused.
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
				const gatedFirst = await countedAttemptThroughProbeGate(
					heldAccount,
					() => {
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
					},
				);
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
			const gated = await countedAttemptThroughProbeGate(list[i], () => {
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
		fallbackAccounts = gates.applyFamilyMemoDemotion(
			gates.applyContextWindowGate(
				gates.applyFamilyWeeklyGate(filteredFallbackAccounts),
			),
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

	/**
	 * Write the give-up terminal into Request History, the way the synthetic 529s
	 * already are. Without this the request is a log line only: the client gets a
	 * 503 that history never shows.
	 *
	 * The response mirrors what `dispatchProxyRequest` builds from the thrown
	 * error, so the recorded row and the bytes the client receives agree.
	 *
	 * Collision guard: `recordSynthetic` bypasses the live-record map and the
	 * repository upserts by request id, so a request that already called
	 * `begin()` — an upstream responded, then a setup exception inside
	 * `forwardToClient` turned into failover — would have its terminal row
	 * overwritten by the late live completion, or emit two summaries. Skipping
	 * leaves exactly today's behaviour in that rare case.
	 */
	const recordGiveUpTerminal = async (
		label: string,
		message: string,
	): Promise<void> => {
		if (ctx.requestRecorder.hasRecord(requestMeta.id)) return;
		const terminalResponse = new Response(
			JSON.stringify({
				type: "error",
				error: { type: "service_unavailable_error", message },
			}),
			{ status: 503, headers: { "Content-Type": "application/json" } },
		);
		await recordSyntheticErrorResponse(terminalResponse, label, {
			failoverAttempts: upstreamAttempts,
		});
	};

	if (needsReauth.length > 0) {
		const accountNames = needsReauth.map((acc) => acc.name).join(", ");
		const message = `All accounts failed to proxy the request. OAuth tokens have expired for accounts: ${accountNames}.\n\nRe-authenticate these account(s) from the dashboard (Accounts tab).`;
		// Its own label: this terminal names the accounts and has an actionable
		// fix (re-authenticate), which is a different diagnosis from a pool that
		// simply exhausted — collapsing them would hide it in history. The label
		// itself stays account-independent so history's (error, account) grouping
		// doesn't fragment per account list.
		await recordGiveUpTerminal("oauth_tokens_expired", message);
		throw new ServiceUnavailableError(message, ctx.provider.name);
	}

	const exhaustedMessage = `${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${allAttemptedAccounts.length} attempted)`;
	await recordGiveUpTerminal("all_accounts_failed", exhaustedMessage);
	throw new ServiceUnavailableError(exhaustedMessage, ctx.provider.name);
}
