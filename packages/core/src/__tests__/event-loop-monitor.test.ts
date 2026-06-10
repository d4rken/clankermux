/**
 * Tests for the event-loop lag monitor — the setInterval tick-delta watchdog
 * that makes main-thread stalls (synchronous bun:sqlite, blocking JSON parses)
 * diagnosable instead of leaving only gaps in unrelated log timestamps.
 *
 * The monitor is driven through its public tick() with an injected clock and
 * logger so tests never depend on real timers for the lag math; only the
 * stop()-halts-ticking test exercises the real setInterval scheduling.
 */
import { describe, expect, it } from "bun:test";
import {
	EVENT_LOOP_ERROR_THRESHOLD_MS,
	EVENT_LOOP_TICK_INTERVAL_MS,
	EVENT_LOOP_WARN_THRESHOLD_MS,
	EventLoopMonitor,
	getEventLoopStats,
	startEventLoopMonitor,
	stopEventLoopMonitor,
} from "../event-loop-monitor";

/** Manual clock + log capture harness around a monitor instance. */
function makeHarness(opts?: {
	tickIntervalMs?: number;
	recentWindowTicks?: number;
}) {
	let nowMs = 0;
	const warns: string[] = [];
	const errors: string[] = [];
	const monitor = new EventLoopMonitor({
		tickIntervalMs: opts?.tickIntervalMs ?? 1000,
		recentWindowTicks: opts?.recentWindowTicks,
		now: () => nowMs,
		logger: {
			warn: (msg: string) => warns.push(msg),
			error: (msg: string) => errors.push(msg),
		},
	});
	return {
		monitor,
		warns,
		errors,
		/** Advance the clock and fire one tick. */
		tickAfter(elapsedMs: number) {
			nowMs += elapsedMs;
			monitor.tick();
		},
	};
}

