import type { DatabaseOperations } from "@clankermux/database";
import type { CapacityRestoredEvidence } from "@clankermux/providers";
import type { CapacityProbeReservation } from "@clankermux/proxy";
import { isQuotaDerivedRateLimitReason } from "@clankermux/types";

/** Minimal logger surface the capacity-restored handler needs. */
export interface CapacityRestoredLogger {
	debug: (msg: string) => void;
	info: (msg: string) => void;
	warn: (msg: string) => void;
}

/**
 * Locks with MORE than this remaining are eligible for the lock-contradiction
 * WARN below. Every non-quota-derived cooldown the CURRENT code can write is
 * far shorter: the transparent-burst hold caps at ~90s, the 429 exponential
 * backoff and the 529 provider-overload cooldown both ceiling at 5 minutes.
 * Only a server-directed deadline (extractCooldownUntil honoring a provider
 * reset/retry-after, which bypasses the backoff cap) can push a lock past this
 * threshold — and a MULTI-HOUR server-directed lock that polling actively
 * contradicts is exactly the signature this alarm exists for, whether the 429
 * was misclassified (Claude-Backup-2, 2026-08-02: a fable-scoped 429 wrote an
 * account-wide model_fallback_429 lock until the weekly reset; polling saw the
 * headroom two seconds later and could only say so at DEBUG) or the provider
 * really directed a long penalty that usage cannot express — either deserves
 * one WARN. 30 minutes = 6× the largest current ceiling.
 *
 * Known qualification: the legacy `upstream_429_no_reset_default_5h` reason
 * (never emitted since ccflare ≤3.5.x) represented a legitimate 5-hour
 * cooldown. If a row with it ever reappeared it would draw one WARN per lock —
 * accepted noise over an exemption branch for a reason that cannot be written.
 */
export const LOCK_CONTRADICTION_MIN_REMAINING_MS = 30 * 60 * 1000;

/**
 * Process-lifetime dedupe for the lock-contradiction WARN: accountId → the
 * exact lock identity (until:at:reason) already warned about. The poller is
 * level-triggered (~90s), so without this one misclassified 14h lock would WARN
 * ~560 times. Entries are pruned on the first healthy (lock-free) poll of the
 * same account, so an identical future lock is a new incident, not a deduped
 * repeat. An account removed (or whose polling dies) between warn and prune
 * leaves its entry behind, so boundedness is enforced explicitly: inserts
 * beyond {@link LOCK_CONTRADICTION_DEDUPE_MAX} evict the oldest entry
 * (insertion order — at worst a very old lock re-warns once). Injectable for
 * tests.
 */
export const LOCK_CONTRADICTION_DEDUPE_MAX = 64;
const defaultWarnedLockContradictions = new Map<string, string>();

/**
 * The single-flight marker API (injected, so this module never deep-imports a
 * proxy-internal file and tests can observe the calls). Backed by
 * `markCapacityRestoredProbePending` / `rollbackCapacityRestoredProbePending`
 * in `@clankermux/proxy`.
 *
 * `markPending` returns a RESERVATION rather than a bare generation: rolling one
 * back must restore whatever it displaced, because this handler is invoked
 * fire-and-forget and two calls for the same account can overlap.
 */
