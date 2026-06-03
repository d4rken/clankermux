import type { MemoryHistoryPoint, MemorySnapshotRow } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

/**
 * Repository for the `memory_snapshots` time-series — an append-only history of
 * the proxy process's own memory footprint (RSS + JS heap) that backs the
 * dashboard "Memory Usage" graph.
 *
 * Reads are bucketed MAX-per-bucket (see `getSnapshots`); writes are idempotent
 * on `sampled_at` so a duplicate tick is harmless. MAX (rather than last-value)
 * is deliberate: a transient RSS spike that drops back stays visible instead of
 * being smoothed away.
 */
export class MemorySnapshotRepository extends BaseRepository<MemorySnapshotRow> {
	/**
	 * Insert one memory sample. Upsert semantics on the `sampled_at` primary key:
	 * a duplicate tick overwrites the prior row rather than erroring. Matches the
	 * ON CONFLICT DO UPDATE style used elsewhere, so it works on modern SQLite and
	 * PostgreSQL alike.
	 */
	async insert(row: MemorySnapshotRow): Promise<void> {
		await this.run(
			`
			INSERT INTO memory_snapshots (
				sampled_at, rss_bytes, heap_used_bytes
			)
			VALUES (?, ?, ?)
			ON CONFLICT (sampled_at) DO UPDATE SET
				rss_bytes = EXCLUDED.rss_bytes,
				heap_used_bytes = EXCLUDED.heap_used_bytes
		`,
			[row.sampledAt, row.rssBytes, row.heapUsedBytes],
		);
	}

	/**
	 * Read the peak (max) sample per time bucket since `sinceMs`. Buckets are
	 * `bucketMs`-wide windows aligned to the epoch; within each bucket the
	 * column-wise MAX of each metric wins (so rss/heap peaks survive even if they
	 * occurred in different samples).
	 */
	async getSnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<MemoryHistoryPoint[]> {
		const { sinceMs, bucketMs } = opts;
		const rows = await this.query<{
			ts: number;
			rss_bytes: number;
			heap_used_bytes: number;
		}>(
			`
			WITH bucketed AS (
				SELECT (sampled_at / ?) * ? AS ts,
				       rss_bytes, heap_used_bytes
				FROM memory_snapshots
				WHERE sampled_at >= ?
			)
			SELECT ts,
			       MAX(rss_bytes) AS rss_bytes,
			       MAX(heap_used_bytes) AS heap_used_bytes
			FROM bucketed
			GROUP BY ts
			ORDER BY ts;
		`,
			[bucketMs, bucketMs, sinceMs],
		);

		return rows.map((row) => ({
			ts: Number(row.ts),
			rssBytes: Number(row.rss_bytes),
			heapUsedBytes: Number(row.heap_used_bytes),
		}));
	}

	/**
	 * Delete snapshots strictly older than `cutoffMs`. Returns rows deleted.
	 * Volume is tiny (one row per sample tick), so a single DELETE suffices.
	 */
	async deleteOlderThan(cutoffMs: number): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM memory_snapshots WHERE sampled_at < ?`,
			[cutoffMs],
		);
	}
}
