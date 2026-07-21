import {
	getExhaustedFamilies,
	getModelFamily,
	isProtectedFamily,
	type ModelFamily,
	PROTECTED_FAMILY,
} from "@clankermux/core";
import type { AnyUsageData } from "@clankermux/providers";
import type {
	Account,
	AnthropicUsageData,
	CapacitySignal,
} from "@clankermux/types";

/**
 * Fraction of a shared window (as a whole-number percent of remaining headroom)
 * we keep in reserve for the protected family. When an account's remaining
 * headroom on a reserved axis drops BELOW this, a non-protected request is
 * demoted off the account so the tail of the window stays available for Fable.
 * Strictly-less-than: exactly `RESERVE_HEADROOM_PCT` left still serves.
 */
export const RESERVE_HEADROOM_PCT = 25;

/**
 * How recently the account must have actually served the protected family for
 * its WEEKLY quota to be reserved for Fable. The 7d axis is demand-targeted:
 * without observed Fable demand inside this window we do not hold weekly quota,
 * so an account Fable never routes to is not needlessly sidelined. 60 minutes.
 */
export const PROTECTED_FAMILY_DEMAND_LOOKBACK_MS = 3_600_000; // 60 min

/**
 * How close to the weekly reset boundary we STOP reserving weekly quota. The
 * protected family's own weekly window resets at the same wall-clock as the
 * account-wide weekly window, so any quota reserved this close to the boundary
 * would simply expire unused — better to let the current non-protected request
 * harvest it. Inside this horizon the 7d reservation yields. 2 hours. An UNKNOWN
 * (null) binding-weekly reset also yields (fails open): we only hold weekly quota
 * when we KNOW the binding window's reset lies beyond this horizon.
 */
export const WEEKLY_HARVEST_YIELD_HORIZON_MS = 7_200_000; // 2 h

/**
 * Pure per-account decision for the shared-window quota-reservation routing gate.
 *
 * Returns `true` to DEMOTE the given NON-protected request away from `account`
 * (move the account to the back of the candidate list so a less-constrained peer
 * is tried first), preserving the tail of a shared usage window for the protected
 * family (Fable). Returns `false` to KEEP the account in place.
 *
 * ## Why the two axes are asymmetric
 *
 * The 5h session window and the 7d weekly window are both shared across all model
 * families on an Anthropic account, but they behave differently near their reset,
 * so the reservation is gated differently on each:
 *
 *  - **5h axis — unconditional & self-healing.** The 5h window rolls every few
 *    hours, so quota we decline to spend now is recovered soon regardless of who
 *    was demanding it. Reserving whenever session headroom is low costs almost
 *    nothing (the peer we route to shares the same short window) and needs no
 *    demand signal. So low `sessionHeadroom` alone demotes.
 *
 *  - **7d axis — demand-gated & harvest-yielding.** The weekly window is
 *    expensive to hold: quota reserved here is unavailable for a full week. We
 *    therefore only reserve weekly quota when (a) Fable has ACTUALLY been routing
 *    to this account recently (`recentDemand`) — reserving for a family that never
 *    shows up just wastes the account — AND (b) we are NOT near the weekly reset
 *    boundary (`!nearReset`), measured on the BINDING weekly window (the one whose
 *    headroom is low), not the earliest-resetting one. The protected family's OWN
 *    weekly window resets at the same wall-clock as this shared weekly window, so
 *    any quota we hold in the last couple of hours would expire unused for Fable
 *    too; near the boundary the reservation yields and the current request harvests
 *    the remainder. An UNKNOWN (null) binding-weekly reset yields too (fails open):
 *    we only hold weekly quota when we KNOW the binding reset is beyond the horizon.
 *
 * ## Fail-open contract
 *
 * Every branch of missing or ambiguous evidence returns `false` (KEEP). This gate
 * only ever REORDERS candidates as a soft preference; it must never be the thing
 * that sidelines an account on thin evidence — the account-wide cooldown and the
 * hard family-weekly gate remain the real guards. Fail-open triggers: an
 * unresolvable/absent family, the request already being the protected family, a
 * non-Anthropic account, null (stale/unknown) capacity, the protected family
 * already exhausted on this account (nothing left to protect), or a non-finite
 * headroom on the axis under test.
 *
 * `getExhaustedFamilies` normalizes any shape and returns `[]` for non-Anthropic
 * usage data, so the cast below is safe — mirrors `resolveFamilyWeeklyExclusion`
 * in family-weekly-gate.ts.
 */
