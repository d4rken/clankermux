import { afterEach, describe, expect, it } from "bun:test";
import {
	__setStallProfilerReaderForTests,
	drainStallSamples,
	formatStallSamples,
	isStallProfilerEnabled,
	STALL_PROFILER_PING_FRAMES,
} from "../stall-profiler";

/**
 * The real profiler cannot be stopped once started, so every test drives an
 * injected reader instead. Module state is process-wide, hence the reset.
 */
afterEach(() => {
	__setStallProfilerReaderForTests(null);
});

const frame = (name: string, sourceURL?: string) => ({ name, sourceURL });
const trace = (...names: string[]) => ({
	timestamp: 1,
	frames: names.map((n) => frame(n)),
});

describe("stall profiler — disabled by default", () => {
	it("drains to nothing and reports disabled when never enabled", () => {
		expect(isStallProfilerEnabled()).toBe(false);
		expect(drainStallSamples()).toMatchObject({ totalSamples: 0, top: [] });
	});

	it("does not call the reader when disabled", () => {
		let calls = 0;
		__setStallProfilerReaderForTests(() => {
			calls++;
			return { traces: [trace("x")] };
		});
		__setStallProfilerReaderForTests(null);
		drainStallSamples();
		expect(calls).toBe(0);
	});
});

describe("stall profiler — tallying", () => {
	it("counts the LEAF frame, not the roots every trace shares", () => {
		// Both traces share the `root` frame; only the leaves differ. Tallying
		// roots would report `root 100%` and identify nothing.
		__setStallProfilerReaderForTests(() => ({
			traces: [
				trace("hotA", "root"),
				trace("hotA", "root"),
				trace("hotB", "root"),
			],
		}));

		const d = drainStallSamples();
		expect(d.totalSamples).toBe(3);
		expect(d.top[0].label).toBe("hotA");
		expect(d.top[0].samples).toBe(2);
		expect(d.top.map((f) => f.label)).not.toContain("root");
	});

	it("reports share as a percentage of all traces", () => {
		__setStallProfilerReaderForTests(() => ({
			traces: [trace("a"), trace("a"), trace("a"), trace("b")],
		}));

		const d = drainStallSamples();
		expect(d.top[0]).toMatchObject({ label: "a", samples: 3 });
		expect(d.top[0].sharePct).toBeCloseTo(75, 5);
	});

	it("drops frames below the noise floor", () => {
		// 1 of 100 = 1%, under the 2% floor.
		const traces = Array.from({ length: 99 }, () => trace("dominant"));
		traces.push(trace("noise"));
		__setStallProfilerReaderForTests(() => ({ traces }));

		const labels = drainStallSamples().top.map((f) => f.label);
		expect(labels).toContain("dominant");
		expect(labels).not.toContain("noise");
	});

	it("buckets unattributable frames instead of dropping them from the denominator", () => {
		// A frame with no name and no source must still be counted, or the
		// remaining frames' shares silently inflate.
		__setStallProfilerReaderForTests(() => ({
			traces: [
				{ timestamp: 1, frames: [{ category: "Host" }] },
				{ timestamp: 1, frames: [{ category: "Host" }] },
				trace("named"),
			],
		}));

		const d = drainStallSamples();
		expect(d.totalSamples).toBe(3);
		expect(d.top.map((f) => f.label)).toContain("<Host>");
	});

	it("treats '(program)' as unattributed rather than a culprit", () => {
		__setStallProfilerReaderForTests(() => ({
			traces: [
				{
					timestamp: 1,
					frames: [{ name: "(program)", sourceURL: "/x/mod.ts" }],
				},
			],
		}));
		expect(drainStallSamples().top[0].label).toBe("mod.ts");
	});

	it("names the calling app frame when the leaf is a builtin", () => {
		// A hot loop bottoms out in a builtin, so a leaf-only tally reports the
		// operation and hides the call site — the thing you would actually go and
		// change. Validated against the real profiler: a 300ms burner attributed
		// 93% to `now` and 7% to the function containing the loop.
		__setStallProfilerReaderForTests(() => ({
			traces: [
				{
					timestamp: 1,
					frames: [
						{ name: "parse", sourceURL: "[native code]" },
						{
							name: "handleChunk",
							sourceURL: "/repo/packages/proxy/src/response-handler.ts",
						},
					],
				},
			],
		}));
		expect(drainStallSamples().top[0].label).toBe(
			"parse <- handleChunk (proxy/src/response-handler.ts)",
		);
	});

	it("skips intervening builtins to reach our own code", () => {
		__setStallProfilerReaderForTests(() => ({
			traces: [
				{
					timestamp: 1,
					frames: [
						{ name: "exec", sourceURL: "[native code]" },
						{ name: "map", sourceURL: "[native code]" },
						{ name: "ours", sourceURL: "/repo/packages/core/src/x.ts" },
					],
				},
			],
		}));
		expect(drainStallSamples().top[0].label).toBe(
			"exec <- ours (core/src/x.ts)",
		);
	});

	it("falls back to the bare leaf when no app frame is on the stack", () => {
		__setStallProfilerReaderForTests(() => ({
			traces: [
				{
					timestamp: 1,
					frames: [
						{ name: "gc", sourceURL: "[native code]" },
						{ name: "runtime", sourceURL: "[native code]" },
					],
				},
			],
		}));
		expect(drainStallSamples().top[0].label).toBe("gc");
	});

	it("shortens a package path to something readable", () => {
		__setStallProfilerReaderForTests(() => ({
			traces: [
				{
					timestamp: 1,
					frames: [
						{
							name: "doWork",
							sourceURL: "/home/x/repo/packages/proxy/src/a.ts",
						},
					],
				},
			],
		}));
		expect(drainStallSamples().top[0].label).toBe("doWork (proxy/src/a.ts)");
	});
});

