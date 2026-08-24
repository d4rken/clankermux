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
 * The single-flight probe holding a bucket's lease.
 *
 * `active` distinguishes a probe still legitimately in flight from an ORPHANED
 * one whose owner died: past its TTL the lease no longer blocks a takeover, but
 * it is still stored and still the thing an operator wants to see. Reporting
 * only live leases would hide the dead owner until some later request happens
 * to replace it.
 */
export interface ProviderOverloadLease {
	id: string;
	ageMs: number;
	ttlMs: number;
	/** False once `ageMs` exceeds `ttlMs`: an orphan awaiting takeover. */
	active: boolean;
}

interface ProviderOverloadBucketFields {
	/**
	 * Bucket identity. OPAQUE — the internal key vocabulary
	 * (`anthropic-upstream`, `anthropic-upstream:opus`) is not a stable API and
	 * must not be parsed. Use it for grouping and for matching log lines.
	 */
	key: string;
	/** Trip counter — ties a hold or probe log line to this exact trip. */
	generation: number;
	lease: ProviderOverloadLease | null;
	/**
	 * Holder slots currently occupied under this key.
	 *
	 * Occupancy, NOT an exhaustive count of requests waiting on this bucket: a
	 * hold freezes its slot key at entry, so if the bucket is cleared or a
	 * provider-wide bucket appears and moves the effective gate, existing
	 * holders keep their original key. The `closed` variant exists precisely to
	 * surface those still draining after their bucket is gone.
	 */
	activeHoldSlots: number;
}

/**
 * One overload bucket (or the draining remains of one) as reported by
 * `/api/system/status`.
 *
 * Answers "what is wedged right now" during an incident, which the journal can
 * only answer afterwards. A discriminated union so the deadline's availability
 * follows from the state rather than being a convention to remember.
 */
export type ProviderOverloadStatus =
	| (ProviderOverloadBucketFields & {
			/** Gating traffic until `until`. */
			state: "open";
			until: number;
	  })
	| (ProviderOverloadBucketFields & {
			/** Deadline lapsed; exactly one probe may test recovery. */
			state: "half-open";
			until: null;
	  })
	| {
			/**
			 * No bucket remains — it recovered or was cleared — but holders
			 * acquired under this key are still draining.
			 */
			state: "closed";
			key: string;
			until: null;
			generation: null;
			lease: null;
			activeHoldSlots: number;
	  };

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
	/**
	 * Live provider-overload breaker buckets, newest incident state first-hand.
	 *
	 * Deliberately NOT part of the `status` rollup: an overloaded upstream is a
	 * transient condition the proxy is actively handling (gating, holding,
	 * probing), not a proxy fault, and `/health` 503s on a non-ok status and is
	 * consumed by container health checks. Same reasoning as `pricingGaps`.
	 *
	 * Empty array when no bucket is live, which is the normal steady state.
	 */
	providerOverload: ProviderOverloadStatus[];
	strategy: string;
	timestamp: string;
}
