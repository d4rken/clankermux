import {
	computeRateLimitBackoffMs,
	logError,
	RateLimitError,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Account, RateLimitReason } from "@clankermux/types";
import type { ProxyContext } from "./proxy-types";

const log = new Logger("RateLimitCooldown");

// --- Single-flight recovery probe gate (upstream 8197364f) -------------------
//
// After an account racks up a mature streak of consecutive 429s, its cooldown
// expiry is often optimistic relative to the real upstream quota window. If we
// let every concurrently-selected request pile onto that account the instant
// the cooldown clears, we re-trigger the same 429 storm that produced the
// streak. This process-local gate admits exactly ONE recovery probe per account
// within a short lease; other concurrent requests skip the account and fall
// through to the next candidate in the selection order.
//
// This is orthogonal to the transparent burst-retry hold (which holds a SINGLE
// account WITHIN one request): the gate arbitrates MANY concurrent requests
// re-selecting a freshly-recovered account ACROSS requests. Both compose — a
// held/reprobing request keeps its lease until it reaches a terminal outcome.
const MATURE_COOLDOWN_STREAK = 5;
const PROBE_LEASE_MS = 2 * 60 * 1000;
const MAX_PROBE_GATES = 10_000;
const probeLeases = new Map<
	string,
	{ leaseUntil: number; capacityGeneration?: number }
>();

// --- Capacity-restored single-flight marker ---------------------------------
//
// An account released EARLY by the usage poller (its cooldown cleared before the
// deadline) becomes selectable again in one step, with `consecutive_rate_limits`
// still at 0 and no cooldown deadline left behind. Neither of those facts
// engages the mature-streak gate above, so without a dedicated marker every
// concurrent request would stampede an account whose recovery is, by
// construction, a guess about the provider's state.
//
// accountId → capacity generation. The generation exists so an OLD probe can
// never clear a NEWER restore's marker (release → re-lock → release again while
// the first probe is still in flight).
const capacityRestoredPending = new Map<string, number>();
let capacityGenerationCounter = 0;

export type RateLimitProbeAdmission =
	| "not_required"
	| "admitted"
	| "suppressed";

/**
 * A provisional capacity-restored reservation. Carries the generation it armed
 * AND the generation it displaced, so a rollback RESTORES the previous state
 * rather than erasing it.
 */
export interface CapacityProbeReservation {
	accountId: string;
	/** The generation this reservation armed. */
	generation: number;
	/** The generation that was pending before it, or null if none was. */
	previousGeneration: number | null;
}

/**
 * Reserve a capacity-restored probe generation for an account. Called by the
 * capacity-restored handler BEFORE its compare-and-clear commits, and rolled
 * back via {@link rollbackCapacityRestoredProbePending} if that CAS fails or
 * throws. A committed (successful) CAS simply keeps the reservation — that is
 * what commits the new generation.
 *
 * Reserve-then-roll-back, not arm-after-commit: DB state and process memory
 * cannot change atomically, and arming only after the async CAS resolves leaves
 * a window in which the account is already unlocked and selectable with NO
 * marker — fan-in through the very hole the marker exists to close. A
 * momentarily-armed marker on a failed CAS costs at most one suppressed request.
 */
export function markCapacityRestoredProbePending(
	accountId: string,
): CapacityProbeReservation {
	capacityGenerationCounter += 1;
	const previousGeneration = capacityRestoredPending.get(accountId) ?? null;
	capacityRestoredPending.set(accountId, capacityGenerationCounter);
	return {
		accountId,
		generation: capacityGenerationCounter,
		previousGeneration,
	};
}

