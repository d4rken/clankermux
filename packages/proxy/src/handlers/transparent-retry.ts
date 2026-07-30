import { REJECTING_STATUSES } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { isAnthropicHardLimitStatus } from "@clankermux/providers";
import {
	type Account,
	PROVIDER_NAMES,
	supportsUsageTracking,
} from "@clankermux/types";
import { getProviderOverloadUntil } from "../provider-overload-cooldown";
import {
	getActiveHoldCount,
	markAnthropicBurstThrottle,
	releaseHoldSlot,
	tryAcquireHoldSlot,
} from "./burst-cooldown";

const log = new Logger("TransparentRetry");

// ---------------------------------------------------------------------------
// Transparent burst-429 retry tuning constants.
//
// The feature is unconditionally on; these are fixed, source-level defaults
// (no env config — the proxy is deployed from source). The hold knobs live here
// because the hold orchestrator below owns them.
// ---------------------------------------------------------------------------

/**
 * Max added latency (ms) spent holding & re-probing the cache account before
 * giving up. A SINGLE always-on budget — we no longer shorten it when a
 * non-Anthropic provider could serve the request: Codex serves gpt-5.5, a full
 * model change from Opus (the same downgrade as Opus→Sonnet), so we hold Opus
 * rather than bail to Codex early. A declined/over-budget hold falls through to
 * the normal failover loop (healthy Anthropic siblings first), and only its
 * exhaustion reaches the Codex-if-fits last-resort.
 */
const BURST_RETRY_MAX_HOLD_MS = 120_000;
/** Max number of re-probes of the held account within the hold budget. */
const BURST_RETRY_MAX_ATTEMPTS = 3;
/** Jitter bound (ms) added to each re-probe wait (used with Math.random). */
const BURST_RETRY_JITTER_MS = 500;
/**
 * Poll interval (ms) while a re-probe is SUPPRESSED — another request holds the
 * account's single-flight recovery-probe lease. Short, because what we are
 * waiting for is that request's upstream call to finish (typically seconds);
 * the hold budget still bounds the total wait.
 */
const BURST_RETRY_SUPPRESSED_POLL_MS = 1_000;

/**
 * Max usage-cache age (ms) trusted when reading fresh headroom for the
 * transient-429 classification. Exported and consumed by the early-intercept
 * (proxy-operations.ts) and the marker-active revalidation (proxy.ts) — it's
 * classification-related, so it lives with the classifier rather than the hold
 * orchestrator. Defined once here to avoid duplicating the literal.
 */
export const BURST_RETRY_MAX_USAGE_AGE_MS = 120_000;

/**
 * Time (ms) reserved for the re-probe request itself when capping a
 * burst-classified cooldown. A deadline is only useful if the orchestrator can
 * wait it out AND still have budget left for the probe to come back: the hold
 * sleeps `cooldownWait + jitter`, then issues `reprobe()` against the remaining
 * budget. Reserving nothing makes the deadline "waitable" by the
 * `cooldownWait > remaining` comparison while leaving the probe itself to be cut
 * off — a hold that spends its whole budget sleeping and learns nothing.
 *
 * 30s is a judgement call, not a derived value — the codebase has no upstream
 * response-time SLA to reference. It is meant to cover an LLM upstream's
 * time-to-first-header comfortably.
 */
const BURST_RETRY_PROBE_RESPONSE_BUDGET_MS = 30_000;