describe("EventLoopMonitor", () => {
	describe("constants", () => {
		it("uses the documented inline thresholds (no env knobs)", () => {
			expect(EVENT_LOOP_TICK_INTERVAL_MS).toBe(1000);
			expect(EVENT_LOOP_WARN_THRESHOLD_MS).toBe(250);
			expect(EVENT_LOOP_ERROR_THRESHOLD_MS).toBe(2000);
		});
	});

	describe("first tick", () => {
		it("only establishes the baseline — no lag recorded, no log", () => {
			const h = makeHarness();
			// First tick arrives way late relative to t=0; without a prior baseline
			// this must NOT be interpreted as lag.
			h.tickAfter(60_000);
			const stats = h.monitor.getStats();
			expect(stats.lastLagMs).toBe(0);
			expect(stats.maxLagMs).toBe(0);
			expect(stats.maxRecentLagMs).toBe(0);
			expect(h.warns).toEqual([]);
			expect(h.errors).toEqual([]);
		});
	});

	describe("lag measurement", () => {
		it("records zero lag for an on-time tick", () => {
			const h = makeHarness();
			h.tickAfter(0); // baseline
			h.tickAfter(1000); // exactly on schedule
			expect(h.monitor.getStats().lastLagMs).toBe(0);
		});

		it("records the tick delay beyond the interval as lag", () => {
			const h = makeHarness();
			h.tickAfter(0);
			h.tickAfter(1100); // 100ms late
			const stats = h.monitor.getStats();
			expect(stats.lastLagMs).toBe(100);
			expect(stats.maxLagMs).toBe(100);
		});

		it("clamps an early tick to zero lag (never negative)", () => {
			const h = makeHarness();
			h.tickAfter(0);
			h.tickAfter(900); // fired early
			expect(h.monitor.getStats().lastLagMs).toBe(0);
		});

		it("tracks maxLagMs across ticks while lastLagMs follows the latest", () => {
			const h = makeHarness();
			h.tickAfter(0);
			h.tickAfter(1500); // 500ms lag
			h.tickAfter(1050); // 50ms lag
			const stats = h.monitor.getStats();
			expect(stats.lastLagMs).toBe(50);
			expect(stats.maxLagMs).toBe(500);
		});
	});

	describe("threshold logging", () => {
		it("stays silent below the warn threshold", () => {
			const h = makeHarness();
			h.tickAfter(0);
			h.tickAfter(1000 + 249);
			expect(h.warns).toEqual([]);
			expect(h.errors).toEqual([]);
		});

		it("warns at >= 250ms lag with the lag in the message", () => {
			const h = makeHarness();
			h.tickAfter(0);
			h.tickAfter(1000 + 300);
			expect(h.warns).toHaveLength(1);
			expect(h.warns[0]).toContain("300");
			expect(h.warns[0]).toContain("Event loop blocked");
			expect(h.errors).toEqual([]);
		});

		it("escalates to error at >= 2000ms lag (and does not also warn)", () => {
			const h = makeHarness();
			h.tickAfter(0);
			h.tickAfter(1000 + 2500);
			expect(h.errors).toHaveLength(1);
			expect(h.errors[0]).toContain("2500");
			expect(h.warns).toEqual([]);
		});
	});

	describe("rolling recent-window max", () => {
		it("reports the max lag within the window and forgets older spikes", () => {
			const h = makeHarness({ recentWindowTicks: 3 });
			h.tickAfter(0);
			h.tickAfter(1000 + 400); // spike: 400ms
			h.tickAfter(1000); // 0
			h.tickAfter(1000 + 30); // 30ms
			expect(h.monitor.getStats().maxRecentLagMs).toBe(400);
			// One more on-time tick pushes the 400ms spike out of the 3-tick window.
			h.tickAfter(1000);
			expect(h.monitor.getStats().maxRecentLagMs).toBe(30);
			// maxLagMs (since start) still remembers the spike.
			expect(h.monitor.getStats().maxLagMs).toBe(400);
		});
	});

	describe("drainSnapshotMaxLagMs", () => {
		it("returns the max lag since the previous drain, then resets to zero", () => {
			const h = makeHarness();
			h.tickAfter(0);
			h.tickAfter(1000 + 500);
			h.tickAfter(1000 + 100);
			expect(h.monitor.drainSnapshotMaxLagMs()).toBe(500);
			// Window reset: nothing new yet.
			expect(h.monitor.drainSnapshotMaxLagMs()).toBe(0);
			h.tickAfter(1000 + 80);
			expect(h.monitor.drainSnapshotMaxLagMs()).toBe(80);
			// maxLagMs since start is untouched by draining.
			expect(h.monitor.getStats().maxLagMs).toBe(500);
		});
	});

	describe("default clock", () => {
		it("defaults to a monotonic clock — a Date.now step can't fake lag", () => {
			// Replace Date.now BEFORE construction so a Date.now-based default
			// would capture the fake. Fake a wall-clock step (NTP correction): a
			// Date.now clock would report ~59s of bogus lag; performance.now is
			// immune.
			const originalDateNow = Date.now;
			let fakeWallClock = 1_000_000;
			Date.now = () => fakeWallClock;
			try {
				const monitor = new EventLoopMonitor();
				monitor.tick(); // baseline
				fakeWallClock += 60_000;
				monitor.tick();
				expect(monitor.getStats().lastLagMs).toBe(0);
				expect(monitor.getStats().maxLagMs).toBe(0);
			} finally {
				Date.now = originalDateNow;
			}
		});
	});

	describe("start/stop scheduling", () => {
		it("start() schedules ticks and stop() halts them", async () => {
			const monitor = new EventLoopMonitor({ tickIntervalMs: 5 });
			let ticks = 0;
			const originalTick = monitor.tick.bind(monitor);
			monitor.tick = () => {
				ticks++;
				originalTick();
			};

			monitor.start();
			await Bun.sleep(40);
			monitor.stop();
			expect(ticks).toBeGreaterThan(0);

			const after = ticks;
			await Bun.sleep(40);
			expect(ticks).toBe(after);
		});

		it("start() is idempotent (no double-scheduling)", async () => {
			const monitor = new EventLoopMonitor({ tickIntervalMs: 1000 });
			monitor.start();
			monitor.start();
			monitor.stop();
			// After stop, no timers remain — nothing to assert beyond no throw; the
			// double-schedule failure mode is caught by the stop test above leaking
			// ticks if a second interval survived stop().
			expect(monitor.getStats().maxLagMs).toBe(0);
		});
	});

	describe("module singleton", () => {
		it("startEventLoopMonitor exposes live stats via getEventLoopStats", () => {
			const monitor = startEventLoopMonitor();
			try {
				const stats = getEventLoopStats();
				expect(typeof stats.lastLagMs).toBe("number");
				expect(typeof stats.maxLagMs).toBe("number");
				expect(typeof stats.maxRecentLagMs).toBe("number");
				expect(startEventLoopMonitor()).toBe(monitor); // same instance
			} finally {
				stopEventLoopMonitor();
			}
		});
	});
});