/**
 * Undo a reservation whose clear never committed, RESTORING whatever was
 * pending before it. Deleting outright would be wrong: the capacity callback is
 * fire-and-forget, so two can overlap (reserve 1 → reserve 2 → CAS 1 SUCCEEDS →
 * CAS 2 fails). Deleting on that rollback would leave an account that IS
 * unlocked with no marker at all — and with the streak still 0, nothing else
 * gates the fan-in. The same applies to a marker retained after
 * `cooldown_reapplied` that a later failed reservation would otherwise erase.
 *
 * Generation-guarded on the way in as well: if a NEWER reservation has since
 * replaced this one, the rollback is a no-op (that newer reservation owns the
 * slot and will restore its own predecessor if it too fails).
 */
export function rollbackCapacityRestoredProbePending(
	reservation: CapacityProbeReservation,
): void {
	const { accountId, generation, previousGeneration } = reservation;
	if (capacityRestoredPending.get(accountId) !== generation) return;
	if (previousGeneration === null) {
		capacityRestoredPending.delete(accountId);
	} else {
		capacityRestoredPending.set(accountId, previousGeneration);
	}
}

/**
 * Drop any capacity-restored marker for an account. For account REMOVAL only —
 * the marker is otherwise cleared exclusively by a successful probe of the
 * matching generation (or a process restart).
 *
 * It is deliberately NEVER time-expired: a family gate, an open 529 breaker or a
 * pinned client can legitimately delay probing indefinitely, and expiring the
 * marker would reopen fan-in at exactly the moment the account finally becomes
 * selectable. The map is keyed by account id, so it is bounded by account count.
 */
export function clearCapacityRestoredProbePending(accountId: string): void {
	capacityRestoredPending.delete(accountId);
}

/** Whether an early-release probe is still owed for this account. */
export function hasCapacityRestoredProbePending(accountId: string): boolean {
	return capacityRestoredPending.has(accountId);
}

function pruneProbeLeases(now: number): void {
	for (const [accountId, lease] of probeLeases) {
		if (lease.leaseUntil <= now) probeLeases.delete(accountId);
	}
	while (probeLeases.size >= MAX_PROBE_GATES) {
		const oldest = probeLeases.keys().next().value;
		if (oldest === undefined) break;
		probeLeases.delete(oldest);
	}
}

/**
 * Admits one process-local recovery probe for an account that just became
 * selectable again — either because a MATURE cooldown streak expired, or
 * because the usage poller released the cooldown EARLY (capacity restored).
 * Ordinary accounts are not gated ("not_required").
 *
 * The two triggers are separate on purpose: the mature-streak condition
 * requires `consecutive_rate_limits >= MATURE_COOLDOWN_STREAK` and an
 * expired-but-present deadline, and an early release satisfies NEITHER (the
 * quota reasons run at streak 0, and the clear removes the deadline entirely) —
 * which is why it needs its own marker rather than a relaxed deadline check.
 *
 * Returns:
 *   - "not_required": the account isn't a freshly-recovered account; the caller
 *     proxies as normal.
 *   - "admitted": THIS request holds the single-flight lease and should probe
 *     the account. The caller MUST release it via {@link completeRateLimitProbe}
 *     on every terminal outcome of the attempt (see the callers in proxy.ts,
 *     which wrap the proxy call in try/finally).
 *   - "suppressed": another request is already probing this account; the caller
 *     must skip it and try the next candidate.
 *
 * NOTE: the global force-account override in `proxy.ts` bypasses account
 * selection entirely, so the "exactly one upstream probe" guarantee explicitly
 * excludes that operator override.
 */
