/**
 * On-demand stack attribution for event-loop stalls.
 *
 * Why this exists: EventLoopMonitor reports THAT the loop froze, never what
 * froze it. Successive rounds of eliminate-by-measurement have ruled out
 * SQLite (at most ~5% of stalls), request-path allocation (heap churn fell 64%
 * at matched load while lag moved 1%) and per-chunk stream work (far too
 * diffuse to make a contiguous block). Guessing the next candidate is not
 * converging, so this reads the actual stacks instead.
 *
 * WHY IT IS OPT-IN AND IRREVERSIBLE — read before enabling:
 *
 *   - JSC's sampling profiler has NO stop, pause or disable entry point. Bun
 *     exposes `startSamplingProfiler` and `samplingProfilerStackTraces` and
 *     nothing else, so once started it runs until the PROCESS RESTARTS.
 *   - It costs ~22% CPU, measured on this runtime against a proxy-shaped
 *     workload. That is not background-safe, and it is self-distorting: the
 *     overhead is itself contention, so absolute lag inflates while it runs.
 *     Attribution BETWEEN frames stays meaningful; the millisecond figures do
 *     not. Read the output as "what was on the stack", never as "how slow".
 *   - The sampling interval is fixed at ~1 ms. Passing an argument to
 *     `startSamplingProfiler` is accepted and ignored (sample density is
 *     unchanged), so it cannot be made cheaper.
 *
 * Hence: disabled at boot, switched on deliberately for a timeboxed window,
 * and switched off by restarting the service. Nothing here runs — not even a
 * branch on the hot path — until someone enables it.
 *
 * Draining: `samplingProfilerStackTraces()` CLEARS the buffer as a side effect
 * of reading. That is load-bearing twice over. It bounds memory (~85 KB per
 * 221 ms of busy CPU would otherwise accumulate forever), and it is what keeps
 * each batch small enough to reason about: draining on every monitor tick means
 * a batch read right after a stall holds roughly one tick interval of samples
 * rather than an unbounded backlog.
 */

/** Frames rendered per stall report. Enough to see a culprit, short enough to read. */
const TOP_FRAMES = 8;

/** Ignore frames below this share of samples — noise, not a culprit. */
const MIN_SHARE_PCT = 2;

/** Assumed JSC sampling period when the profiler does not report a usable one. */
const DEFAULT_SAMPLE_INTERVAL_MS = 1;

/**
 * Clock-offset observations kept for window calibration. Both clocks derive
 * from CLOCK_MONOTONIC, so the offset is a constant and the ring only exists to
 * pick the tightest of several observations — once it is full, calibration
 * stops entirely.
 */
const CALIBRATION_SLOTS = 30;

/**
 * How long the calibration ping busy-waits. Long enough that a ~1 ms sampler
 * reliably catches it (measured on an idle process: 20/20 drains at 3 ms, 5/8
 * at 1 ms), short enough that the whole calibration costs 30 ticks x 3 ms once
 * per enable. `scripts/stall-profiler-clock-check.ts` re-measures both.
 */
const CLOCK_PING_MS = 3;

/**
 * Frame names the calibration ping runs under, used in alternation.
 *
 * A sample carrying one is a sample we planted at a known instant, which is
 * what makes the observation verifiable rather than opportunistic. Two names
 * rather than one because the read that drains the buffer races the sampler
 * that fills it: a trace published just after tick N's read arrives in tick
 * N+1's batch, and if tick N+1's own ping went unsampled, a single fixed name
 * would let that leftover be mistaken for the current ping — an observation a
 * whole tick stale. Alternating names give each ping a generation, so a
 * one-tick leak carries the wrong name and is ignored. (Aliasing needs a sample
 * to survive two destructive reads, i.e. the sampler running two seconds
 * behind.)
 *
 * Exported so tests can model a real batch.
 */
export const STALL_PROFILER_PING_FRAMES = [
	"stallProfilerClockPingA",
	"stallProfilerClockPingB",
] as const;

