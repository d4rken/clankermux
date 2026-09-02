/**
 * The ZERO-ACCOUNTS TERMINAL: everything `handleProxy` does once every gate has
 * run and no candidate account survives.
 *
 * One ordered cascade of holds and terminals lives here — the pin-transient
 * hold and its strict-fail terminal, the local count_tokens synthesis, the
 * storm-degrade burst hold and its give-up 429, the context-window hold with
 * its last-resort relaxation and size 400, both family-weekly terminals (and
 * the cooled-sibling hold in front of them), the usage-throttled 529, the
 * provider-overload hold and its 529, and finally the pinned-target and
 * pool-exhausted terminals. Every path returns a Response; there is no
 * fall-through back to the caller.
 *
 * `accounts.length === 0` is a caller-enforced PRECONDITION, not something this
 * module re-checks: the gated candidate list is not even passed in.
 *
 * `requestMeta`, `gates` and `holds` are deliberately the LIVE per-request
 * objects, not snapshots — this code writes `requestMeta.pinFailure` (the
 * pin-hold save/restore triangle), and every hold's re-selection grows the
 * gates' exclusion accumulators, which the terminals below then read. The only
 * stateless claim being made is that THE MODULE holds no per-request state; the
 * request state it mutates belongs to its caller.
 */

import {
	codexAccountFitsRequestUnmargined,
	mapModelName,
	NETWORK,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { getFreshCapacity, usageCache } from "@clankermux/providers";
import type { Account, ComboSlotInfo, RequestMeta } from "@clankermux/types";
import type {
	AdmissionGates,
	ProviderOverloadedAccount,
} from "./admission-gates";
import {
	createBurstRetryGiveUpResponse,
	isBurstHoldEligible,
} from "./burst-retry-policy";
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
	isAnthropicBurstThrottleActive,
	isOAuthAnthropicAccount,
	type ProxyContext,
	proxyWithAccount,
	type RequestBodyContext,
	resolveFamilyWeeklyExclusion,
	resolveTransientlyCooledFamilySibling,
	type TransientlyCooledFamilySibling,
} from "./handlers";
// Direct leaf import (not via the `handlers` barrel) — see the module comment.
import { createClientAbortResponse } from "./handlers/client-abort-response";
import {
	getProviderOverloadUntil,
	resolveOverloadAttributionModel,
} from "./provider-overload-cooldown";
import {
	CW_HOLD_MAX_MS,
	CW_HOLD_MAX_MS_NO_CODEX_FALLBACK,
	FAMILY_WEEKLY_COOLDOWN_HOLD_MAX_MS,
	PIN_HOLD_MAX_MS,
	type RecoveryHolds,
} from "./recovery-holds";

// Same channel name as handleProxy's own logger: this module was carved out of
// it, and the log lines below must keep their historical prefix.
const log = new Logger("Proxy");

/**
 * Everything the zero-accounts cascade needs from the request that produced it.
 *
 * The three object deps are LIVE, not snapshots: `requestMeta` is mutated here
 * (`pinFailure`), and `gates` / `holds` accumulate state across every hold wake
 * that this cascade triggers.
 */