export function getRateLimitProbeAdmission(
	account: Account,
	now: number = Date.now(),
): RateLimitProbeAdmission {
	const expiredMatureCooldown =
		account.consecutive_rate_limits >= MATURE_COOLDOWN_STREAK &&
		account.rate_limited_until != null &&
		account.rate_limited_until <= now;
	const capacityGeneration = capacityRestoredPending.get(account.id);
	if (!expiredMatureCooldown && capacityGeneration === undefined)
		return "not_required";

	pruneProbeLeases(now);
	const existingLease = probeLeases.get(account.id);
	if (existingLease && existingLease.leaseUntil > now) {
		log.debug(
			`[clankermux] account=${account.name} cooldown_probe_suppressed lease_until=${new Date(existingLease.leaseUntil).toISOString()}`,
		);
		return "suppressed";
	}

	const leaseUntil = now + PROBE_LEASE_MS;
	// Record WHICH capacity generation this probe was admitted for, so its
	// outcome can only ever clear that generation's marker.
	probeLeases.set(account.id, { leaseUntil, capacityGeneration });
	log.info(
		`[clankermux] account=${account.name} cooldown_probe_admitted streak=${account.consecutive_rate_limits}${
			capacityGeneration !== undefined
				? ` capacity_generation=${capacityGeneration}`
				: ""
		} lease_until=${new Date(leaseUntil).toISOString()}`,
	);
	return "admitted";
}

/**
 * Releases the single-flight probe lease for an account, if one is held.
 * Must be called on every terminal outcome of a probed request: success
 * (recovered), a fresh cooldown being reapplied (cooldown_reapplied), or the
 * request being abandoned (exception, mid-loop skip, or any other early exit).
 *
 * The capacity-restored marker has a NARROWER lifecycle than the lease:
 *   - `recovered` clears it — but only when the admitted generation still
 *     matches, so an older probe can never clear a newer restore's marker.
 *   - `cooldown_reapplied` RETAINS it. The probe got another reset-bearing 429,
 *     which leaves `consecutive_rate_limits` at 0 and a deadline that may be the
 *     synthesized 60s one — i.e. it can expire before the next 90s poll, and the
 *     mature-streak gate would then return "not_required" for every concurrent
 *     request. Clearing here would defeat the marker after the first
 *     unsuccessful probe. While the reapplied cooldown is active the marker is
 *     dormant (the account is unselectable); when it expires the marker again
 *     forces exactly one probe.
 *   - `abandoned` RETAINS it: nothing was learned about the account.
 *
 * Idempotent: if no lease is held this is a no-op (and capacity state is left
 * untouched), so it is safe to call from a try/finally chokepoint even when an
 * earlier path already released it.
 */
export function completeRateLimitProbe(
	account: Account,
	outcome: "recovered" | "cooldown_reapplied" | "abandoned",
): void {
	const lease = probeLeases.get(account.id);
	if (!lease) return;
	probeLeases.delete(account.id);
	if (outcome === "recovered") {
		if (
			lease.capacityGeneration !== undefined &&
			capacityRestoredPending.get(account.id) === lease.capacityGeneration
		) {
			capacityRestoredPending.delete(account.id);
		}
		log.info(
			`[clankermux] account=${account.name} cooldown_probe_recovery_success`,
		);
	} else if (outcome === "abandoned") {
		log.debug(`[clankermux] account=${account.name} cooldown_probe_abandoned`);
	}
}

/** Test-only: clears all in-memory probe leases/markers between test cases. */
export function resetRateLimitProbeGatesForTests(): void {
	probeLeases.clear();
	capacityRestoredPending.clear();
}

