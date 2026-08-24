/**
 * The per-request RECOVERY-HOLD family: every path in `handleProxy` that parks a
 * live client connection and re-attempts, rather than bouncing a terminal error
 * back to the client.
 *
 * Three holds live here, plus the machinery they share:
 *  - {@link RecoveryHolds.holdForOverloadRecovery} — every candidate is
 *    overload-gated, or every attempt was suppressed behind an in-flight
 *    half-open probe;
 *  - {@link RecoveryHolds.holdForNonCodexRecovery} — the shared wait+retry hold
 *    behind the context-window, family-weekly and API-key-pin terminals;
 *  - {@link RecoveryHolds.runBurstHold} — the transparent burst-retry hold on
 *    the cache-affinity account (OAuth-Anthropic).
 *
 * Built ONCE per request (like `admission-gates.ts`) because the burst hold
 * accumulates give-up bookkeeping that the failover loop and the give-up
 * terminal read back afterwards, and because the suppressed-attempt sink must
 * span every pass a single request makes.
 */

import { mapModelName, NETWORK } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Account, RequestMeta } from "@clankermux/types";
import type {
	AdmissionGates,
	ProviderOverloadedAccount,
} from "./admission-gates";
import { cacheBodyStore } from "./cache-body-store";
import {
	abortableSleep,
	getComboSlotInfo,
	HOLD_OVERFLOW,
	holdAndRetryCacheAccount,
	isTrustedSyntheticProbe,
	type ProxyAttemptOutcome,
	type ProxyContext,
	proxyWithAccount,
	type ReprobeOutcome,
	type RequestBodyContext,
	selectAccountsForRequest,
} from "./handlers";
// Direct leaf import (not via the `handlers` barrel) — see the module comment.
import { createClientAbortResponse } from "./handlers/client-abort-response";
import {
	getOverloadHoldBudgetMs,
	releaseOverloadHoldSlot,
	tryAcquireOverloadHoldSlot,
} from "./overload-hold";
import {
	getOverloadBucketGeneration,
	getOverloadHoldSlotKey,
	getProviderOverloadKey,
	getProviderOverloadUntil,
	inspectProviderOverload,
	resolveOverloadAttributionModel,
} from "./provider-overload-cooldown";

// Same channel name as handleProxy's own logger: this module was carved out of
// it, and the log lines below must keep their historical prefix.
const log = new Logger("Proxy");

// Max time (ms) the proxy will hold an open connection waiting for a
// rate-limited large-context (non-Codex) account to become available before
// falling back to a 400 context_window_exceeded. Matches BURST_RETRY_MAX_HOLD_MS
// (120s) — both are bounds on how long we hold a live client connection.
export const CW_HOLD_MAX_MS = 120_000;
// Extended CW-hold budget used when NO Codex account can serve the request even
// against its full (unmargined) window — i.e. the only backends that can hold
// the request are the rate-limited large-context (Anthropic) accounts, so a 400
// is the only alternative to waiting. 330s covers one full 300s 429 backoff
// ceiling cooldown plus a re-probe, and stays under the Anthropic SDK's ~600s
// client request timeout. When Codex *can* fall back, the shorter
// CW_HOLD_MAX_MS (120s) is used and behavior is unchanged.
export const CW_HOLD_MAX_MS_NO_CODEX_FALLBACK = 330_000;
// Small jitter (ms) added to each CW hold sleep to avoid thundering herd.
const CW_HOLD_JITTER_MS = 500;
// Max time (ms) to hold a live client connection for a family-weekly request when
// the ONLY reason the pool emptied is that a family-capable sibling is on a short
// transient cooldown (per-account 429 or provider 529 overload). Kept modest
// (120s, matching CW_HOLD_MAX_MS — NOT the 330s no-Codex variant) because the
// trigger is an upstream overload storm where many family requests pile into the
// hold at once; a client disconnect releases it promptly via abortableSleep.
export const FAMILY_WEEKLY_COOLDOWN_HOLD_MAX_MS = 120_000;
// Max time (ms) to hold a live client connection for an API-key→account/class
// PINNED request when the pin strict-failed selection ONLY because every
// pin-allowed account is on a short transient cooldown (per-account 429 or a
// provider-wide 529 overload) that will clear within budget. Re-selection during
// the hold re-enforces the pin, so a disallowed account is never served; a long
// 5h/7d wall (recovery beyond budget) is not held and still fast-fails. 120s
// matches CW_HOLD_MAX_MS / BURST_RETRY_MAX_HOLD_MS.
export const PIN_HOLD_MAX_MS = 120_000;
// Retry-After horizon for the suppressed-only overload terminal: every
// remaining candidate was skipped because a half-open bucket's probe is already
// in flight, so recovery (or a re-trip) is expected within seconds — not a
// full cooldown window. Used when the admission refusal carried no deadline.
const OVERLOAD_PROBE_SUPPRESSED_RETRY_AFTER_MS = 5_000;
// The overload-hold budget and the per-bucket holder cap both live in
// overload-hold.ts; the hold reads the budget via getOverloadHoldBudgetMs(),
// which is path-aware — 330s normally, and the shorter no-re-arm budget for
// connections whose Bun idle timer we cannot refresh. Unlike the other holds
// here it is deliberately NOT pinned to the shared 120s value: the others
// wait out a per-account cooldown, this one waits out a provider incident
// that can re-trip several times before it settles.
// Short-poll interval (ms) while a half-open probe is in flight: holders must
// not sleep past a probe completion, so they re-check (and re-attempt — the
// admission chokepoint keeps all but one suppressed) on this cadence rather
// than waiting out a cooldown deadline that no longer exists.
const OVERLOAD_HOLD_PROBE_POLL_MS = 1_500;

/**
 * Whether an attempt outcome is an ORDINARY failure — one with no overload
 * verdict to wait on, so a hold must stop re-attempting that account.
 *
 * The two exclusions are the whole point. `overload_suppressed` has a probe in
 * flight; `overload_529` IS the condition a hold exists to wait out, and
 * treating it as ordinary would make the hold refuse to retry the very account
 * whose recovery it is waiting for.
 *
 * Shared so the hold's own per-round classification and the pre-hold seeding
 * cannot drift apart — they did, and the seeding folded `overload_529` in.
 */
export function isOrdinaryAttemptFailure(
	outcome: ProxyAttemptOutcome,
): boolean {
	return (
		outcome.kind !== "overload_suppressed" && outcome.kind !== "overload_529"
	);
}

/**
 * Whether an ordinary failure may be held against the ACCOUNT for the rest of
 * the request, rather than only against the attempt that produced it.
 *
 * The exclusion set is keyed by account id alone, so anything whose cause is
 * narrower than the account must stay out of it:
 *
 * - `model_not_found` is a fact about the MODEL the attempt sent. A combo slot
 *   can fail entitlement on model A, the combo-fallback pass then clears the
 *   override and waits on model B's breaker; excluding by id would refuse the
 *   account after B recovers, for a reason that never applied to B.
 * - `other` is the catch-all, and family-weekly exhaustion is emitted through
 *   it — deliberately WITHOUT an account-wide cooldown (see the fail() call in
 *   proxy-operations.ts). Same shape of bug, one family instead of one model.
 *
 * Erring toward NOT excluding is the safe direction: the cost is a redundant
 * retry on wake, whereas a wrong exclusion can refuse the only account able to
 * serve the request.
 */
