import type { CapacitySignal } from "@clankermux/types";

/**
 * Weekly headroom (percent) below which remaining quota is held as failover
 * capacity instead of harvested.
 */
export const LIVENESS_RESERVE_HEADROOM_PCT = 10;

/**
 * How long before the BINDING weekly reset the reserve releases. 12h.
 * DELIBERATELY may not fully drain a 10% tail (observed burn ~15.8%/day ⇒ a
 * 10% tail needs ~15h): liveness is prioritized over complete harvest,
 * because the failure this gate exists to prevent is a total-pool outage,
 * and a partially unspent tail is a far cheaper loss. Revisit if waste
 * becomes visible in practice.
 */
export const LIVENESS_RESERVE_RELEASE_HORIZON_MS = 12 * 60 * 60 * 1000;

/**
 * Whether `capacity`'s account can absorb traffic that the pool-liveness reserve
 * is steering AWAY from another account right now.
 *
 * This is the "is anyone else actually able to take this?" half of the reserve.
 * The reserve only makes sense while some peer can serve the request instead;
 * demoting the last account able to serve would trade a liveness reserve for an
 * immediate outage, which is strictly worse.
 *
 * All three conditions must hold:
 *
 *  - **Fresh capacity with `minHeadroom >= LIVENESS_RESERVE_HEADROOM_PCT`.**
 *    `minHeadroom` (the min across ALL hard windows), NOT `weeklyHeadroom`: a
 *    peer whose 5h session is momentarily spent has plenty of weekly quota but
 *    cannot serve right now — and a peer cooling off its 5h window is exactly
 *    the failover case the reserve exists for. Counting it would let the reserve
 *    fire precisely when it must not.
 *    `>=` is deliberate: `resolvePoolLivenessDemotion` reserves at `< 10`, so
 *    `>= 10` here leaves NO dead zone at exactly 10 — every account is either
 *    reserved or absorbing, never neither.
 *  - **Not family-reserved.** A peer the family-reservation gate is holding for
 *    the protected family cannot also be counted on to absorb this traffic; it
 *    was just demoted for the opposite reason.
 *  - **No pending capacity-restored recovery probe.** A capacity-restored
 *    account admits exactly ONE probe and suppresses concurrent requests, so it
 *    is not a general-purpose absorber until that probe resolves.
 */
export function isAbsorbablePeer(
	capacity: CapacitySignal | null,
	familyReserved: boolean,
	owesRecoveryProbe: boolean,
): boolean {
	if (capacity === null) return false;
	if (!Number.isFinite(capacity.minHeadroom)) return false;
	if (capacity.minHeadroom < LIVENESS_RESERVE_HEADROOM_PCT) return false;
	if (familyReserved) return false;
	if (owesRecoveryProbe) return false;
	return true;
}

/**
 * Pure per-account decision for the pool-liveness reserve routing gate.
 *
 * Returns `true` to DEMOTE the request away from this account (move it to the
 * BACK of the candidate list so a peer is tried first), holding the last
 * `LIVENESS_RESERVE_HEADROOM_PCT` of its weekly quota as failover capacity.
 * Returns `false` to KEEP the account in place.
 *
 * ## Why the reserve exists
 *
 * The session strategy ranks accounts FEFO on the WEEKLY reset — deliberately
 * draining the soonest-expiring account first so unused weekly budget is not
 * lost. That is right for budget and wrong for liveness: it drives accounts to
 * weekly 100% one after another, and an account at weekly 100% is dead until its
 * weekly reset, up to seven days away. Holding back the tail keeps an account
 * alive to cover a peer whose (short, self-healing) 5h window is cooling.
 *
 * ## The three things that make it safe
 *
 *  - **Pool-aware (rule 4).** The reserve only fires while at least one OTHER
 *    account can actually absorb the traffic. With no absorbable peer the
 *    account is needed NOW and keeps its place. This also makes the gate
 *    self-disabling on degraded paths, where by construction no peer is healthy.
 *  - **Released before the weekly reset (rule 6).** Quota held past its reset is
 *    quota destroyed, so the reserve yields inside
 *    `LIVENESS_RESERVE_RELEASE_HORIZON_MS` of the BINDING weekly reset and the
 *    tail gets harvested.
 *  - **Soft only.** Like the family-reservation gate, this reorders and never
 *    excludes; it cannot empty the pool.
 *
 * ## Fail-open contract
 *
 * Every branch of missing or ambiguous evidence returns `false` (KEEP), matching
 * the family gate's contract: null (stale/unknown) capacity, a non-finite weekly
 * headroom, an unknown binding weekly reset. This gate is a soft preference and
 * must never sideline an account on thin evidence.
 */
export function resolvePoolLivenessDemotion(
	capacity: CapacitySignal | null,
	absorbablePeerCount: number,
	now: number,
): boolean {
	// 1. No fresh capacity signal → stale/unknown; fail open.
	if (capacity === null) return false;

	// 2. Weekly headroom must be a real number to compare against the band.
	if (!Number.isFinite(capacity.weeklyHeadroom)) return false;

	// 3. Only the tail of the weekly window is reserved. Strictly-less-than, so
	//    exactly LIVENESS_RESERVE_HEADROOM_PCT still serves — the complement of
	//    isAbsorbablePeer's `>=`, leaving no account in neither role.
	if (capacity.weeklyHeadroom >= LIVENESS_RESERVE_HEADROOM_PCT) return false;

	// 4. Pool-aware: with nobody able to absorb the traffic there is nothing to
	//    hand it to, and this account is needed now. Reserving here would cause
	//    the very outage the reserve exists to prevent.
	if (absorbablePeerCount < 1) return false;

	// 5. The release horizon is measured on the BINDING weekly window (the one
	//    whose headroom is low), not the earliest-resetting one — an unrelated,
	//    healthier window's sooner reset must not release the constrained one.
	//    Unknown / non-finite fails OPEN.
	if (!Number.isFinite(capacity.bindingWeeklyResetMs as number)) return false;

	// 6. Release before the weekly reset so the reserved tail is still spent:
	//    quota held past its reset is quota destroyed.
	if (
		(capacity.bindingWeeklyResetMs as number) - now <=
		LIVENESS_RESERVE_RELEASE_HORIZON_MS
	) {
		return false;
	}

	return true;
}
