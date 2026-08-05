/**
 * The transparent burst-retry POLICY leaf: the two pure helpers the burst-retry
 * hold's callers need — its give-up response and its eligibility guard.
 *
 * Extracted from `proxy.ts` so both call sites can share them without a module
 * cycle: `handleProxy` itself (the decide-before-loop and the give-up terminal
 * at the end of the failover loop) and `zero-accounts-terminal.ts` (the
 * storm-degrade hold and its give-up terminal). A neutral leaf — it imports
 * nothing but the `Account` type.
 */

import type { Account } from "@clankermux/types";

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
export function createBurstRetryGiveUpResponse(heldAccount: Account): Response {
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
export function isBurstHoldEligible(
	decision: string | undefined,
	heldInGatedAccounts: boolean,
): boolean {
	return heldInGatedAccounts || decision === "affinity_hold";
}