/** Offsets required before any window is trusted. Below this: no attribution. */
const MIN_CALIBRATION_OBSERVATIONS = 5;

/**
 * A blocked window must yield at least this fraction of the samples it could
 * physically hold before its contents are ranked. See `drainStallSamples`.
 */
const MIN_COVERAGE_RATIO = 0.5;

/** ...and this many samples outright, so a short window cannot rank on a handful. */
const MIN_WINDOW_SAMPLES = 20;

/**
 * Slices the window is cut into when checking that the samples span it.
 *
 * A count alone does not establish coverage: 150 samples inside a 300 ms window
 * clears the 50% floor whether they are spread across it or packed into one
 * contiguous half. The second shape is a real one — descheduled for half the
 * window, then a coalesced timer callback runs before the watchdog does — and
 * ranking it names a function that did not block for anything like the reported
 * duration. Occupied slices catch that; a total cannot.
 */
const COVERAGE_BINS = 20;

/**
 * Share of the samples a slice could hold that it must actually hold to count
 * as observed.
 *
 * Presence alone is not observation, and the difference is exploitable: five
 * lone samples spread across five slices make them look covered while all the
 * real samples sit in a separate dense stretch, which passes a presence check
 * and ranks that stretch as if it were the whole block. A quarter of the
 * possible density is far below what a running block produces (measured ~82%)
 * and far above what a stray sample in a descheduled slice can reach.
 */
const MIN_BIN_DENSITY = 0.25;

/**
 * Slices that must be observed. Deliberately not 100%: a real
 * block can contain short unsampled pockets (a GC pause stops the sampler too),
 * and refusing those would suppress attribution for the very stalls worth
 * naming. The occupied count is printed on ranked lines so a partly-observed
 * window is visible rather than implied.
 */
const MIN_OCCUPIED_BINS_RATIO = 0.75;

interface SampledFrame {
	name?: string;
	sourceURL?: string;
	line?: number;
	category?: string;
}

interface SampledTrace {
	timestamp?: number;
	frames?: SampledFrame[];
}

interface SamplingResult {
	interval?: number;
	traces?: SampledTrace[];
}

type StackTraceReader = () => SamplingResult;

let reader: StackTraceReader | null = null;
let enabled = false;
let enabledAt: number | null = null;

/**
 * Ring of `pingEnd - plantedSample` observations, in milliseconds — the offset
 * between the monitor's clock and the profiler's.
 *
 * Each observation comes from a sample the ping deliberately planted, so it is
 * an upper bound on the true offset that is tight to within `CLOCK_PING_MS`,
 * and the minimum of several is tighter still.
 *
 * Deriving this from whatever the batch happens to contain does NOT work, and
 * that is the whole reason the ping exists. Measured on an idle process: most
 * reads return ZERO traces (JSC samples nothing when no JS runs) and the rest
 * return one sample that is ~1000 ms stale, which would place a 300 ms window a
 * full second before the block it is supposed to cover — sampled, plausible,
 * and completely wrong.
 *
 * The offset is neither small nor positive: `performance.now()` counts from
 * process start while JSC timestamps count from boot, so on a host up 72 days
 * it measures about -6.22e9 ms. Nothing here may assume a sign or a magnitude.
 */
const offsetRing = new Float64Array(CALIBRATION_SLOTS);
let offsetRingIndex = 0;
let offsetRingFilled = 0;

function resetCalibration(): void {
	offsetRing.fill(0);
	offsetRingIndex = 0;
	offsetRingFilled = 0;
	pingGeneration = 0;
	needsClearingRead = false;
}

function recordClockOffset(candidateMs: number): void {
	if (!Number.isFinite(candidateMs)) return;
	offsetRing[offsetRingIndex] = candidateMs;
	offsetRingIndex = (offsetRingIndex + 1) % CALIBRATION_SLOTS;
	if (offsetRingFilled < CALIBRATION_SLOTS) offsetRingFilled++;
}

/** Sink for the spin loop, so nothing can optimise the busy-wait away. */
let _pingSpins = 0;