/**
 * Hard ceiling (ms from now) on the cooldown a BURST-classified 429 may write.
 *
 * A rung that concluded "transient burst" must not be able to emit a long lock.
 * It can otherwise, because the classification and the deadline come from
 * different evidence: `classify429Transient` decides on the account's unified
 * 5h/7d headroom, while `extractCooldownUntil` copies whatever `retry-after` the
 * response carried. Those disagree whenever the window Anthropic actually
 * rejected on is one the unified headers don't express — a family-scoped weekly,
 * or the overage-included seven-day claim. On 2026-07-30 that combination
 * (headroom present, `retry-after: 333111`) cooled an account ACCOUNT-WIDE for
 * 92 hours on a request that should have failed over for one model family.
 *
 * The ceiling is derived from what the hold can actually complete, NOT from some
 * shorter "typical burst" value, because the property that matters is
 * usefulness: a deadline the orchestrator can sit through *and still probe
 * after* is honoured verbatim however it was derived, and only a deadline that
 * can't be is overridden. Budget minus jitter minus the probe reservation is
 * exactly that boundary. It keeps two behaviours intact — a genuine burst
 * carries no reset header at all (973 of 1145 measured 429s), so it still lands
 * on `extractCooldownUntil`'s shorter 60s fallback, and a real server hint that
 * fits (say `retry-after: 75`) is preserved rather than expired early into a
 * still-throttled window.
 *
 * A capped cooldown is self-correcting: if the account really is unable to
 * serve, the next attempt 429s again and lands on a rung with proper evidence.
 */
export const BURST_RETRY_COOLDOWN_CAP_MS =
	BURST_RETRY_MAX_HOLD_MS -
	BURST_RETRY_JITTER_MS -
	BURST_RETRY_PROBE_RESPONSE_BUDGET_MS;

/**
 * Classification of a 429 response for the transparent burst-retry feature.
 *
 * - `fresh_headroom`: the account still has known, fresh quota headroom, so the
 *   429 is the per-IP burst throttle rather than a real account limit. Eligible
 *   for the full hold-and-retry budget on the cache account.
 * - `stale_should_retry`: usage is stale/absent, but Anthropic signalled
 *   `x-should-retry: true` (and no hard-limit status). Eligible for a SINGLE
 *   short probe only — the orchestrator must NOT spend the full hold budget,
 *   because the account *might* actually be exhausted.
 * - `{ retryable: false }`: do not hold; fall through to normal failover.
 */
export type Burst429Classification =
	| { retryable: true; confidence: "fresh_headroom" }
	| { retryable: true; confidence: "stale_should_retry" }
	| { retryable: false; reason: string };

/**
 * A freshness-guarded capacity lookup. Returns the account's capacity signal
 * (only `minHeadroom` is consumed here) when fresh usage is available, or `null`
 * when usage is stale, absent, or content-stale (past a window roll).
 *
 * Injected — NOT a direct import of the `usageCache` singleton — so the
 * predicate stays pure/synchronous and unit-testable without module mocks,
 * mirroring the `extractCooldownUntil(getRateLimitedUntil)` injection pattern.
 *
 * Production wires this to:
 *
 *   (accountId) =>
 *     getFreshCapacity(
 *       usageCache,
 *       accountId,
 *       account.provider,
 *       now,
 *       BURST_RETRY_MAX_USAGE_AGE_MS,
 *     )
 *
 * `getFreshCapacity` already returns `null` for age-stale or content-stale
 * usage, so the caller need not re-check freshness.
 */
export type FreshCapacityLookup = (
	accountId: string,
) => { minHeadroom: number } | null;

/**
 * Returns `true` iff the account is an OAuth-Anthropic account — i.e. the
 * provider is `anthropic` (which, by design, is the OAuth flavour; the
 * pay-as-you-go API-key flavour is the separate `claude-console-api` provider),
 * the provider supports the OAuth usage-tracking endpoint, and the account
 * actually carries an OAuth refresh token.
 *
 * The refresh-token check guards the edge case of an `anthropic` account that
 * was created without OAuth (no usage cache to read headroom from).
 */
export function isOAuthAnthropicAccount(account: Account): boolean {
	return (
		account.provider === PROVIDER_NAMES.ANTHROPIC &&
		supportsUsageTracking(account.provider) &&
		typeof account.refresh_token === "string" &&
		account.refresh_token.length > 0
	);
}