/**
 * Single entry point for applying a 429-driven cooldown to an account.
 * Computes exponential-backoff cooldown capped by upstream reset (if any), updates
 * in-memory state, and enqueues the DB-side atomic increment.
 *
 * Must be called from every 429 path (response-processor, model_fallback_429,
 * all_models_exhausted_429) — never reach into rate_limited_until manually.
 *
 * @param account - The account that just received a 429 (mutated in place).
 * @param rateLimitInfo - Parsed rate-limit hints from the provider. `resetTime`
 *   caps the computed cooldown via `min(resetTime, now + backoff)`. `remaining`
 *   is forwarded to the emitted `RateLimitError` for observability. `reason`
 *   overrides the auto-derived audit reason (use for `model_fallback_429` /
 *   `all_models_exhausted_429` paths so the audit trail is preserved).
 * @param ctx - The proxy context (provides `asyncWriter` + `dbOps`).
 * @param options - Optional behaviour flags. See {@link applyRateLimitCooldown}'s
 *   `reprobe` documentation below.
 *
 * ### Re-probe semantics (`options.reprobe === true`)
 *
 * The transparent burst-retry feature re-probes a held cache account *while it is
 * still inside its existing cooldown window* (a deliberate, bounded retry on the
 * same throttled IP). Those re-probe 429s must NOT escalate the account's streak
 * state, otherwise every gentle re-probe would inflate the backoff tier and delay
 * the streak-reset-on-success. When `reprobe` is set, this function therefore:
 *
 *   - DOES NOT touch `account.consecutive_rate_limits` (no streak escalation).
 *   - DOES NOT touch `account.rate_limited_at` (so a later genuine success can
 *     still reset the streak via the stability window — see response-processor's
 *     `(a) Stability reset`, which is gated on `rate_limited_at` alone).
 *   - DOES NOT enqueue the DB-side `markAccountRateLimited` increment.
 *   - ONLY refreshes `account.rate_limited_until` to the upstream-provided
 *     `resetTime` (if any) so the hold orchestrator's next wait is computed from
 *     a fresh deadline. With no `resetTime`, in-memory state is left untouched
 *     entirely (the orchestrator computes its own bounded wait).
 *
 * ### Server-directed reset semantics (Lever B)
 *
 * When the 429 carries an explicit `resetTime` in the future (and no `floorUntil`
 * out-of-credits override), the upstream has told us exactly when to retry. We
 * honor that deadline but DO NOT escalate `consecutive_rate_limits` — only
 * no-reset 429s should ramp the adaptive backoff streak. The DB write goes through
 * the non-incrementing `markAccountRateLimitedDeadlineOnly`. `rate_limited_at` is
 * still refreshed so a later genuine success can reset the streak via the
 * stability window.
 *
 * The no-reset path and the `floorUntil` (out-of-credits depletion) path keep the
 * original escalating behaviour verbatim.
 */
