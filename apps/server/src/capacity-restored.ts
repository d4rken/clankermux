import type { ObservedWindow } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import {
	isSelfHealingPauseReason,
	supportsWindowResetUnpause,
} from "@clankermux/load-balancer";
import type { CapacityRestoredEvidence } from "@clankermux/providers";
import type { CapacityProbeReservation } from "@clankermux/proxy";
import { type Account, isQuotaDerivedRateLimitReason } from "@clankermux/types";

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
		| "getAccount"
		| "clearRateLimitOnCapacityRestore"
		| "stampObservedRateLimitReset"
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
		if (acc) await stampStaleResetIfStranded(dbOps, logger, acc, evidence);
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
		// The lock is gone, but a PAUSED account is still not selectable, and the
		// clear deliberately leaves `rate_limit_reset` alone. If that value is
		// stale, auto-unpause stays shut for the same reason as on the no-lock
		// path — correct it here too.
		await stampStaleResetIfStranded(dbOps, logger, acc, evidence);
	} else {
		marker.rollbackPending(reservation);
		logger.debug(
			`[clankermux] account=${acc.name} capacity_restored_skip cas_mismatch (a concurrent write replaced the observed cooldown)`,
		);
	}
}

/**
 * A recorded `rate_limit_reset` COUNTS AS MATCHING a reported window reset when
 * the two are within this many ms. The column is written from
 * `anthropic-ratelimit-unified-reset`, a whole-SECONDS header, while the usage
 * payload carries millisecond `resets_at`; measured across every live account
 * on 2026-09-03 the difference was at most 474ms (0ms for Codex). 1s is the
 * same drift tolerance `applyCodexUsageBookkeeping` uses for this column.
 */
export const RESET_MATCH_TOLERANCE_MS = 1000;

/**
 * True when NO reported window both matches `recordedReset` (within
 * {@link RESET_MATCH_TOLERANCE_MS}) AND is still spent — i.e. nothing the
 * provider describes still OWNS the deadline we are holding. Two shapes make a
 * recorded reset stale:
 *  - the boundary MOVED (a seat reassignment): no reported window carries the
 *    old reset any more;
 *  - the window DRAINED in place (a gift reset, which this codebase documents
 *    as "the reported percentage dropping while `resets_at` stayed put"): the
 *    reset still matches, but the window is no longer spent, so it no longer
 *    justifies holding the account.
 *
 * A matching window that is still SPENT must never read as stale: a spent
 * per-family weekly (Claude-1 on 2026-09-03: fable 100%, account-wide 78%)
 * leaves the header-derived reset pointing days out while account-wide
 * headroom is plainly visible. Unknown utilization on a matching window
 * counts as spent (hold): that trades the cost asymmetry below the other way,
 * for a shape (a reset with no percent) no captured payload has shown.
 *
 * An EMPTY list is stale: a spent window always carries a `resets_at`, so a
 * payload reporting none positively says no window owns a future deadline.
 * Failing closed here would recreate the deadlock for a paused account whose
 * every window is idle (idle windows can report `resets_at: null`). The cost
 * asymmetry also points this way: a wrong stamp costs one prime request that
 * re-locks on a 429; a wrong refusal costs days of pause.
 */
export function isStaleRecordedReset(
	recordedReset: number,
	observedWindows: readonly ObservedWindow[],
): boolean {
	return !observedWindows.some(
		(w) =>
			Math.abs(w.resetMs - recordedReset) <= RESET_MATCH_TOLERANCE_MS &&
			(w.utilization === null || w.utilization >= 100),
	);
}

