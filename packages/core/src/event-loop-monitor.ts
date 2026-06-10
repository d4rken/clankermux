/**
 * Event-loop lag monitor — a setInterval tick-delta watchdog that makes
 * main-thread stalls diagnosable.
 *
 * ClankerMux runs on a single Bun process with synchronous bun:sqlite: any
 * long synchronous operation on the main thread freezes ALL HTTP serving.
 * Historically such stalls left no trace beyond gaps in unrelated log
 * timestamps. This monitor measures how late each scheduled tick fires (the
 * delta beyond the interval = time the loop was blocked) and:
 *
 *   - logs a WARN/ERROR with the observed lag when thresholds are crossed,
 *   - keeps cheap stats (last, max-since-start, max-in-recent-window) for the
 *     /api/system/status surface,
 *   - tracks a drainable per-snapshot max so the memory sampler can persist
 *     peak lag into the memory_snapshots time-series.
 *
 * Thresholds are inline named constants by project convention (no env knobs).
 */
import { Logger } from "@clankermux/logger";
import type { EventLoopLagStats } from "@clankermux/types";

const defaultLog = new Logger("EventLoopMonitor");

/** How often the watchdog tick is scheduled. */
export const EVENT_LOOP_TICK_INTERVAL_MS = 1000;
/** Lag at or above this logs a WARN ("Event loop blocked for ~Xms"). */
export const EVENT_LOOP_WARN_THRESHOLD_MS = 250;
/** Lag at or above this escalates to ERROR. */
export const EVENT_LOOP_ERROR_THRESHOLD_MS = 2000;
/** Ticks kept in the rolling window (~1 minute at the 1s tick interval). */
const RECENT_WINDOW_TICKS = 60;

/** Minimal log sink — injectable for tests; defaults to the real Logger. */
interface LagLogSink {
	warn(message: string): void;
	error(message: string): void;
}

export interface EventLoopMonitorOptions {
	tickIntervalMs?: number;
	warnThresholdMs?: number;
	errorThresholdMs?: number;
	/** Size of the rolling recent-lag window, in ticks. */
	recentWindowTicks?: number;
	/** Injectable clock for tests; defaults to Date.now. */
	now?: () => number;
	/** Injectable log sink for tests; defaults to Logger("EventLoopMonitor"). */
	logger?: LagLogSink;
}

export class EventLoopMonitor {
	private readonly tickIntervalMs: number;
	private readonly warnThresholdMs: number;
	private readonly errorThresholdMs: number;
	private readonly now: () => number;
	private readonly log: LagLogSink;

	/** Circular buffer of the most recent per-tick lag values. */
	private readonly recentLags: Float64Array;
	private recentIndex = 0;
	private recentFilled = 0;

	private intervalId: ReturnType<typeof setInterval> | null = null;
	private lastTickAt: number | null = null;
	private lastLagMs = 0;
	private maxLagMs = 0;
	/** Max lag since the last drainSnapshotMaxLagMs() call. */
	private snapshotMaxLagMs = 0;

	constructor(options: EventLoopMonitorOptions = {}) {
		this.tickIntervalMs = options.tickIntervalMs ?? EVENT_LOOP_TICK_INTERVAL_MS;
		this.warnThresholdMs =
			options.warnThresholdMs ?? EVENT_LOOP_WARN_THRESHOLD_MS;
		this.errorThresholdMs =
			options.errorThresholdMs ?? EVENT_LOOP_ERROR_THRESHOLD_MS;
		this.now = options.now ?? Date.now;
		this.log = options.logger ?? defaultLog;
		this.recentLags = new Float64Array(
			options.recentWindowTicks ?? RECENT_WINDOW_TICKS,
		);
	}

	/**
	 * Start the watchdog interval. Idempotent. The interval is unref()'d so it
	 * never keeps the process alive on shutdown.
	 */
	start(): void {
		if (this.intervalId !== null) return;
		// Baseline NOW so the first scheduled tick measures a real delta instead
		// of a bogus "lag since the epoch / since construction".
		this.lastTickAt = this.now();
		this.intervalId = setInterval(() => this.tick(), this.tickIntervalMs);
		this.intervalId.unref?.();
	}

