/**
 * Manual validation harness for the stall profiler's window derivation.
 *
 * `bun packages/core/scripts/stall-profiler-clock-check.ts`
 *
 * The windowing in `stall-profiler.ts` rests on three claims about JSC that no
 * unit test can check, because a unit test injects a fake reader:
 *
 *   1. trace timestamps are SECONDS on a clock that advances at the same rate
 *      as `performance.now()` (otherwise the offset drifts and the window
 *      slides off the block),
 *   2. under load the newest sample in a batch is only a millisecond or two old
 *      (otherwise the calibration minimum never converges on the true offset),
 *   3. a block spent executing JS is densely sampled while a block spent
 *      descheduled or inside a blocking native call is not (otherwise the
 *      coverage gate either suppresses everything or nothing).
 *
 * Starting the profiler is irreversible, so this runs as its own process and
 * exits. It prints measurements, and asserts only the claims above.
 */

import { createRequire } from "node:module";
import {
	__setStallProfilerReaderForTests,
	drainStallSamples,
	formatStallSamples,
	STALL_PROFILER_PING_FRAMES,
} from "../src/stall-profiler";

const require = createRequire(import.meta.url);
const jsc = require("bun:jsc") as {
	startSamplingProfiler: () => void;
	samplingProfilerStackTraces: () => {
		interval?: number;
		traces?: { timestamp?: number; frames?: { name?: string }[] }[];
	};
};

const TICK_MS = 1000;
const WARN_MS = 250;
const CHILD_FLAG = "--child";

/** Busy-wait in JS for `ms`, the way a synchronous stall does. */
function burnJs(ms: number): number {
	const start = performance.now();
	let acc = 0;
	while (performance.now() - start < ms) {
		for (let i = 0; i < 5_000; i++) acc += Math.sqrt(i) % 7;
	}
	return acc;
}

/** Emulate steady traffic so the sampler has JS to catch between ticks. */
function startBackgroundLoad(): ReturnType<typeof setInterval> {
	let sink = 0;
	return setInterval(() => {
		sink += burnJs(3);
		if (sink === Number.POSITIVE_INFINITY) console.log("unreachable");
	}, 12);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PING_FRAME = STALL_PROFILER_PING_FRAMES[0];

/**
 * A stand-in for the module's private ping: same shape, and named to match the
 * frame the module actually looks for, so phase 1b measures how reliably JSC
 * catches such a burn without needing the internals exported.
 */
function stallProfilerClockPingA(): number {
	const startedAt = performance.now();
	let spins = 0;
	while (performance.now() - startedAt < 3) spins++;
	if (spins < 0) console.log("unreachable");
	return performance.now();
}

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures.push(label);
};

/**
 * Child mode: run the profiler and a monitor-shaped tick loop, appending one
 * JSON line per tick. Writes to a file rather than a pipe so nothing is lost to
 * buffering while the process is stopped.
 */
if (process.argv.includes(CHILD_FLAG)) {
	const out = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
	jsc.startSamplingProfiler();
	const childLoad = startBackgroundLoad();
	__setStallProfilerReaderForTests(jsc.samplingProfilerStackTraces as never);
	let childLast = performance.now();
	const { appendFileSync } = require("node:fs") as typeof import("node:fs");
	setInterval(() => {
		const nowTick = performance.now();
		const lagMs = Math.max(0, nowTick - childLast - TICK_MS);
		childLast = nowTick;
		const d = drainStallSamples(lagMs >= WARN_MS ? lagMs : undefined);
		appendFileSync(
			out,
			`${JSON.stringify({
				lagMs: Math.round(lagMs),
				attribution: d.attribution,
				totalSamples: d.totalSamples,
				expectedSamples: d.expectedSamples,
				batchSamples: d.batchSamples,
				line: lagMs >= WARN_MS ? formatStallSamples(d) : null,
			})}\n`,
		);
	}, TICK_MS);
	// Held open by the interval; the parent kills it.
	await new Promise(() => {});
	clearInterval(childLoad);
}

