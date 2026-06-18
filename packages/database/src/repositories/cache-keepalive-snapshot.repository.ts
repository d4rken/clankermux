import { BaseRepository } from "./base.repository";

/**
 * Write shape for a single cache-keepalive sample (one tick).
 *
 * Gauges (`warmSessions`/`promotedSessions`/`totalBytes`) are point-in-time;
 * the counters (`keepalivesSent`/`hits`/`misses`/`failures`/`spentUsd`/
 * `savedUsd`) are CUMULATIVE-since-process-restart running totals captured at
 * sample time.
 */
export interface CacheKeepaliveSnapshotRow {
	/** Sample time, ms since epoch. */
	sampledAt: number;
	/** GAUGE: warm cache sessions currently tracked. */
	warmSessions: number;
	/** GAUGE: promoted (long-lived) cache sessions currently tracked. */
	promotedSessions: number;
	/** GAUGE: total bytes held across warm sessions. */
	totalBytes: number;
	/** CUMULATIVE: keepalive requests sent since process restart. */
	keepalivesSent: number;
	/** CUMULATIVE: cache hits since process restart. */
	hits: number;
	/** CUMULATIVE: cache misses since process restart. */
	misses: number;
	/** CUMULATIVE: keepalive failures since process restart. */
	failures: number;
	/** CUMULATIVE: USD spent on keepalive requests since process restart. */
	spentUsd: number;
	/** CUMULATIVE: estimated USD saved by cache hits since process restart. */
	savedUsd: number;
}

/**
 * Read shape — one row per time bucket. Gauges carry the peak (MAX) observed
 * within the bucket; cumulative counters carry the value at the latest sample
 * in the bucket. `ts` is the bucket's floored start time in ms
 * (sampledAt / bucketMs * bucketMs).
 */
export interface CacheKeepaliveHistoryPoint {
	ts: number;
	warmSessions: number;
	promotedSessions: number;
	totalBytes: number;
	keepalivesSent: number;
	hits: number;
	misses: number;
	failures: number;
	spentUsd: number;
	savedUsd: number;
}

/**
 * Repository for the `cache_keepalive_snapshots` time-series — an append-only
 * history of the cache-keepalive feature's health, backing the dashboard
 * analytics panel.
 *
 * Reads bucket two kinds of column (see `getSnapshots`): GAUGES are read
 * MAX-per-bucket (so a transient peak stays visible, matching memory_snapshots),
 * while CUMULATIVE counters are read as the value at the greatest `sampled_at`
 * in the bucket (latest-in-bucket) so they stay correct across a process restart
 * where a counter resets to a smaller value. Writes are idempotent on
 * `sampled_at` so a duplicate tick is harmless.
 */
export class CacheKeepaliveSnapshotRepository extends BaseRepository<CacheKeepaliveSnapshotRow> {
	/**
	 * Insert one cache-keepalive sample. Upsert semantics on the `sampled_at`
	 * primary key: a duplicate tick overwrites the prior row rather than erroring.
	 * Matches the ON CONFLICT DO UPDATE style used by memory_snapshots.
	 */
	async insertSnapshot(row: CacheKeepaliveSnapshotRow): Promise<void> {
		await this.run(
			`
			INSERT INTO cache_keepalive_snapshots (
				sampled_at, warm_sessions, promoted_sessions, total_bytes,
				keepalives_sent, hits, misses, failures, spent_usd, saved_usd
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (sampled_at) DO UPDATE SET
				warm_sessions = EXCLUDED.warm_sessions,
				promoted_sessions = EXCLUDED.promoted_sessions,
				total_bytes = EXCLUDED.total_bytes,
				keepalives_sent = EXCLUDED.keepalives_sent,
				hits = EXCLUDED.hits,
				misses = EXCLUDED.misses,
				failures = EXCLUDED.failures,
				spent_usd = EXCLUDED.spent_usd,
				saved_usd = EXCLUDED.saved_usd
		`,
			[
				row.sampledAt,
				row.warmSessions,
				row.promotedSessions,
				row.totalBytes,
				row.keepalivesSent,
				row.hits,
				row.misses,
				row.failures,
				row.spentUsd,
				row.savedUsd,
			],
		);
	}

	/**
	 * Read one row per time bucket since `sinceMs`. Buckets are `bucketMs`-wide
	 * windows aligned to the epoch. Within each bucket, GAUGE columns
	 * (warm_sessions/promoted_sessions/total_bytes) take the column-wise MAX
	 * (peak survives), while CUMULATIVE counter columns take the value at the row
	 * with the greatest `sampled_at` (latest-in-bucket via a ROW_NUMBER window,
	 * matching usage_snapshots) so a process restart resetting the counters reads
	 * back the reset value rather than a stale MAX.
	 */
	async getSnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<CacheKeepaliveHistoryPoint[]> {
		const { sinceMs, bucketMs } = opts;
		const rows = await this.query<{
			ts: number;
			warm_sessions: number;
			promoted_sessions: number;
			total_bytes: number;
			keepalives_sent: number;
			hits: number;
			misses: number;
			failures: number;
			spent_usd: number;
			saved_usd: number;
		}>(
			`
			WITH bucketed AS (
				SELECT (sampled_at / ?) * ? AS ts,
				       sampled_at, warm_sessions, promoted_sessions, total_bytes,
				       keepalives_sent, hits, misses, failures, spent_usd, saved_usd
				FROM cache_keepalive_snapshots
				WHERE sampled_at >= ?
			),
			ranked AS (
				SELECT *, ROW_NUMBER() OVER (PARTITION BY ts ORDER BY sampled_at DESC) AS rn
				FROM bucketed
			)
			SELECT ts,
			       MAX(warm_sessions) AS warm_sessions,
			       MAX(promoted_sessions) AS promoted_sessions,
			       MAX(total_bytes) AS total_bytes,
			       MAX(CASE WHEN rn = 1 THEN keepalives_sent END) AS keepalives_sent,
			       MAX(CASE WHEN rn = 1 THEN hits END) AS hits,
			       MAX(CASE WHEN rn = 1 THEN misses END) AS misses,
			       MAX(CASE WHEN rn = 1 THEN failures END) AS failures,
			       MAX(CASE WHEN rn = 1 THEN spent_usd END) AS spent_usd,
			       MAX(CASE WHEN rn = 1 THEN saved_usd END) AS saved_usd
			FROM ranked
			GROUP BY ts
			ORDER BY ts;
		`,
			[bucketMs, bucketMs, sinceMs],
		);

		return rows.map((row) => ({
			ts: Number(row.ts),
			warmSessions: Number(row.warm_sessions),
			promotedSessions: Number(row.promoted_sessions),
			totalBytes: Number(row.total_bytes),
			keepalivesSent: Number(row.keepalives_sent),
			hits: Number(row.hits),
			misses: Number(row.misses),
			failures: Number(row.failures),
			spentUsd: Number(row.spent_usd),
			savedUsd: Number(row.saved_usd),
		}));
	}

	/**
	 * Delete snapshots strictly older than `cutoffMs`. Returns rows deleted.
	 * Volume is tiny (one row per sample tick), so a single DELETE suffices.
	 */
	async deleteOlderThan(cutoffMs: number): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM cache_keepalive_snapshots WHERE sampled_at < ?`,
			[cutoffMs],
		);
	}
}