/**
 * Classify a 429 response as a retryable transient (per-IP burst) throttle or a
 * non-retryable failure, for the transparent burst-retry feature.
 *
 * PURE and SYNCHRONOUS: it classifies only on what it is given. It does NOT
 * attempt a usage refresh (that is the orchestrator's job) and does NOT import
 * the usageCache singleton — the freshness-guarded capacity lookup is injected.
 *
 * Logic (per the plan's "Detection predicate" section):
 *  1. Not OAuth-Anthropic            → not retryable (`not_oauth_anthropic`).
 *  2. Hard-limit unified-status      → not retryable (`hard_limit_status`),
 *     even when `x-should-retry: true` is present.
 *  3. Fresh capacity, minHeadroom>0  → retryable, `fresh_headroom`.
 *  4. Stale/absent capacity (or zero headroom):
 *       - REJECTING unified-status   → not retryable
 *         (hard set plus `rejected`)   (`rejecting_status_no_headroom`).
 *       - `x-should-retry: true`     → retryable, `stale_should_retry`
 *                                       (single short probe only).
 *       - otherwise                  → not retryable
 *                                       (`no_headroom_no_retry_hint`).
 */
export function classify429Transient(args: {
	response: Response;
	account: Account;
	now: number;
	/**
	 * Freshness-guarded capacity lookup; returns `null` when usage is
	 * stale/absent. See {@link FreshCapacityLookup}.
	 */
	getCapacity: FreshCapacityLookup;
}): Burst429Classification {
	const { response, account, getCapacity } = args;

	// 1. Only OAuth-Anthropic accounts participate (console/API-key, non-Anthropic
	//    providers, and OAuth-less anthropic accounts are excluded).
	if (!isOAuthAnthropicAccount(account)) {
		return { retryable: false, reason: "not_oauth_anthropic" };
	}

	// 2. A hard, account-level unified-status means a real account limit, not a
	//    per-IP burst — never hold, even if the upstream set x-should-retry.
	if (isAnthropicHardLimitStatus(response)) {
		return { retryable: false, reason: "hard_limit_status" };
	}

	// 3. Fresh, positive headroom → the 429 is the per-IP burst throttle while the
	//    account still has quota. Strict `> 0`: a signal with minHeadroom === 0 is
	//    treated as no headroom and falls through to the stale/hint path below.
	const capacity = getCapacity(account.id);
	if (capacity !== null && capacity.minHeadroom > 0) {
		return { retryable: true, confidence: "fresh_headroom" };
	}

	// 4a. Usage stale/absent (or headroom 0) AND the provider says it is REFUSING
	//     the request (`REJECTING_STATUSES`, i.e. the hard set plus `rejected`):
	//     never rescue this on the `x-should-retry` hint. Anthropic sends
	//     `rejected` together with `x-should-retry: true` on an account whose
	//     window is spent, so without this we hold and re-probe an account that
	//     is spent right now — a bounded in-request hold cannot outlast that.
	//     (An EARLY provider reset is possible, but it is observed by the usage
	//     poller's capacity-restored path, not by holding.) Deliberately narrow: it does
	//     NOT touch step 3, so a `rejected` 429 with fresh positive headroom is
	//     still treated as the per-IP burst throttle that burst-retry exists for.
	const statusHeader = response.headers.get(
		"anthropic-ratelimit-unified-status",
	);
	if (statusHeader !== null && REJECTING_STATUSES.has(statusHeader)) {
		return { retryable: false, reason: "rejecting_status_no_headroom" };
	}

	// 4b. Otherwise trust a `x-should-retry: true` hint for a single short probe
	//     only; failing that, do not hold.
	if (response.headers.get("x-should-retry") === "true") {
		return { retryable: true, confidence: "stale_should_retry" };
	}

	return { retryable: false, reason: "no_headroom_no_retry_hint" };
}

// ---------------------------------------------------------------------------
// holdAndRetryCacheAccount — the hold-and-re-probe orchestration.
//
// Invoked by proxy.ts once the cache account's first attempt classified as a
// retryable transient burst 429. It waits out the account's cooldown (never
// waking early), re-probes it (gently, jittered, abortable, concurrency-capped),
// and returns the first real Response. The cache stays warm — no sibling is
// touched. On give-up it returns `null`; on concurrency-cap overflow it returns
// the {@link HOLD_OVERFLOW} sentinel so the caller does a filtered last-resort
// (Codex-if-fits / synthetic 429) rather than sibling failover.
// ---------------------------------------------------------------------------