export function isAccountWideFailure(outcome: ProxyAttemptOutcome): boolean {
	return (
		isOrdinaryAttemptFailure(outcome) &&
		outcome.kind !== "model_not_found" &&
		outcome.kind !== "other"
	);
}

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

/**
 * Everything the recovery holds need from the request that produced them.
 * Captured ONCE at construction; `requestMeta` and `gates` are the LIVE objects
 * (a hold wake re-runs selection through them and re-reads the mutated routing
 * metadata), never snapshots.
 */
export interface RecoveryHoldsDeps {
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
	gates: AdmissionGates;
	bumpIdleTimeout: () => void;
	/**
	 * Whether {@link bumpIdleTimeout} can actually reach the client's socket.
	 * False on the translated Codex `/v1/responses` path (see request-ingress).
	 * The overload hold reads this to pick a budget it can actually honor —
	 * holding an un-re-armable connection past Bun's 180s base idleTimeout
	 * would have US close it mid-hold. Defaults true for callers that predate
	 * the flag (tests); production always passes it.
	 */
	canRearmIdleTimeout?: boolean;
	/**
	 * Deterministic-timing seam for the burst-retry hold, forwarded verbatim to
	 * `holdAndRetryCacheAccount`. Production never passes it.
	 */
	burstHoldTimingOverride?: {
		maxHoldMs?: number;
		now?: () => number;
		jitterMs?: number;
	};
	/**
	 * Deterministic-timing seam for the non-Codex recovery hold — the sibling of
	 * `burstHoldTimingOverride`, and like it, production never passes it.
	 * `holdForNonCodexRecovery` reads EVERY clock through it (budget elapsed,
	 * cooldown deadlines, jitter) and sleeps through `sleep`, which defaults to
	 * `abortableSleep` and keeps its contract (resolves false when the signal
	 * aborts). A test can therefore hand in a fake clock whose `sleep` advances
	 * `now` synchronously and drive the hold with no wall-clock wait at all,
	 * instead of racing an absolute cooldown window against a preempted worker.
	 *
	 * No `maxHoldMs` counterpart: this hold takes its budget as a call parameter.
	 */
	nonCodexHoldTimingOverride?: {
		now?: () => number;
		jitterMs?: number;
		sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
	};
	/**
	 * handleProxy's once-per-request post-gate routing log. Called from every
	 * admission point inside a hold, exactly as it is from the ones outside.
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

/** The per-request recovery holds, plus the state they accumulate. */
export interface RecoveryHolds {
	/**
	 * Returns the served (or client-abort) Response, or null when the caller must
	 * fall through to the synthetic 529.
	 */
	holdForOverloadRecovery(
		gated: readonly ProviderOverloadedAccount[],
	): Promise<Response | null>;
	/**
	 * Returns the upstream Response on success, a client-abort Response, or null
	 * when the budget was exhausted with nothing served. The CALLER arms/clears
	 * the idle-timeout re-arm interval around this.
	 */
	holdForNonCodexRecovery(
		budgetMs: number,
		label: string,
		opts?: { eligible?: (a: Account) => boolean; clearPinFailure?: boolean },
	): Promise<Response | null>;
	runBurstHold(
		heldAccount: Account,
		confidence: "fresh_headroom" | "stale_should_retry",
	): Promise<BurstHoldOutcome>;
	refreshOverloadUntils(
		gated: readonly ProviderOverloadedAccount[],
	): ProviderOverloadedAccount[];
	noteOverloadSuppression(account: Account, outcome: ProxyAttemptOutcome): void;
	/**
	 * Record a candidate the attempt loop's LATE overload gate skipped — the
	 * breaker tripped after selection, while this request was already walking
	 * its list.
	 *
	 * Separate entry point from {@link noteOverloadSuppression} because that one
	 * reads a ProxyAttemptOutcome, and these candidates were never attempted at
	 * all: they are refused before `proxyWithAccount` is reached, so no outcome
	 * exists to inspect. Both feed the same list, because both mean the same
	 * thing to the terminal — this request was blocked by an overload.
	 */
	noteOverloadGateSkip(
		account: Account,
		until: number,
		gatedModel: string | null,
	): void;
	/**
	 * Record that `accountId` failed for an ORDINARY reason outside any hold.
	 *
	 * The attempt loop owns this: by the time a hold is entered, the candidates
	 * that already failed are invisible to it, and re-attempting them on wake
	 * lets the hold be satisfied by the same failure it was waiting past.
	 */
	noteOrdinaryFailure(accountId: string): void;
	/**
	 * Record that the caller ATTEMPTED the held account outside a hold (the
	 * affinity-first preflight). The one bookkeeping write the holds do not own
	 * themselves, so the double-attempt guard has a single home either way.
	 */
	noteBurstAttempt(accountId: string): void;
	readonly overloadSuppressedAttempts: ReadonlyArray<ProviderOverloadedAccount>;
	readonly burstAttemptedAccountId: string | null;
	readonly burstHoldDeclined: boolean;
	readonly burstHeldAccountForGiveUp: Account | null;
	readonly burstHeldId: string | null;
}

/** Build the recovery holds for ONE request. */
export function createRecoveryHolds(deps: RecoveryHoldsDeps): RecoveryHolds {
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
		gates,
		bumpIdleTimeout,
		canRearmIdleTimeout = true,
		burstHoldTimingOverride,
		nonCodexHoldTimingOverride,
		logFinalOrderOnce,
		attemptThroughProbeGate,
	} = deps;

	// Resolved once: the non-Codex hold's clock, jitter width and sleep. Production
	// passes no override, so these ARE Date.now / CW_HOLD_JITTER_MS / abortableSleep.
	const nonCodexNow = nonCodexHoldTimingOverride?.now ?? Date.now;
	const nonCodexJitterMs =
		nonCodexHoldTimingOverride?.jitterMs ?? CW_HOLD_JITTER_MS;
	const nonCodexSleep = nonCodexHoldTimingOverride?.sleep ?? abortableSleep;

