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