/**
 * Correct a stale FUTURE `rate_limit_reset` on an account that is STRANDED: it
 * is paused for a reason the load balancer may clear on its own, but the column
 * the auto-unpause gate reads still claims its window resets later, so the gate
 * stays shut. Nothing else can fix that record — a paused account gets no
 * requests to carry fresh headers, and the auto-refresh scheduler's own
 * `bindingWindowResetElapsed` gate is shut by the very same value. Without this,
 * an out-of-band weekly reset pauses the account permanently.
 *
 * Runs on both handler paths (no lock, and after a lock was just cleared),
 * since a paused account is stranded either way. Anthropic only in practice:
 * capacity-restored evidence is emitted by the Anthropic poll branch, and Codex
 * already rewrites this column from every free usage read in
 * `applyCodexUsageBookkeeping`. Deliberately narrow:
 *
 *  - Paused with a SELF-HEALING reason, auto-fallback ON, and a provider the
 *    gate accepts. Anything else nothing will ever auto-unpause, so a stamp
 *    would only produce a log line promising an outcome that cannot happen. An
 *    UNPAUSED account is not stranded at all: it still receives traffic, and
 *    the next response rewrites the column from real headers.
 *  - Only a reset still in the FUTURE relative to the observation is touched, so
 *    an already-elapsed value is never moved and the write is idempotent across
 *    the level-triggered re-reports.
 *  - Only a reset that is STALE — owned by no window the provider reported as
 *    still spent in this very poll ({@link isStaleRecordedReset}). This is the
 *    guard that keeps a legitimately-future reset (a spent scoped weekly) in
 *    place.
 *  - The DB-level compare-and-swap on the observed value and on `paused` is the
 *    real race guard, not the read above: a concurrent write between the read
 *    and the stamp misses the WHERE rather than being clobbered.
 *
 * The value written is `fetchStartedAt`, the instant the poll that produced this
 * evidence began — the moment we can actually attest the recorded window was
 * gone. It is in the past by the time it lands, so the gate's 1s skew buffer
 * passes it on the next selection.
 *
 * In production the first consumer is usually NOT the load-balancer gate but
 * the auto-refresh scheduler: every reachable self-healing pause is `overage`,
 * which is only written for `auto_pause_on_overage_enabled` accounts, and those
 * are exactly the paused rows the scheduler's eligibility SQL admits. Its
 * `bindingWindowResetElapsed` opens on the stamped value, so within a cycle it
 * sends one translated prime (a real, small request), which rewrites this column
 * from the response headers and resumes the account. The unpause is not free:
 * one prime per stale detection.
 */
async function stampStaleResetIfStranded(
	dbOps: Pick<DatabaseOperations, "stampObservedRateLimitReset">,
	logger: CapacityRestoredLogger,
	acc: Account,
	evidence: CapacityRestoredEvidence,
): Promise<void> {
	if (!acc.paused) return;
	if (!acc.auto_fallback_enabled) return;
	if (!supportsWindowResetUnpause(acc.provider)) return;
	if (!isSelfHealingPauseReason(acc.pause_reason)) return;
	const reset = Number(acc.rate_limit_reset);
	if (!Number.isFinite(reset) || reset <= evidence.fetchStartedAt) return;
	// NOT logged: for a paused account whose recorded reset is a real window
	// (Claude-1: spent fable weekly) this is the normal state on every poll, and
	// a per-poll line here would drown the rejection tokens like the healthy
	// no-lock return above would.
	if (!isStaleRecordedReset(reset, evidence.observedWindows)) return;

	const stamped = await dbOps.stampObservedRateLimitReset(
		acc.id,
		reset,
		evidence.fetchStartedAt,
	);
	if (stamped) {
		logger.info(
			`[clankermux] account=${acc.name} capacity_restored_stamp_reset pause_reason=${
				acc.pause_reason ?? "null"
			} utilization=${evidence.utilization}% stale_reset=${new Date(
				reset,
			).toISOString()} observed_at=${new Date(evidence.fetchStartedAt).toISOString()} reported_windows=${evidence.observedWindows
				.map(
					(w) =>
						`${new Date(w.resetMs).toISOString()}@${w.utilization ?? "?"}%`,
				)
				.join(
					",",
				)} — paused account's recorded window reset is owned by no window the provider reports as spent (out-of-band or gift reset); corrected so auto-unpause can see the window as elapsed`,
		);
	} else {
		logger.debug(
			`[clankermux] account=${acc.name} capacity_restored_skip stale_reset_cas_mismatch (a concurrent write replaced the observed rate_limit_reset or resumed the account)`,
		);
	}
}
