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
 * error directions are not symmetric: a false negative from clock skew costs one
 * poll — the next observation sees the stale near-now value as `prev` and the
 * real future reset as `new`, and detects the roll — whereas a false positive
 * repeats forever.
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
