// Usage snapshot types — append-only time-series of account rate-limit
// utilization, sampled at a regular cadence and read back as bucketed
// last-value-per-bucket series for the dashboard "sawtooth" graph.

/**
 * Write shape for a single usage-snapshot sample (one account, one tick).
 *
 * Utilization percentages and reset timestamps are nullable: a window may be
 * unknown (account never primed it, provider didn't report it, etc.). `provider`
 * is a denormalized copy of the owning account's provider string (e.g.
 * 'anthropic'/'codex') kept for interpretability when reading the series.
 */
export interface UsageSnapshotRow {
	accountId: string;
	provider: string | null;
	/** Sample time, ms since epoch. */
	sampledAt: number;
	/** 5-hour window utilization %, or null when unknown. */
	fiveHourPct: number | null;
	/** 5-hour window reset time, ms since epoch, or null when unknown. */
	fiveHourReset: number | null;
	/** 7-day window utilization %, or null when unknown. */
	sevenDayPct: number | null;
	/** 7-day window reset time, ms since epoch, or null when unknown. */
	sevenDayReset: number | null;
}

/**
 * Read shape returned by `getSnapshots` — one row per (account, time bucket),
 * carrying the latest sample observed within that bucket. `ts` is the bucket's
 * floored start time in ms (sampledAt / bucketMs * bucketMs).
 */
export interface RankedSnapshot {
	accountId: string;
	provider: string | null;
	/** Bucket start, ms since epoch. */
	ts: number;
	fiveHourPct: number | null;
	sevenDayPct: number | null;
	fiveHourReset: number | null;
	sevenDayReset: number | null;
}
