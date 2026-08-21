import { afterEach, describe, expect, it } from "bun:test";
import {
	__setStallProfilerReaderForTests,
	drainStallSamples,
	formatStallSamples,
	isStallProfilerEnabled,
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

describe("stall profiler — attribution window", () => {
	// Timestamps are SECONDS. This is the flaw the window fix exists for:
	// without it, work preceding the block outranks the block itself.
	const at = (ts: number, name: string) => ({
		timestamp: ts,
		frames: [{ name, sourceURL: "/repo/packages/proxy/src/a.ts" }],
	});

	it("excludes work that ran before the blocked window", () => {
		// 8 samples of innocent work spread over the second BEFORE the stall,
		// then 4 samples inside a 300ms block. Un-windowed, innocent wins 8-4.
		const traces = [
			...Array.from({ length: 8 }, (_, i) =>
				at(100.0 + i * 0.05, "innocentWork"),
			),
			...Array.from({ length: 4 }, (_, i) => at(100.75 + i * 0.05, "theStall")),
		];
		__setStallProfilerReaderForTests(() => ({ traces }));
		expect(drainStallSamples().top[0].label).toContain("innocentWork");

		__setStallProfilerReaderForTests(() => ({ traces }));
		const w = drainStallSamples(300);
		expect(w.windowed).toBe(true);
		expect(w.top[0].label).toContain("theStall");
	});

	it("drops samples older than the window, keeping the recent tail", () => {
		// The window is anchored to the NEWEST sample, which is correct: the tick
		// fires immediately after the block ends, so [newest - lag, newest] is
		// exactly the blocked period. A consequence is that the newest sample is
		// always in-window, so an empty in-window result cannot occur while any
		// timestamped trace exists — the zero-sample branch is defensive only.
		__setStallProfilerReaderForTests(() => ({
			traces: [
				at(50.0, "longBefore"),
				at(50.2, "longBefore"),
				at(51.0, "recent"),
			],
		}));
		const d = drainStallSamples(100);
		expect(d.windowed).toBe(true);
		expect(d.totalSamples).toBe(1);
		expect(d.top[0].label).toContain("recent");
	});

	it("keeps the whole batch when traces carry no usable timestamps", () => {
		__setStallProfilerReaderForTests(() => ({
			traces: [{ frames: [{ name: "x" }] }, { frames: [{ name: "x" }] }],
		}));
		const d = drainStallSamples(100);
		expect(d.totalSamples).toBe(2);
		expect(d.windowed).toBe(false);
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
});