/** Which of the two ping frames the next calibration will run under. */
let pingGeneration = 0;

/**
 * Set when a buffer read failed, so the buffer still holds whatever was in it —
 * including the ping we just planted. The next drain then reads WITHOUT
 * planting, purely to clear it. Two failed reads in a row would otherwise let
 * generations alias (A, B, A) with all three batches still present, and a
 * missed third ping would take the first one's sample as current.
 */
let needsClearingRead = false;

/**
 * Burn `CLOCK_PING_MS` under a uniquely-named frame and return the instant it
 * ended, on the caller's clock. The sampler is then holding a trace whose
 * timestamp is known to sit within the ping, which is what turns the offset
 * from a guess into a measurement.
 *
 * Runs only on healthy ticks, and only until the ring fills, so the whole cost
 * of calibration is 30 ticks x 3 ms, once, per enable.
 *
 * Its own samples can never land inside a stall window, whatever the lag: the
 * ping runs at the start of a tick, and a window is the OVERSHOOT past the tick
 * interval, so it begins a full interval after the previous tick started. The
 * ping is always at least that far outside it.
 */
function stallProfilerClockPing(now: () => number): number {
	// The two functions below exist ONLY to put distinguishable names on the
	// sampled stack. They are byte-identical and must stay that way: merging
	// them, or having them share a body, erases the generation and reopens the
	// one-tick leak described above.
	return pingGeneration === 0
		? stallProfilerClockPingA(now)
		: stallProfilerClockPingB(now);
}

function stallProfilerClockPingA(now: () => number): number {
	const startedAt = performance.now();
	let spins = 0;
	while (performance.now() - startedAt < CLOCK_PING_MS) spins++;
	_pingSpins = spins;
	return now();
}

// Yes, identical. Do NOT factor the body into a shared helper: a wrapper that
// only forwards a call is inlined, its frame disappears from the sampled stack,
// and calibration then never finds a planted sample at all. That is not a
// hypothetical — it is what the first version of this did, and the validation
// harness caught it reporting every stall as "clock not yet calibrated".
function stallProfilerClockPingB(now: () => number): number {
	const startedAt = performance.now();
	let spins = 0;
	while (performance.now() - startedAt < CLOCK_PING_MS) spins++;
	_pingSpins = spins;
	return now();
}

/**
 * Newest timestamp among traces planted by THIS tick's ping, or null if it
 * caught none. Matching only the current generation's frame name is what makes
 * a leftover from the previous tick inert rather than a 1000 ms error.
 */
function newestPlantedSample(
	traces: SampledTrace[],
	frameName: string,
): number | null {
	let newest = Number.NEGATIVE_INFINITY;
	for (const trace of traces) {
		const ts = trace?.timestamp;
		if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= newest)
			continue;
		const frames = trace.frames;
		if (!Array.isArray(frames)) continue;
		if (frames.some((f) => f?.name === frameName)) newest = ts;
	}
	return Number.isFinite(newest) ? newest : null;
}

function clockOffsetMs(): number | null {
	if (offsetRingFilled < MIN_CALIBRATION_OBSERVATIONS) return null;
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < offsetRingFilled; i++) {
		if (offsetRing[i] < min) min = offsetRing[i];
	}
	return Number.isFinite(min) ? min : null;
}

/**
 * Start sampling. Irreversible for the lifetime of the process — see the module
 * comment. Returns false if it could not be started (missing API), so a caller
 * can report failure rather than silently believing profiling is on.
 */
export function enableStallProfiler(now: () => number = Date.now): boolean {
	if (enabled) return true;
	try {
		// Imported lazily so a runtime without bun:jsc still loads this module,
		// and so nothing profiling-related is touched unless explicitly enabled.
		const jsc = require("bun:jsc") as {
			startSamplingProfiler?: () => void;
			samplingProfilerStackTraces?: StackTraceReader;
		};
		if (
			typeof jsc.startSamplingProfiler !== "function" ||
			typeof jsc.samplingProfilerStackTraces !== "function"
		) {
			return false;
		}
		jsc.startSamplingProfiler();
		reader = jsc.samplingProfilerStackTraces;
		enabled = true;
		enabledAt = now();
		resetCalibration();
		return true;
	} catch {
		return false;
	}
}

