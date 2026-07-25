import type { DatabaseOperations } from "@clankermux/database";
import type { CapacityRestoredEvidence } from "@clankermux/providers";
import { isQuotaDerivedRateLimitReason } from "@clankermux/types";

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
 * REASON-GATED: only cooldowns that are QUOTA-DERIVED BY CONSTRUCTION may be
 * released here — the proxy read the very windows this evidence re-reads (see
 * `QUOTA_DERIVED_RATE_LIMIT_REASONS`). Everything else is refused, notably:
 *  - `out_of_credits`, an intentional billing floor that must expire on its own
 *    or clear on a real successful request. The account-wide representative
 *    excludes `extra_usage`, so an overage account can legitimately read <100%
 *    here; without the gate the clear would re-enable a spend-blocked account.
 *  - `upstream_429_with_reset`, which a per-IP BURST inherits (`parseRateLimit`
 *    synthesizes a 60s reset for a bare 429). A burst limit is unrelated to the
 *    account's quota; releasing one on quota evidence just re-storms it.
 *
 * The checks below are cheap early-outs, NOT the real protection: read-check-
 * clear would be a TOCTOU race (the callback reads an eligible cooldown; a
 * concurrent request writes a floor; an unconditional clear then wipes it). The
 * real guard is the DB-level compare-and-clear
 * (`clearRateLimitOnCapacityRestore`), which re-asserts the deadline, the write
 * instant, the exact reason AND the causal boundary inside one UPDATE. The
 * "cleared" line logs only when a row actually changed.
 *
 * Residual risk: a wall-clock ROLLBACK could make a cooldown's `rate_limited_at`
 * appear older than the poll that preceded it. A monotonic stamp is deliberately
 * NOT adopted — it would change `rate_limited_at`'s "when written" meaning that
 * the streak/stability logic depends on. A monotonic `rate_limit_generation`
 * column is the robust answer and is a recorded follow-up.
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
	const reason = acc.rate_limited_reason;
	if (!isQuotaDerivedRateLimitReason(reason)) {
		logger.debug(
			`[clankermux] account=${acc.name} capacity_restored_skip ineligible_reason reason=${reason ?? "null"}`,
		);
		return;
	}
	// Fail CLOSED on a missing write instant: without it the cooldown cannot be
	// ordered against the evidence, and an unordered clear is exactly the
	// premature release this guard exists to prevent. Explicit — never let JS
	// coercion decide (0 is a legitimate, if absurd, timestamp).
	if (acc.rate_limited_at === null || acc.rate_limited_at === undefined) {
		logger.debug(
			`[clankermux] account=${acc.name} capacity_restored_skip missing_rate_limited_at reason=${reason}`,
		);
		return;
	}
	// Causal boundary: the cooldown must PREDATE the start of the usage request
	// that produced this reading. A cooldown written while that request was in
	// flight is temporally ambiguous — the next poll re-reports and re-decides.
	if (acc.rate_limited_at >= evidence.fetchStartedAt) {
		logger.debug(
			`[clankermux] account=${acc.name} capacity_restored_skip cooldown_newer_than_evidence rate_limited_at=${new Date(
				acc.rate_limited_at,
			).toISOString()} fetch_started_at=${new Date(evidence.fetchStartedAt).toISOString()}`,
		);
		return;
	}
	// Atomic compare-and-clear: only clears if the EXACT observed cooldown is
	// still in place — deadline, write instant AND reason unchanged — and still
	// predates the evidence, so any cooldown/floor written concurrently between
	// the read above and this write is preserved (even one reusing the same
	// deadline — rate_limited_at, the write instant, still differs).
	const cleared = await dbOps.clearRateLimitOnCapacityRestore(
		accountId,
		acc.rate_limited_until,
		acc.rate_limited_at,
		reason,
		evidence.fetchStartedAt,
	);
	if (cleared) {
		logger.info(
			`[clankermux] account=${acc.name} capacity_restored_clear reason=${reason} utilization=${evidence.utilization}% extra_usage=${
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