// ---------------------------------------------------------------------------
// Windowing. Timestamps are SECONDS on the profiler's own clock; `nowMs` is
// milliseconds on the monitor's monotonic clock. The tests below set the two
// epochs a fixed distance apart and check that the window lands on the block
// regardless of what the batch happens to contain.
// ---------------------------------------------------------------------------

interface FakeTrace {
	timestamp?: number;
	frames?: { name?: string; sourceURL?: string; category?: string }[];
}

let nextTraces: FakeTrace[] = [];
let nextInterval: number | undefined = 0.001;
let nextThrows = false;

/** Install the reader once; tests then swap `nextTraces` between drains. */
function installReader(): void {
	nextTraces = [];
	nextInterval = 0.001;
	nextThrows = false;
	__setStallProfilerReaderForTests(() => {
		if (nextThrows) throw new Error("profiler read failed");
		return { interval: nextInterval, traces: nextTraces } as never;
	});
}

/**
 * Drive healthy drains so the mono→profiler offset is known. `skewMs` is the
 * true offset, and may be of either sign: a sample taken at monotonic time T is
 * stamped (T - skewMs)/1000 seconds.
 *
 * The batch must contain a trace carrying the ping frame, because that is the
 * only kind of sample calibration accepts — a healthy drain whose batch holds
 * nothing planted teaches it nothing, by design.
 */
function primeClock(skewMs = 0, drains = 6): void {
	for (let i = 1; i <= drains; i++) {
		const monoMs = i * 1000;
		nextTraces = [
			{
				timestamp: (monoMs - skewMs) / 1000,
				// Ping frames alternate per calibrating drain, and only the current
				// generation is accepted, so the fake has to alternate with them.
				frames: [{ name: STALL_PROFILER_PING_FRAMES[(i - 1) % 2] }],
			},
		];
		drainStallSamples(undefined, () => monoMs);
	}
}

