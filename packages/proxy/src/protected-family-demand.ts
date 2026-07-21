/**
 * In-memory tracker of recent protected-family (Fable) demand per account.
 *
 * Records, per account, the epoch-ms timestamp of the most recent request that
 * the account served for the protected model family (Fable). The shared-window
 * reservation gate reads this hint to *demand-target* its weekly reservation:
 * an account's weekly quota is only reserved for Fable when Fable has actually
 * been routing to that account, so idle accounts aren't needlessly held back.
 *
 * This is a routing hint, NOT persisted state. On process restart the map is
 * empty (cold-start) and stays empty for an account until its first
 * protected-family request re-populates it. That is acceptable because the
 * reservation gate fails open: with no recorded demand it applies no weekly
 * reservation, so a cold map at worst delays a reservation until the first
 * post-restart Fable request — it never over-reserves.
 */

const lastDemand = new Map<string, number>();

/**
 * Record that `accountId` served the protected family (Fable) at `now`
 * (epoch ms), overwriting any earlier timestamp.
 */
export function recordProtectedFamilyDemand(
	accountId: string,
	now: number,
): void {
	lastDemand.set(accountId, now);
}

/**
 * Return the last recorded protected-family-use timestamp (epoch ms) for
 * `accountId`, or `null` if the account has no recorded demand.
 */
export function getLastProtectedFamilyDemand(accountId: string): number | null {
	return lastDemand.get(accountId) ?? null;
}
