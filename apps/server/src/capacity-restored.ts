import type { DatabaseOperations } from "@clankermux/database";
import type { CapacityRestoredEvidence } from "@clankermux/providers";

/** Minimal logger surface the capacity-restored handler needs. */
export interface CapacityRestoredLogger {
	debug: (msg: string) => void;
	info: (msg: string) => void;
}

/**
 * Handle the usage-poller's capacity-restored signal: polling observed that NO
 * account-wide window is spent any more (representative utilization < 100), so
 * an account still sitting on a cooldown can be released early — a seat
 * reassignment or an early provider reset — instead of waiting out a deadline
 * that can be days away.
 *
 * LEVEL-TRIGGERED. The poller reports this on every successful poll while the
 * account reads healthy; this handler decides whether that evidence may clear
 * the lock. That is what makes a refused or missed clear self-healing: the next
 * poll simply reports again. It does NOT heal an INCORRECT clear — nothing
 * un-clears a lock — which is why the guards below are strict.
 *
 * REASON-AWARE + ATOMIC: an `out_of_credits` floor is intentional (overage/
 * credits depleted) and must expire on its own or be cleared by a real
 * successful request — NEVER wiped early by usage polling. Because the
 * account-wide representative excludes `extra_usage`, an overage account can
 * legitimately read <100% here, so without a reason guard the clear would
 * prematurely re-enable a spend-blocked account.
 *
 * The reason short-circuit below is a cheap early-out, but it is NOT the real
 * protection: read-check-clear would be a TOCTOU race (the callback reads an
 * older ordinary cooldown; a concurrent request writes a new floor; an
 * unconditional clear then wipes it). The real guard is the DB-level
 * compare-and-clear (`clearRateLimitOnCapacityRestore`), which only clears when
 * the observed cooldown is still in place. The "cleared" line logs only when a
 * row actually changed.
 *
 * Pure-ish (caller injects `dbOps`, `logger`, and `now`) so it can be unit
 * tested directly.
 */
export async function clearRateLimitOnCapacityRestored(
	dbOps: Pick<
		DatabaseOperations,
		"getAccount" | "clearRateLimitOnCapacityRestore"
	>,
	logger: CapacityRestoredLogger,
	evidence: CapacityRestoredEvidence,
	now: number = Date.now(),
): Promise<void> {
	const { accountId } = evidence;
	const acc = await dbOps.getAccount(accountId);
	// No active lock: the normal state for a healthy account on every poll. NOT
	// logged — it would drown the rejection tokens below in debug output.
	if (!acc?.rate_limited_until || Number(acc.rate_limited_until) <= now) {
		return;
	}
	if (acc.rate_limited_reason === "out_of_credits") {
		logger.debug(
			`[clankermux] account=${acc.name} capacity_restored_skip ineligible_reason reason=out_of_credits (intentional floor — must expire or clear on a successful request)`,
		);
		return;
	}
	// Atomic compare-and-clear: only clears if the EXACT observed cooldown is still
	// in place — both rate_limited_until AND rate_limited_at unchanged — and the
	// reason isn't out_of_credits, so a cooldown/floor written concurrently between
	// the read above and this write is preserved (even one reusing the same
	// deadline — rate_limited_at, the write instant, still differs).
	const cleared = await dbOps.clearRateLimitOnCapacityRestore(
		accountId,
		acc.rate_limited_until,
		acc.rate_limited_at,
	);
	if (cleared) {
		logger.info(
			`[clankermux] account=${acc.name} capacity_restored_clear reason=${
				acc.rate_limited_reason ?? "none"
			} utilization=${evidence.utilization}% extra_usage=${
				evidence.extraUsageUtilization ?? "none"
			} cooldown_remaining=${Math.round(
				(Number(acc.rate_limited_until) - now) / 60_000,
			)}m fetch_started_at=${new Date(evidence.fetchStartedAt).toISOString()}`,
		);
	} else {
		logger.debug(
			`[clankermux] account=${acc.name} capacity_restored_skip cas_mismatch (a concurrent write replaced the observed cooldown)`,
		);
	}
}