/**
 * `count` samples spread evenly across the `spanMs` ending at `endSec` — what a
 * block that occupied its whole window looks like. Use `samplesEndingAt` for
 * the opposite shape: samples packed into one stretch of it.
 */
function samplesSpanning(
	endSec: number,
	spanMs: number,
	count: number,
	name: string,
): FakeTrace[] {
	const step = count > 1 ? spanMs / 1000 / (count - 1) : 0;
	return Array.from({ length: count }, (_, i) => ({
		timestamp: endSec - step * (count - 1 - i),
		frames: [{ name, sourceURL: "/repo/packages/proxy/src/a.ts" }],
	}));
}

/** `count` samples spread backwards from `endSec`, one per millisecond. */
function samplesEndingAt(
	endSec: number,
	count: number,
	name: string,
): FakeTrace[] {
	return Array.from({ length: count }, (_, i) => ({
		timestamp: endSec - (count - 1 - i) / 1000,
		frames: [{ name, sourceURL: "/repo/packages/proxy/src/a.ts" }],
	}));
}

describe("stall profiler — locating the blocked window", () => {
	it("ranks the block, not the busier stretch that preceded it", () => {
		installReader();
		primeClock();

		// 400 samples of ordinary work well before the stall, then 200 inside it.
		// Un-windowed, the innocent work wins 400 to 200.
		nextTraces = [
			...samplesEndingAt(9.0, 400, "innocentWork"),
			...samplesSpanning(10.0, 300, 200, "theStall"),
		];
		const d = drainStallSamples(300, () => 10_000);

		expect(d.attribution).toBe("ranked");
		expect(d.windowed).toBe(true);
		expect(d.totalSamples).toBe(200);
		expect(d.batchSamples).toBe(600);
		expect(d.top[0].label).toContain("theStall");
		expect(d.top.map((f) => f.label).join()).not.toContain("innocentWork");
	});

	it("places the window from the monitor clock, not from the newest sample", () => {
		// THE regression test for the second rejected design. Everything sampled
		// here is over a second old — the loop was descheduled for the whole
		// block. Anchoring to the newest sample slides the window back onto that
		// old work and reports it at 100%; deriving the endpoint from the drain
		// clock leaves the window empty, which is the truth.
		installReader();
		primeClock();

		nextTraces = samplesEndingAt(8.9, 300, "workBeforeTheBlock");
		const d = drainStallSamples(300, () => 10_000);

		expect(d.totalSamples).toBe(0);
		expect(d.top).toEqual([]);
		expect(d.attribution).toBe("low-coverage");
		expect(formatStallSamples(d)).toContain("spent executing JS");
	});

	it("refuses to rank a window the loop barely sampled (the SIGSTOP shape)", () => {
		// Reproduces the real SIGSTOP measurement: 296.7ms of lag, two samples
		// 1.2966s apart, the newer one being the resumed tick callback itself.
		// One sample inside a 296ms window is not attribution, whatever its
		// share works out to.
		installReader();
		primeClock();

		nextTraces = [
			{ timestamp: 8.7034, frames: [{ name: "beforeTheStop" }] },
			{
				timestamp: 10.0,
				frames: [{ name: "tick", sourceURL: "/repo/packages/core/src/x.ts" }],
			},
		];
		const d = drainStallSamples(296.7, () => 10_000);

		expect(d.attribution).toBe("low-coverage");
		expect(d.totalSamples).toBe(1);
		expect(d.top).toEqual([]);
		const line = formatStallSamples(d);
		expect(line).toContain("1 of ~297");
		expect(line).not.toContain("tick");
	});

	it("keeps ranking once coverage is dense enough", () => {
		installReader();
		primeClock();

		// 150 of a possible 300 is exactly the 50% floor.
		nextTraces = samplesSpanning(10.0, 300, 150, "realWork");
		const d = drainStallSamples(300, () => 10_000);
		expect(d.attribution).toBe("ranked");
		expect(d.top[0].label).toContain("realWork");
	});

	it("suppresses ranking just below the coverage floor", () => {
		installReader();
		primeClock();

		nextTraces = samplesSpanning(10.0, 300, 149, "realWork");
		const d = drainStallSamples(300, () => 10_000);
		expect(d.attribution).toBe("low-coverage");
		expect(d.top).toEqual([]);
	});

	it("never ranks a handful of samples even when the window is tiny", () => {
		installReader();
		primeClock();

		// 19 samples in a 20ms window is 95% coverage, and still far too few to
		// name a culprit from.
		nextTraces = samplesEndingAt(10.0, 19, "realWork");
		const d = drainStallSamples(20, () => 10_000);
		expect(d.attribution).toBe("low-coverage");
		expect(d.top).toEqual([]);
	});

	it("handles the real epoch gap, where profiler time runs AHEAD of the monitor", () => {
		// Measured on the live host: `performance.now()` counts from process
		// start, JSC timestamps count from boot, so the offset is about -6.22e9
		// ms after 72 days of uptime. An implementation that assumes the offset
		// is small, or positive, never calibrates at all and reports every stall
		// as unattributable.
		installReader();
		const bootSkewMs = -6_224_704_089;
		primeClock(bootSkewMs);

		const endSec = (10_000 - bootSkewMs) / 1000;
		nextTraces = [
			...samplesEndingAt(endSec - 1, 400, "innocentWork"),
			...samplesSpanning(endSec, 300, 200, "theStall"),
		];
		const d = drainStallSamples(300, () => 10_000);
		expect(d.attribution).toBe("ranked");
		expect(d.top[0].label).toContain("theStall");
	});

	it("tracks a non-zero offset between the two clocks", () => {
		installReader();
		primeClock(4_000);

		// Monotonic 10_000 is profiler-clock 6.0s once the 4s skew is known.
		nextTraces = [
			...samplesEndingAt(5.5, 400, "innocentWork"),
			...samplesSpanning(6.0, 300, 200, "theStall"),
		];
		const d = drainStallSamples(300, () => 10_000);
		expect(d.attribution).toBe("ranked");
		expect(d.top[0].label).toContain("theStall");
	});

	it("will not window before the clock has been observed enough times", () => {
		installReader();
		primeClock(0, 4);

		nextTraces = samplesEndingAt(10.0, 300, "realWork");
		const d = drainStallSamples(300, () => 10_000);
		expect(d.attribution).toBe("not-calibrated");
		expect(d.top).toEqual([]);
		expect(formatStallSamples(d)).toContain("not yet calibrated");
	});

	it("excludes the current batch from its own calibration", () => {
		// A stalled batch whose newest sample is ancient must not be able to drag
		// the window back onto itself, and must not poison the offset for the
		// drains that follow.
		installReader();
		primeClock();

		nextTraces = samplesEndingAt(8.9, 300, "stale");
		expect(drainStallSamples(300, () => 10_000).totalSamples).toBe(0);

		nextTraces = samplesSpanning(11.0, 300, 200, "theStall");
		const d = drainStallSamples(300, () => 11_000);
		expect(d.attribution).toBe("ranked");
		expect(d.top[0].label).toContain("theStall");
	});

	it("does not calibrate from unplanted samples, however many there are", () => {
		// The failure this rules out, measured on an idle process: batches hold
		// either nothing at all or a single sample ~1000ms stale, so calibrating
		// off "the newest trace in the batch" places the window a full second
		// before the block — densely sampled, plausible, and wrong. Without a
		// planted sample there is no observation, and the stall is reported as
		// unattributable instead.
		installReader();
		// More drains than the ring has slots, so this also pins that a run of
		// unplanted batches can never fill it or evict a good observation.
		for (let i = 1; i <= 40; i++) {
			const monoMs = i * 1000;
			nextTraces = samplesEndingAt((monoMs - 1000) / 1000, 200, "ordinaryWork");
			drainStallSamples(undefined, () => monoMs);
		}

		nextTraces = samplesSpanning(40.0, 300, 300, "realWork");
		const d = drainStallSamples(300, () => 41_000);
		expect(d.attribution).toBe("not-calibrated");
		expect(d.top).toEqual([]);
	});

	it("keeps a good calibration once the ring is full", () => {
		// The mirror image: after calibrating, a long run of stale unplanted
		// batches must not be able to displace the observations already held.
		installReader();
		primeClock(0, 30);
		for (let i = 31; i <= 80; i++) {
			const monoMs = i * 1000;
			nextTraces = samplesEndingAt((monoMs - 400) / 1000, 200, "sparseWork");
			drainStallSamples(undefined, () => monoMs);
		}

		nextTraces = [
			...samplesEndingAt(80.6, 300, "innocentWork"),
			...samplesSpanning(81.0, 300, 200, "theStall"),
		];
		const d = drainStallSamples(300, () => 81_000);
		expect(d.attribution).toBe("ranked");
		expect(d.top[0].label).toContain("theStall");
	});

	it("refuses a window that is dense but only half observed", () => {
		// Descheduled for the first half of the window, then a coalesced timer
		// callback runs before the watchdog does. 200 samples in a 300ms window
		// clears the count floor easily, and every one of them is from a callback
		// that ran for 150ms — naming it for a 300ms stall is a false claim.
		installReader();
		primeClock();

		nextTraces = samplesEndingAt(10.0, 200, "lateCallback"); // 9.80 -> 10.00
		const d = drainStallSamples(300, () => 10_000); // window 9.70 -> 10.00

		expect(d.attribution).toBe("uneven-coverage");
		expect(d.top).toEqual([]);
		expect(d.occupiedBins).toBeLessThan(20);
		const line = formatStallSamples(d);
		expect(line).toContain("slices");
		expect(line).toContain("never observed");
	});

	it("ranks a window whose samples span it, and shows how much they span", () => {
		installReader();
		primeClock();

		nextTraces = samplesSpanning(10.0, 300, 300, "theStall"); // 9.70 -> 10.00
		const d = drainStallSamples(300, () => 10_000);

		expect(d.attribution).toBe("ranked");
		expect(d.occupiedBins).toBe(20);
		expect(formatStallSamples(d)).toContain("(20/20 slices)");
	});

	it("reports a stall the profiler returned nothing for, instead of nothing", () => {
		// An empty batch during a stall is the strongest form of the coverage
		// finding. Falling back to the unwindowed shape makes the formatter
		// return null and the caller log nothing at all, which is indistinguishable
		// from never having profiled the stall.
		installReader();
		primeClock();

		nextTraces = [];
		const d = drainStallSamples(300, () => 10_000);
		expect(d.attribution).toBe("low-coverage");
		expect(d.totalSamples).toBe(0);
		expect(formatStallSamples(d)).toContain("0 of ~300");
	});

	it("distinguishes a failed profiler read from an empty window", () => {
		__setStallProfilerReaderForTests(() => {
			throw new Error("profiler exploded");
		});
		const d = drainStallSamples(300, () => 10_000);
		expect(d.attribution).toBe("unavailable");
		expect(formatStallSamples(d)).toContain("no usable sample batch");
	});

	it("ignores a ping sample that leaked in from the previous tick", () => {
		// The sampler races the read that drains it, so a trace published just
		// after tick N's read lands in tick N+1's batch. If tick N+1's own ping
		// went unsampled and both pings shared a name, that leftover would be
		// taken for the current one — an observation a full tick stale, and with
		// a write-once ring, latched. Five of those in a row would fix the offset
		// 1000ms late and every window after it would land on the wrong second.
		installReader();
		// First drain: the ping is missed entirely, so its samples are in flight.
		nextTraces = [{ timestamp: 1.0, frames: [{ name: "ordinaryWork" }] }];
		drainStallSamples(undefined, () => 1_000);

		// Every later drain returns only the PREVIOUS generation's ping.
		for (let i = 2; i <= 10; i++) {
			const monoMs = i * 1000;
			nextTraces = [
				{
					timestamp: (monoMs - 1000) / 1000,
					frames: [{ name: STALL_PROFILER_PING_FRAMES[i % 2] }],
				},
			];
			drainStallSamples(undefined, () => monoMs);
		}

		nextTraces = samplesSpanning(11.0, 300, 300, "realWork");
		const d = drainStallSamples(300, () => 11_000);
		expect(d.attribution).toBe("not-calibrated");
		expect(d.top).toEqual([]);
	});

	it("does not let a failed read hand the next ping a stale sample", () => {
		// A read that throws leaves the buffer holding the ping just planted. If
		// the generation only advanced after a successful read, the next tick
		// would plant under the SAME name, and a missed ping would then accept
		// the previous tick's leftover as its own — an offset a tick late, and
		// latched, because the ring is write-once.
		installReader();
		for (let i = 1; i <= 20; i += 2) {
			// Tick that plants a ping and then fails to read it back.
			nextThrows = true;
			drainStallSamples(undefined, () => i * 1000);
			// Tick whose own ping is missed; the batch holds only the leftover.
			nextThrows = false;
			nextTraces = [
				{
					timestamp: ((i + 1) * 1000 - 1000) / 1000,
					frames: [{ name: STALL_PROFILER_PING_FRAMES[0] }],
				},
				{
					timestamp: ((i + 1) * 1000 - 1000) / 1000,
					frames: [{ name: STALL_PROFILER_PING_FRAMES[1] }],
				},
			];
			drainStallSamples(undefined, () => (i + 1) * 1000);
		}

		nextTraces = samplesSpanning(21.0, 300, 300, "realWork");
		const d = drainStallSamples(300, () => 21_000);
		expect(d.attribution).toBe("not-calibrated");
		expect(d.top).toEqual([]);
	});

	it("advances the ping generation across a failed read", () => {
		// The mirror of the test above: after a throw the next drain is a pure
		// clearing read, and the drain after that must plant under the NEXT
		// generation. If the generation had not advanced, the B-named sample
		// below would not match and calibration would never happen.
		installReader();
		for (let round = 0; round < 6; round++) {
			const base = round * 3000;
			nextThrows = true;
			drainStallSamples(undefined, () => base + 1000);

			nextThrows = false;
			nextTraces = [];
			drainStallSamples(undefined, () => base + 2000); // clearing read

			nextTraces = [
				{
					timestamp: (base + 3000) / 1000,
					frames: [{ name: STALL_PROFILER_PING_FRAMES[1] }],
				},
			];
			drainStallSamples(undefined, () => base + 3000);
		}

		nextTraces = samplesSpanning(19.0, 300, 300, "realWork");
		const d = drainStallSamples(300, () => 19_000);
		expect(d.attribution).toBe("ranked");
		expect(d.top[0].label).toContain("realWork");
	});

	it("refuses a comb: slices that hold one sample are not observed slices", () => {
		// Presence per slice is not observation. 145 samples packed into the last
		// 144ms plus five lone samples scattered through the first 75ms gives
		// 150/300 samples and, counting mere presence, 15/20 slices — enough to
		// rank a callback that ran for 144ms as the cause of a 300ms stall.
		installReader();
		primeClock();

		nextTraces = [
			...samplesEndingAt(10.0, 145, "lateCallback"),
			...[0, 1, 2, 3, 4].map((bin) => ({
				timestamp: 9.7 + (bin + 0.5) * 0.015,
				frames: [{ name: "strayProbe" }],
			})),
		];
		const d = drainStallSamples(300, () => 10_000);

		expect(d.totalSamples).toBe(150);
		expect(d.attribution).toBe("uneven-coverage");
		expect(d.occupiedBins).toBe(10);
		expect(d.top).toEqual([]);
	});

	it("refuses the window when any trace cannot be placed", () => {
		// 99 unplaceable traces plus one placeable must not become a confident
		// 100% for the one that survived the filter.
		installReader();
		primeClock();

		nextTraces = [
			...Array.from({ length: 99 }, () => ({ frames: [{ name: "unplaced" }] })),
			{ timestamp: 10.0, frames: [{ name: "placed" }] },
		];
		const d = drainStallSamples(300, () => 10_000);

		expect(d.attribution).toBe("unplaceable");
		expect(d.windowed).toBe(false);
		expect(d.top).toEqual([]);
		expect(formatStallSamples(d)).toContain("timestamps unusable");
	});

	it("assumes a 1ms sampling period when the profiler reports none", () => {
		installReader();
		primeClock();

		nextInterval = undefined;
		nextTraces = samplesSpanning(10.0, 300, 200, "realWork");
		const d = drainStallSamples(300, () => 10_000);
		expect(d.expectedSamples).toBe(300);
		expect(d.attribution).toBe("ranked");
	});

	it("reads a millisecond-shaped sampling period too", () => {
		installReader();
		primeClock();

		nextInterval = 2; // 2ms per sample => a 300ms window can hold ~150
		nextTraces = samplesSpanning(10.0, 300, 100, "realWork");
		const d = drainStallSamples(300, () => 10_000);
		expect(d.expectedSamples).toBe(150);
		expect(d.attribution).toBe("ranked");
	});
});