	// Transparent burst-retry hold state + orchestration (OAuth-Anthropic). It is
	// per-request factory state because BOTH burst-hold call sites — the
	// zero-accounts storm-degrade hold (Finding 1), which runs inside the
	// no-accounts terminal, and the normal decide-before-loop, which runs after
	// account selection — reuse the SAME orchestration, so it exists exactly once.
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
	// Candidates an OVERLOAD stopped from reaching upstream, from either of two
	// routes: refused by half-open probe admission (another request is probing,
	// or an open bucket won a race against the gate), or dropped by the attempt
	// loop's late gate when the breaker tripped mid-walk. When the loops exhaust
	// with at least one recorded, the terminal must be the provider-overloaded
	// 529 — the request was blocked by an overload and can wait for recovery —
	// NOT the generic ALL_ACCOUNTS_FAILED / pool_exhausted error.
	//
	// Retry-After is NOT taken from the `until` recorded here: the terminal runs
	// `refreshOverloadUntils` over this list to re-read each bucket's CURRENT
	// deadline, so a re-trip during the hold is reflected instead of a stale
	// pre-hold value.
	const overloadSuppressedAttempts: ProviderOverloadedAccount[] = [];
	const noteOverloadSuppression = (
		account: Account,
		outcome: ProxyAttemptOutcome,
	): void => {
		if (outcome.kind === "overload_suppressed") {
			overloadSuppressedAttempts.push({
				account,
				until:
					outcome.until ??
					Date.now() + OVERLOAD_PROBE_SUPPRESSED_RETRY_AFTER_MS,
			});
		}
	};
	// The late-gate counterpart, for candidates dropped when the breaker tripped
	// while this request was already walking its list.
	//
	// `until` is the deadline the gate had already resolved to decide the skip.
	// It is a snapshot for the record, NOT what drives behaviour: the hold
	// re-inspects the live buckets, and the terminal runs `refreshOverloadUntils`
	// to re-read them, so both follow the CURRENT deadline rather than this one.
	// Accounts that failed ORDINARILY outside any hold — in the attempt loop
	// before a hold was entered. Seeds `ordinaryFailedIds` so a hold does not
	// re-attempt, and be served by, the very account whose failure led to it.
	const preHoldOrdinaryFailures = new Set<string>();
	const noteOrdinaryFailure = (accountId: string): void => {
		preHoldOrdinaryFailures.add(accountId);
	};

	const noteOverloadGateSkip = (
		account: Account,
		until: number,
		gatedModel: string | null,
	): void => {
		overloadSuppressedAttempts.push({ account, until, gatedModel });
	};
	// The cache-affinity-pinned account id recorded by the routing strategy (set
	// on affinity_hit, affinity_hold, and the zero-siblings storm-degrade hold).
	// The burst-hold only ever serves an OAuth-Anthropic account, so for a
	// Codex-CLI (excludeOfficialAnthropic) request it MUST be disabled — otherwise
	// the hold could serve a Claude account that selection deliberately excluded.
	const burstHeldId = requestMeta.excludeOfficialAnthropic
		? null
		: (requestMeta.routing?.heldAccountId ?? null);

	// The affinity-first preflight attempts the held account OUTSIDE any hold, so
	// its double-attempt bookkeeping cannot be written by the hold itself. This is
	// the one external writer; every other write happens on the give-up path.
	const noteBurstAttempt = (accountId: string): void => {
		burstAttemptedAccountId = accountId;
	};

	// Transparent overload hold. When EVERY candidate is overload-gated (the
	// zero-available terminal), or every remaining candidate was stopped by an
	// overload inside the loop — probe-suppressed or late-gated (the
	// overload-blocked terminal) — a
	// synthetic 529 bounced to the client forces a client-side retry loop for a
	// condition that typically clears in seconds. Instead, hold the live
	// connection and serve the request when the family recovers — bounded by
	// the OVERLOAD_HOLD_MAX_MS budget (overload-hold.ts) and capped per
	// overload bucket; overflow, a recovery beyond budget, and budget expiry
	// all fall back to the existing synthetic 529. The budget bounds the whole
	// hold, wake attempts included: an in-flight wake fetch is aborted at the
	// remaining budget (mirroring the burst-retry probe) so a hung upstream
	// can't pin the connection + hold slot for the 30-minute request timeout.
	// These terminals only fire when NO cross-provider candidate exists, so
	// the hold can never steal a request that would have failed over.

	// Unique (provider, effective model) pairs behind an overload terminal —
	// the breaker buckets the hold waits on.
	const overloadHoldPairs = (
		gated: readonly ProviderOverloadedAccount[],
	): Array<{ provider: string; model: string | null }> => {
		const pairs = new Map<string, { provider: string; model: string | null }>();
		for (const entry of gated) {
			const { account } = entry;
			// The model the GATE decided on, when it resolved one. Re-deriving via
			// modelForAccount would pick a different bucket for an account with
			// per-account model mapping, so the hold would wait on (or find closed)
			// a bucket that had nothing to do with the skip.
			const model =
				entry.gatedModel !== undefined
					? entry.gatedModel
					: gates.modelForAccount(account);
			pairs.set(
				`${getProviderOverloadKey(account.provider)}\u0000${model ?? ""}`,
				{
					provider: account.provider,
					model,
				},
			);
		}
		return [...pairs.values()];
	};

	// Re-read the gated accounts' block deadlines for the terminal 529 so its
	// Retry-After reflects a re-trip that happened while holding, not the stale
	// pre-hold snapshot. A bucket that went half-open/closed mid-hold reads as
	// the short probe horizon.
	const refreshOverloadUntils = (
		gated: readonly ProviderOverloadedAccount[],
	): ProviderOverloadedAccount[] => {
		const now = Date.now();
		return gated.map((entry) => ({
			...entry,
			until:
				getProviderOverloadUntil(
					entry.account.provider,
					now,
					entry.gatedModel !== undefined
						? entry.gatedModel
						: gates.modelForAccount(entry.account),
				) ?? now + OVERLOAD_PROBE_SUPPRESSED_RETRY_AFTER_MS,
		}));
	};

	// Current combo slot override for an account, resolved by ACCOUNT ID at
	// attempt time (not selection time): a hold wake re-runs selection, which
	// re-populates the combo slot info, and a combo fallback clears comboName —
	// so the override must be read fresh per attempt or a recovered combo slot
	// would be served with the wrong (non-overridden) model.
	const currentComboOverrideForAccount = (account: Account): string | null => {
		const combo = requestMeta.comboName ? getComboSlotInfo(requestMeta) : null;
		const slot = combo?.slots.find((s) => s.accountId === account.id);
		return slot?.modelOverride ?? null;
	};

