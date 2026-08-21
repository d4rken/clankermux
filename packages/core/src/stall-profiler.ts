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
 * 221 ms of busy CPU would otherwise accumulate forever), and it is what makes
 * the attribution window meaningful: draining on every monitor tick means a
 * batch read right after a stall contains the samples from that stall rather
 * than an unbounded backlog.
 */

/** Frames rendered per stall report. Enough to see a culprit, short enough to read. */
const TOP_FRAMES = 8;

/** Ignore frames below this share of samples — noise, not a culprit. */
const MIN_SHARE_PCT = 2;

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
}

export interface FrameTally {
	label: string;
	samples: number;
	sharePct: number;
}

/**
 * Drain the sample buffer and tally what was executing.
 *
 * Tallies the LEAF frame of each trace — the function actually running when the
 * sample fired — rather than roots, because every trace shares the same handful
 * of roots and they identify nothing.
 *
 * Always call this on a tick even when there was no stall: the read is what
 * clears the buffer, and skipping it would let an unbounded backlog accumulate
 * and then be misattributed to whichever stall happens to read next.
 */
export function drainStallSamples(windowMs?: number): {
	totalSamples: number;
	top: FrameTally[];
	windowed: boolean;
} {
	if (!enabled || reader === null)
		return { totalSamples: 0, top: [], windowed: false };

	let result: SamplingResult;
	try {
		result = reader();
	} catch {
		return { totalSamples: 0, top: [], windowed: false };
	}

	const all = result?.traces;
	if (!Array.isArray(all) || all.length === 0) {
		return { totalSamples: 0, top: [], windowed: false };
	}

	// Restrict to the tail that actually covers the stall.
	//
	// This is the difference between attribution and fiction. A drain holds
	// everything since the previous tick — about a second PLUS the lag — so
	// ranking the whole batch credits whatever ran BEFORE the block. Measured
	// case: 800 ms of ordinary yielding work followed by a 500 ms stall reported
	// the innocent work at 61% and the real stall at 39%, i.e. it named the
	// wrong function first.
	//
	// Trace timestamps are in SECONDS (the reported `interval` is 0.001 for 1 ms
	// sampling), so the cutoff is `newest - windowMs/1000`. Anchored to the
	// newest sample rather than a wall clock because the two use different
	// epochs and only their differences are comparable.
	const traces = windowTraces(all, windowMs);
	const windowed = windowMs !== undefined && traces.length !== all.length;

	if (traces.length === 0) {
		// Sampled, but nothing landed inside the blocked window — the loop was
		// descheduled by the OS/cgroup rather than executing JS. Reported as a
		// real finding, never silently widened back to the whole batch.
		return { totalSamples: 0, top: [], windowed: true };
	}

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

	return { totalSamples: total, top, windowed };
}

/** Keep only traces within `windowMs` of the newest sample. */
function windowTraces(
	traces: SampledTrace[],
	windowMs: number | undefined,
): SampledTrace[] {
	if (windowMs === undefined || !Number.isFinite(windowMs) || windowMs <= 0) {
		return traces;
	}
	let newest = Number.NEGATIVE_INFINITY;
	for (const t of traces) {
		if (typeof t?.timestamp === "number" && t.timestamp > newest) {
			newest = t.timestamp;
		}
	}
	// No usable timestamps: return everything rather than silently dropping the
	// batch, and let `windowed` stay false so the caller does not claim a
	// precision it does not have.
	if (!Number.isFinite(newest)) return traces;
	const cutoff = newest - windowMs / 1000;
	return traces.filter(
		(t) => typeof t?.timestamp === "number" && t.timestamp >= cutoff,
	);
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
}): string | null {
	// Zero samples INSIDE a stall window is itself the finding: the loop was not
	// executing JS, so it was descheduled (OS/cgroup) rather than blocked by our
	// own code. Distinguished from "profiler off", which returns null.
	if (drained.totalSamples === 0) {
		return drained.windowed === true
			? "0 samples in the blocked window — loop was not running JS (descheduled?)"
			: null;
	}
	if (drained.top.length === 0) {
		return `${drained.totalSamples} samples, none above ${MIN_SHARE_PCT}% — no dominant frame`;
	}
	const parts = drained.top.map(
		(f) => `${f.label} ${f.sharePct.toFixed(0)}% (${f.samples})`,
	);
	return `${drained.totalSamples} samples | ${parts.join("  |  ")}`;
}
