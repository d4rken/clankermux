import type { DatabaseOperations } from "@clankermux/database";

/** Minimal logger surface the capacity-restored handler needs. */
export interface CapacityRestoredLogger {
	debug: (msg: string) => void;
	info: (msg: string) => void;
}

/**
 * Handle the usage-poller's capacity-restored signal: when polling confirms an
 * account has available capacity again, clear a stale future `rate_limited_until`
 * lock (seat-reassignment / early reset) so the router can use it without waiting
 * for the natural expiry timer.
 *
 * REASON-AWARE + ATOMIC: an `out_of_credits` floor is intentional (overage/
 * credits depleted) and must expire on its own or be cleared by a real
 * successful request — NEVER wiped early by usage polling. Because the
 * account-wide representative excludes `extra_usage`, an overage account can
 * legitimately read <100% here, so without this guard the clear would
 * prematurely re-enable a spend-blocked account.
 *
 * The reason short-circuit below is a cheap early-out, but it is NOT the real
 * protection: read-check-clear would be a TOCTOU race (the callback reads an
 * older ordinary cooldown; a concurrent request writes a new floor; an
 * unconditional clear then wipes it). The real guard is the DB-level
 * compare-and-clear (`clearRateLimitOnCapacityRestore`), which only clears when
 * `rate_limited_until` is unchanged since the read AND the reason isn't
 * `out_of_credits`. The "cleared" line logs only when a row actually changed.
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
	accountId: string,
	now: number = Date.now(),
): Promise<void> {
	const acc = await dbOps.getAccount(accountId);
	if (!acc?.rate_limited_until || Number(acc.rate_limited_until) <= now) {
		return;
	}
	if (acc.rate_limited_reason === "out_of_credits") {
		logger.debug(
			`Skipping capacity-restored clear for account ${acc.name} (${accountId}): rate_limited_reason=out_of_credits (intentional floor — must expire or clear on a successful request)`,
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
			`Cleared stale rate_limited_until for account ${acc.name} (${accountId}): usage polling shows available capacity (seat reassignment or early reset)`,
		);
	}
}