	// Result of one re-attempt round over re-selected hold candidates.
	// `sawOverloadSuppression` / `sawRetrip` are derived from the per-attempt
	// outcome sink (the same mechanism the failover loops use for
	// `overload_suppressed`) so the overload hold can tell overload-related
	// failures (keep polling — a probe verdict is what it waits on) from
	// ordinary failures (auth / network / 429 / model — break out rather than
	// hammering a broken candidate on every 1.5s poll). `budgetAborted` marks
	// a caller-supplied signal that fired for a NON-client reason (the hold
	// budget deadline) — it must fall through to the synthetic 529, never be
	// mislabeled as a client abort.
	type AttemptRound = {
		response: Response | null;
		sawOverloadSuppression: boolean;
		sawRetrip: boolean;
		/**
		 * Candidates skipped by the single-flight recovery-probe gate: NOTHING was
		 * attempted against them because another request is probing them right now.
		 * Like `sawOverloadSuppression`, this is an AVAILABILITY condition with a
		 * verdict already in flight — never a failure of the candidate — so the
		 * hold loops keep waiting for it within their budget instead of treating
		 * the round as "everything failed for ordinary reasons".
		 *
		 * Account IDs rather than a flag: a round can MIX a suppressed candidate
		 * with one that failed ordinarily, and the loops must be able to re-attempt
		 * exactly the former while leaving the latter alone.
		 */
		probeSuppressedAccountIds: Set<string>;
		/**
		 * Candidates that WERE attempted and failed for an ordinary reason (auth /
		 * network / 429 / model). Nothing is in flight for them, so a short poll
		 * that re-attempts them is pure hammering — worse than wasted work for a
		 * 429, which it can deepen. Replaces the old write-only `ordinaryFailures`
		 * counter, whose information the hold loops could not act on.
		 */
		ordinaryFailedAccountIds: Set<string>;
		budgetAborted: boolean;
	};

	// Shared re-attempt loop for the hold paths (holdForOverloadRecovery and
	// holdForNonCodexRecovery): try each re-selected candidate in order and
	// return the first served Response in `response`, or a fully-classified
	// round when every candidate failed (the caller's hold loop decides
	// whether to keep waiting). Terminal forwarding is always suppressed — a
	// hold must never surface a wake attempt's rate-limit/terminal response.
	// When `options.signal` is given it is threaded into the attempt and
	// checked between candidates; a CLIENT abort returns the client-abort
	// Response, while a budget-only abort sets `budgetAborted`.
	const attemptCandidates = async (
		candidates: Account[],
		options?: { signal: AbortSignal },
	): Promise<AttemptRound> => {
		const round: AttemptRound = {
			response: null,
			sawOverloadSuppression: false,
			sawRetrip: false,
			probeSuppressedAccountIds: new Set<string>(),
			ordinaryFailedAccountIds: new Set<string>(),
			budgetAborted: false,
		};
		for (let i = 0; i < candidates.length; i++) {
			const candidate = candidates[i];
			// Pre-attempt overload read. The authoritative admission lives inside
			// proxyWithAccount, but by the time it refuses, the attempt has already
			// staged a ~0.5–1.5MB copy of the body, validated (and possibly
			// refreshed, over the network + a DB write) the token, and transformed +
			// re-parsed the body. Inside a hold that happens on every ~1.5s poll for
			// every candidate, so read the bucket first and skip on a verdict that
			// is already decided.
			//
			// Inspected FRESH per candidate, deliberately: no sticky per-sweep set
			// and no getOverloadHoldSlotKey dedup. That key collapses families under
			// a live provider-wide bucket, so it would suppress a family that is
			// already probeable, and a sticky verdict would go stale exactly when a
			// probe completes mid-sweep. After an earlier candidate re-trips the
			// shared bucket, the next inspection reads `open` on its own.
			//
			// The model is resolved EXACTLY as the attempt below resolves it: the
			// CURRENT combo slot override (see currentComboOverrideForAccount —
			// re-read per attempt, because a hold wake re-runs selection and can
			// change a slot's override) falling back to the request's logical model,
			// then run through the shared canonical overload attribution (account
			// mapping, with the logical-model fallback) that the authoritative
			// admission re-derives from the transformed body.
			//
			// Deliberately NOT gates.modelForAccount: that reads the combo snapshot
			// frozen at gate construction (admission-gates.ts), so after a wake
			// changed the slot's override it would inspect one family while the
			// attempt sends another — suppressing a healthy account on every ~1.5s
			// round for the whole hold budget. Using the request's logical model
			// alone would be wrong the other way: it would sideline an account whose
			// mapped model belongs to a different, healthy family.
			const attemptLogicalModel =
				currentComboOverrideForAccount(candidate) ?? effectiveRequestModel;
			const overload = inspectProviderOverload(
				candidate.provider,
				attemptLogicalModel
					? resolveOverloadAttributionModel(
							mapModelName(attemptLogicalModel, candidate),
							attemptLogicalModel,
						)
					: null,
			);
			if (overload.state === "open" || overload.probeActive) {
				// Same bookkeeping as a recovery-probe suppression: NOTHING was
				// attempted and a verdict is pending, so the hold loops keep waiting
				// for exactly this candidate rather than counting it as a failure.
				round.probeSuppressedAccountIds.add(candidate.id);
				log.debug(
					`Overload-suppressed candidate ${candidate.name} skipped before the attempt (${overload.state}${overload.probeActive ? ", probe active" : ""})`,
				);
				continue;
			}
			// Same single-flight probe gate as every other upstream attempt: a hold
			// wake must not stampede a freshly-recovered account either.
			const gated = await attemptThroughProbeGate(candidate, () => {
				logFinalOrderOnce(candidate.id);
				return proxyWithAccount(
					req,
					url,
					candidate,
					requestMeta,
					finalBodyBuffer,
					finalCreateBodyStream,
					i,
					ctx,
					// HIGH: a recovered combo slot must be served with ITS model, not
					// the request's — resolve the current slot override by account id.
					currentComboOverrideForAccount(candidate),
					apiKeyId,
					apiKeyName,
					requestBodyContext,
					false,
					{
						...(options?.signal ? { signal: options.signal } : {}),
						// Log-level only: inside a hold an admission refusal is the
						// expected steady state, and the hold logs its own exit summary.
						fromHold: true,
						onOutcome: (o) => {
							if (o.kind === "overload_suppressed") {
								round.sawOverloadSuppression = true;
							} else if (o.kind === "overload_529") {
								round.sawRetrip = true;
							} else if (isOrdinaryAttemptFailure(o)) {
								// Attributed to the candidate, so a later poll can skip
								// exactly this account rather than the whole round.
								round.ordinaryFailedAccountIds.add(candidate.id);
							}
						},
					},
				);
			});
			// Suppressed: another request is probing this candidate and NOTHING was
			// attempted. Record the ACCOUNT — it is neither a failure nor a served
			// round; the hold loops wait for this candidate's in-flight verdict and
			// re-attempt exactly it.
			if (gated.suppressed) {
				round.probeSuppressedAccountIds.add(candidate.id);
				continue;
			}
			const r = gated.response;
			if (r) {
				round.response = r;
				return round;
			}
			// Client abort wins over budget abort: a disconnect must surface as
			// the 499 marker, never as the synthetic 529 (and vice versa).
			if (req.signal.aborted) {
				round.response = createClientAbortResponse();
				return round;
			}
			if (options?.signal?.aborted) {
				round.budgetAborted = true;
				return round;
			}
		}
		return round;
	};