export interface CapacityRestoredProbeMarker {
	/** Reserve a probe generation for the account. */
	markPending: (accountId: string) => CapacityProbeReservation;
	/** Release a reservation whose clear never committed. */
	rollbackPending: (reservation: CapacityProbeReservation) => void;
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
	marker: CapacityRestoredProbeMarker,
	now: number = Date.now(),
	warnedLockContradictions: Map<
		string,
		string
	> = defaultWarnedLockContradictions,
): Promise<void> {
	const { accountId } = evidence;
	const acc = await dbOps.getAccount(accountId);
	// No active lock: the normal state for a healthy account on every poll. NOT
	// logged — it would drown the rejection tokens below in debug output. Prune
	// the contradiction-warn dedupe entry so the next lock is a fresh incident.
	if (!acc?.rate_limited_until || Number(acc.rate_limited_until) <= now) {
		warnedLockContradictions.delete(accountId);
		return;
	}
	const reason = acc.rate_limited_reason;
	if (!isQuotaDerivedRateLimitReason(reason)) {
		// Lock-contradiction alarm: this refusal is CORRECT (the reason is not
		// releasable by quota evidence — see the gate rationale above), but when
		// the lock is far longer than any legitimate non-quota cooldown can be
		// AND polling actively observes account-wide headroom, the combination is
		// the signature of a misclassified 429 and deserves more than DEBUG.
		// Report-only: nothing here releases or shortens the lock. The
		// intentional out_of_credits billing floor is exempt — account-wide
		// usage excludes extra_usage, so headroom under a credits floor is the
		// EXPECTED state, not a contradiction.
		const remainingMs = Number(acc.rate_limited_until) - now;
		const lockIdentity = `${acc.rate_limited_until}:${acc.rate_limited_at ?? "null"}:${reason ?? "null"}`;
		if (
			reason !== "out_of_credits" &&
			remainingMs > LOCK_CONTRADICTION_MIN_REMAINING_MS &&
			warnedLockContradictions.get(accountId) !== lockIdentity
		) {
			// Re-set (delete-then-set) so a refreshed account moves to the back of
			// the insertion order before the size-cap eviction considers victims.
			warnedLockContradictions.delete(accountId);
			warnedLockContradictions.set(accountId, lockIdentity);
			if (warnedLockContradictions.size > LOCK_CONTRADICTION_DEDUPE_MAX) {
				const oldest = warnedLockContradictions.keys().next().value;
				if (oldest !== undefined) warnedLockContradictions.delete(oldest);
			}
			logger.warn(
				`[clankermux] account=${acc.name} capacity_restored_skip ineligible_reason lock_contradiction reason=${reason ?? "null"} utilization=${evidence.utilization}% remaining=${Math.round(
					remainingMs / 60_000,
				)}m until=${new Date(Number(acc.rate_limited_until)).toISOString()} — polling observes account-wide headroom but this lock's reason is not releasable by evidence; if the lock is unexpected, the 429 that wrote it was likely misclassified (clear it manually or wait out the deadline)`,
			);
		} else {
			logger.debug(
				`[clankermux] account=${acc.name} capacity_restored_skip ineligible_reason reason=${reason ?? "null"}`,
			);
		}
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
	//
	// The single-flight marker is reserved BEFORE the CAS and rolled back if it
	// fails or throws. An early release makes the account selectable in one step
	// with `consecutive_rate_limits` still 0 and no deadline left behind, so
	// nothing else would gate the fan-in; arming only after the await resolves
	// would leave a window in which the account is unlocked and unmarked.
	const reservation = marker.markPending(accountId);
	let cleared: boolean;
	try {
		cleared = await dbOps.clearRateLimitOnCapacityRestore(
			accountId,
			acc.rate_limited_until,
			acc.rate_limited_at,
			reason,
			evidence.fetchStartedAt,
		);
	} catch (err) {
		marker.rollbackPending(reservation);
		throw err;
	}
	if (cleared) {
		logger.info(
			`[clankermux] account=${acc.name} capacity_restored_clear reason=${reason} utilization=${evidence.utilization}% extra_usage=${
				evidence.extraUsageUtilization ?? "none"
			} cooldown_remaining=${Math.round(
				(Number(acc.rate_limited_until) - now) / 60_000,
			)}m fetch_started_at=${new Date(evidence.fetchStartedAt).toISOString()}`,
		);
	} else {
		marker.rollbackPending(reservation);
		logger.debug(
			`[clankermux] account=${acc.name} capacity_restored_skip cas_mismatch (a concurrent write replaced the observed cooldown)`,
		);
	}
}