export function resolveReservationDemotion(
	account: Account,
	modelForGate: string | null,
	usageData: AnyUsageData | null,
	capacity: CapacitySignal | null,
	lastProtectedDemandMs: number | null,
	now: number,
): boolean {
	// 1. Resolve the requested family. Unresolvable → fail open. Reserving FOR the
	//    protected family against itself is nonsensical: never demote Fable.
	const family: ModelFamily | null = modelForGate
		? getModelFamily(modelForGate)
		: null;
	if (family === null) return false;
	if (isProtectedFamily(family)) return false;

	// 2. Only Anthropic accounts have a per-family shared quota to reserve FOR
	//    today. Generalization hook: when Codex gains per-family quota,
	//    `getModelFamily` must learn `gpt-*` IDs and this branch relaxes to
	//    include the Codex provider.
	if (account.provider !== "anthropic") return false;

	// 3. No fresh capacity signal → stale/unknown; fail open.
	if (capacity === null) return false;

	// 4. PRECONDITION: only reserve if this account can still serve the protected
	//    family. If Fable is itself exhausted here there is nothing left to
	//    protect, so demoting other families would be pointless. `getExhaustedFamilies`
	//    returns [] for non-Anthropic shapes, so the cast is safe. Absence of a
	//    scoped Fable entry is treated as "Fable still serveable" ON PURPOSE — this
	//    is a deliberate flat-only policy, not an oversight:
	//      - 7d axis: demand-targeting already prevents reserving weekly quota for a
	//        family that can't serve. An exhausted Fable never produces a successful
	//        serve, so it never records demand, so `recentDemand` stays false and the
	//        weekly reservation self-disables without needing scoped exhaustion data.
	//      - 5h axis: remains BEST-EFFORT protection keyed purely on shared-window
	//        headroom. Absent positive per-family (scoped) evidence of exhaustion we
	//        protect the shared window rather than disable the feature (protecting
	//        Fable's tail is the whole point). Only POSITIVE scoped evidence of Fable
	//        exhaustion skips the reservation.
	const data = (usageData ?? undefined) as AnthropicUsageData | undefined;
	if (
		getExhaustedFamilies(data, now).some((e) => e.family === PROTECTED_FAMILY)
	) {
		return false;
	}

	// 5. 5h AXIS (unconditional, self-healing): low session headroom alone demotes.
	if (
		Number.isFinite(capacity.sessionHeadroom) &&
		capacity.sessionHeadroom < RESERVE_HEADROOM_PCT
	) {
		return true;
	}

	// 6. 7d AXIS (demand-targeted + harvest-yield): only reserve weekly quota when
	//    Fable demanded this account recently AND we are not near the weekly reset.
	if (
		Number.isFinite(capacity.weeklyHeadroom) &&
		capacity.weeklyHeadroom < RESERVE_HEADROOM_PCT
	) {
		const recentDemand =
			lastProtectedDemandMs != null &&
			now - lastProtectedDemandMs <= PROTECTED_FAMILY_DEMAND_LOOKBACK_MS;
		// Use the BINDING weekly window's reset (the one whose headroom is low),
		// not the earliest reset across all weekly windows — an unrelated
		// sooner-resetting window must not make us yield the constrained one. An
		// UNKNOWN (null) OR non-finite binding reset FAILS OPEN → treated as
		// near-reset so we do NOT demote: we only reserve weekly quota when we KNOW
		// the binding window's reset is beyond the horizon.
		const nearReset =
			!Number.isFinite(capacity.bindingWeeklyResetMs as number) ||
			(capacity.bindingWeeklyResetMs as number) - now <=
				WEEKLY_HARVEST_YIELD_HORIZON_MS;
		if (recentDemand && !nearReset) return true;
	}

	// 7. No axis triggered — keep the account.
	return false;
}
