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
	/**
	 * When the reported reading was actually OBSERVED (ms since epoch), as
	 * opposed to `sampledAt`, which is the sampler tick's own clock. The tick
	 * accepts any cache entry younger than the freshness bound, so the two can
	 * differ by up to that bound. `null` on rows written before the column
	 * existed — unknown, never "same as sampledAt".
	 */
	observedAt: number | null;
	/**
	 * The account's plan tier as of this sample (e.g. "pro", "max"), or null on
	 * pre-column rows / when uncaptured. Recorded per sample because today's
	 * value on the accounts row would refile the whole history under a tier the
	 * account may have changed to since.
	 */
	planTier: string | null;
	/** The account's rate-limit tier as of this sample (e.g. "20x"), or null. */
	rateLimitTier: string | null;
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

/**
 * Raw (un-bucketed) read shape returned by `getRecentSnapshotsForAccounts` —
 * one row per stored sample, carrying the real sample time (not a bucket
 * start). Used by the usage-prediction service to build per-window time series.
 * Distinct from `RankedSnapshot`, whose `ts` is a floored bucket start and
 * would be misleading for regression.
 */
export interface UsageSnapshotSample {
	accountId: string;
	provider: string | null;
	/** epoch ms — the real sample time, not a bucket. */
	sampledAt: number;
	fiveHourPct: number | null;
	fiveHourReset: number | null;
	sevenDayPct: number | null;
	sevenDayReset: number | null;
	/**
	 * When the reported reading was actually OBSERVED (ms since epoch), as
	 * opposed to `sampledAt`, which is the sampler tick's own clock. The tick
	 * accepts any cache entry younger than the freshness bound, so the two can
	 * differ by up to that bound. `null` on rows written before the column
	 * existed — unknown, never "same as sampledAt".
	 */
	observedAt: number | null;
	/**
	 * The account's plan tier as of this sample (e.g. "pro", "max"), or null on
	 * pre-column rows / when uncaptured. Recorded per sample because today's
	 * value on the accounts row would refile the whole history under a tier the
	 * account may have changed to since.
	 */
	planTier: string | null;
	/** The account's rate-limit tier as of this sample (e.g. "20x"), or null. */
	rateLimitTier: string | null;
}

/**
 * Write shape for one per-model-family weekly window observed at a sampler tick
 * (`usage_scoped_snapshots`). One row per (account, tick, family): a single tick
 * emits as many rows as the provider reported scoped windows.
 *
 * `family` is the ROUTING family (opus/sonnet/haiku/fable). `displayName` is the
 * provider's own scope label ("Claude Opus 5") kept beside it because the family
 * mapping is lossy across generations — two generations of the same family are
 * indistinguishable from `family` alone, and history cannot be backfilled.
 *
 * `pct`/`resetAt` are nullable for the same reason the account-wide windows are:
 * absence of evidence is null, never a concrete 0.
 */
export interface ScopedUsageSnapshotRow {
	accountId: string;
	/** Sample time, ms since epoch — the sampler tick's shared `now`. */
	sampledAt: number;
	/** Routing family the provider's scope label resolved to. */
	family: string;
	/** The provider's scope model display name, or null when it had none. */
	displayName: string | null;
	/** Reported utilization % for this family's weekly window, or null. */
	pct: number | null;
	/** Window reset time, ms since epoch, or null when unknown. */
	resetAt: number | null;
}

/**
 * Raw read shape returned by the scoped-snapshot repository — one row per stored
 * sample at its real sample time (no bucketing). Structurally identical to
 * {@link ScopedUsageSnapshotRow}; kept as a separate name so the read and write
 * sides can diverge (as `UsageSnapshotRow` / `UsageSnapshotSample` already have)
 * without a rename at every call site.
 */
export interface ScopedUsageSnapshotSample {
	accountId: string;
	/** epoch ms — the real sample time, not a bucket. */
	sampledAt: number;
	family: string;
	displayName: string | null;
	pct: number | null;
	resetAt: number | null;
}