/**
 * Distinct sentinel returned when no hold slot could be acquired (concurrency
 * cap reached). The caller treats this as "do the filtered last-resort", NOT as
 * a give-up and NOT as sibling failover.
 */
export const HOLD_OVERFLOW = Symbol("burst-retry-hold-overflow");

/** Result of {@link holdAndRetryCacheAccount}. */
export type HoldResult = Response | null | typeof HOLD_OVERFLOW;

/**
 * Outcome of one re-probe of the held account.
 *
 * `suppressed` is deliberately NOT collapsed into `throttled`: it means the
 * re-probe never happened, because another request holds the account's
 * single-flight recovery-probe lease. Treating it as a failed probe would
 * consume one of the (three) attempts — and for `stale_should_retry`, whose
 * budget is a SINGLE probe, the very first suppression would end the hold — so
 * the request would fail over while the real probe was still in flight.
 */
export type ReprobeOutcome =
	| { kind: "response"; response: Response }
	| { kind: "throttled" }
	| { kind: "suppressed" };

/**
 * A closure that re-probes the held account once via the reprobe path
 * (`proxyWithAccount` in reprobe mode). See {@link ReprobeOutcome}: a real
 * Response, "still throttled" (429 / failed over), or "not attempted at all".
 */
export type ReprobeFn = (
	account: Account,
	signal: AbortSignal,
) => Promise<ReprobeOutcome>;

/**
 * Sleep for `ms`, resolving early (with `false`) if the signal aborts. Resolves
 * `true` when the full duration elapsed. Never rejects — the caller checks
 * `signal.aborted` to decide what to do. A non-positive `ms` resolves on the
 * next microtask after an abort check.
 */
export function abortableSleep(
	ms: number,
	signal: AbortSignal,
): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve(true);
			},
			Math.max(0, ms),
		);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Hold the cache (affinity) account through its transient burst-throttle
 * cooldown and re-probe it, returning the first successful Response.
 *
 * Behaviour:
 *  - Acquires a module-level hold slot; if the cap is reached, returns
 *    {@link HOLD_OVERFLOW} immediately (caller does filtered last-resort).
 *  - Sets the shared burst marker so concurrent OAuth-Anthropic-affinity
 *    requests are held on their own cache account (sibling diversion suppressed
 *    pool-wide) for the marker lifetime.
 *  - Loops up to `BURST_RETRY_MAX_ATTEMPTS` re-probes within a single always-on
 *    `BURST_RETRY_MAX_HOLD_MS` total wall-clock budget. We do NOT bail early to a
 *    non-Anthropic fallback: Codex serves gpt-5.5, a full model change from Opus
 *    (the same downgrade as Opus→Sonnet), so we hold Opus and let a
 *    declined/over-budget hold fall through to the caller's normal failover loop
 *    (healthy Anthropic siblings first). For `stale_should_retry` confidence
 *    (usage unknown — the account *might* really be exhausted) it does exactly
 *    ONE probe rather than spending the full budget.
 *  - Each wait = (account.rate_limited_until ?? now) - now + jitter. NEVER wakes
 *    early: if the soonest expiry is beyond the remaining budget, it gives up
 *    now (returns null).
 *  - The sleep and each probe are abortable via `signal`; a client disconnect
 *    returns promptly so the hold slot is released without waiting on upstream.
 *  - Always releases the hold slot in `finally`.
 *
 * @returns a real Response on success, `null` on give-up (budget/attempts
 *   exhausted, still throttled, or aborted), or {@link HOLD_OVERFLOW} when no
 *   slot was available.
 */
