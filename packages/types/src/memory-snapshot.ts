// Memory snapshot types — append-only time-series of the proxy process's own
// memory footprint (RSS + JS heap), sampled at a regular cadence and read back
// as a bucketed (max-per-bucket) series for the dashboard "Memory Usage" graph.
//
// Unlike usage_snapshots (per-account), memory is a single global metric: one
// row per sample tick, no account dimension. Max-per-bucket (rather than
// last-value) is deliberate — a transient RSS spike that drops back stays
// visible instead of being smoothed away, which is the signal that matters for
// leak-spotting (RSS climbing while heap stays flat ⇒ native leak).

/** Write shape for a single memory sample (one tick). All sizes are bytes. */
export interface MemorySnapshotRow {
	/** Sample time, ms since epoch. */
	sampledAt: number;
	/** Resident set size in bytes. */
	rssBytes: number;
	/** JS heap used in bytes. */
	heapUsedBytes: number;
}

/**
 * Read shape — one row per time bucket, carrying the peak (max) sample observed
 * within that bucket. `ts` is the bucket's floored start time in ms
 * (sampledAt / bucketMs * bucketMs).
 */
export interface MemoryHistoryPoint {
	/** Bucket start, ms since epoch. */
	ts: number;
	/** Peak RSS in the bucket, bytes. */
	rssBytes: number;
	/** Peak heap-used in the bucket, bytes. */
	heapUsedBytes: number;
}

/** Wire response for `GET /api/analytics/memory-history?range=…`. */
export interface MemoryHistoryResponse {
	range: string;
	bucketMs: number;
	points: MemoryHistoryPoint[];
}