	// Returns the served (or client-abort) Response, or null when the caller
	// must fall through to the synthetic 529 (hold not entered, holder-cap
	// overflow, recovery beyond budget, or budget expiry).
	const holdForOverloadRecovery = async (
		gated: readonly ProviderOverloadedAccount[],
	): Promise<Response | null> => {
		if (gated.length === 0) return null;
		// Synthetic scheduler traffic and advisory probes need a fast verdict,
		// not a held connection: internal requests, auto-refresh probes,
		// keepalive replays, and count_tokens (answered locally/quickly — same
		// rationale as the pin hold's count_tokens skip).
		//
		// The probe-marker arm is trust-gated: the markers are client-settable, so
		// on their own they would let any external caller opt out of the overload
		// hold and get a synthetic 529 instead of a recovered response. Gating them
		// makes them a strict SUBSET of the `requestMeta.internal` arm below — kept
		// explicit so the intent survives, and ordered first so the compiler does
		// not narrow `requestMeta.internal` out from under it.
		if (
			isTrustedSyntheticProbe(
				req.headers,
				requestMeta.internal === true,
				"any",
			) ||
			requestMeta.internal ||
			url.pathname === "/v1/messages/count_tokens"
		) {
			return null;
		}
		if (req.signal.aborted) return createClientAbortResponse();

		const pairs = overloadHoldPairs(gated);
		// A connection whose Bun idle timer we cannot refresh is capped by the
		// flat 180s base idleTimeout no matter how long we would like to wait, so
		// it gets the shorter no-re-arm budget. The capability comes from ingress
		// (derived from the adapter's unspoofable per-request context) rather
		// than from `excludeOfficialAnthropic`: that flag is ROUTING policy read
		// from a client-visible header, so it is both forgeable and not
		// equivalent — a future synthetic dispatch could be un-re-armable without
		// carrying it.
		const holdBudgetMs = getOverloadHoldBudgetMs(canRearmIdleTimeout);
		const entryNow = Date.now();
		// Hold only when recovery can land within budget: a half-open bucket's
		// probe may report a verdict any moment; an open bucket must expire
		// within the hold budget. A cooldown wholly beyond budget keeps the
		// immediate 529 + Retry-After.
		const holdable = pairs
			.map(({ provider, model }) =>
				inspectProviderOverload(provider, model, entryNow),
			)
			.some(
				(s) =>
					s.state !== "open" ||
					(s.until !== null && s.until - entryNow <= holdBudgetMs),
			);
		if (!holdable) return null;

		// Acquire a hold slot for EVERY unique slot key among the gated pairs,
		// all-or-nothing: when a live provider-wide bucket coexists with
		// lingering family entries the pairs can map to different slot keys, and
		// counting the holder against only the first pair's key would let the
		// other keys' caps be exceeded invisibly. Any refusal releases what was
		// already acquired and overflows to the immediate synthetic 529.
		const slotKeys: string[] = [];
		for (const { provider, model } of pairs) {
			const key = getOverloadHoldSlotKey(provider, model);
			if (!slotKeys.includes(key)) slotKeys.push(key);
		}
		const acquiredSlotKeys: string[] = [];
		for (const key of slotKeys) {
			if (!tryAcquireOverloadHoldSlot(key)) {
				for (const held of acquiredSlotKeys) {
					releaseOverloadHoldSlot(held);
				}
				const refusedGen = getOverloadBucketGeneration(key);
				log.warn(
					`Overload hold ${requestMeta.id} overflow for ${
						refusedGen === null ? key : `${key}@g${refusedGen}`
					} — returning the immediate synthetic 529`,
				);
				return null;
			}
			acquiredSlotKeys.push(key);
		}
		// Naming the request AND the bucket generation is what makes a
		// multi-family storm readable: with up to
		// OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET holders per bucket and several
		// buckets live at once, the entry/exit lines otherwise interleave with
		// nothing to group them by.
		//
		// Formatted ONCE, at acquisition, and reused verbatim on exit. Looking
		// the generation up again at exit would report whatever trip is current
		// THEN — during a storm that is routinely a later one — so the entry and
		// exit lines for the same hold would disagree and defeat the pairing.
		const labelledSlotKeys = slotKeys
			.map((k) => {
				const gen = getOverloadBucketGeneration(k);
				return gen === null ? k : `${k}@g${gen}`;
			})
			.join(", ");
		log.info(
			`Overload hold ${requestMeta.id} entered for ${labelledSlotKeys} (budget ${holdBudgetMs}ms)`,
		);
		// Re-arm the connection's idle timer while we hold (the base 180s
		// timeout would otherwise reap a silently-held connection).
		bumpIdleTimeout();
		const holdRearm = setInterval(
			bumpIdleTimeout,
			NETWORK.IDLE_REARM_INTERVAL_MS,
		);
		const holdStart = Date.now();
		// Accounts that failed for an ordinary reason (auth / network / 429 /
		// model). Nothing is in flight for them, so re-attempting them on every
		// ~1.5s poll is exactly the hammering this loop's classification exists to
		// prevent — and for a 429 it can deepen a real rate limit. They stay
		// excluded for the rest of the hold; the hold itself still ends (below)
		// when a round has no verdict to wait on.
		//
		// SEEDED from failures that happened BEFORE the hold. A request reaching
		// the late overload gate has, by definition, already failed candidates in
		// the attempt loop — that is how it got mid-walk — so starting empty means
		// the first wake re-attempts the account that just failed, and can be
		// served by it while the account the hold was actually waiting for is
		// never tried. Left empty, the hold silently becomes a retry of the
		// failure rather than a wait for the overload.
		const ordinaryFailedIds = new Set<string>(preHoldOrdinaryFailures);
		// Hold-exit summary counters. ONE INFO line per hold, at exit — not per
		// round: at a ~1.5s poll and up to OVERLOAD_HOLD_MAX_CONCURRENT_PER_BUCKET
		// holders per bucket, a per-round line would be noisier than the
		// per-attempt refusals it replaces.
		let rounds = 0;
		let suppressedAttempts = 0;
		// Exit accounting. Round counts alone cannot distinguish "waited out
		// repeated breaker cooldowns" from "queued behind ONE in-flight probe",
		// and the 2026-08-24 incident was initially misread that way: holds
		// ending at the ceiling with 30+ suppressed rounds looked like a breaker
		// that would not settle, when the breaker had recovered and the holders
		// were waiting on another request's generation. Splitting the elapsed
		// time into open-bucket sleep vs probe-wait makes that visible directly,
		// and the exit reason removes the need to infer anything from duration.
		let exitReason = "budget_exhausted";
		let openSleepMs = 0;
		// NOT "time behind an overload probe": the short poll below is also
		// charged after a re-trip, after an admission race, and behind a
		// per-ACCOUNT single-flight recovery probe. Calling it probe-wait would
		// reproduce, in the telemetry, the exact confusion this accounting was
		// added to remove.
		let verdictPollMs = 0;
		try {
			while (true) {
				const nowMs = Date.now();
				const elapsed = nowMs - holdStart;
				if (elapsed >= holdBudgetMs) break;
				const remaining = holdBudgetMs - elapsed;

				const statuses = pairs.map(({ provider, model }) =>
					inspectProviderOverload(provider, model, nowMs),
				);
				const attemptable = statuses.some((s) => s.state !== "open");
				if (!attemptable) {
					// Every relevant bucket is open — sleep to the soonest deadline.
					const untils = statuses
						.map((s) => s.until)
						.filter((u): u is number => u !== null);
					const soonest = Math.min(...untils);
					const waitMs =
						Math.max(0, soonest - nowMs) +
						Math.floor(Math.random() * CW_HOLD_JITTER_MS);
					if (waitMs > remaining) {
						// The next cooldown does not fit in what is left — starting a
						// sleep we cannot finish would just burn the connection.
						exitReason = "cooldown_beyond_budget";
						break;
					}
					// Measured around the sleep, not assumed from `waitMs`: an abort
					// after 100s of waiting must still report 100s, or the split is
					// useless for exactly the incidents it exists to explain.
					const sleepStart = Date.now();
					const slept = await abortableSleep(waitMs, req.signal);
					openSleepMs += Date.now() - sleepStart;
					if (!slept) {
						exitReason = "client_abort";
						return createClientAbortResponse();
					}
					continue;
				}

				// A relevant bucket is half-open (admission decides — one holder
				// becomes the probe, the rest stay suppressed) or closed
				// (recovered): re-run full selection + gates and attempt. Clear a
				// residual pin strict-fail marker first so a pinned re-selection
				// doesn't short-circuit on it (mirrors the pin hold); the pin is
				// re-enforced by selection, so a disallowed account is never served.
				requestMeta.pinFailure = null;
				const reSelected = await selectAccountsForRequest(
					requestMeta,
					ctx,
					effectiveRequestModel ?? undefined,
				);
				const { available: reAvailable } =
					gates.applyProviderOverloadGate(reSelected);
				const { available: rePostThrottle } =
					gates.applyUsageThrottling(reAvailable);
				// Wake-time gates honor the CURRENT combo info (re-selection just
				// re-populated it; a cleared combo reads null) so a combo slot's
				// model override is gated exactly like the initial pipeline.
				const wakeComboInfo = requestMeta.comboName
					? getComboSlotInfo(requestMeta)
					: null;
				const candidates = gates.applyFamilyMemoDemotion(
					gates.applySoftDemotionReorder(
						gates.applyContextWindowGate(
							gates.applyFamilyWeeklyGate(rePostThrottle, wakeComboInfo),
							wakeComboInfo,
						),
						wakeComboInfo,
					),
					wakeComboInfo,
				);
				if (requestMeta.routing) {
					// The wake re-selection replaces the candidate list, so the post-gate
					// first attempt moves with it (see the initial pipeline).
					requestMeta.routing.primaryAttemptAccountId =
						candidates[0]?.id ?? null;
				}
				// Drop candidates a previous round already proved broken for THIS
				// request (see `ordinaryFailedIds`). `candidates` itself is kept intact
				// below: the "pool is empty" branch asks whether the GATES left
				// anything, which is a different question from "is anything left worth
				// attempting".
				const attemptableCandidates = candidates.filter(
					(a) => !ordinaryFailedIds.has(a.id),
				);
				if (attemptableCandidates.length < candidates.length) {
					log.debug(
						`Overload hold: skipping ${candidates.length - attemptableCandidates.length} candidate(s) that already failed for an ordinary reason this hold`,
					);
				}
				// Bound the wake attempt by the REMAINING hold budget (mirrors the
				// burst-retry probe in transparent-retry.ts): makeProxyRequest's
				// internal timeout is 30 minutes, so a wake near the budget's edge
				// against a hung upstream would otherwise pin the connection + the
				// hold slot(s) far past the budget and expiry would never reach the
				// synthetic-529 fallback. Composed with the client signal so EITHER
				// a disconnect OR the budget elapsing aborts the in-flight attempt;
				// attemptCandidates tells the two apart (client → 499 marker,
				// budget → fall through to the synthetic 529).
				const attemptRemaining = holdBudgetMs - (Date.now() - holdStart);
				if (attemptRemaining <= 0) break;
				const budgetController = new AbortController();
				const budgetTimer = setTimeout(
					() => budgetController.abort(),
					attemptRemaining,
				);
				const wakeSignal = req.signal.aborted
					? req.signal
					: AbortSignal.any([req.signal, budgetController.signal]);
				let round: AttemptRound;
				rounds++;
				try {
					round = await attemptCandidates(attemptableCandidates, {
						signal: wakeSignal,
					});
					suppressedAttempts += round.probeSuppressedAccountIds.size;
				} finally {
					// Disarm the budget timer on every path; the composed signal's
					// listeners are released with the per-wake controller itself.
					clearTimeout(budgetTimer);
				}
				for (const id of round.ordinaryFailedAccountIds) {
					ordinaryFailedIds.add(id);
				}
				if (round.response) {
					// `attemptCandidates` returns the 499 marker when the client hangs
					// up mid-attempt, so a returned Response is NOT proof of a serve —
					// test the signal first or every abort is miscounted as success.
					//
					// And a returned Response is not proof of SUCCESS either: it is
					// whatever the wake attempt produced, 2xx or not. Report the status
					// rather than claiming "served"; the request-history transport
					// outcome stays authoritative for how it actually ended.
					exitReason = req.signal.aborted
						? "client_abort"
						: `response_returned(status=${round.response.status})`;
					return round.response;
				}
				if (req.signal.aborted) {
					exitReason = "client_abort";
					return createClientAbortResponse();
				}
				if (round.budgetAborted) {
					// An attempt ran past the budget deadline and was aborted.
					exitReason = "attempt_budget_abort";
					break; // budget expiry → synthetic 529
				}
				if (candidates.length === 0) {
					if (statuses.every((s) => s.state === "closed")) {
						// The breaker recovered but the pool is empty for a non-overload
						// reason — nothing left for THIS hold to wait on.
						exitReason = "pool_empty_after_recovery";
						break;
					}
					// No candidates while a bucket is still open/half-open (the gate
					// re-excluded them) — keep polling for the probe verdict.
				} else if (
					!round.sawOverloadSuppression &&
					!round.sawRetrip &&
					round.probeSuppressedAccountIds.size === 0
				) {
					// Nothing this round has a verdict in flight: every candidate either
					// failed ORDINARILY (auth / network / 429 / model-not-found) or was
					// already excluded as broken. There is nothing to wait for, and
					// re-attempting on the short probe poll would hammer a broken
					// candidate dozens of times over the budget. Break out to the
					// normal terminal / synthetic path.
					//
					// A recovery-probe suppression is explicitly NOT that: a probe IS
					// in flight for a candidate that may serve us, so we keep polling
					// within budget rather than returning a synthetic 529 immediately —
					// while the ordinary-failure exclusion above keeps that polling off
					// the siblings that already failed.
					exitReason = "no_verdict_pending";
					break;
				}
				// Suppressed behind the in-flight overload probe or the single-flight
				// per-account recovery probe, or re-tripped mid-attempt: short-poll
				// so a verdict wakes us promptly (holders must not sleep past a probe
				// completion). All three causes are charged to verdictPollMs, which
				// is why it is NOT named after the overload probe alone. Recompute the remaining budget —
				// the wake attempt above may have consumed a meaningful slice of it.
				const pollMs =
					OVERLOAD_HOLD_PROBE_POLL_MS +
					Math.floor(Math.random() * CW_HOLD_JITTER_MS);
				const postAttemptRemaining = holdBudgetMs - (Date.now() - holdStart);
				if (pollMs > postAttemptRemaining) {
					exitReason = "verdict_poll_beyond_budget";
					break;
				}
				const pollStart = Date.now();
				const polled = await abortableSleep(pollMs, req.signal);
				verdictPollMs += Date.now() - pollStart;
				if (!polled) {
					exitReason = "client_abort";
					return createClientAbortResponse();
				}
			}
			return null;
		} finally {
			// The one INFO line the hold emits on the way out — the per-attempt
			// admission refusals it replaces are DEBUG inside a hold.
			log.info(
				`Overload hold ${requestMeta.id} exited for ${labelledSlotKeys} after ${Date.now() - holdStart}ms ` +
					`(${exitReason}, budget ${holdBudgetMs}ms): ` +
					`${rounds} round(s), ${suppressedAttempts} suppressed attempt(s), ` +
					`${openSleepMs}ms sleeping on an open breaker, ` +
					`${verdictPollMs}ms polling for a recovery verdict`,
			);
			clearInterval(holdRearm);
			for (const held of acquiredSlotKeys) {
				releaseOverloadHoldSlot(held);
			}
		}
	};