export async function holdAndRetryCacheAccount(args: {
	account: Account;
	confidence: "fresh_headroom" | "stale_should_retry";
	signal: AbortSignal;
	reprobe: ReprobeFn;
	/**
	 * The request's model, for family-scoped provider-overload precedence: an
	 * overload breaker that opens for this model's family (or provider-wide)
	 * while the hold is waiting means the upstream is sick — re-probing would
	 * only feed more 529s into it, so the hold gives up instead. Null/absent
	 * checks the provider's conservative aggregate (every open bucket).
	 */
	model?: string | null;
	/** Injectable clock for tests; defaults to Date.now. */
	now?: () => number;
	/**
	 * Injectable tuning overrides for tests; each defaults to the module-level
	 * constant. Production never passes these — the feature uses the fixed
	 * source-level defaults. They exist purely as a deterministic-timing seam for
	 * unit tests (same rationale as the injectable `now` clock above).
	 */
	maxHoldMs?: number;
	maxAttempts?: number;
	jitterMs?: number;
	suppressedPollMs?: number;
}): Promise<HoldResult> {
	const { account, confidence, signal, reprobe } = args;
	const clock = args.now ?? Date.now;
	// Budget: the test-override (maxHoldMs) wins; otherwise the single always-on
	// full budget. We no longer shorten it when a non-Anthropic fallback exists —
	// a declined hold falls through to the caller's normal failover loop.
	const maxHoldMs = args.maxHoldMs ?? BURST_RETRY_MAX_HOLD_MS;
	const configuredMaxAttempts = args.maxAttempts ?? BURST_RETRY_MAX_ATTEMPTS;
	const jitterMs = args.jitterMs ?? BURST_RETRY_JITTER_MS;
	const suppressedPollMs =
		args.suppressedPollMs ?? BURST_RETRY_SUPPRESSED_POLL_MS;

	if (!tryAcquireHoldSlot()) {
		log.warn(
			`Burst-retry hold cap reached (${getActiveHoldCount()} active) — overflow for account ${account.name}; deferring to filtered last-resort`,
		);
		return HOLD_OVERFLOW;
	}

	// Activate the shared marker so concurrent affinity requests hold their own
	// cache accounts (sibling diversion suppressed) while this window plays out.
	markAnthropicBurstThrottle(clock());

	const start = clock();
	const budgetMs = maxHoldMs;
	// stale_should_retry: a single short probe only (Codex: don't spend the full
	// budget on a possibly-real exhaustion).
	const maxAttempts =
		confidence === "stale_should_retry" ? 1 : configuredMaxAttempts;
	let attempt = 0;
	let heldMs = 0;

	try {
		while (attempt < maxAttempts) {
			if (signal.aborted) {
				log.info(
					`Burst-retry hold aborted for ${account.name} after ${heldMs}ms (${attempt}/${maxAttempts} attempts)`,
				);
				return null;
			}

			// Provider-overload precedence (defense in depth — the caller already
			// skips the hold when the breaker was open at entry): a breaker that
			// opened for this request's family (or provider-wide) mid-hold means
			// the upstream itself is sick, so a re-probe can only feed the
			// incident. Give up like any other failed precondition; the caller's
			// give-up path (normal failover + its overload gate) takes over.
			const overloadedUntil = getProviderOverloadUntil(
				account.provider,
				clock(),
				args.model ?? null,
			);
			if (overloadedUntil !== null) {
				log.warn(
					`Burst-retry giving up on ${account.name}: provider-overload breaker open until ${new Date(overloadedUntil).toISOString()} — not re-probing a sick upstream`,
				);
				return null;
			}

			const now = clock();
			const remaining = budgetMs - (now - start);
			if (remaining <= 0) break;

			// Wait the FULL remaining cooldown before probing (gentle / per-IP-aware),
			// plus bounded jitter. Never wake early.
			const cooldownWait = Math.max(
				0,
				(account.rate_limited_until ?? now) - now,
			);
			const jitter = Math.random() * jitterMs;
			let wait = cooldownWait + jitter;
			// Don't-wake-early: if the soonest expiry is beyond the remaining budget,
			// give up now rather than probe before the window could have cleared.
			if (cooldownWait > remaining) {
				log.info(
					`Burst-retry giving up on ${account.name}: soonest expiry (${Math.round(cooldownWait)}ms) exceeds remaining budget (${Math.round(remaining)}ms) after ${heldMs}ms held`,
				);
				return null;
			}
			// Clamp the jittered wait to the remaining budget so a probe always
			// happens within the budget once we've decided to wait.
			if (wait > remaining) wait = remaining;

			if (wait > 0) {
				const completed = await abortableSleep(wait, signal);
				heldMs = clock() - start;
				if (!completed || signal.aborted) {
					log.info(
						`Burst-retry hold aborted during wait for ${account.name} after ${heldMs}ms`,
					);
					return null;
				}
			}

			// Counted only once the probe actually HAPPENS — a suppressed re-probe
			// below leaves the counter untouched (see ReprobeOutcome).
			const attemptNumber = attempt + 1;
			log.info(
				`Burst-retry: re-probing ${account.name}, attempt ${attemptNumber}/${maxAttempts} (held ${heldMs}ms, confidence=${confidence})`,
			);

			// Bound the probe by the remaining hold budget. makeProxyRequest now
			// always composes in its own (30-minute) internal timeout, which is far
			// longer than the hold budget — so an upstream that accepts the
			// connection and then never responds, with the client still connected,
			// would otherwise block `await reprobe` well past MAX_HOLD_MS and pin the
			// semaphore slot. Compose a budget-deadline AbortController with the
			// caller signal so the probe aborts on EITHER a client disconnect OR the
			// remaining budget elapsing.
			const probeRemaining = Math.max(0, budgetMs - (clock() - start));
			const budgetController = new AbortController();
			const budgetTimer = setTimeout(
				() => budgetController.abort(),
				probeRemaining,
			);
			const probeSignal = signal.aborted
				? signal
				: AbortSignal.any([signal, budgetController.signal]);
			let outcome: ReprobeOutcome;
			try {
				outcome = await reprobe(account, probeSignal);
			} finally {
				clearTimeout(budgetTimer);
			}
			heldMs = clock() - start;

			if (outcome.kind === "suppressed") {
				// NOT an attempt: another request holds the account's single-flight
				// recovery-probe lease, so nothing was sent upstream and we learned
				// nothing about the account. Do not consume an attempt (a
				// stale_should_retry hold has exactly one, and would otherwise end
				// here) — short-poll instead so this hold wakes promptly once that
				// probe's verdict lands, still bounded by the hold budget.
				const pollRemaining = budgetMs - (clock() - start);
				const pollWait = suppressedPollMs + Math.random() * jitterMs;
				if (pollWait > pollRemaining) {
					log.info(
						`Burst-retry giving up on ${account.name}: recovery probe still suppressed and the remaining budget (${Math.round(pollRemaining)}ms) is under one poll interval`,
					);
					return null;
				}
				log.debug(
					`Burst-retry: re-probe of ${account.name} suppressed (another request holds the recovery-probe lease) — polling in ${Math.round(pollWait)}ms, attempt not consumed`,
				);
				const completed = await abortableSleep(pollWait, signal);
				heldMs = clock() - start;
				if (!completed || signal.aborted) {
					log.info(
						`Burst-retry hold aborted while suppressed for ${account.name} after ${heldMs}ms`,
					);
					return null;
				}
				continue;
			}

			attempt = attemptNumber;
			if (outcome.kind === "response") {
				log.info(
					`Burst-retry succeeded on ${account.name} after ${heldMs}ms held, ${attempt} attempt(s)`,
				);
				return outcome.response;
			}

			// Still throttled — loop to wait out the refreshed cooldown within the
			// full budget (subject to the never-wake-early guard and the
			// stale_should_retry single-probe cap). On give-up the caller falls
			// through to its normal failover loop (healthy Anthropic siblings first).
		}

		log.info(
			`Burst-retry gave up on ${account.name} after ${heldMs}ms held, ${attempt}/${maxAttempts} attempts (still throttled)`,
		);
		return null;
	} finally {
		releaseHoldSlot();
	}
}