console.log("starting sampling profiler (irreversible for this process)\n");
jsc.startSamplingProfiler();
let load = startBackgroundLoad();

// -- Phase 1: characterise the profiler clock against performance.now() -----
console.log("PHASE 1 — clock characterisation (raw reads, ~1s apart)");
const candidates: number[] = [];
let reportedInterval: number | undefined;
let sawTimestamps = true;

for (let i = 0; i < 8; i++) {
	await sleep(TICK_MS);
	const batch = jsc.samplingProfilerStackTraces();
	const mono = performance.now();
	const traces = batch?.traces ?? [];
	reportedInterval = batch?.interval;
	const stamps = traces
		.map((t) => t?.timestamp)
		.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
	if (stamps.length !== traces.length) sawTimestamps = false;
	if (stamps.length === 0) {
		console.log(`  read ${i}: ${traces.length} traces, no usable timestamps`);
		continue;
	}
	const newest = Math.max(...stamps);
	const oldest = Math.min(...stamps);
	const candidate = mono - newest * 1000;
	candidates.push(candidate);
	console.log(
		`  read ${i}: ${traces.length} traces  span=${((newest - oldest) * 1000).toFixed(0)}ms  ` +
			`offsetCandidate=${candidate.toFixed(2)}ms`,
	);
}

console.log(`\n  reported interval: ${reportedInterval}`);
const minC = Math.min(...candidates);
const maxC = Math.max(...candidates);
console.log(
	`  offset candidates: min=${minC.toFixed(2)} max=${maxC.toFixed(2)} spread=${(maxC - minC).toFixed(2)}ms\n`,
);

check(sawTimestamps, "every trace carries a numeric timestamp");
check(
	typeof reportedInterval === "number" && reportedInterval > 0,
	`profiler reports a usable sampling interval (${reportedInterval})`,
);
check(
	candidates.length >= 6,
	`most reads yield timestamped samples (${candidates.length}/8)`,
);
// Claim 1: same rate. A rate mismatch shows up as a candidate that marches in
// one direction across the run; a shared rate keeps them in a tight band.
// The absolute value is meaningless — the epochs differ by the host's uptime —
// so only the SPREAD is evidence. A rate mismatch would march the candidates in
// one direction; stale newest samples would scatter them. Both show up here.
check(
	maxC - minC < 20,
	`candidate spread stays under 20ms over ~8s (${(maxC - minC).toFixed(2)}ms)`,
);
check(
	minC < 0 === maxC < 0,
	`the offset does not straddle zero, i.e. its sign is a property of the epochs (${minC < 0 ? "negative" : "positive"})`,
);

// -- Phase 1b: can calibration be obtained when nothing else runs JS? -----
// The motivating measurement: on an idle process most reads return ZERO traces
// and the rest return one sample ~1000ms stale, so an offset derived from "the
// newest trace" places a 300ms window a full second before the block. The ping
// has to work here, not just under load.
console.log("PHASE 1b — planted-sample calibration on an idle process");
// Genuinely idle: the background load has to be OFF, or this phase measures the
// easy case and claims the hard one.
clearInterval(load);
{
	let planted = 0;
	let unplanted = 0;
	let empty = 0;
	const errors: number[] = [];
	const ROUNDS = 20;
	for (let i = 0; i < ROUNDS; i++) {
		await sleep(1000); // a full tick with no JS at all between drains
		const pingEnd = stallProfilerClockPingA();
		const batch = jsc.samplingProfilerStackTraces();
		const traces = (batch?.traces ?? []) as {
			timestamp?: number;
			frames?: { name?: string }[];
		}[];
		if (traces.length === 0) empty++;
		const pingStamps = traces
			.filter((t) => (t.frames ?? []).some((f) => f?.name === PING_FRAME))
			.map((t) => t.timestamp)
			.filter((t): t is number => typeof t === "number");
		if (pingStamps.length === 0) {
			unplanted++;
		} else {
			planted++;
			errors.push(pingEnd - Math.max(...pingStamps) * 1000);
		}
	}
	const spread = Math.max(...errors) - Math.min(...errors);
	console.log(
		`  ${planted}/${ROUNDS} idle drains caught the planted sample (${unplanted} missed, ${empty} batches held nothing at all)`,
	);
	console.log(`  planted-observation spread: ${spread.toFixed(2)}ms\n`);
	// Calibration needs 5 observations to start windowing and 30 to finish, so
	// the bar is that observations are readily available on an idle process, not
	// a particular hit rate — a miss costs one tick.
	check(
		planted >= ROUNDS * 0.75,
		`the ping is caught on most idle drains (${planted}/${ROUNDS})`,
	);
	check(
		spread < 10,
		`planted observations agree within 10ms (${spread.toFixed(2)}ms)`,
	);
	// The point of the ping: without it these batches would be empty, and there
	// would be nothing to calibrate from at all.
	check(
		empty === 0,
		`the ping guarantees a non-empty batch even when idle (${empty} empty)`,
	);
}