export function isStallProfilerEnabled(): boolean {
	return enabled;
}

export function stallProfilerEnabledAt(): number | null {
	return enabledAt;
}

/** Test seam: inject a fake reader instead of starting the real profiler. */
export function __setStallProfilerReaderForTests(
	fake: StackTraceReader | null,
	now: () => number = Date.now,
): void {
	reader = fake;
	enabled = fake !== null;
	enabledAt = fake === null ? null : now();
	resetCalibration();
}

export interface FrameTally {
	label: string;
	samples: number;
	sharePct: number;
}

/**
 * What the drained batch supports saying.
 *
 * - `ranked`      — the blocked window was located and densely sampled; `top` is
 *                   attribution for that window and nothing else.
 * - `unwindowed`  — no window was requested (a healthy tick); `top` covers the
 *                   whole batch, which is NOT a stall attribution.
 * - `not-calibrated` — too few clock observations yet to place the window.
 * - `unplaceable` — at least one trace carried no usable timestamp, so the batch
 *                   cannot be split into in- and out-of-window.
 * - `low-coverage` — the window was located but holds far fewer samples than it
 *                   could, i.e. little of it was spent executing JS.
 * - `uneven-coverage` — enough samples, but they leave part of the window
 *                   unobserved, so they describe a fraction of the block only.
 * - `unavailable` — the profiler read failed or returned nothing usable.
 *
 * Everything except `ranked` and `unwindowed` carries NO `top`: a stall we
 * cannot place is reported as unattributed, never ranked against whatever else
 * happens to be in the batch.
 */
export type StallAttribution =
	| "ranked"
	| "unwindowed"
	| "not-calibrated"
	| "unplaceable"
	| "low-coverage"
	| "uneven-coverage"
	| "unavailable";

export interface StallDrain {
	/** Samples the report is based on: in-window when windowed, else the batch. */
	totalSamples: number;
	/** Samples in the whole drained batch, regardless of windowing. */
	batchSamples: number;
	top: FrameTally[];
	windowed: boolean;
	attribution: StallAttribution;
	/** Samples the window could hold at the sampling rate; null when unwindowed. */
	expectedSamples: number | null;
	/** Window slices holding at least one sample, out of COVERAGE_BINS. */
	occupiedBins: number | null;
}

