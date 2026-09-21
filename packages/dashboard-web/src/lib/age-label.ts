/**
 * How long ago an instant was, in one unit: `5s ago`, `2m ago`, `2h ago`,
 * `3d ago`.
 *
 * The clock is a parameter rather than `Date.now()` so a page that ticks one
 * shared `now` renders every age it shows on the same tick, and so a test can
 * assert an exact string.
 */
export function ageLabel(atMs: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - atMs) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}