// And the same claim end to end, through the module rather than a stand-in: an
// idle process must be able to reach a calibrated state on its own.
{
	__setStallProfilerReaderForTests(jsc.samplingProfilerStackTraces as never);
	for (let i = 0; i < 8; i++) {
		await sleep(1000);
		drainStallSamples();
	}
	const probe = drainStallSamples(300);
	console.log(`  after 8 idle drains the module reports: ${probe.attribution}`);
	check(
		probe.attribution !== "not-calibrated",
		`the module calibrates itself on an idle process (${probe.attribution})`,
	);
}

// Restore the load for the phases that need traffic-shaped work.
load = startBackgroundLoad();

// -- Phase 2: end-to-end, through the module ------------------------------
console.log("\nPHASE 2 — attribution through drainStallSamples()");
__setStallProfilerReaderForTests(jsc.samplingProfilerStackTraces as never);

let last = performance.now();
const results: {
	kind: string;
	line: string | null;
	attribution: string;
	occupiedBins: number | null;
}[] = [];

/** One monitor tick, exactly as EventLoopMonitor.recordLag drives it. */
function monitorTick(kind: string): void {
	const now = performance.now();
	const lagMs = Math.max(0, now - last - TICK_MS);
	last = now;
	const d = drainStallSamples(lagMs >= WARN_MS ? lagMs : undefined);
	if (lagMs < WARN_MS) {
		console.log(
			`  ${kind}: lag=${lagMs.toFixed(0)}ms  batch=${d.batchSamples}`,
		);
	} else {
		results.push({
			kind,
			line: formatStallSamples(d),
			attribution: d.attribution,
			occupiedBins: d.occupiedBins,
		});
		console.log(
			`  ${kind}: lag=${lagMs.toFixed(0)}ms  attribution=${d.attribution}  ` +
				`samples=${d.totalSamples}/${d.expectedSamples?.toFixed(0) ?? "-"} (batch ${d.batchSamples})`,
		);
		console.log(`      ${formatStallSamples(d)}`);
	}
}

// Calibrate: healthy ticks with no stall.
for (let i = 0; i < 7; i++) {
	await sleep(TICK_MS);
	monitorTick("healthy");
}

// A 300ms block spent executing JS: must be densely sampled and ranked. The
// sleep is a FULL tick, so the burn lands on top of the interval and shows up
// as lag — exactly how a real stall delays the watchdog.
await sleep(TICK_MS);
burnJs(300);
monitorTick("js-burn");

for (let i = 0; i < 2; i++) {
	await sleep(TICK_MS);
	monitorTick("healthy");
}

// A 300ms block spent inside a blocking native call: whatever JSC does here,
// the module must not invent a JS culprit for it.
await sleep(TICK_MS);
Bun.sleepSync(300);
monitorTick("native-block");

clearInterval(load);

const burn = results.find((r) => r.kind === "js-burn");
const native = results.find((r) => r.kind === "native-block");

