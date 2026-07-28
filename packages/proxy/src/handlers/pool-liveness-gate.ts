import type { CapacitySignal } from "@clankermux/types";

const HOUR_MS = 3_600_000;

/**
 * Weekly headroom (percent) below which remaining quota is held as failover
 * capacity instead of harvested, for an ORDINARY (non-protected-family) request.
 * This is the outer tier: the pool as a whole stops draining an account here.
 */
export const LIVENESS_RESERVE_HEADROOM_PCT = 20;

/**
 * The inner tier: how deep a request the account would serve as the PROTECTED
 * family (Fable) may spend. Between this and `LIVENESS_RESERVE_HEADROOM_PCT` the
 * account is Fable-plus-emergencies only; below it, everything is held back as
 * true emergency capacity.
 */
export const LIVENESS_RESERVE_PROTECTED_HEADROOM_PCT = 10;

/** Lower clamp on the burn-aware release horizon. */
export const LIVENESS_RELEASE_HORIZON_MIN_MS = 12 * HOUR_MS;

/** Upper clamp on the burn-aware release horizon. */
export const LIVENESS_RELEASE_HORIZON_MAX_MS = 36 * HOUR_MS;

/**
 * The design burn assumption used when no usable slope evidence exists: 0.66
 * %/h, i.e. the documented ~15.8%/day observed pool burn. Scaling the tier's
 * threshold by it gives the time that tier's reserved tail actually needs to
 * drain — ≈15.2h for the protected tier, ≈30.3h for the non-protected one.
 */
export const LIVENESS_DESIGN_SLOPE_PCT_PER_HOUR = 0.66;

/** Options for a single `resolvePoolLivenessDemotion` decision. */
export interface PoolLivenessOptions {
	/**
	 * The reserve threshold for THIS request's tier, from
	 * `resolveLivenessReserveThreshold`. The same value must be handed to
	 * `isAbsorbablePeer` when counting this account's peers.
	 */
	reserveThresholdPct: number;
	/**
	 * The account's observed weekly burn (percent per hour), validated against the
	 * BINDING weekly window by `resolveEffectiveWeeklySlope`, or `null` when there
	 * is no usable evidence.
	 */
	weeklySlopePctPerHour: number | null;
}

/**
 * The reserve threshold for a request, and the ONLY place the two tiers are
 * chosen between. Both the demotion decision and the absorbable-peer count read
 * it, so the band and its complement can never drift apart.
 *
 * `protectedRequest` is whether THIS account would serve the request as the
 * protected family (Fable).
 */
export function resolveLivenessReserveThreshold(
	protectedRequest: boolean,
): number {
	return protectedRequest
		? LIVENESS_RESERVE_PROTECTED_HEADROOM_PCT
		: LIVENESS_RESERVE_HEADROOM_PCT;
}

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
 *  - **Fresh capacity with `minHeadroom >= reserveThresholdPct`.**
 *    `minHeadroom` (the min across ALL hard windows), NOT `weeklyHeadroom`: a
 *    peer whose 5h session is momentarily spent has plenty of weekly quota but
 *    cannot serve right now — and a peer cooling off its 5h window is exactly
 *    the failover case the reserve exists for. Counting it would let the reserve
 *    fire precisely when it must not.
 *    `reserveThresholdPct` is the DECIDING account's tier threshold (the tier of
 *    the request being routed), so `>=` here is the exact complement of
 *    `resolvePoolLivenessDemotion`'s `<` at the same tier — within a tier no
 *    account is in neither role.
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
	reserveThresholdPct: number,
): boolean {
	if (capacity === null) return false;
	if (!Number.isFinite(capacity.minHeadroom)) return false;
	if (capacity.minHeadroom < reserveThresholdPct) return false;
	if (familyReserved) return false;
	if (owesRecoveryProbe) return false;
	return true;
}