	// Shared wait+retry hold used by BOTH the context-window terminal and the
	// family-weekly terminal below. While non-Codex sibling accounts are on a
	// transient cooldown — a per-account 429 (`rate_limited_until`) OR a
	// provider-wide 529 overload (`getProviderOverloadUntil`, e.g. the shared
	// `anthropic-upstream` cooldown) — sleep until the soonest recovery (the MAX
	// of the two deadlines, since an account is serveable only once BOTH clear),
	// bounded by `budgetMs`, then re-run full account selection with the same
	// gates and retry any now-available non-Codex candidate. Waiting on the 429
	// signal alone missed the 529-overload case entirely (all Anthropic accounts
	// share one overload cooldown, with `rate_limited_until` null).
	//
	// Returns the upstream Response on success, a client-abort Response if the
	// client disconnects mid-wait, or null when the budget/soonest-expiry is
	// exhausted with nothing served (the caller then runs its own fall-through
	// terminal). The CALLER arms/clears the idle-timeout re-arm interval around
	// this — the base 180s timeout would otherwise reap a connection held
	// silently while we wait.
	// `opts.eligible` narrows BOTH the wait-set and the re-probe candidates to a
	// caller-supplied predicate (the pin's allow-list); it defaults to "any
	// non-Codex account" (the original CW / family-weekly behavior).
	// `opts.clearPinFailure` clears the residual pin strict-fail marker before
	// each re-selection so selectCandidates doesn't short-circuit on it (pin hold
	// only).
	const holdForNonCodexRecovery = async (
		budgetMs: number,
		label: string,
		opts?: { eligible?: (a: Account) => boolean; clearPinFailure?: boolean },
	): Promise<Response | null> => {
		const isEligible = (a: Account): boolean =>
			opts?.eligible ? opts.eligible(a) : a.provider !== "codex";
		const holdStart = nonCodexNow();
		// The candidates the PREVIOUS round skipped via the single-flight
		// recovery-probe gate. Such a candidate has no cooldown deadline to wait
		// on (that is exactly why it was selectable), so without this the loop
		// would see "nothing to wait for" and exit while the probe was still in
		// flight — handing the caller its terminal (a size 400, a family 429 or a
		// pin 503) although a candidate was about to become usable.
		//
		// Account IDs, not a flag: a round can mix a suppressed candidate with a
		// sibling that failed for an ordinary reason, and a probe-verdict poll
		// must re-attempt ONLY the former. Retrying the failed sibling every
		// ~1.5s for the rest of the budget (up to 330s here) is the hammering
		// this loop's classification exists to prevent. Deliberately NOT sticky:
		// refreshed from each round, so an ordinary failure restores the original
		// exit behaviour on the next pass.
		let probeSuppressedIds = new Set<string>();
		while (true) {
			const nowMs = nonCodexNow();
			const elapsed = nowMs - holdStart;
			if (elapsed >= budgetMs) break;
			const remaining = budgetMs - elapsed;

			const allAccs = await ctx.dbOps.getAllAccounts();
			const unavailable = allAccs
				.filter((a) => !a.paused && isEligible(a))
				.map((a) => {
					const rl =
						a.rate_limited_until && a.rate_limited_until > nowMs
							? a.rate_limited_until
							: 0;
					// Family-scoped read: only wait out buckets relevant to THIS
					// request's model — an unrelated family's breaker must not
					// extend (or create) the wait.
					const ov =
						getProviderOverloadUntil(
							a.provider,
							nowMs,
							effectiveRequestModel ?? null,
						) ?? 0;
					return { account: a, availableAt: Math.max(rl, ov) };
				})
				.filter((x) => x.availableAt > nowMs);

			let waitMs: number;
			// True when this pass exists ONLY to wait for an in-flight recovery
			// probe (no cooldown deadline drove it). Such a pass must re-attempt
			// exactly the suppressed candidates — see `probeSuppressedIds`.
			const pollingForProbeVerdict = unavailable.length === 0;
			if (pollingForProbeVerdict) {
				// Nothing is cooling down. Normally that means there is nothing to
				// wait for — unless the last round was recovery-probe suppressed, in
				// which case an upstream probe IS in flight for a candidate that may
				// serve this request; short-poll for its verdict instead.
				if (probeSuppressedIds.size === 0) break;
				waitMs =
					OVERLOAD_HOLD_PROBE_POLL_MS +
					Math.floor(Math.random() * nonCodexJitterMs);
				log.info(
					`${label}: waiting ${waitMs}ms for an in-flight recovery probe`,
				);
			} else {
				const soonest = Math.min(...unavailable.map((x) => x.availableAt));
				waitMs =
					Math.max(0, soonest - nowMs) +
					Math.floor(Math.random() * nonCodexJitterMs);
				log.info(
					`${label}: waiting ${waitMs}ms for account(s): ${unavailable.map((x) => x.account.name).join(", ")}`,
				);
			}

			if (waitMs > remaining) break; // soonest expiry is beyond budget

			const completed = await nonCodexSleep(waitMs, req.signal);
			if (!completed) {
				log.info(`${label}: client disconnected during wait`);
				return createClientAbortResponse();
			}

			// Re-run full account selection with the same gates. For a pin hold,
			// clear the residual strict-fail marker first — otherwise
			// selectCandidates short-circuits on it and never re-selects.
			if (opts?.clearPinFailure) {
				requestMeta.pinFailure = null;
			}
			const reSelected = await selectAccountsForRequest(
				requestMeta,
				ctx,
				effectiveRequestModel ?? undefined,
			);
			const { available: reAvailable } =
				gates.applyProviderOverloadGate(reSelected);
			const { available: rePostThrottle } =
				gates.applyUsageThrottling(reAvailable);
			// Eligible accounts always pass the context-window gate; still apply
			// the family-weekly gate so we don't retry an account whose requested
			// family is weekly-exhausted (it would only 429 again). The gate
			// honors the CURRENT combo info (re-selection re-populates it) so a
			// combo slot's model override is evaluated, not the request model.
			// (soft-demotion reorder — family reservation AND pool liveness —
			// intentionally omitted on the failover/fallback tail: already-degraded
			// path. For pool liveness this is largely self-enforcing anyway: rule 4
			// requires an absorbable peer, and on a degraded path there is none, so
			// the reserve fails open regardless.)
			const candidates = gates.applyFamilyMemoDemotion(
				gates.applyFamilyWeeklyGate(
					rePostThrottle.filter((a) => isEligible(a)),
					requestMeta.comboName ? getComboSlotInfo(requestMeta) : null,
				),
				requestMeta.comboName ? getComboSlotInfo(requestMeta) : null,
			);

			// A probe-verdict poll re-attempts ONLY the candidates that were
			// suppressed — the whole reason this pass exists. A sibling that
			// already failed for an ordinary reason has no verdict pending, so
			// re-attempting it every poll would just hammer it (and deepen a real
			// 429). A cooldown-driven pass is unchanged: it re-attempts every
			// candidate, because waiting out a refreshed cooldown and re-probing
			// is exactly this hold's job.
			const attemptList = pollingForProbeVerdict
				? candidates.filter((a) => probeSuppressedIds.has(a.id))
				: candidates;

			if (attemptList.length === 0) {
				// Nothing was attempted this pass: either the gates left no
				// candidate, or the suppressed one is no longer selectable (it
				// picked up a cooldown, which the next pass will wait out).
				probeSuppressedIds = new Set();
				continue;
			}

			log.info(
				`${label}: ${attemptList.length} account(s) now available, retrying`,
			);

			// This hold deliberately ignores the round's overload/ordinary
			// classification — its loop-back semantics predate the overload hold
			// and are unchanged (it waits on account cooldowns, not probe
			// verdicts). The ONE exception is recovery-probe suppression, which
			// means a candidate was not attempted at all: carry those accounts to
			// the next pass so the "nothing to wait for" exit above waits for the
			// probe's verdict instead of giving up on a candidate that may serve
			// us — and so that pass targets exactly them.
			const round = await attemptCandidates(attemptList);
			if (round.response) return round.response;
			probeSuppressedIds = round.probeSuppressedAccountIds;
			// All candidates returned null — loop back to recheck.
		}
		return null;
	};

