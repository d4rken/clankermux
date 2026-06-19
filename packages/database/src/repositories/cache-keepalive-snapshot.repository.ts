import { BaseRepository } from "./base.repository";

/** Summed counter activity over a window (see `getWindowCounterTotals`). */
export interface CacheKeepaliveWindowTotals {
	keepalivesSent: number;
	hits: number;
	misses: number;
	failures: number;
	warmResumes: number;
	spentUsd: number;
	savedUsd: number;
	savedUsd5m: number;
}

/** Raw counter columns of one snapshot (cumulative-since-restart). */
interface CounterRow {
	keepalives_sent: number;
	hits: number;
	misses: number;
	failures: number;
	spent_usd: number;
	saved_usd: number;
	warm_resumes: number;
	saved_usd_5m: number;
}

/**
 * Fold consecutive cumulative-counter samples into a window total, clamping each
 * process-restart reset (a sample smaller than its predecessor → count the sample
 * itself, i.e. post-restart activity). `anchor` is the latest sample before the
 * window (or null when the window opens at the first-ever sample): with an anchor
 * the first in-window sample contributes only its increment over the anchor;
 * without one it counts in full. Exported for unit testing.
 */
export function sumCounterDeltas(
	anchor: CounterRow | null,
	rows: CounterRow[],
): CacheKeepaliveWindowTotals {
	const totals: CacheKeepaliveWindowTotals = {
		keepalivesSent: 0,
		hits: 0,
		misses: 0,
		failures: 0,
		warmResumes: 0,
		spentUsd: 0,
		savedUsd: 0,
		savedUsd5m: 0,
	};
	let prev: CounterRow | null = anchor;
	const step = (cur: number, p: number | undefined): number => {
		if (p === undefined) return cur; // no prior sample → full value
		return cur >= p ? cur - p : cur; // reset → count the post-restart value
	};
	for (const cur of rows) {
		totals.keepalivesSent += step(cur.keepalives_sent, prev?.keepalives_sent);
		totals.hits += step(cur.hits, prev?.hits);
		totals.misses += step(cur.misses, prev?.misses);
		totals.failures += step(cur.failures, prev?.failures);
		totals.spentUsd += step(cur.spent_usd, prev?.spent_usd);
		totals.savedUsd += step(cur.saved_usd, prev?.saved_usd);
		totals.warmResumes += step(cur.warm_resumes, prev?.warm_resumes);
		totals.savedUsd5m += step(cur.saved_usd_5m, prev?.saved_usd_5m);
		prev = cur;
	}
	return totals;
}

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
	/** CUMULATIVE: optimistic USD saved (1h write rate) since process restart. */
	savedUsd: number;
	/** CUMULATIVE: real warm resumes since process restart. */
	warmResumes: number;
	/** CUMULATIVE: honest USD saved (5m write rate, no-bridge counterfactual). */
	savedUsd5m: number;
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
	warmResumes: number;
	savedUsd5m: number;
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
				keepalives_sent, hits, misses, failures, spent_usd, saved_usd,
				warm_resumes, saved_usd_5m
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (sampled_at) DO UPDATE SET
				warm_sessions = EXCLUDED.warm_sessions,
				promoted_sessions = EXCLUDED.promoted_sessions,
				total_bytes = EXCLUDED.total_bytes,
				keepalives_sent = EXCLUDED.keepalives_sent,
				hits = EXCLUDED.hits,
				misses = EXCLUDED.misses,
				failures = EXCLUDED.failures,
				spent_usd = EXCLUDED.spent_usd,
				saved_usd = EXCLUDED.saved_usd,
				warm_resumes = EXCLUDED.warm_resumes,
				saved_usd_5m = EXCLUDED.saved_usd_5m
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
				row.warmResumes,
				row.savedUsd5m,
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
			warm_resumes: number;
			saved_usd_5m: number;
		}>(
			`
			WITH bucketed AS (
				SELECT (sampled_at / ?) * ? AS ts,
				       sampled_at, warm_sessions, promoted_sessions, total_bytes,
				       keepalives_sent, hits, misses, failures, spent_usd, saved_usd,
				       warm_resumes, saved_usd_5m
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
			       MAX(CASE WHEN rn = 1 THEN saved_usd END) AS saved_usd,
			       MAX(CASE WHEN rn = 1 THEN warm_resumes END) AS warm_resumes,
			       MAX(CASE WHEN rn = 1 THEN saved_usd_5m END) AS saved_usd_5m
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
			warmResumes: Number(row.warm_resumes),
			savedUsd5m: Number(row.saved_usd_5m),
		}));
	}

	/**
	 * Summed counter activity in the window [sinceMs, now] — the correct
	 * window TOTAL (not chart-shaped per-bucket deltas, which zero the first bucket).
	 *
	 * Cumulative counters reset to 0 on each process restart, so a window total is
	 * the sum of consecutive-sample deltas, clamping each reset (cur < prev → count
	 * cur). We anchor on the latest sample BEFORE the window (if any) so the first
	 * in-window sample contributes only its in-window increment; with no anchor (the
	 * window starts at the first-ever sample, e.g. range "all") the first sample's
	 * cumulative value IS in-window activity and counts in full.
	 */
	async getWindowCounterTotals(
		sinceMs: number,
	): Promise<CacheKeepaliveWindowTotals> {
		const counterCols = `keepalives_sent, hits, misses, failures, spent_usd, saved_usd, warm_resumes, saved_usd_5m`;
		const [anchorRows, windowRows] = await Promise.all([
			this.query<CounterRow>(
				`SELECT ${counterCols} FROM cache_keepalive_snapshots
				 WHERE sampled_at < ? ORDER BY sampled_at DESC LIMIT 1`,
				[sinceMs],
			),
			this.query<CounterRow>(
				`SELECT ${counterCols} FROM cache_keepalive_snapshots
				 WHERE sampled_at >= ? ORDER BY sampled_at ASC`,
				[sinceMs],
			),
		]);
		return sumCounterDeltas(anchorRows[0] ?? null, windowRows);
	}

	/**
	 * The single most-recent snapshot row (greatest `sampled_at`), or null when the
	 * table is empty. Used at boot to seed the in-memory cumulative counters so the
	 * live ledger continues across restarts instead of dropping to zero.
	 */
	async getLatestSnapshot(): Promise<CacheKeepaliveSnapshotRow | null> {
		const rows = await this.query<{
			sampled_at: number;
			warm_sessions: number;
			promoted_sessions: number;
			total_bytes: number;
			keepalives_sent: number;
			hits: number;
			misses: number;
			failures: number;
			spent_usd: number;
			saved_usd: number;
			warm_resumes: number;
			saved_usd_5m: number;
		}>(
			`SELECT * FROM cache_keepalive_snapshots ORDER BY sampled_at DESC LIMIT 1`,
		);
		const row = rows[0];
		if (!row) return null;
		return {
			sampledAt: Number(row.sampled_at),
			warmSessions: Number(row.warm_sessions),
			promotedSessions: Number(row.promoted_sessions),
			totalBytes: Number(row.total_bytes),
			keepalivesSent: Number(row.keepalives_sent),
			hits: Number(row.hits),
			misses: Number(row.misses),
			failures: Number(row.failures),
			spentUsd: Number(row.spent_usd),
			savedUsd: Number(row.saved_usd),
			warmResumes: Number(row.warm_resumes),
			savedUsd5m: Number(row.saved_usd_5m),
		};
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
