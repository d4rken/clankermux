/**
 * Shared dashboard range → bucketing/lookback mapping, used by the analytics,
 * usage-history, and memory-history handlers so every time-series chart
 * buckets identically: 1h→1m, 6h→5m, 24h/7d→1h, 30d/all→1d.
 *
 * `windowMs: null` means "no lookback bound" (the all-time range). Each caller
 * derives its own cutoff semantics from it: analytics omits the timestamp
 * predicate entirely, the snapshot-history handlers scan from sinceMs 0 (their
 * tables are small and retention-capped, so an unbounded lookback stays cheap).
 * All-time uses daily buckets like 30d — anything finer produces thousands of
 * points over months of history. Unknown ranges fall back to the 24h window.
 */
export interface RangeConfig {
	/** Time-series bucket width. */
	bucketMs: number;
	/** Human label for the bucket width (e.g. "1h"), surfaced in responses. */
	displayName: string;
	/** Lookback duration, or null for the unbounded all-time range. */
	windowMs: number | null;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function getRangeConfig(range: string): RangeConfig {
	switch (range) {
		case "1h":
			return { bucketMs: MINUTE, displayName: "1m", windowMs: HOUR };
		case "6h":
			return { bucketMs: 5 * MINUTE, displayName: "5m", windowMs: 6 * HOUR };
		case "24h":
			return { bucketMs: HOUR, displayName: "1h", windowMs: DAY };
		case "7d":
			return { bucketMs: HOUR, displayName: "1h", windowMs: 7 * DAY };
		case "30d":
			return { bucketMs: DAY, displayName: "1d", windowMs: 30 * DAY };
		case "all":
			return { bucketMs: DAY, displayName: "1d", windowMs: null };
		default:
			return { bucketMs: HOUR, displayName: "1h", windowMs: DAY };
	}
}
