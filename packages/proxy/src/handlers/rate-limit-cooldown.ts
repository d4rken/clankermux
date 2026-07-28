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
// through to the next candidate in the selection order — and, when there is no
// next candidate left, recover instead of failing (see below).
//
// This is orthogonal to the transparent burst-retry hold (which holds a SINGLE
// account WITHIN one request): the gate arbitrates MANY concurrent requests
// re-selecting a freshly-recovered account ACROSS requests. Both compose — a
// held/reprobing request keeps its lease until it reaches a terminal outcome.
//
// SUPPRESSION IS NOT A FAILURE. A suppressed candidate was never attempted, so
// a request whose candidates are ALL suppressed has learned nothing about any
// of them. It must not fall through to a terminal error — see
// `awaitProbeRelease` and its caller in proxy.ts.
const MATURE_COOLDOWN_STREAK = 5;
const PROBE_LEASE_MS = 2 * 60 * 1000;
/** Poll interval while waiting for an in-flight probe lease to be released. */
const PROBE_RELEASE_POLL_MS = 25;
const MAX_PROBE_GATES = 10_000;
const probeLeases = new Map<
	string,
	{ leaseUntil: number; capacityGeneration?: number; leaseGeneration: number }
>();
/**
 * Monotonic lease id. Every admitted probe gets a fresh generation, which is what
 * the backup-probe permit below is keyed by: one ungated bypass per LEASE, not
 * one per process and not one per waiter.
 */
let probeLeaseGenerationCounter = 0;

// --- Backup-probe permit -----------------------------------------------------
//
// When a request's recovery hold expires with the probe still unresolved, it may
// attempt the account UNGATED rather than 503 against an untried pool. That
// bypass must be single-flighted too: on a one-account pool with a stuck probe,
// every waiter's budget expires at roughly the same instant, and without an
// arbiter each of them fires its own ungated request — re-creating exactly the
// 429 storm the gate exists to prevent.
//
// accountId → the lease generation whose bypass has already been handed out
// (`null` = handed out while no lease was live). `active` is purely diagnostic
// state for the in-flight window; ACQUISITION refuses on a generation match
// whether or not the winner has finished, so a released permit never re-opens a
// second bypass for the same lease. A newer lease generation supersedes the
// record on the next acquire, so the map holds at most one entry per account.
//
// LIFECYCLE. The map holds at most one entry per account, but "one per account"
// is only bounded while dead entries go away: admitting a new lease drops a spent
// record (it can no longer refuse anything), and account removal evicts the
// account via `clearCapacityRestoredProbePending`. Without the latter a
// long-lived server accumulates deleted account ids.
//
// Removal may only evict a SPENT record outright. An ACTIVE one is marked
// `evictOnRelease` and kept until its winner finishes: a recovery waiter retains
// its pre-removal target and deliberately does not reselect on timeout, so a
// later waiter for the same stuck lease still reaches `acquireBackupProbePermit`
// — and deleting the record under it would hand out a SECOND ungated request for
// the same lease generation, against an account that no longer exists. Retaining
// the record keeps those waiters refused; the eviction happens on release.
const backupProbePermits = new Map<
	string,
	{ generation: number | null; active: boolean; evictOnRelease: boolean }
>();

/** Opaque handle for a granted backup-probe permit. Release it in a `finally`. */
export interface BackupProbePermit {
	accountId: string;
	generation: number | null;
}

// --- Capacity-restored single-flight marker ---------------------------------
//
// An account released EARLY by the usage poller (its cooldown cleared before the
// deadline) becomes selectable again in one step, with `consecutive_rate_limits`
// still at 0 and no cooldown deadline left behind. Neither of those facts
// engages the mature-streak gate above, so without a dedicated marker every
// concurrent request would stampede an account whose recovery is, by
// construction, a guess about the provider's state.
//
// accountId → the reservation currently owning the slot. The generation exists
// so an OLD probe can never clear a NEWER restore's marker (release → re-lock →
// release again while the first probe is still in flight).
const capacityRestoredPending = new Map<string, CapacityProbeReservation>();
let capacityGenerationCounter = 0;

export type RateLimitProbeAdmission =
	| "not_required"
	| "admitted"
	| "suppressed";

/**
 * A capacity-restored reservation — a node in the per-account reservation chain.
 * It links to the reservation it displaced, so unwinding restores real state
 * rather than erasing it, and carries its own outcome so a predecessor that
 * ALSO failed is never resurrected.
 *
 * Opaque to callers: hand it back to
 * {@link rollbackCapacityRestoredProbePending} and nothing else.
 */
