// Cache keep-alive (prompt-cache bridge) observability types — the wire shapes
// for the dashboard's "Cache Keep-Alive" monitoring panel.
//
// Two surfaces:
//  - LIVE: current in-memory gauges + cumulative-since-restart counters, read on
//    the main thread straight from the proxy singletons. GET /api/analytics/cache-keepalive.
//  - HISTORY: a bucketed time-series from the cache_keepalive_snapshots table.
//    GET /api/analytics/cache-keepalive-history?range=…. Counter fields are
//    PER-BUCKET DELTAS (reset-clamped), gauges are peak-per-bucket.

/**
 * Live snapshot of the cache-keepalive bridge. Gauges are point-in-time; the
 * counter fields (keepalivesSent..savedUsd) are cumulative since the last process
 * restart (they reset to 0 on restart). `netUsd = savedUsd - spentUsd`;
 * `hitRate = hits / (hits + misses)` (0 when none decided).
 */
export interface CacheKeepaliveLiveResponse {
	/** Active cache-warming mode. */
	mode: "off" | "static" | "dynamic";
	/** Configured minimum cached-token eligibility threshold. */
	minTokens: number;
	/** Warm session slots currently held (gauge). */
	warmSessions: number;
	/** Of those, sessions on the 1h-TTL (promoted) cadence (gauge). */
	promotedSessions: number;
	/** Total bytes of stored warm bodies (gauge). */
	totalBytes: number;
	/** Keepalives dispatched whose hit/miss was determined (cumulative). */
	keepalivesSent: number;
	/** Keepalives that found the cache still warm (cumulative). */
	hits: number;
	/** Keepalives that found the cache expired / re-created it (cumulative). */
	misses: number;
	/** Keepalives that failed to dispatch (non-routable / non-ok / threw) (cumulative). */
	failures: number;
	/** Real cache-read turns that resumed a kept-warm session (cumulative). */
	warmResumes: number;
	/** USD spent on keepalive hit+miss costs (cumulative). */
	spentUsd: number;
	/** USD of resume penalties avoided on real warm resumes (cumulative). */
	savedUsd: number;
	/** savedUsd - spentUsd (cumulative). */
	netUsd: number;
	/** hits / (hits + misses), 0 when none decided. */
	hitRate: number;
}

/**
 * One bucket of the cache-keepalive history series. GAUGE fields
 * (warmSessions/promotedSessions/totalBytes) carry the bucket value as stored
 * (peak-per-bucket from the repository). The COUNTER fields
 * (keepalivesSent/hits/misses/failures/spentUsd/savedUsd) are PER-BUCKET DELTAS
 * — the change vs. the previous bucket, reset-clamped — rather than raw
 * cumulative running totals, so the chart shows per-window activity. `hitRate`
 * is computed from the per-bucket hit/miss deltas.
 */
export interface CacheKeepaliveHistoryPointDelta {
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
	hitRate: number;
}

/** Wire response for `GET /api/analytics/cache-keepalive-history?range=…`. */
export interface CacheKeepaliveHistoryResponse {
	range: string;
	bucketMs: number;
	points: CacheKeepaliveHistoryPointDelta[];
}