	/** Stop the watchdog. Stats are retained; start() resumes with a fresh baseline. */
	stop(): void {
		if (this.intervalId !== null) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.lastTickAt = null;
	}

	/**
	 * One watchdog tick: lag = time since the previous tick beyond the
	 * scheduled interval, clamped to >= 0. Public so tests can drive the
	 * monitor with an injected clock instead of real timers. The very first
	 * tick (no baseline yet) only establishes the baseline — it can never
	 * report a false-positive lag.
	 */
	tick(): void {
		const nowMs = this.now();
		if (this.lastTickAt === null) {
			this.lastTickAt = nowMs;
			return;
		}
		const lagMs = Math.max(0, nowMs - this.lastTickAt - this.tickIntervalMs);
		this.lastTickAt = nowMs;
		this.recordLag(lagMs);
	}

	/** Current lag stats (cheap; safe to call from a request handler). */
	getStats(): EventLoopLagStats {
		let maxRecent = 0;
		for (let i = 0; i < this.recentFilled; i++) {
			if (this.recentLags[i] > maxRecent) maxRecent = this.recentLags[i];
		}
		return {
			lastLagMs: this.lastLagMs,
			maxLagMs: this.maxLagMs,
			maxRecentLagMs: maxRecent,
		};
	}

	/**
	 * Max lag observed since the previous drain, then reset — so each
	 * memory_snapshots row covers exactly its own sample interval.
	 */
	drainSnapshotMaxLagMs(): number {
		const max = this.snapshotMaxLagMs;
		this.snapshotMaxLagMs = 0;
		return max;
	}

	private recordLag(lagMs: number): void {
		this.lastLagMs = lagMs;
		if (lagMs > this.maxLagMs) this.maxLagMs = lagMs;
		if (lagMs > this.snapshotMaxLagMs) this.snapshotMaxLagMs = lagMs;

		this.recentLags[this.recentIndex] = lagMs;
		this.recentIndex = (this.recentIndex + 1) % this.recentLags.length;
		if (this.recentFilled < this.recentLags.length) this.recentFilled++;

		if (lagMs >= this.errorThresholdMs) {
			this.log.error(
				`Event loop blocked for ~${Math.round(lagMs)}ms (>= ${this.errorThresholdMs}ms) — synchronous work froze HTTP serving`,
			);
		} else if (lagMs >= this.warnThresholdMs) {
			this.log.warn(`Event loop blocked for ~${Math.round(lagMs)}ms`);
		}
	}
}

// ---------------------------------------------------------------------------
// Process-wide singleton — the server starts exactly one monitor; handlers and
// the memory sampler read it through these accessors.
// ---------------------------------------------------------------------------

let activeMonitor: EventLoopMonitor | null = null;

const ZERO_STATS: EventLoopLagStats = {
	lastLagMs: 0,
	maxLagMs: 0,
	maxRecentLagMs: 0,
};

/** Start (or resume) the process-wide monitor and return it. */
export function startEventLoopMonitor(): EventLoopMonitor {
	if (!activeMonitor) {
		activeMonitor = new EventLoopMonitor();
	}
	activeMonitor.start();
	return activeMonitor;
}

/** Stop the process-wide monitor (no-op when never started). */
export function stopEventLoopMonitor(): void {
	activeMonitor?.stop();
}

/** Stats from the process-wide monitor; zeros when it was never started. */
export function getEventLoopStats(): EventLoopLagStats {
	return activeMonitor ? activeMonitor.getStats() : { ...ZERO_STATS };
}

/**
 * Drain the process-wide monitor's per-snapshot max lag (see
 * EventLoopMonitor.drainSnapshotMaxLagMs). Null when the monitor was never
 * started, so snapshot rows distinguish "monitor off" from "no lag".
 */
export function drainEventLoopSnapshotMaxLagMs(): number | null {
	return activeMonitor ? activeMonitor.drainSnapshotMaxLagMs() : null;
}