/**
 * Pure per-account decision for the pool-liveness reserve routing gate.
 *
 * Returns `true` to DEMOTE the request away from this account (move it to the
 * BACK of the candidate list so a peer is tried first), holding the tail of its
 * weekly quota as failover capacity. Returns `false` to KEEP the account in
 * place.
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
 * ## Two tiers, not one band
 *
 * The reserve is tiered by WHOSE traffic is asking (`reserveThresholdPct`, from
 * `resolveLivenessReserveThreshold`):
 *
 *  - Ordinary traffic stops at `LIVENESS_RESERVE_HEADROOM_PCT` (20%).
 *  - Traffic this account would serve as the protected family (Fable) may spend
 *    down to `LIVENESS_RESERVE_PROTECTED_HEADROOM_PCT` (10%).
 *
 * So the 10–20% band is Fable-plus-emergencies-only capacity, and below 10%
 * everything is held. The tier is a property of the REQUEST, not the account:
 * the same account is judged at different depths by different traffic.
 *
 * ## The three things that make it safe
 *
 *  - **Pool-aware (rule 4).** The reserve only fires while at least one OTHER
 *    account can actually absorb the traffic. With no absorbable peer the
 *    account is needed NOW and keeps its place. This also makes the gate
 *    self-disabling on degraded paths, where by construction no peer is healthy.
 *  - **Released before the weekly reset (rule 6).** Quota held past its reset is
 *    quota destroyed, so the reserve yields once the BINDING weekly reset comes
 *    inside the release horizon and the tail gets harvested.
 *  - **Soft only.** Like the family-reservation gate, this reorders and never
 *    excludes; it cannot empty the pool.
 *
 * ## The release horizon is burn-aware
 *
 * The horizon answers "how long would this tail take to actually drain?", so it
 * is computed from the account's OWN observed weekly burn where evidence exists:
 * `weeklyHeadroom / slope`, clamped to [`LIVENESS_RELEASE_HORIZON_MIN_MS`,
 * `LIVENESS_RELEASE_HORIZON_MAX_MS`]. Without a usable slope (absent, stale,
 * low-confidence, fitted on a different weekly window, or flat/negative) it falls
 * back to the TIER-SCALED static estimate
 * `reserveThresholdPct / LIVENESS_DESIGN_SLOPE_PCT_PER_HOUR` — ≈15.2h protected,
 * ≈30.3h non-protected.
 *
 * Two consequences worth stating outright:
 *
 *  - **Self-suppression is expected and bounded.** A well-reserved account stops
 *    receiving traffic, so its own slope collapses and `headroom / slope` pegs at
 *    the 36h max clamp. That is bounded EARLY release, chosen deliberately: it
 *    favors a complete drain of the tail over holding quota that would expire.
 *    The converse is what matters — under fail-open pool pressure the account IS
 *    being served, its slope is high, and the horizon shortens toward the time
 *    actually needed, so the reserve holds longer exactly when the pool is
 *    strained.
 *  - **Rule 4 still fail-opens BEFORE any release logic.** When no peer can
 *    absorb, the account keeps its place regardless of horizon or tier, so the
 *    "all backups cooling" erosion channel remains open BY DESIGN: serving the
 *    request now beats reserving into a 503.
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
	opts: PoolLivenessOptions,
): boolean {
	// 1. No fresh capacity signal → stale/unknown; fail open.
	if (capacity === null) return false;

	// 2. Weekly headroom must be a real number to compare against the band.
	if (!Number.isFinite(capacity.weeklyHeadroom)) return false;

	// 3. Only the tail of the weekly window is reserved, at THIS request's tier.
	//    Strictly-less-than, so exactly the threshold still serves — the
	//    complement of isAbsorbablePeer's `>=` at the same threshold, leaving no
	//    account in neither role.
	if (capacity.weeklyHeadroom >= opts.reserveThresholdPct) return false;

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
	//    quota held past its reset is quota destroyed. The horizon is the time
	//    this tail would actually need to drain.
	const horizonMs = resolveReleaseHorizonMs(capacity.weeklyHeadroom, opts);
	if ((capacity.bindingWeeklyResetMs as number) - now <= horizonMs) {
		return false;
	}

	return true;
}

/**
 * How long before the BINDING weekly reset the reserve releases: the observed
 * drain time (clamped) when a usable slope exists, else the tier-scaled static
 * estimate. Not exported — `resolvePoolLivenessDemotion` is the only consumer,
 * and the constants above document the resulting values.
 */
function resolveReleaseHorizonMs(
	weeklyHeadroom: number,
	opts: PoolLivenessOptions,
): number {
	const slope = opts.weeklySlopePctPerHour;
	if (slope !== null && Number.isFinite(slope) && slope > 0) {
		const drainMs = (weeklyHeadroom / slope) * HOUR_MS;
		return Math.min(
			LIVENESS_RELEASE_HORIZON_MAX_MS,
			Math.max(LIVENESS_RELEASE_HORIZON_MIN_MS, drainMs),
		);
	}
	return (
		(opts.reserveThresholdPct / LIVENESS_DESIGN_SLOPE_PCT_PER_HOUR) * HOUR_MS
	);
}