/**
 * Drain the sample buffer and tally what was executing.
 *
 * Tallies the LEAF frame of each trace — the function actually running when the
 * sample fired — rather than roots, because every trace shares the same handful
 * of roots and they identify nothing.
 *
 * Always call this on a tick even when there was no stall: the read is what
 * clears the buffer, and it is also what calibrates the clock alignment that
 * windowing depends on.
 *
 * ## Locating the blocked window
 *
 * A drain holds everything since the previous tick — about a second PLUS the
 * lag — so ranking the whole batch credits whatever ran BEFORE the block.
 * (Measured: 800 ms of ordinary yielding work followed by a 500 ms stall
 * reported the innocent work at 61% and the real stall at 39%.)
 *
 * Anchoring the window to the NEWEST sample instead is also wrong, and wrong in
 * a worse way. When the loop is descheduled by the OS or the cgroup, nothing is
 * sampled during the pause, so the newest sample is either the resumed tick
 * itself (reported at 100%, blaming the monitor for an OS pause) or a sample
 * from before the block (reported at 100%, blaming unrelated work). Both look
 * confident. Verified with a real SIGSTOP: 296.7 ms of measured lag, two
 * samples 1.2966 s apart.
 *
 * So the endpoint is derived independently of the batch. Trace timestamps are
 * in SECONDS on a profiler clock with its own epoch; `performance.now()` is
 * milliseconds on another. Healthy ticks measure the offset between the two by
 * planting a sample at a known instant (see `stallProfilerClockPing`), and that
 * offset translates THIS drain's timestamp into profiler time. The drain runs
 * at the top of the tick callback, i.e. immediately after the loop unblocked,
 * so the translated instant is the end of the block and `[end - lagMs, end]` is
 * the block itself — whether or not anything was sampled inside it.
 *
 * The current batch is deliberately excluded from its own calibration, so the
 * window cannot be dragged onto whatever this batch happens to contain.
 *
 * The window is a SUFFIX of the block, not necessarily the whole of it: lag is
 * measured as overshoot past the tick interval, so a block that began before
 * the tick was due is only reported from `end - lagMs` onwards. That is enough
 * to identify one contiguous synchronous operation, which is what a stall is.
 *
 * ## Refusing to rank
 *
 * A located window is not automatically a rankable one, and it fails in two
 * different ways.
 *
 * Too few samples: at a ~1 ms sampling period a 300 ms block can hold ~300
 * samples; if it holds two, the loop spent that time not executing JS, and
 * ranking those two would report a 100% culprit for something our JS never did.
 *
 * Enough samples in the wrong places: 150 samples clears a 50% floor whether
 * they span the window or fill one contiguous half of it, and the second shape
 * describes half a block while being reported as a whole one. So the window is
 * also cut into slices, and most slices have to hold a real share of the
 * samples they could hold — a lone sample in a slice proves the loop ran for
 * one millisecond of it, not that the slice was observed.
 *
 * Both shortfalls ARE findings and are reported as such.
 *
 * Measured on this runtime: a 300 ms JS burn yields ~82% coverage and a
 * blocking `sleepSync` ~75% (JSC keeps sampling through a native call, so it
 * gets named rather than hidden), while a real SIGSTOP yields 2 samples of a
 * possible 774. The floor sits well clear of both. If a run reports coverage
 * clustered just under it, that is a reason to re-examine the floor — the
 * percentage is in the log line precisely so it can be second-guessed.
 */
