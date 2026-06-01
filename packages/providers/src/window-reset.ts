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
 * timestamps known, the new reset is strictly later than the previous one,
 * AND the previous reset time has already ARRIVED (prevResetAt <= now).
 *
 * The `prevResetAt <= now` guard is essential: Anthropic/Codex usage endpoints
 * re-report a still-future reset with sub-second jitter on each poll
 * (e.g. 10:40:00.641Z -> 10:40:00.856Z). Without the guard that drift was
 * mistaken for a new window and churned session_start (flapping the dashboard
 * Primary badge).
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
		prevResetAt <= now
	);
}