export interface ZeroAccountsOutcomeDeps {
	req: Request;
	url: URL;
	ctx: ProxyContext;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	requestMeta: RequestMeta;
	requestBodyContext: RequestBodyContext;
	finalBodyBuffer: ArrayBuffer | null;
	finalCreateBodyStream: () => ReadableStream<Uint8Array> | undefined;
	effectiveRequestModel: string | null;
	gateTokenEstimate: number;
	initialComboInfo: ComboSlotInfo | null;
	/** The strategy's pre-gate selection (empty when selection itself failed). */
	selectedAccounts: Account[];
	/** Accounts the usage-throttle gate parked. */
	throttledAccounts: Account[];
	/** Accounts that survived the provider-overload gate. */
	providerAvailableAccounts: Account[];
	/** Accounts the provider-overload gate parked, with their deadlines. */
	providerOverloadedAccounts: ProviderOverloadedAccount[];
	bumpIdleTimeout: () => void;
	/** The per-request admission gates, including their exclusion accumulators. */
	gates: AdmissionGates;
	/** The per-request recovery holds, including the burst give-up bookkeeping. */
	holds: RecoveryHolds;
	/** handleProxy's synthetic-terminal recorder (the Request-History write). */
	recordSyntheticErrorResponse: (
		response: Response,
		error: string,
	) => Promise<void>;
	/** handleProxy's synthetic provider-overloaded 529 (records itself). */
	createProviderOverloadedResponse: (
		overloaded: ProviderOverloadedAccount[],
		opts?: { failoverAttempts?: number },
	) => Promise<Response>;
	/**
	 * handleProxy's live count of real upstream attempts. Read at the moment a
	 * terminal fires, NOT captured at construction: the holds below make wake
	 * attempts through the counted probe gate, so a zero-accounts request can
	 * reach its terminal having genuinely tried upstream several times.
	 */
	getUpstreamAttempts: () => number;
	/**
	 * handleProxy's once-per-request post-gate routing log. Called from every
	 * admission point here, exactly as it is from the ones outside.
	 */
	logFinalOrderOnce: (actualAccountId: string) => void;
	/**
	 * handleProxy's single upstream-attempt chokepoint (the recovery-probe gate).
	 * INJECTED rather than imported: its other call sites stay in proxy.ts, and
	 * importing it back from there would be a module cycle.
	 */
	attemptThroughProbeGate: (
		account: Account,
		attempt: () => Promise<Response | null>,
	) => Promise<{ response: Response | null; suppressed: boolean }>;
}

/**
 * Resolve the terminal outcome for a request whose gated candidate list is
 * empty. PRECONDITION: the caller has established `accounts.length === 0`.
 */
export async function resolveZeroAccountsOutcome(
	deps: ZeroAccountsOutcomeDeps,
): Promise<Response> {
	const {
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
		getUpstreamAttempts,
		logFinalOrderOnce,
		attemptThroughProbeGate,
	} = deps;

	// The model whose overload bucket an attempt on THIS account would trip, and
	// therefore the bucket every overload deadline here must read. Mirrors
	// recovery-holds.ts: the request's logical model alone would consult the
	// wrong family for an account that maps it (e.g. sonnet -> opus), so a hold
	// would look eligible against a clear bucket while the attempt runs into an
	// open one.
	//
	// The combo override comes from the CURRENT combo info, not the frozen
	// `initialComboInfo`: the cooled-sibling detection below runs AFTER
	// holdForNonCodexRecovery, whose wake re-runs selection and can replace or
	// clear the combo state.
	const overloadAttributionModelFor = (account: Account): string | null => {
		const combo = requestMeta.comboName ? getComboSlotInfo(requestMeta) : null;
		const slot = combo?.slots.find((s) => s.accountId === account.id);
		const logical = slot?.modelOverride ?? effectiveRequestModel;
		return logical
			? resolveOverloadAttributionModel(mapModelName(logical, account), logical)
			: null;
	};

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
						overloadAttributionModelFor(a),
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
		// selection and returns the pin strict-fail terminal above before
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
		await recordSyntheticErrorResponse(giveUpResponse, "burst_retry_exhausted");
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
	// Family-weekly PACING is throttle evidence too, so it takes the same
	// precedence: an account held back by pacing is over its quota pace, not
	// unavailable for a reason a context-window hold could resolve.
	if (
		gates.contextExcludedAccounts.length > 0 &&
		throttledAccounts.length === 0 &&
		gates.familyWeeklyPacedAccounts.length === 0
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
			const held = await holds.holdForNonCodexRecovery(cwHoldBudget, "CW hold");
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
					requestMeta.excludeOfficialAnthropic === true,
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
		throttledAccounts.length === 0 &&
		gates.familyWeeklyPacedAccounts.length === 0
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
								overloadAttributionModelFor(a),
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

	// A paced account is throttled, just on a per-family weekly window rather
	// than an account-wide one: the answer is the same retryable 529, never the
	// family-exhausted 429 above (whose Retry-After is the multi-day window).
	if (
		throttledAccounts.length > 0 ||
		gates.familyWeeklyPacedAccounts.length > 0
	) {
		return createUsageThrottledResponse([
			...throttledAccounts,
			...gates.familyWeeklyPacedAccounts.map((paced) => paced.account),
		]);
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
			{ failoverAttempts: getUpstreamAttempts() },
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