export function drainStallSamples(
	windowMs?: number,
	now: () => number = () => performance.now(),
): StallDrain {
	const wantWindow =
		windowMs !== undefined && Number.isFinite(windowMs) && windowMs > 0;

	if (!enabled || reader === null) return emptyDrain(false);

	// The window has to end where the loop unblocked, so the clock is read
	// BEFORE anything else happens in this call — the buffer read alone costs
	// ~11 ms.
	const drainedAtMs = now();

	// Plant a sample at a known instant, on healthy ticks only, and only until
	// the ring is full. A ping measures the offset wherever it runs, so skipping
	// it during a stall is not a correctness rule: it is that the stall drain
	// already uses a prior observation, and adding 3 ms of busy-wait to the tick
	// that just reported a freeze is a poor trade for an observation we do not
	// need.
	const pingFrame = STALL_PROFILER_PING_FRAMES[pingGeneration];
	const pingEndedAtMs =
		!wantWindow && offsetRingFilled < CALIBRATION_SLOTS && !needsClearingRead
			? stallProfilerClockPing(now)
			: null;
	if (pingEndedAtMs !== null) {
		// Advance HERE, not after the read. The read can fail, and a generation
		// left un-advanced by a failed read is reused by the next tick — whose
		// own ping, if missed, then takes the previous tick's still-in-flight
		// sample for its own and calibrates a whole tick late.
		pingGeneration = (pingGeneration + 1) % STALL_PROFILER_PING_FRAMES.length;
	}

	let result: SamplingResult;
	try {
		result = reader();
	} catch {
		needsClearingRead = true;
		return emptyDrain(wantWindow);
	}
	// The call returned, so the buffer was drained even if its contents are
	// unusable.
	needsClearingRead = false;

	// An empty batch is NOT nothing to report. During a stall it means the
	// window holds no samples at all, which is the strongest form of the
	// coverage finding — so it falls through to the checks below rather than
	// returning early and leaving the caller with silence. Only a read that
	// failed outright is unavailable.
	const all = result?.traces;
	if (!Array.isArray(all)) return emptyDrain(wantWindow);

	let placeable = 0;
	for (const trace of all) {
		const ts = trace?.timestamp;
		if (typeof ts === "number" && Number.isFinite(ts)) placeable++;
	}

	// Offset from PRIOR drains only. A batch never contributes to the window it
	// is about to be measured against.
	const offsetMs = clockOffsetMs();
	if (pingEndedAtMs !== null) {
		const planted = newestPlantedSample(all, pingFrame);
		// No planted sample means the sampler missed the ping entirely. Record
		// nothing rather than falling back to the newest trace: that fallback is
		// exactly the ~1000 ms error this design exists to avoid.
		if (planted !== null) recordClockOffset(pingEndedAtMs - planted * 1000);
	}

	if (!wantWindow) {
		return {
			...tally(all),
			batchSamples: all.length,
			windowed: false,
			attribution: "unwindowed",
			expectedSamples: null,
			occupiedBins: null,
		};
	}

	// Mixed or missing timestamps: an unplaceable trace cannot be shown to be
	// outside the window, so dropping it would inflate the share of every trace
	// that survives — 99 unplaceable plus 1 placeable would read as a confident
	// 100%. Refuse the window instead of narrowing onto an arbitrary subset.
	if (placeable !== all.length) {
		return unattributed(all.length, "unplaceable", null);
	}
	if (offsetMs === null) {
		return unattributed(all.length, "not-calibrated", null);
	}

	const windowEndSec = (drainedAtMs - offsetMs) / 1000;
	const windowStartSec = windowEndSec - windowMs / 1000;
	const inWindow = all.filter((t) => {
		const ts = t.timestamp as number;
		return ts >= windowStartSec && ts <= windowEndSec;
	});

	const expectedSamples = windowMs / sampleIntervalMs(result);
	if (
		inWindow.length < MIN_WINDOW_SAMPLES ||
		inWindow.length < expectedSamples * MIN_COVERAGE_RATIO
	) {
		return {
			totalSamples: inWindow.length,
			batchSamples: all.length,
			top: [],
			windowed: true,
			attribution: "low-coverage",
			expectedSamples,
			occupiedBins: occupiedBins(
				inWindow,
				windowStartSec,
				windowMs,
				expectedSamples,
			),
		};
	}

	// Enough samples; now check they describe the WHOLE window and not one
	// densely-sampled stretch of it.
	const occupied = occupiedBins(
		inWindow,
		windowStartSec,
		windowMs,
		expectedSamples,
	);
	if (occupied < COVERAGE_BINS * MIN_OCCUPIED_BINS_RATIO) {
		return {
			totalSamples: inWindow.length,
			batchSamples: all.length,
			top: [],
			windowed: true,
			attribution: "uneven-coverage",
			expectedSamples,
			occupiedBins: occupied,
		};
	}

	return {
		...tally(inWindow),
		batchSamples: all.length,
		windowed: true,
		attribution: "ranked",
		expectedSamples,
		occupiedBins: occupied,
	};
}

/**
 * How many of the window's slices hold a real share of the samples they could
 * hold — see MIN_BIN_DENSITY. A slice with one lone sample in it does not
 * count.
 *
 * This is the difference between "the block was sampled" and "something inside
 * the window was sampled". A window half of which the loop spent descheduled
 * can still be dense in total, and its samples then describe the other half
 * only — they are not attribution for the stall that was reported.
 */
function occupiedBins(
	traces: SampledTrace[],
	windowStartSec: number,
	windowMs: number,
	expectedSamples: number,
): number {
	const binSec = windowMs / 1000 / COVERAGE_BINS;
	if (!(binSec > 0)) return 0;
	const counts = new Array<number>(COVERAGE_BINS).fill(0);
	for (const trace of traces) {
		const ts = trace.timestamp;
		if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
		const bin = Math.min(
			COVERAGE_BINS - 1,
			Math.max(0, Math.floor((ts - windowStartSec) / binSec)),
		);
		counts[bin]++;
	}
	const needed = Math.max(
		1,
		(expectedSamples / COVERAGE_BINS) * MIN_BIN_DENSITY,
	);
	return counts.filter((c) => c >= needed).length;
}