export function applyRateLimitCooldown(
	account: Account,
	rateLimitInfo: {
		resetTime?: number;
		remaining?: number;
		reason?: RateLimitReason;
		/**
		 * Hard minimum cooldown deadline (epoch ms). After the normal
		 * `min(resetTime, now + backoff)` computation the cooldown is raised to
		 * `floorUntil` if it is larger — letting a deliberately LONG cooldown (e.g.
		 * out-of-credits depletion) survive the exponential-backoff cap, which would
		 * otherwise pin every no-reset 429 at the backoff ceiling. Omitted on all
		 * normal paths (no behavioural change). Ignored in `reprobe` mode.
		 */
		floorUntil?: number;
	},
	ctx: ProxyContext,
	options?: { reprobe?: boolean },
): void {
	const now = Date.now();

	// Re-probe path: a gentle retry of a held account inside its existing
	// cooldown. Never escalate the streak or its anchor; only advance
	// rate_limited_until from a fresh upstream reset so the next wait is right.
	if (options?.reprobe) {
		if (rateLimitInfo.resetTime && rateLimitInfo.resetTime > now) {
			account.rate_limited_until = rateLimitInfo.resetTime;
		}
		// Deliberately do NOT touch consecutive_rate_limits, rate_limited_at, or
		// enqueue a DB write. Emit only an observability error (no DB reconcile).
		const rateLimitError = new RateLimitError(
			account.id,
			account.rate_limited_until ?? now,
			rateLimitInfo.remaining,
		);
		logError(rateLimitError, log);
		return;
	}

	// Single-flight recovery probe: reaching here means a REAL fresh cooldown is
	// about to be (re)applied (Lever B server-directed reset OR the escalating
	// no-reset path) — a terminal outcome for any in-flight recovery probe on
	// this account. Release its lease so the account isn't sidelined for the full
	// lease TTL; the next expiry re-arms a fresh single probe. The reprobe path
	// above returns before this point, so gentle in-request re-probes never
	// release the cross-request lease.
	const wasRecoveryProbe = probeLeases.has(account.id);
	completeRateLimitProbe(account, "cooldown_reapplied");
	if (wasRecoveryProbe) {
		log.info(`[clankermux] account=${account.name} cooldown_probe_reapplied`);
	}

	// Lever B: the upstream gave us an explicit reset time (it told us exactly when
	// to retry). Honor that deadline WITHOUT escalating the adaptive-backoff streak
	// — only no-reset 429s should ramp the streak. The `floorUntil` override is
	// reserved for out-of-credits depletion (which never carries a reset), so it
	// takes precedence: if both are somehow present, fall through to the escalating
	// path below to preserve the existing out-of-credits semantics.
	if (
		rateLimitInfo.resetTime &&
		rateLimitInfo.resetTime > now &&
		!rateLimitInfo.floorUntil
	) {
		const reason: RateLimitReason =
			rateLimitInfo.reason ?? "upstream_429_with_reset";

		// In-memory update: honor the server-directed deadline; refresh
		// rate_limited_at so a later genuine success can still reset the streak via
		// the stability window; leave consecutive_rate_limits UNTOUCHED.
		account.rate_limited_until = rateLimitInfo.resetTime;
		account.rate_limited_at = now;

		const cooldownUntil = rateLimitInfo.resetTime;
		ctx.asyncWriter.enqueue(async () => {
			await ctx.dbOps.markAccountRateLimitedDeadlineOnly(
				account.id,
				cooldownUntil,
				reason,
			);
			// Audit log: report the UNCHANGED streak so the no-escalation behaviour
			// is visible in the operational trail.
			log.warn(
				`[clankermux] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${account.consecutive_rate_limits} (server-directed reset, streak not escalated)`,
			);
		});

		// Still emit the RateLimitError for observability, as before.
		const rateLimitError = new RateLimitError(
			account.id,
			cooldownUntil,
			rateLimitInfo.remaining,
		);
		logError(rateLimitError, log);
		return;
	}

	// Best-effort in-memory computation. The DB write does the authoritative atomic
	// increment; under parallel 429s the second concurrent request may compute one
	// tier short, but the persisted counter still ramps correctly.
	const nextCount = account.consecutive_rate_limits + 1;
	const backoffMs = computeRateLimitBackoffMs(nextCount);
	const candidateUntil = now + backoffMs;
	let cooldownUntil = rateLimitInfo.resetTime
		? Math.min(rateLimitInfo.resetTime, candidateUntil)
		: candidateUntil;
	// A hard floor (e.g. out-of-credits depletion) overrides the backoff cap
	// upward so a deliberately long cooldown is not shortened by the exponential
	// ramp's min(resetTime, backoff).
	if (rateLimitInfo.floorUntil && rateLimitInfo.floorUntil > cooldownUntil) {
		cooldownUntil = rateLimitInfo.floorUntil;
	}
	const reason: RateLimitReason =
		rateLimitInfo.reason ??
		(rateLimitInfo.resetTime
			? "upstream_429_with_reset"
			: "upstream_429_no_reset_probe_cooldown");

	// In-memory update so the rest of this request sees consistent state.
	account.rate_limited_until = cooldownUntil;
	account.rate_limited_at = now;
	account.consecutive_rate_limits = nextCount;

	ctx.asyncWriter.enqueue(async () => {
		const persistedCount = await ctx.dbOps.markAccountRateLimited(
			account.id,
			cooldownUntil,
			reason,
		);
		// Reconcile in-memory counter with the authoritative DB value (may differ
		// under concurrent 429s for the same account).
		account.consecutive_rate_limits = persistedCount;
		// Log AFTER the DB write so the reported `consecutive=` reflects the
		// persisted counter — not the in-memory pre-write estimate (which may
		// be one tier short under concurrent 429s for the same account).
		log.warn(
			`[clankermux] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount}`,
		);
	});

	const rateLimitError = new RateLimitError(
		account.id,
		cooldownUntil,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
}
