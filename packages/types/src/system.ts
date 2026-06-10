import type { PoolStatus } from "./stats";

/**
 * Live event-loop lag stats from the in-process monitor (see
 * @clankermux/core event-loop-monitor). With synchronous bun:sqlite a blocked
 * main thread freezes ALL HTTP serving, so lag is the primary stall signal.
 */
export interface EventLoopLagStats {
	/** Lag measured on the most recent monitor tick, ms. */
	lastLagMs: number;
	/** Worst lag observed since the monitor started, ms. */
	maxLagMs: number;
	/** Worst lag within the recent rolling window (~last minute), ms. */
	maxRecentLagMs: number;
}

/**
 * Live operational snapshot for the dashboard's System Status tile.
 *
 * Served by `GET /api/system/status`. Unlike `/health` (consumed by external
 * load balancers and intentionally terse), this bundles the health rollup with
 * process uptime and memory so the dashboard can render uptime + an RSS
 * sparkline without hitting the `/api/debug/*` profiling endpoints.
 *
 * Point-in-time only: `memory.rss_mb` is the current RSS. The sparkline history
 * is accumulated client-side across polls; the server keeps no time series.
 */
export interface SystemStatusResponse {
	/** Rollup health, computed identically to `/health` (runtime + pool). */
	status: "ok" | "degraded" | "unhealthy";
	/** Process uptime in seconds (`process.uptime()`). */
	uptime_s: number;
	memory: {
		rss_bytes: number;
		rss_mb: number;
	};
	pool: PoolStatus;
	/** Compact runtime signals used to explain a non-ok status. */
	runtime: {
		asyncWriterHealthy: boolean;
		integrityStatus: "ok" | "corrupt" | "unchecked" | "running";
	};
	/** Event-loop lag from the in-process monitor (zeros when not running). */
	eventLoop: EventLoopLagStats;
	strategy: string;
	timestamp: string;
}