export interface CapacityProbeReservation {
	accountId: string;
	/** The generation this reservation armed. */
	generation: number;
	/** The reservation this one displaced, or null if the slot was empty. */
	previous: CapacityProbeReservation | null;
	/**
	 * Set once this reservation's clear is known to have failed. A rolled-back
	 * reservation is never restored as anyone else's predecessor — otherwise two
	 * overlapping failed clears would leave a marker pending for a restore that
	 * never happened, and markers deliberately never expire, so a healthy
	 * account would be single-flighted forever.
	 */
	rolledBack: boolean;
}

/**
 * Walk back to the first reservation that has NOT been rolled back — the state
 * the slot should hold once `from` unwinds. Null when every ancestor failed.
 */
function firstLiveReservation(
	from: CapacityProbeReservation | null,
): CapacityProbeReservation | null {
	let node = from;
	while (node?.rolledBack) node = node.previous;
	return node;
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
	const reservation: CapacityProbeReservation = {
		accountId,
		generation: capacityGenerationCounter,
		previous: capacityRestoredPending.get(accountId) ?? null,
		rolledBack: false,
	};
	capacityRestoredPending.set(accountId, reservation);
	return reservation;
}

/**
 * Undo a reservation whose clear never committed, restoring the most recent
 * predecessor that is still LIVE (not itself rolled back).
 *
 * Two failure modes this has to thread between, both real:
 *  - Erasing is wrong. The capacity callback is fire-and-forget, so two can
 *    overlap: reserve 1 → reserve 2 → CAS 1 SUCCEEDS → CAS 2 fails. Deleting on
 *    that rollback would leave an account that IS unlocked with no marker at all
 *    — and with the streak still 0, nothing else gates the fan-in. The same
 *    applies to a marker retained across `cooldown_reapplied`.
 *  - Blindly restoring is also wrong. If BOTH CASes fail and the older one
 *    unwinds first, its rollback is a slot no-op (2 owns the slot) — so without
 *    per-reservation state, 2's rollback would restore 1 and leave a marker
 *    pending for a restore that never happened. Markers never expire, so a
 *    healthy account would be single-flighted forever.
 *
 * Marking the node resolves both: the rollback always records THIS reservation's
 * outcome (even when it no longer owns the slot), and the owner unwinds to the
 * first ancestor that has not been rolled back — or clears the slot when every
 * ancestor failed.
 */
export function rollbackCapacityRestoredProbePending(
	reservation: CapacityProbeReservation,
): void {
	// Record the outcome unconditionally: a newer reservation currently owning
	// the slot must be able to see, later, that this predecessor failed.
	reservation.rolledBack = true;
	const { accountId } = reservation;
	if (capacityRestoredPending.get(accountId) !== reservation) return;
	const restored = firstLiveReservation(reservation.previous);
	if (restored === null) {
		capacityRestoredPending.delete(accountId);
	} else {
		capacityRestoredPending.set(accountId, restored);
	}
}

/**
 * Drop an account's in-memory recovery-probe state: the capacity-restored marker
 * AND its spent backup-probe permit record. For account REMOVAL only — the
 * marker is otherwise cleared exclusively by a successful probe of the matching
 * generation (or a process restart).
 *
 * The marker is deliberately NEVER time-expired: a family gate, an open 529
 * breaker or a pinned client can legitimately delay probing indefinitely, and
 * expiring it would reopen fan-in at exactly the moment the account finally
 * becomes selectable. Both maps are keyed by account id, so they are bounded by
 * account count — but only while removal evicts them: a deleted id would
 * otherwise keep its spent-permit record forever on a long-lived server, and a
 * retained `null`-generation record would deny a legitimate no-live-lease claim
 * if that id were ever restored.
 *
 * Only a SPENT permit is safe to evict here. An ACTIVE one still has a bypass in
 * flight, and further waiters on that same stuck lease must stay refused — so it
 * is marked for eviction and dropped by {@link releaseBackupProbePermit}.
 * Deleting it outright would re-open a second ungated request per lease
 * generation, which is exactly the guarantee this permit exists to hold.
 */
