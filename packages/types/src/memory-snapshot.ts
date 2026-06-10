// Memory snapshot types — append-only time-series of the proxy process's own
// memory footprint (RSS + JS heap), sampled at a regular cadence and read back
// as a bucketed (max-per-bucket) series for the dashboard "Memory Usage" graph.
//
// Unlike usage_snapshots (per-account), memory is a single global metric: one
// row per sample tick, no account dimension. Max-per-bucket (rather than
// last-value) is deliberate — a transient RSS spike that drops back stays
// visible instead of being smoothed away, which is the signal that matters for
// leak-spotting (RSS climbing while heap stays flat ⇒ native leak).

/**
 * Write shape for a single memory sample (one tick). All sizes are bytes.
 * `heapTotalBytes` is nullable so rows written before the column existed (a
 * deployment that ran the pre-heap-committed schema) read back as null rather
 * than breaking the series.
 */
export interface MemorySnapshotRow {
	/** Sample time, ms since epoch. */
	sampledAt: number;
	/** Resident set size in bytes. */
	rssBytes: number;
	/** JS heap used in bytes. */
	heapUsedBytes: number;
	/** JS heap total (committed) in bytes, or null when not recorded. */
	heapTotalBytes: number | null;
	/**
	 * Peak event-loop lag observed during this sample interval, ms. Nullable so
	 * rows written before the column existed read back as null.
	 */
	eventLoopMaxLagMs: number | null;
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
	/** Peak heap-total (committed) in the bucket, bytes, or null when unrecorded. */
	heapTotalBytes: number | null;
	/** Peak event-loop lag in the bucket, ms, or null when unrecorded. */
	eventLoopMaxLagMs: number | null;
}

/** Wire response for `GET /api/analytics/memory-history?range=…`. */
export interface MemoryHistoryResponse {
	range: string;
	bucketMs: number;
	points: MemoryHistoryPoint[];
}
