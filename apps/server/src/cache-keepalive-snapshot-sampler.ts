/**
 * Cache-keepalive snapshot sampler — a periodic job that records the Session
 * Cache Bridge's live economics into the `cache_keepalive_snapshots` time-series
 * that backs the dashboard keepalive analytics panel.
 *
 * Design notes:
 *  - Each tick captures GAUGEs (warm / promoted sessions and total bytes held,
 *    read live from `sessionCacheStore`) plus the CUMULATIVE-since-restart
 *    counters from `bridgeStats.snapshot()` (keepalives, hits, misses, failures,
 *    spent/saved USD). The pure `buildCacheKeepaliveSnapshotRow` mapper turns
 *    those into one write-ready row stamped with a single `now`.
 *  - We ALWAYS sample on tick (mirrors UsageSnapshotSampler, which always writes
 *    its batch). The capture is cheap and gauges/counters may legitimately be 0
 *    when the bridge is idle or the cache-warming mode is off — recording the
 *    zero keeps the series continuous so the chart never has phantom gaps.
 *  - Runs on the SAME 2-minute cadence as the usage-snapshot sampler
 *    (`SAMPLE_INTERVAL_MS`, env-overridable via the shared resolver) and uses the
 *    same deferred/staggered first tick so it lines up with the startup poll wave.
 */

import { intervalManager } from "@clankermux/core";
import type { CacheKeepaliveSnapshotRow } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import type { BridgeStatsSnapshot } from "@clankermux/proxy";
import { bridgeStats, sessionCacheStore } from "@clankermux/proxy";
import { resolveSampleIntervalMs } from "./usage-snapshot-sampler";

const log = new Logger("CacheKeepaliveSnapshotSampler");

/** Live session-cache gauges captured at tick time. */
export interface CacheKeepaliveGauges {
	warmSessions: number;
	promotedSessions: number;
	totalBytes: number;
}

/**
 * PURE projection: map the live gauges + the cumulative bridge-stats snapshot
 * into a single write-ready row stamped with `now`. The derived `netUsd` /
 * `netUsdConservative` / `hitRate` are dropped (recomputable on read);
 * `warmResumes` and `savedUsdConservative` ARE persisted (they cannot be derived
 * from the other columns and are the report's headline ROI signals).
 */
export function buildCacheKeepaliveSnapshotRow(
	now: number,
	gauges: CacheKeepaliveGauges,
	stats: BridgeStatsSnapshot,
): CacheKeepaliveSnapshotRow {
	return {
		sampledAt: now,
		warmSessions: gauges.warmSessions,
		promotedSessions: gauges.promotedSessions,
		totalBytes: gauges.totalBytes,
		keepalivesSent: stats.keepalivesSent,
		hits: stats.hits,
		misses: stats.misses,
		failures: stats.failures,
		spentUsd: stats.spentUsd,
		savedUsd: stats.savedUsd,
		warmResumes: stats.warmResumes,
		savedUsd5m: stats.savedUsdConservative,
	};
}

/** Dependencies the sampler needs from the host server. */
export interface CacheKeepaliveSnapshotSamplerDeps {
	/** Read the live session-cache gauges each tick. */
	getGauges: () => CacheKeepaliveGauges;
	/** Read the cumulative bridge-stats snapshot each tick. */
	getStats: () => BridgeStatsSnapshot;
	/** Persist a single snapshot row. */
	insertSnapshot: (row: CacheKeepaliveSnapshotRow) => Promise<void>;
	/**
	 * Base poll interval (ms) used to compute the deferred first-sample delay,
	 * mirroring the usage-snapshot sampler so both first ticks land after the
	 * startup poll-stagger wave.
	 */
	getPollIntervalMs: () => number;
}

/**
 * Periodic sampler. Each tick stamps one shared `now`, reads the live gauges +
 * cumulative bridge stats, projects them via `buildCacheKeepaliveSnapshotRow`,
 * and writes the row (DB errors are logged, never thrown). Registered through
 * `intervalManager` with `maxConcurrent: 1`.
 */
export class CacheKeepaliveSnapshotSampler {
	private readonly deps: CacheKeepaliveSnapshotSamplerDeps;
	private stopInterval: (() => void) | null = null;
	private startupTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly intervalId = "cache-keepalive-snapshot-sampler";

	constructor(deps: CacheKeepaliveSnapshotSamplerDeps) {
		this.deps = deps;
	}

	/**
	 * Start the sampler. The first sample is DEFERRED by one poll interval so it
	 * lines up with the startup poll-stagger wave (mirrors UsageSnapshotSampler);
	 * after that, steady 2-minute cadence.
	 */
	start(): void {
		const intervalMs = resolveSampleIntervalMs();
		const initialDelayMs = this.deps.getPollIntervalMs();

		log.info(
			`Cache keepalive snapshot sampler starting: interval=${Math.round(intervalMs / 1000)}s, first sample in ~${Math.round(initialDelayMs / 1000)}s`,
		);

		this.startupTimer = setTimeout(() => {
			this.startupTimer = null;
			this.stopInterval = intervalManager.register({
				id: this.intervalId,
				callback: () => this.tick(),
				intervalMs,
				immediate: true,
				maxConcurrent: 1,
				description: "Cache keepalive snapshot sampler (bridge economics)",
			});
		}, initialDelayMs);
		// Don't let the deferral timer keep the process alive on its own.
		this.startupTimer.unref?.();
	}

	/** Stop the sampler: cancel the deferral timer and unregister the interval. */
	stop(): void {
		if (this.startupTimer) {
			clearTimeout(this.startupTimer);
			this.startupTimer = null;
		}
		if (this.stopInterval) {
			this.stopInterval();
			this.stopInterval = null;
		}
	}

	/** One sampling tick (exposed for tests / manual triggering). */
	async tick(): Promise<void> {
		const now = Date.now();
		const row = buildCacheKeepaliveSnapshotRow(
			now,
			this.deps.getGauges(),
			this.deps.getStats(),
		);

		try {
			await this.deps.insertSnapshot(row);
			log.debug("Cache keepalive snapshot recorded");
		} catch (err) {
			// A DB error must not kill the interval — log and move on.
			log.error(
				`Cache keepalive snapshot sampler: failed to persist snapshot: ${err}`,
			);
		}
	}
}

/**
 * Default dependency wiring: live gauges from `sessionCacheStore`, cumulative
 * counters from `bridgeStats`. The host server supplies `insertSnapshot` (DB
 * facade) and `getPollIntervalMs` (config).
 */
export function liveGauges(): CacheKeepaliveGauges {
	return {
		warmSessions: sessionCacheStore.getSize(),
		promotedSessions: sessionCacheStore.getPromotedSessions(),
		totalBytes: sessionCacheStore.getTotalBytes(),
	};
}

/** Live bridge-stats snapshot. */
export function liveStats(): BridgeStatsSnapshot {
	return bridgeStats.snapshot();
}