function emptyDrain(wantWindow: boolean): StallDrain {
	return {
		totalSamples: 0,
		batchSamples: 0,
		top: [],
		windowed: false,
		// A stall whose profiler read produced nothing must say so. Reporting it
		// as an ordinary unwindowed drain makes the formatter return null and the
		// caller log nothing, which reads exactly like a stall that was never
		// profiled at all.
		attribution: wantWindow ? "unavailable" : "unwindowed",
		expectedSamples: null,
		occupiedBins: null,
	};
}

function unattributed(
	batchSamples: number,
	attribution: StallAttribution,
	expectedSamples: number | null,
): StallDrain {
	return {
		totalSamples: batchSamples,
		batchSamples,
		top: [],
		windowed: false,
		attribution,
		expectedSamples,
		occupiedBins: null,
	};
}

/** Tally leaf frames across a set of traces. */
function tally(traces: SampledTrace[]): {
	totalSamples: number;
	top: FrameTally[];
} {
	const counts = new Map<string, number>();
	const bump = (label: string) =>
		counts.set(label, (counts.get(label) ?? 0) + 1);

	for (const trace of traces) {
		const frames = trace?.frames;
		if (!Array.isArray(frames) || frames.length === 0) {
			// Counted, not skipped. Every trace is in the denominator, so a trace
			// dropped here without a bucket would silently deflate the share of
			// every real frame — the same accounting bug the `<unattributed>`
			// bucket below exists to avoid.
			bump("<unattributed>");
			continue;
		}
		bump(labelFor(frames));
	}

	const total = traces.length;
	const top = [...counts.entries()]
		.map(([label, samples]) => ({
			label,
			samples,
			sharePct: (samples / total) * 100,
		}))
		.filter((f) => f.sharePct >= MIN_SHARE_PCT)
		.sort((a, b) => b.samples - a.samples)
		.slice(0, TOP_FRAMES);

	return { totalSamples: total, top };
}

/**
 * Sampling period in milliseconds.
 *
 * JSC reports it in SECONDS (0.001 for the fixed ~1 ms rate), but accept a
 * millisecond-shaped value too rather than silently assuming 1 ms if that ever
 * changes — the number feeds the coverage gate, and overestimating the expected
 * sample count only suppresses attribution, never fabricates it.
 */
function sampleIntervalMs(result: SamplingResult): number {
	const interval = result?.interval;
	if (
		typeof interval !== "number" ||
		!Number.isFinite(interval) ||
		interval <= 0
	) {
		return DEFAULT_SAMPLE_INTERVAL_MS;
	}
	if (interval < 1) return interval * 1000;
	return interval <= 100 ? interval : DEFAULT_SAMPLE_INTERVAL_MS;
}

/** Does this frame belong to our own source rather than a builtin or runtime? */
function isAppFrame(frame: SampledFrame | undefined): boolean {
	const url = frame?.sourceURL;
	return typeof url === "string" && url.includes("/packages/");
}

/**
 * Build the label for one trace.
 *
 * The leaf alone is usually not actionable. Hot loops bottom out in a builtin —
 * `Date.now`, `JSON.parse`, a regex exec — so a leaf-only tally reports the
 * OPERATION while hiding the CALL SITE, which is the thing you would actually
 * go and change. (Observed while validating this: a deliberate 300 ms burner
 * attributed 93% to `now` and only 7% to the function containing the loop.)
 *
 * So when the leaf is not our own code, walk outwards to the nearest frame that
 * is, and report both as `leaf <- caller`. That keeps the operation visible
 * while naming the code responsible for it.
 */
