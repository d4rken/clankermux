import type { PricingGap } from "./pricing";
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
 * process uptime and memory so the dashboard can render uptime and current RSS
 * without hitting the `/api/debug/*` profiling endpoints.
 *
 * Point-in-time only: `memory.rss_mb` is the current RSS, and no history is
 * carried here. Trend lines read `GET /api/analytics/memory-history` instead,
 * which serves bucketed `memory_snapshots` rows — do NOT accumulate a series
 * client-side across polls, it would reset on every navigation and disagree
 * with the chart.
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
		integrityStatus: "ok" | "corrupt" | "unchecked" | "running" | "skipped";
		/**
		 * Models whose cost could not be computed since this process started, so
		 * their requests were recorded with a NULL cost. Deliberately does NOT
		 * feed the `status` rollup: requests are still served correctly, only
		 * costing is degraded, and `/health` (which 503s on a non-ok status) is
		 * consumed by container health checks.
		 */
		pricingGaps: PricingGap[];
	};
	/** Event-loop lag from the in-process monitor (zeros when not running). */
	eventLoop: EventLoopLagStats;
	strategy: string;
	timestamp: string;
}