export function clearCapacityRestoredProbePending(accountId: string): void {
	capacityRestoredPending.delete(accountId);
	const permit = backupProbePermits.get(accountId);
	if (permit === undefined) return;
	if (permit.active) {
		permit.evictOnRelease = true;
		return;
	}
	backupProbePermits.delete(accountId);
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

/** What {@link inspectProbeGate} observed about an account's gate state. */
interface ProbeGateInspection {
	/**
	 * True when this account is subject to the single-flight recovery-probe gate
	 * at all — i.e. a mature cooldown streak whose deadline has expired, or an
	 * owed capacity-restored probe. False means "ordinary account, not gated".
	 */
	gatingRequired: boolean;
	/** The pending capacity-restored generation, or undefined when none is owed. */
	capacityGeneration: number | undefined;
}

/**
 * The ONE definition of "is this account gated, and by which capacity
 * generation". {@link getRateLimitProbeAdmission} (which then takes a lease) and
 * {@link wouldSuppressProbe} (which must not perturb anything) both consume it,
 * so the read-only predicate can never drift from the authoritative gate.
 *
 * PURE: no pruning, no lease acquisition, no logging. Both of those stay
 * exclusively inside `getRateLimitProbeAdmission`.
 */
function inspectProbeGate(account: Account, now: number): ProbeGateInspection {
	const expiredMatureCooldown =
		account.consecutive_rate_limits >= MATURE_COOLDOWN_STREAK &&
		account.rate_limited_until != null &&
		account.rate_limited_until <= now;
	const capacityGeneration = capacityRestoredPending.get(
		account.id,
	)?.generation;
	return {
		gatingRequired: expiredMatureCooldown || capacityGeneration !== undefined,
		capacityGeneration,
	};
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
 *
 * IMPORTANT — "suppressed" is not "failed". Nothing was attempted, so a caller
 * whose candidates are ALL suppressed knows nothing about any of them and must
 * NOT fall through to a terminal error: that would 503 a request against a pool
 * of healthy accounts, none of which was ever tried. Callers recover by waiting
 * out the in-flight probe ({@link awaitProbeRelease}) and, only if that wait
 * times out, attempting the first suppressed candidate ungated. See the
 * recovery path in `proxy.ts`.
 */
export function getRateLimitProbeAdmission(
	account: Account,
	now: number = Date.now(),
): RateLimitProbeAdmission {
	const { gatingRequired, capacityGeneration } = inspectProbeGate(account, now);
	if (!gatingRequired) return "not_required";

	pruneProbeLeases(now);
	const existingLease = probeLeases.get(account.id);
	if (existingLease && existingLease.leaseUntil > now) {
		log.debug(
			`[clankermux] account=${account.name} cooldown_probe_suppressed lease_until=${new Date(existingLease.leaseUntil).toISOString()}`,
		);
		return "suppressed";
	}

	const leaseUntil = now + PROBE_LEASE_MS;
	probeLeaseGenerationCounter += 1;
	// A new lease supersedes any SPENT bypass record for this account: the record
	// only ever guards its own generation, and acquisition would discard it on the
	// next claim anyway. Dropping it here keeps the map from carrying dead
	// generations (including the `null` "no live lease" key, which would otherwise
	// deny a legitimate later no-lease claim). An ACTIVE record is left alone —
	// its winner is still in flight and must be able to release it.
	if (backupProbePermits.get(account.id)?.active === false) {
		backupProbePermits.delete(account.id);
	}
	// Record WHICH capacity generation this probe was admitted for, so its
	// outcome can only ever clear that generation's marker. The lease generation
	// is separate and identifies THIS lease (see the backup-probe permit).
	probeLeases.set(account.id, {
		leaseUntil,
		capacityGeneration,
		leaseGeneration: probeLeaseGenerationCounter,
	});
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
			capacityRestoredPending.get(account.id)?.generation ===
				lease.capacityGeneration
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

/**
 * Would {@link getRateLimitProbeAdmission} refuse this account right now?
 *
 * Side-effect free: it asks the SHARED {@link inspectProbeGate} inspector (the
 * same one the real gate consumes, so the two can never disagree), reads
 * `probeLeases` WITHOUT pruning, and takes no lease — so it is safe to call from
 * a decision path that must not perturb gate state.
 *
 * Used to decide whether an attempt is the request's LAST realistic one: a
 * remaining candidate that would only be suppressed cannot serve as fallback, so
 * a real upstream 529 body must be forwarded rather than discarded in favour of
 * a generic 503.
 */
export function wouldSuppressProbe(
	account: Account,
	now: number = Date.now(),
): boolean {
	if (!inspectProbeGate(account, now).gatingRequired) return false;
	const existingLease = probeLeases.get(account.id);
	return existingLease !== undefined && existingLease.leaseUntil > now;
}

/**
 * Atomically claim the RIGHT to attempt `accountId` ungated after a recovery
 * hold expired without a verdict.
 *
 * At most ONE permit is ever granted per (account, lease generation): the losers
 * get `null` and must fall through to their caller's normal terminals. Without
 * this, a stuck probe on a one-account pool lets every waiter bypass the gate at
 * the same instant — unbounded fan-in onto the account the gate is protecting.
 *
 * Synchronous and allocation-cheap by design: the check-and-claim must not be
 * split by an await, or two waiters could interleave between them.
 *
 * @returns the permit to release in a `finally`, or `null` when this account's
 *   bypass for the current lease generation is already spoken for.
 */
export function acquireBackupProbePermit(
	accountId: string,
	now: number = Date.now(),
): BackupProbePermit | null {
	const lease = probeLeases.get(accountId);
	// A lease that is still live identifies the generation being waited on. With
	// none live (it expired while we waited, or was never taken) `null` is its own
	// generation key — still exactly one bypass, and superseded by the next real
	// lease.
	const generation =
		lease && lease.leaseUntil > now ? lease.leaseGeneration : null;
	const existing = backupProbePermits.get(accountId);
	if (existing && existing.generation === generation) return null;
	backupProbePermits.set(accountId, {
		generation,
		active: true,
		evictOnRelease: false,
	});
	return { accountId, generation };
}

/**
 * Release a granted backup-probe permit. The RECORD of the bypass is retained
 * (only its in-flight flag clears): the one-bypass-per-lease-generation
 * guarantee must survive the winner finishing, or the next waiter — whose budget
 * expires moments later against the same stuck probe — would bypass too.
 *
 * The single exception is an account REMOVED while this bypass was in flight:
 * `clearCapacityRestoredProbePending` could not evict a live record without
 * re-opening the bypass, so it deferred the eviction to here.
 */
export function releaseBackupProbePermit(permit: BackupProbePermit): void {
	const existing = backupProbePermits.get(permit.accountId);
	if (!existing || existing.generation !== permit.generation) return;
	if (existing.evictOnRelease) {
		backupProbePermits.delete(permit.accountId);
		return;
	}
	existing.active = false;
}

/** Test-only: is a backup-probe bypass currently in flight for this account? */
export function isBackupProbePermitActive(accountId: string): boolean {
	return backupProbePermits.get(accountId)?.active === true;
}

/**
 * Remaining lifetime (ms) of an account's in-flight recovery-probe lease, or
 * `null` when no live lease is held.
 *
 * Read-only: it deliberately does NOT prune, so it can be called from a hot
 * decision path without mutating gate state.
 */
export function getProbeLeaseRemainingMs(
	accountId: string,
	now: number = Date.now(),
): number | null {
	const lease = probeLeases.get(accountId);
	if (!lease || lease.leaseUntil <= now) return null;
	return lease.leaseUntil - now;
}

/**
 * Bounded wait for an account's in-flight recovery probe to reach a verdict.
 *
 * A probe lease is released at RESPONSE-HEADER time (response-processor's
 * `completeRateLimitProbe(account, response.ok ? "recovered" : "abandoned")`),
 * not at stream end, so the common wait here costs time-to-first-byte rather
 * than a whole generation. That is what makes waiting viable at all.
 *
 * The wait is bounded by `min(maxWaitMs, remaining lease)`: a lease that is
 * already nearly expired needs no further waiting, and a caller must never be
 * held for the full two-minute lease.
 *
 * @returns `true` when the lease was released (or was never held) within the
 *   bound, `false` on timeout or client abort. A `false` return means the caller
 *   still has no verdict and must fall back rather than keep waiting.
 */
export async function awaitProbeRelease(
	accountId: string,
	maxWaitMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	const now = Date.now();
	const leaseRemaining = getProbeLeaseRemainingMs(accountId, now);
	if (leaseRemaining === null) return true;
	const deadline = now + Math.min(maxWaitMs, leaseRemaining);
	while (Date.now() < deadline) {
		if (signal?.aborted) return false;
		const wait = Math.min(PROBE_RELEASE_POLL_MS, deadline - Date.now());
		if (wait > 0) {
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
		if (getProbeLeaseRemainingMs(accountId) === null) return true;
	}
	return getProbeLeaseRemainingMs(accountId) === null;
}

/** Test-only: clears all in-memory probe leases/markers between test cases. */
export function resetRateLimitProbeGatesForTests(): void {
	probeLeases.clear();
	capacityRestoredPending.clear();
	backupProbePermits.clear();
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
