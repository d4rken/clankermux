const DAY_MS = 86_400_000;

/**
 * date-fns format string for the Usage Over Time x-axis. The label must
 * disambiguate the day once the visible span exceeds 24h:
 *   • daily buckets (30d) floor to midnight → date-only "MMM d";
 *   • a multi-day span with sub-daily buckets (7d) → date + time "MMM d HH:mm",
 *     else every hourly "HH:mm" repeats across days with no way to tell them apart;
 *   • ≤24h → time-only "HH:mm".
 *
 * @param bucketMs width of each history bucket in ms (0 before any history exists)
 * @param rangeMs total visible span in ms (the selected range)
 */
export function pickTimePattern(bucketMs: number, rangeMs: number): string {
	if (bucketMs >= DAY_MS) return "MMM d";
	if (rangeMs > DAY_MS) return "MMM d HH:mm";
	return "HH:mm";
}