	// Shared reprobe closure: re-attempt the given (held) account in reprobe mode
	// (cooldown gate bypassed, no re-staging, no streak escalation) with a supplied
	// AbortSignal so a client disconnect releases the hold promptly.
	// `holdAndRetryCacheAccount` always invokes this with the held account, so the
	// closure is generic over the account it is handed. Shared by the normal
	// decide-before-loop and the zero-accounts storm-degrade hold (Finding 1) so
	// both re-probe identically.
	//
	// Routed through the single-flight probe gate like every other upstream
	// attempt: a re-probe IS an upstream request, so concurrent holds must not all
	// probe a freshly-recovered account. Suppression is reported AS SUCH (never
	// collapsed into "still throttled"): nothing was sent upstream, so the hold
	// must not spend one of its attempts on it — it short-polls instead.
	const reprobe = async (
		probeAccount: Account,
		signal: AbortSignal,
	): Promise<ReprobeOutcome> => {
		const gated = await attemptThroughProbeGate(probeAccount, () => {
			logFinalOrderOnce(probeAccount.id);
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
				// `fromHold`: log-level only — this re-probe runs inside the burst
				// hold, which reports its own outcome (see runBurstHold).
				{ reprobe: true, signal, fromHold: true },
			);
		});
		if (gated.suppressed) return { kind: "suppressed" };
		return gated.response
			? { kind: "response", response: gated.response }
			: { kind: "throttled" };
	};

	// Run the hold on `heldAccount` and apply the shared give-up machinery
	// (staged-body discard, double-attempt guard, give-up bookkeeping). Reused by
	// BOTH the normal decide-before-loop (siblings present) and the zero-accounts
	// storm-degrade path (Finding 1) so the orchestration is defined once.
	const runBurstHold = async (
		heldAccount: Account,
		confidence: "fresh_headroom" | "stale_should_retry",
	): Promise<BurstHoldOutcome> => {
		// Provider-overload precedence: an open family/provider breaker means the
		// upstream itself is sick — holding and re-probing the held account would
		// only feed more requests into the incident. Skip the hold entirely (no
		// give-up bookkeeping — nothing was attempted) and fall through to normal
		// failover, whose overload gate/terminal handles it.
		const heldOverloadedUntil = getProviderOverloadUntil(
			heldAccount.provider,
			Date.now(),
			effectiveRequestModel ?? null,
		);
		if (heldOverloadedUntil !== null) {
			log.warn(
				`Burst-retry hold skipped for ${heldAccount.name}: provider-overload breaker open until ${new Date(heldOverloadedUntil).toISOString()} — deferring to normal failover`,
			);
			return { kind: "gave-up" };
		}

		const holdResult = await holdAndRetryCacheAccount({
			account: heldAccount,
			confidence,
			signal: req.signal,
			reprobe,
			// Family-scoped overload precedence inside the hold's reprobe loop
			// (defense in depth for a breaker that opens mid-hold).
			model: effectiveRequestModel ?? null,
			// Deterministic-timing overrides (maxHoldMs/now/jitterMs). Undefined in
			// production — the hold falls back to its fixed source-level defaults.
			...(burstHoldTimingOverride ?? {}),
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

	return {
		holdForOverloadRecovery,
		holdForNonCodexRecovery,
		runBurstHold,
		refreshOverloadUntils,
		noteOverloadSuppression,
		noteOverloadGateSkip,
		noteOrdinaryFailure,
		noteBurstAttempt,
		get overloadSuppressedAttempts() {
			return overloadSuppressedAttempts;
		},
		get burstAttemptedAccountId() {
			return burstAttemptedAccountId;
		},
		get burstHoldDeclined() {
			return burstHoldDeclined;
		},
		get burstHeldAccountForGiveUp() {
			return burstHeldAccountForGiveUp;
		},
		burstHeldId,
	};
}
