/**
 * Parse a usage-window reset timestamp (ISO 8601 string or epoch ms) to epoch ms.
 * Returns null for null/undefined/unparseable input.
 */
export function toEpochMs(
	v: string | number | null | undefined,
): number | null {
	if (v == null) return null;
	const ms = typeof v === "number" ? v : new Date(v).getTime();
	return Number.isFinite(ms) ? ms : null;
}

/**
 * True only when a usage window has GENUINELY rolled to a new period: both
 * timestamps known, the new reset is strictly later than the previous one, the
 * previous reset time has already ARRIVED (prevResetAt <= now), AND the new
 * reset has NOT yet arrived (newResetAt > now).
 *
 * Both bounds are load-bearing, and each fixes a different observed churn:
 *
 *  - `prevResetAt <= now` — Anthropic/Codex usage endpoints re-report a
 *    still-future reset with sub-second jitter on each poll (e.g.
 *    10:40:00.641Z -> 10:40:00.856Z). Without this, that drift was mistaken for
 *    a new window and churned session_start (flapping the dashboard Primary
 *    badge).
 *
 *  - `newResetAt > now` — an IDLE Codex 5h window reports `resets_at` tracking
 *    the wall clock, so every poll sees a reset later than the last one yet
 *    still in the past. Both of the other conditions hold and nothing has
 *    rolled. Production logged 843 such "rollovers" in 12.7h on one idle
 *    account, each resetting session state. A window that has genuinely rolled
 *    always has its next reset in the FUTURE.
 *
 * The second bound is deliberately strict (no skew tolerance) because the two
 * error directions are not symmetric: a false positive repeats forever, while a
 * false negative is at worst a single missed roll. For the polling caller
 * (`UsageFetcher.notifyWindowReset`) it is not even that — it compares against
 * the cached baseline BEFORE overwriting it, so the next poll sees the stale
 * near-now value as `prev` and the real future reset as `new` and detects the
 * roll one cycle late.
 *
 * Callers whose baseline can EXPIRE between observations do not get that
 * recovery: if the baseline is gone the next comparison starts from null and the
 * roll is simply missed. The codex observation path is one such caller (its
 * baseline is the evicting `usageCache.get()`), which is why the scheduler keeps
 * its prime cadence inside USAGE_CACHE_TTL_MS. A caller that cannot hold that
 * invariant should persist the last observed reset itself rather than widen this
 * bound.
 *
 * Note the strictness costs nothing against real provider behaviour: Anthropic
 * and Codex report a window END, zai a `resetAt`, MiniMax an `end_time` — none
 * reports a window START — and ordinary clock skew cannot move a newly opened
 * window's end behind local `now`.
 */
export function isGenuineWindowRoll(
	prevResetAt: number | null,
	newResetAt: number | null,
	now: number,
): boolean {
	return (
		prevResetAt !== null &&
		newResetAt !== null &&
		newResetAt > prevResetAt &&
		prevResetAt <= now &&
		newResetAt > now
	);
}