console.log("");
check(burn !== undefined, "the 300ms JS burn registered as a stall");
// Claim 3a: JS work is dense enough to clear the coverage gate.
check(
	burn?.attribution === "ranked",
	`JS burn is ranked (got ${burn?.attribution})`,
);
check(
	burn?.line?.includes("burnJs") === true,
	`JS burn names burnJs (got: ${burn?.line?.slice(0, 120)})`,
);
// The occupancy floor is 15/20. A genuine block should sit far clear of it, or
// the gate would suppress real attribution instead of only the half-observed
// windows it is aimed at.
check(
	(burn?.occupiedBins ?? 0) >= 19,
	`the JS burn occupies nearly every slice of its window (${burn?.occupiedBins}/20)`,
);
check(
	(native?.occupiedBins ?? 0) >= 19,
	`the native block does too (${native?.occupiedBins}/20)`,
);
check(native !== undefined, "the 300ms native block registered as a stall");
// Claim 3b: whichever way JSC treats a blocking native call, the report must be
// honest — either it names the blocking call, or it says the loop was not
// running JS. It must never name unrelated application work.
check(
	native?.attribution === "low-coverage" ||
		(native?.attribution === "ranked" &&
			(native.line?.includes("sleepSync") === true ||
				native.line?.includes("<unattributed>") === true)),
	`native block is reported honestly (${native?.attribution}: ${native?.line?.slice(0, 120)})`,
);

// -- Phase 3: a real SIGSTOP, in a child --------------------------------
// The scenario the windowing exists for, and the one a fake reader cannot
// produce: the loop is not slow, it is not running at all. Nothing is sampled
// during the pause, so a design that anchors the window to the newest sample
// reports either the resumed tick or pre-pause work at 100% — confidently
// blaming JS for an OS pause. The only honest output is that the window is
// empty.
console.log("\nPHASE 3 — real SIGSTOP (child process)");
const childLog = `/tmp/stall-profiler-sigstop-${process.pid}.log`;
const child = Bun.spawn(
	[process.execPath, import.meta.path, CHILD_FLAG, childLog],
	{
		stdout: "ignore",
		stderr: "pipe",
	},
);

await sleep(9_000); // let the child calibrate on healthy ticks first
process.kill(child.pid, "SIGSTOP");
await sleep(800);
process.kill(child.pid, "SIGCONT");
await sleep(2_500);
child.kill();
await child.exited;

const childLines = (await Bun.file(childLog).text())
	.trim()
	.split("\n")
	.filter(Boolean);
for (const line of childLines) console.log(`  ${line}`);
const childErr = await new Response(child.stderr).text();
if (childErr.trim())
	console.log(`  child stderr: ${childErr.trim().slice(0, 400)}`);

const stalled = childLines
	.map(
		(l) =>
			JSON.parse(l) as {
				lagMs: number;
				attribution: string;
				totalSamples: number;
				expectedSamples: number | null;
				line: string | null;
			},
	)
	.filter((r) => r.lagMs >= WARN_MS);

console.log("");
check(
	stalled.length > 0,
	`the SIGSTOP produced a measurable stall (${stalled.length})`,
);
const pause = stalled.find((r) => r.lagMs >= 500);
check(
	pause !== undefined,
	`the ~800ms pause was measured as lag (${stalled.map((s) => Math.round(s.lagMs)).join(", ")}ms)`,
);
check(
	pause?.attribution === "low-coverage",
	`the pause is reported as unattributable, not blamed on JS (got ${pause?.attribution}: ${pause?.line?.slice(0, 140)})`,
);
check(
	(pause?.totalSamples ?? Number.POSITIVE_INFINITY) <
		(pause?.expectedSamples ?? 0) * 0.5,
	`the window is near-empty as it must be (${pause?.totalSamples} of ~${Math.round(pause?.expectedSamples ?? 0)})`,
);

console.log(
	failures.length === 0
		? "\nALL CHECKS PASSED"
		: `\n${failures.length} CHECK(S) FAILED:\n  - ${failures.join("\n  - ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