describe("stall profiler — robustness", () => {
	it("survives a reader that throws", () => {
		__setStallProfilerReaderForTests(() => {
			throw new Error("profiler exploded");
		});
		expect(drainStallSamples()).toMatchObject({ totalSamples: 0, top: [] });
	});

	it("survives malformed results", () => {
		__setStallProfilerReaderForTests(() => ({}) as never);
		expect(drainStallSamples().totalSamples).toBe(0);

		__setStallProfilerReaderForTests(() => ({ traces: [] }));
		expect(drainStallSamples().totalSamples).toBe(0);

		// A frameless trace is still a sample: it counts toward the denominator
		// and lands in the unattributed bucket rather than vanishing.
		__setStallProfilerReaderForTests(() => ({ traces: [{ timestamp: 1 }] }));
		const d = drainStallSamples();
		expect(d.totalSamples).toBe(1);
		expect(d.top[0].label).toBe("<unattributed>");
		expect(d.top[0].sharePct).toBeCloseTo(100, 5);
	});
});

describe("formatStallSamples", () => {
	it("returns null when nothing was sampled, so the caller logs nothing", () => {
		expect(formatStallSamples({ totalSamples: 0, top: [] })).toBeNull();
	});

	it("says so explicitly when samples exist but no frame dominates", () => {
		const line = formatStallSamples({ totalSamples: 40, top: [] });
		expect(line).toContain("40 samples");
		expect(line).toContain("no dominant frame");
	});

	it("renders each frame with its share and raw count", () => {
		const line = formatStallSamples({
			totalSamples: 10,
			top: [{ label: "hot", samples: 7, sharePct: 70 }],
		});
		expect(line).toContain("10 samples");
		expect(line).toContain("hot 70% (7)");
	});

	it("states the window a ranked attribution covers", () => {
		const line = formatStallSamples({
			totalSamples: 210,
			top: [{ label: "hot", samples: 200, sharePct: 95 }],
			windowed: true,
			attribution: "ranked",
			expectedSamples: 300,
			occupiedBins: 18,
		});
		expect(line).toContain("210 of ~300 samples in the blocked window");
		expect(line).toContain("18/20 slices");
		expect(line).toContain("hot 95% (200)");
	});
});