function labelFor(frames: SampledFrame[]): string {
	const leaf = frames[0];
	const leafName = leaf?.name?.trim();
	const leafUrl = leaf?.sourceURL?.trim();

	let leafLabel: string;
	if (leafName && leafName !== "(program)") {
		leafLabel = leafName;
	} else if (leafUrl) {
		leafLabel = shortenSource(leafUrl);
	} else {
		leafLabel = leaf?.category ? `<${leaf.category}>` : "<unattributed>";
	}

	// Already our code: the leaf names both the operation and its location.
	if (isAppFrame(leaf)) {
		return leafUrl ? `${leafLabel} (${shortenSource(leafUrl)})` : leafLabel;
	}

	const caller = frames.find((f, i) => i > 0 && isAppFrame(f));
	if (!caller) return leafLabel;
	const callerName = caller.name?.trim() || "?";
	const callerUrl = caller.sourceURL?.trim();
	return callerUrl
		? `${leafLabel} <- ${callerName} (${shortenSource(callerUrl)})`
		: `${leafLabel} <- ${callerName}`;
}

/** Trim an absolute module path to something readable in a log line. */
function shortenSource(url: string): string {
	const marker = "/packages/";
	const at = url.lastIndexOf(marker);
	if (at !== -1) return url.slice(at + marker.length);
	const slash = url.lastIndexOf("/");
	return slash === -1 ? url : url.slice(slash + 1);
}

/** Render a drained tally as one log line, or null when there is nothing to say. */
export function formatStallSamples(drained: {
	totalSamples: number;
	top: FrameTally[];
	windowed?: boolean;
	attribution?: StallAttribution;
	expectedSamples?: number | null;
	occupiedBins?: number | null;
}): string | null {
	const attribution = drained.attribution ?? "unwindowed";

	// The window could not be located. Say which way it failed and stop — the
	// batch is still full of samples, and ranking them here is exactly the
	// mistake this instrument exists to avoid.
	if (attribution === "unavailable") {
		return "profiler returned no usable sample batch — no attribution";
	}
	if (attribution === "not-calibrated") {
		return `${drained.totalSamples} samples, clock not yet calibrated — cannot isolate the blocked window`;
	}
	if (attribution === "unplaceable") {
		return `${drained.totalSamples} samples, timestamps unusable — cannot isolate the blocked window`;
	}

	// The window WAS located, and what it holds does not support naming a
	// culprit. Report the shape of the shortfall — which of the two it is
	// changes what the stall probably was.
	if (attribution === "low-coverage") {
		const expected = drained.expectedSamples ?? 0;
		const pct =
			expected > 0 ? Math.round((drained.totalSamples / expected) * 100) : 0;
		return `${drained.totalSamples} of ~${Math.round(expected)} possible samples inside the blocked window (${pct}%) — little of it was spent executing JS: descheduled, stopped inside the VM, or the sampler could not keep up; no attribution`;
	}
	if (attribution === "uneven-coverage") {
		return `${drained.totalSamples} of ~${Math.round(drained.expectedSamples ?? 0)} samples inside the blocked window, but they cover only ${drained.occupiedBins ?? 0}/${COVERAGE_BINS} slices of it — part of the window was never observed, so they describe a fraction of the block; no attribution`;
	}

	if (drained.totalSamples === 0) return null;
	if (drained.top.length === 0) {
		return `${drained.totalSamples} samples, none above ${MIN_SHARE_PCT}% — no dominant frame`;
	}

	const parts = drained.top.map(
		(f) => `${f.label} ${f.sharePct.toFixed(0)}% (${f.samples})`,
	);
	// The slice count rides along on ranked lines too: a window at 18/20 is a
	// good attribution with a gap in it, and the reader should see that rather
	// than infer uniform coverage from a percentage.
	const scope =
		attribution === "ranked"
			? `${drained.totalSamples} of ~${Math.round(drained.expectedSamples ?? 0)} samples in the blocked window (${drained.occupiedBins ?? 0}/${COVERAGE_BINS} slices)`
			: `${drained.totalSamples} samples`;
	return `${scope} | ${parts.join("  |  ")}`;
}
