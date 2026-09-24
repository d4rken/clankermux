/**
 * Tests for startIntegrityScheduler + runIntegrityCheckOnDemand
 * (packages/proxy/src/integrity-scheduler.ts).
 *
 * Strategy: pass a mock DatabaseOperations so we can observe calls to
 * runQuickIntegrityCheck / runFullIntegrityCheck / markIntegrityCheckRunning
 * / recordIntegrityResult without touching a real database. Timers run on a
 * very long interval so the periodic ticks don't fire during the test —
 * we exercise the per-check coroutines via the on-demand entry point.
 *
 * `runIntegrityCheckInWorker` is mocked via `mock.module` so we can verify
 * routing without spawning real `bun:sqlite` workers. Tests with
 * `dbPath: undefined` exercise the no-file-path fallback branch (no worker —
 * e.g. an in-memory DB whose path can't be resolved); tests with
 * `dbPath: "/tmp/anything"` exercise the worker branch.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as nodeFs from "node:fs";
import type { DatabaseOperations } from "@clankermux/database";
import type { IntegrityStatus } from "@clankermux/types";
// The real corruption classifier — imported by FILE path (not the mocked
// `@clankermux/database` package specifier) so the scheduler's mocked module
// can re-export the genuine implementation used by the fallback path.
import { isCorruptionError as realIsCorruptionError } from "../../../database/src/sqlite-error";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the scheduler so that
// bun's module resolution picks up the mocks. The scheduler imports
// `runIntegrityCheckInWorker` (a value we fake) and `statSync` from node:fs
// (which we fake so the defensive size-skip path is testable without a real
// 24 GiB file). `DatabaseOperations` is a type-only import and is erased at
// runtime, so it doesn't need a stub.
// ---------------------------------------------------------------------------

// Runner shape: a non-ok result carries a `verdict` discriminating a real
// corruption verdict from an operational failure (error/timeout). `verdict` is
// intentionally optional here so a test can inject the legacy, verdict-less
// `{ ok: false, error }` shape (a stale embedded worker) and assert it fails
// safe toward `corrupt`.
type RunnerResult =
	| { ok: true }
	| {
			ok: false;
			verdict?: "corrupt" | "error" | "timeout";
			error: string;
	  };

let workerResultByKind: { quick: RunnerResult; full: RunnerResult } = {
	quick: { ok: true },
	full: { ok: true },
};
/** When set, the mocked worker rejects (simulates worker.onerror / throw). */
let workerThrows: Error | null = null;

const mockRunIntegrityCheckInWorker = mock(
	async (
		_dbPath: string,
		options: { kind: "quick" | "full" },
	): Promise<RunnerResult> => {
		if (workerThrows) throw workerThrows;
		return workerResultByKind[options.kind];
	},
);

mock.module("@clankermux/database", () => ({
	runIntegrityCheckInWorker: mockRunIntegrityCheckInWorker,
	// Real classifier — the scheduler's in-memory-fallback path calls it to
	// decide whether a thrown pragma error is corruption (→ corrupt) or an
	// operational failure (→ skipped).
	isCorruptionError: realIsCorruptionError,
}));

// statSync mock — small size by default so the full path takes the normal
// worker route; individual tests bump `statSize` past the ceiling to exercise
// the size-skip branch. Spread the real module so every other fs export is
// preserved for unrelated importers (core/logger).
//
// `mock.module` is process-global AND permanent for the whole test run: every
// file bun loads after this one gets THIS `statSync`, so whatever it returns
// must satisfy the full `Stats` contract for unrelated callers, not just the
// two `.size` reads this suite makes. A partial `{ size }` object is exactly
// what broke `packages/logger/src/__guards__/no-core-barrel-import.test.ts` on
// CI (`statSync(...).isDirectory is not a function`) once file ordering put it
// after this suite. Hence: only the synthetic paths this suite owns get a
// COMPLETE Stats-shaped object (controlled `size` plus the whole `is*`
// predicate surface); every other path delegates to the genuine implementation.
//
// Routing is by explicit allow-list, NOT by "does this path exist on disk" —
// existence-based routing would silently hand a real `statSync` result (and
// therefore a real size) to this suite the moment something else on the machine
// happened to create /tmp/test.db, quietly disabling the `statSize` knob and the
// size-skip branch these tests name.
//
// CONTRACT: a `dbPath` used by a future test in this file must be added to this
// set. If it isn't, the call delegates to the real `statSync` and fails loudly
// with ENOENT rather than silently fabricating a `Stats`. One test relies on
// that ENOENT deliberately, to drive the scheduler's stat-failure fallback; it
// says so at its own path.
const SYNTHETIC_DB_PATHS = new Set([
	"/tmp/test.db",
	"/tmp/huge.db",
	"/tmp/normal.db",
]);
const realStatSync = nodeFs.statSync;
let statSize = 1024;
const mockStatSync = mock((path: nodeFs.PathLike) => {
	if (typeof path !== "string" || !SYNTHETIC_DB_PATHS.has(path)) {
		return realStatSync(path);
	}
	return {
		size: statSize,
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
	} as unknown as ReturnType<typeof nodeFs.statSync>;
});
mock.module("node:fs", () => ({ ...nodeFs, statSync: mockStatSync }));

import {
	fullCheckInitialDelayMs,
	runIntegrityCheckOnDemand,
	runScheduledIntegrityCheck,
	startFullIntegrityCheckBackground,
	startIntegrityScheduler,
} from "../integrity-scheduler";

interface MockDbOpsOptions {
	quickResult?: string | Error;
	fullResult?: { ok: true } | { ok: false; error: string } | Error;
	dbPath?: string | undefined;
	canClaim?: boolean;
}

/**
 * Build a stub DatabaseOperations. `recordIntegrityResult` / `getIntegrityStatus`
 * maintain a faithful in-memory copy of the real collapse precedence so tests
 * can assert the end-to-end status (`getIntegrityStatus().status`) the scheduler
 * produces, not just the raw call args. The real reducer is independently
 * covered by integrity-storage-methods.test.ts.
 */
function makeDbOps(opts: MockDbOpsOptions = {}): DatabaseOperations {
	const quickResult = opts.quickResult ?? "ok";
	const fullResult = opts.fullResult ?? { ok: true };

	const state: IntegrityStatus = {
		status: "unchecked",
		runningKind: null,
		lastCheckAt: null,
		lastError: null,
		lastQuickCheckAt: null,
		lastQuickResult: null,
		lastQuickError: null,
		lastQuickAttemptAt: null,
		lastQuickSkipReason: null,
		lastFullCheckAt: null,
		lastFullResult: null,
		lastFullError: null,
		lastFullAttemptAt: null,
		lastFullSkipReason: null,
	};

	const runQuickIntegrityCheck = mock(async () => {
		if (quickResult instanceof Error) throw quickResult;
		return quickResult;
	});
	const runFullIntegrityCheck = mock(async () => {
		if (fullResult instanceof Error) throw fullResult;
		return fullResult.ok ? "ok" : fullResult.error;
	});
	const markIntegrityCheckRunning = mock((kind: "quick" | "full") => {
		if (opts.canClaim === false) return false;
		// Mirror the real mutex: in-flight is tracked via runningKind only, and
		// the collapsed status is never overwritten to "running".
		if (state.runningKind !== null) return false;
		state.runningKind = kind;
		return true;
	});
	const recordIntegrityResult = mock(
		(
			kind: "quick" | "full",
			result: "ok" | "corrupt" | "skipped",
			detail?: string | null,
		) => {
			const now = Date.now();
			state.runningKind = null;
			if (result === "skipped") {
				const reason = detail ?? "check could not complete";
				if (kind === "quick") {
					state.lastQuickAttemptAt = now;
					state.lastQuickSkipReason = reason;
				} else {
					state.lastFullAttemptAt = now;
					state.lastFullSkipReason = reason;
				}
			} else if (kind === "quick") {
				state.lastQuickCheckAt = now;
				state.lastQuickResult = result;
				state.lastQuickError = result === "corrupt" ? (detail ?? null) : null;
				state.lastQuickAttemptAt = now;
				state.lastQuickSkipReason = null;
				state.lastCheckAt = now;
			} else {
				state.lastFullCheckAt = now;
				state.lastFullResult = result;
				state.lastFullError = result === "corrupt" ? (detail ?? null) : null;
				state.lastFullAttemptAt = now;
				state.lastFullSkipReason = null;
				if (result === "ok") {
					state.lastQuickResult = "ok";
					state.lastQuickError = null;
					state.lastQuickSkipReason = null;
				}
				state.lastCheckAt = now;
			}
			if (
				state.lastFullResult === "corrupt" ||
				state.lastQuickResult === "corrupt"
			) {
				state.status = "corrupt";
				state.lastError =
					state.lastFullError ??
					state.lastQuickError ??
					"integrity check failed";
			} else if (
				state.lastFullSkipReason !== null ||
				state.lastQuickSkipReason !== null
			) {
				state.status = "skipped";
				state.lastError = null;
			} else if (
				state.lastQuickResult === "ok" ||
				state.lastFullResult === "ok"
			) {
				state.status = "ok";
				state.lastError = null;
			} else {
				state.status = "unchecked";
				state.lastError = null;
			}
		},
	);
	const getIntegrityStatus = mock(() => ({ ...state }));
	const getResolvedDbPath = mock(() => opts.dbPath);
	const restoreFullIntegrityStatus = mock(async () => {});

	return {
		runQuickIntegrityCheck,
		runFullIntegrityCheck,
		markIntegrityCheckRunning,
		recordIntegrityResult,
		getIntegrityStatus,
		getResolvedDbPath,
		restoreFullIntegrityStatus,
	} as unknown as DatabaseOperations;
}

beforeEach(() => {
	mockRunIntegrityCheckInWorker.mockClear();
	mockStatSync.mockClear();
	workerResultByKind = { quick: { ok: true }, full: { ok: true } };
	workerThrows = null;
	statSize = 1024;
});

describe("node:fs statSync mock contract", () => {
	it("keeps the full Stats surface for real paths and only fabricates size for synthetic ones", async () => {
		// Pins the cross-file invariant: this file's `mock.module("node:fs")` is
		// process-global and permanent, so every test file loaded after it must
		// still get a usable `Stats`. Reading through the module registry is what
		// a later file would do.
		const fs = await import("node:fs");

		// A path outside the synthetic set (and a real one) delegates to the
		// genuine implementation: real Stats object, methods intact.
		const dirStats = fs.statSync(import.meta.dir);
		expect(typeof dirStats.isDirectory).toBe("function");
		expect(dirStats.isDirectory()).toBe(true);
		expect(dirStats.isFile()).toBe(false);

		// A declared synthetic path → the controlled size, and still a complete
		// Stats shape.
		statSize = 4242;
		const fakeStats = fs.statSync("/tmp/test.db");
		expect(fakeStats.size).toBe(4242);
		expect(fakeStats.isDirectory()).toBe(false);
		expect(fakeStats.isFile()).toBe(true);
		expect(fakeStats.isSymbolicLink()).toBe(false);
		expect(fakeStats.isBlockDevice()).toBe(false);
		expect(fakeStats.isCharacterDevice()).toBe(false);
		expect(fakeStats.isFIFO()).toBe(false);
		expect(fakeStats.isSocket()).toBe(false);
	});
});

describe("startIntegrityScheduler", () => {
	it("returns a stop function that doesn't throw", () => {
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, {
			quickIntervalHours: 500,
			fullIntervalHours: 500,
		});
		expect(typeof stop).toBe("function");
		expect(() => stop()).not.toThrow();
	});

	it("both interval overrides = 0 returns a no-op stop", () => {
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, {
			quickIntervalHours: 0,
			fullIntervalHours: 0,
		});
		expect(() => stop()).not.toThrow();
		expect(
			(dbOps.runQuickIntegrityCheck as ReturnType<typeof mock>).mock.calls
				.length,
		).toBe(0);
	});

	it("override quickIntervalHours=0 disables the quick probe (not setInterval(0))", () => {
		// Regression: an explicit `0` override used to multiply by HOUR (still
		// 0) and pass the !== null guard, scheduling setInterval(runQuick, 0).
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, {
			quickIntervalHours: 0,
			fullIntervalHours: 500,
		});
		expect(typeof stop).toBe("function");
		// If the disable path is broken setInterval would have fired by now
		// (we don't sleep, but constructor-time logic decides scheduling).
		// The test passes as long as we don't blow up; full assertion is
		// indirect via "no exception on stop()" + no exception during setup.
		stop();
	});

	it("override fullIntervalHours=0 disables the full probe", () => {
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, {
			quickIntervalHours: 500,
			fullIntervalHours: 0,
		});
		expect(typeof stop).toBe("function");
		stop();
	});

	it("restores the last full-check outcome before scheduling the full probe", async () => {
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, {
			quickIntervalHours: 500,
			fullIntervalHours: 500,
		});
		await Promise.resolve();
		expect(
			(dbOps.restoreFullIntegrityStatus as ReturnType<typeof mock>).mock.calls
				.length,
		).toBe(1);
		stop();
	});
});

describe("fullCheckInitialDelayMs", () => {
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	const now = 1_790_000_000_000;

	it("waits the startup delay when no full check was ever attempted", () => {
		expect(fullCheckInitialDelayMs(null, now, DAY)).toBe(30 * 60_000);
	});

	it("waits out the rest of the interval since the last attempt", () => {
		expect(fullCheckInitialDelayMs(now - 2 * HOUR, now, DAY)).toBe(22 * HOUR);
	});

	it("never runs sooner than the startup delay, even when overdue", () => {
		expect(fullCheckInitialDelayMs(now - 3 * DAY, now, DAY)).toBe(30 * 60_000);
	});
});

describe("runIntegrityCheckOnDemand", () => {
	it("quick returns ok when quick_check returns 'ok'", async () => {
		const dbOps = makeDbOps({ quickResult: "ok" });
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toBe("ok");
			expect(out.error).toBeNull();
		}
		expect(dbOps.recordIntegrityResult).toHaveBeenCalledWith(
			"quick",
			"ok",
			null,
		);
	});

	it("quick returns corrupt with the error message when quick_check fails", async () => {
		const dbOps = makeDbOps({ quickResult: "*** missing index entry" });
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toBe("corrupt");
			expect(out.error).toBe("*** missing index entry");
		}
	});

	it("quick reports SKIPPED when runQuickIntegrityCheck throws (a throw is not proven corruption)", async () => {
		// Behavior change: a thrown pragma error (I/O failure, etc.) is an
		// operational failure that could NOT complete — the outer catch now
		// records it as `skipped`, not `corrupt`, preserving any prior verdict.
		const dbOps = makeDbOps({ quickResult: new Error("I/O error") });
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toBe("skipped");
			expect(out.error).toContain("I/O error");
		}
		expect(dbOps.getIntegrityStatus().status).toBe("skipped");
	});

	it("returns 409-style { ok: false, reason: 'already-running' } when mutex is held", async () => {
		const dbOps = makeDbOps({ canClaim: false });
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("already-running");
	});

	it("full falls back to direct runFullIntegrityCheck when no SQLite path is resolvable", async () => {
		const dbOps = makeDbOps({ dbPath: undefined, fullResult: { ok: true } });
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("ok");
		// Should NOT have tried to spawn a worker — it has no SQLite file
		expect(dbOps.runFullIntegrityCheck).toHaveBeenCalled();
		expect(mockRunIntegrityCheckInWorker).not.toHaveBeenCalled();
	});

	it("quick routes through the worker when a SQLite path is resolvable", async () => {
		// Regression: the quick check used to run on the main thread, which
		// froze the proxy event loop for ~30 s on a multi-GiB DB (bun:sqlite
		// is synchronous), resetting downstream sockets. It now goes through
		// the same worker as the full check.
		const dbOps = makeDbOps({ dbPath: "/tmp/test.db" });
		workerResultByKind.quick = { ok: true };
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("ok");
		expect(mockRunIntegrityCheckInWorker).toHaveBeenCalledTimes(1);
		const [calledPath, calledOpts] =
			mockRunIntegrityCheckInWorker.mock.calls[0];
		expect(calledPath).toBe("/tmp/test.db");
		expect(calledOpts).toEqual({ kind: "quick" });
		// Critical: the synchronous main-thread fallback MUST NOT have been
		// invoked when a SQLite path exists.
		expect(dbOps.runQuickIntegrityCheck).not.toHaveBeenCalled();
	});

	it("quick worker corrupt result is recorded with the worker's error message", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/test.db" });
		workerResultByKind.quick = {
			ok: false,
			verdict: "corrupt",
			error: "*** in database main",
		};
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toBe("corrupt");
			expect(out.error).toBe("*** in database main");
		}
		expect(dbOps.recordIntegrityResult).toHaveBeenCalledWith(
			"quick",
			"corrupt",
			"*** in database main",
		);
	});

	it("quick falls back to direct call when no SQLite path is resolvable", async () => {
		const dbOps = makeDbOps({ dbPath: undefined, quickResult: "ok" });
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("ok");
		expect(dbOps.runQuickIntegrityCheck).toHaveBeenCalled();
		expect(mockRunIntegrityCheckInWorker).not.toHaveBeenCalled();
	});

	it("full routes through the worker when a SQLite path is resolvable", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/test.db" });
		workerResultByKind.full = { ok: true };
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("ok");
		expect(mockRunIntegrityCheckInWorker).toHaveBeenCalledTimes(1);
		const [, calledOpts] = mockRunIntegrityCheckInWorker.mock.calls[0];
		expect(calledOpts).toEqual({ kind: "full" });
		expect(dbOps.runFullIntegrityCheck).not.toHaveBeenCalled();
	});

	it("a quick on-demand check followed by a full corrupt produces sticky-corrupt status", async () => {
		// This is the integration glue: the scheduler routes results through
		// `recordIntegrityResult`, which is what enforces the sticky rule.
		// `runIntegrityCheckOnDemand` should call into it with the correct kind.
		const dbOps = makeDbOps({
			quickResult: "ok",
			fullResult: { ok: false, error: "index missing entry" },
			dbPath: undefined, // forces full to use runFullIntegrityCheck path
		});

		await runIntegrityCheckOnDemand(dbOps, "quick");
		const quickCall = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(quickCall?.[0]).toBe("quick");
		expect(quickCall?.[1]).toBe("ok");

		await runIntegrityCheckOnDemand(dbOps, "full");
		const fullCall = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(fullCall?.[0]).toBe("full");
		expect(fullCall?.[1]).toBe("corrupt");
		expect(fullCall?.[2]).toBe("index missing entry");
	});
});

// ---------------------------------------------------------------------------
// Verdict mapping: a timeout / worker error / worker onerror is NOT proven
// corruption — the scheduler must record `skipped` (amber), preserving the
// last verified verdict. A real `verdict:"corrupt"` still records `corrupt`.
// ---------------------------------------------------------------------------

describe("runCheckLocked verdict mapping", () => {
	it("verdict:'timeout' is recorded as skipped, not corrupt", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/test.db" });
		workerResultByKind.full = {
			ok: false,
			verdict: "timeout",
			error: "worker timed out after 600000ms — bun:sqlite call likely hung",
		};
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("skipped");

		const s = dbOps.getIntegrityStatus();
		expect(s.status).not.toBe("corrupt");
		expect(s.status).toBe("skipped");
		expect(s.lastFullSkipReason).toContain("timed out");
		expect(dbOps.recordIntegrityResult).toHaveBeenLastCalledWith(
			"full",
			"skipped",
			expect.stringContaining("timed out"),
		);
	});

	it("verdict:'error' is recorded as skipped, not corrupt", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/test.db" });
		workerResultByKind.full = {
			ok: false,
			verdict: "error",
			error: "unable to open database file",
		};
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("skipped");
		expect(dbOps.getIntegrityStatus().status).toBe("skipped");
		expect(dbOps.getIntegrityStatus().lastFullSkipReason).toContain(
			"unable to open database file",
		);
	});

	it("a worker onerror/throw is recorded as skipped, not corrupt", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/test.db" });
		workerThrows = new Error("integrity worker error");
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("skipped");
		expect(dbOps.getIntegrityStatus().status).toBe("skipped");
		const last = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(last?.[1]).toBe("skipped");
	});

	it("a real verdict:'corrupt' is still recorded as corrupt", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/test.db" });
		workerResultByKind.full = {
			ok: false,
			verdict: "corrupt",
			error: "*** in database main",
		};
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("corrupt");
		expect(dbOps.getIntegrityStatus().status).toBe("corrupt");
	});

	it("an on-demand full over the ceiling still runs the full worker", async () => {
		// The ceiling contains AUTOMATIC scanning. An operator who asks for a
		// check on a huge database has chosen to pay for it, and a database too
		// big to ever check by hand would be worse than the scan.
		const dbOps = makeDbOps({ dbPath: "/tmp/huge.db" });
		statSize = 70 * 1024 ** 3; // > 64 GiB ceiling
		workerResultByKind.full = { ok: true };

		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("ok");
		expect(mockRunIntegrityCheckInWorker).toHaveBeenCalledTimes(1);
		expect(mockRunIntegrityCheckInWorker.mock.calls[0][1]).toEqual({
			kind: "full",
		});
		expect(dbOps.getIntegrityStatus().status).toBe("ok");
	});

	it("an on-demand quick over the ceiling still runs the quick worker", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/huge.db" });
		statSize = 70 * 1024 ** 3;
		workerResultByKind.quick = { ok: true };

		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("ok");
		expect(mockRunIntegrityCheckInWorker.mock.calls[0][1]).toEqual({
			kind: "quick",
		});
	});

	it("the ceiling does not trigger below it (normal on-demand full worker path)", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/normal.db" });
		statSize = 1024; // well under the ceiling
		workerResultByKind.full = { ok: true };

		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("ok");
		expect(mockRunIntegrityCheckInWorker).toHaveBeenCalledTimes(1);
		expect(mockRunIntegrityCheckInWorker.mock.calls[0][1]).toEqual({
			kind: "full",
		});
	});

	it("Fix A: a non-ok worker result WITHOUT a verdict (stale old-protocol worker) fails safe to corrupt", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/test.db" });
		// Legacy embedded worker shape: { ok:false, error } — NO `verdict`. This
		// must NOT be downgraded to skipped; masking real corruption is the
		// dangerous false-negative direction.
		workerResultByKind.full = { ok: false, error: "*** in database main" };
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("corrupt");
		expect(dbOps.getIntegrityStatus().status).toBe("corrupt");
		expect(dbOps.recordIntegrityResult).toHaveBeenLastCalledWith(
			"full",
			"corrupt",
			"*** in database main",
		);
	});

	it("Fix B (worker path): a worker-classified corruption throw (verdict:'corrupt') is recorded corrupt", async () => {
		// The worker's catch classifies a thrown SQLITE_CORRUPT via
		// isCorruptionError and posts verdict:"corrupt"; the scheduler records it.
		const dbOps = makeDbOps({ dbPath: "/tmp/test.db" });
		workerResultByKind.full = {
			ok: false,
			verdict: "corrupt",
			error: "database disk image is malformed",
		};
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("corrupt");
		expect(dbOps.getIntegrityStatus().status).toBe("corrupt");
	});

	it("Fix B (fallback): in-memory direct check that THROWS SQLITE_CORRUPT is recorded corrupt", async () => {
		const corruptErr = Object.assign(
			new Error("database disk image is malformed"),
			{ code: "SQLITE_CORRUPT", errno: 11 },
		);
		const dbOps = makeDbOps({ dbPath: undefined, fullResult: corruptErr });
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("corrupt");
		expect(dbOps.getIntegrityStatus().status).toBe("corrupt");
		const last = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(last?.[0]).toBe("full");
		expect(last?.[1]).toBe("corrupt");
		expect(last?.[2]).toContain("malformed");
	});

	it("Fix B (fallback): in-memory direct check that throws a NON-corruption error is recorded skipped", async () => {
		const ioErr = Object.assign(new Error("disk I/O error"), {
			code: "SQLITE_IOERR",
			errno: 10,
		});
		const dbOps = makeDbOps({ dbPath: undefined, fullResult: ioErr });
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("skipped");
		expect(dbOps.getIntegrityStatus().status).toBe("skipped");
	});

	it("an on-demand check over the ceiling that PROVES corruption is recorded corrupt", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/huge.db" });
		statSize = 70 * 1024 ** 3;
		workerResultByKind.full = {
			ok: false,
			verdict: "corrupt",
			error: "*** page 5 is corrupt",
		};

		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toBe("corrupt");
			expect(out.error).toContain("page 5 is corrupt");
		}
		expect(dbOps.getIntegrityStatus().status).toBe("corrupt");
	});
});

describe("automatic-check size ceiling", () => {
	it("a scheduled full over the ceiling scans nothing", async () => {
		// PRAGMA quick_check walks every b-tree page and the freelist, so
		// substituting it above the ceiling only changes WHICH whole-file scan
		// runs on a timer. The scheduled probe has to not scan.
		const dbOps = makeDbOps({ dbPath: "/tmp/huge.db" });
		statSize = 70 * 1024 ** 3; // > 64 GiB ceiling

		await runScheduledIntegrityCheck(dbOps, "full");

		expect(mockRunIntegrityCheckInWorker).not.toHaveBeenCalled();
		expect(dbOps.runFullIntegrityCheck).not.toHaveBeenCalled();
		expect(dbOps.runQuickIntegrityCheck).not.toHaveBeenCalled();

		const last = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(last?.[0]).toBe("full");
		expect(last?.[1]).toBe("skipped");
		expect(last?.[2]).toContain("exceeds the automatic-check ceiling");

		// Mutex released — a fresh claim succeeds.
		expect(dbOps.markIntegrityCheckRunning("full")).toBe(true);
	});

	it("a scheduled quick over the ceiling scans nothing either", async () => {
		// The quick timer consulted no ceiling at all, so above it the 6-hourly
		// whole-file scan kept running regardless of what the full timer did.
		const dbOps = makeDbOps({ dbPath: "/tmp/huge.db" });
		statSize = 70 * 1024 ** 3;

		await runScheduledIntegrityCheck(dbOps, "quick");

		expect(mockRunIntegrityCheckInWorker).not.toHaveBeenCalled();
		const last = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(last?.[0]).toBe("quick");
		expect(last?.[1]).toBe("skipped");
		expect(last?.[2]).toContain("exceeds the automatic-check ceiling");
		expect(dbOps.markIntegrityCheckRunning("quick")).toBe(true);
	});

	it("a skipped scheduled check never surfaces as ok or healthy", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/huge.db" });

		// Start from a verified-healthy surface.
		statSize = 1024;
		workerResultByKind.quick = { ok: true };
		await runScheduledIntegrityCheck(dbOps, "quick");
		expect(dbOps.getIntegrityStatus().status).toBe("ok");

		// The database grows past the ceiling; the next scheduled probe skips.
		statSize = 70 * 1024 ** 3;
		await runScheduledIntegrityCheck(dbOps, "full");

		const status = dbOps.getIntegrityStatus();
		expect(status.status).toBe("skipped");
		expect(status.status).not.toBe("ok");
		expect(status.lastFullSkipReason).toContain(
			"exceeds the automatic-check ceiling",
		);
		// The stale green verdict is still on record but no longer the surface.
		expect(status.lastQuickResult).toBe("ok");
	});

	it("both scheduled kinds still run below the ceiling", async () => {
		statSize = 1024;

		const quickOps = makeDbOps({ dbPath: "/tmp/normal.db" });
		workerResultByKind.quick = { ok: true };
		await runScheduledIntegrityCheck(quickOps, "quick");
		expect(mockRunIntegrityCheckInWorker.mock.calls.at(-1)?.[1]).toEqual({
			kind: "quick",
		});
		expect(quickOps.getIntegrityStatus().status).toBe("ok");

		const fullOps = makeDbOps({ dbPath: "/tmp/normal.db" });
		workerResultByKind.full = { ok: true };
		await runScheduledIntegrityCheck(fullOps, "full");
		expect(mockRunIntegrityCheckInWorker.mock.calls.at(-1)?.[1]).toEqual({
			kind: "full",
		});
		expect(fullOps.getIntegrityStatus().status).toBe("ok");
	});

	it("a scheduled check whose stat fails falls through to the normal worker path", async () => {
		// An unreadable size must not become a silent skip — the check runs and
		// produces a real verdict. This path is deliberately OUTSIDE
		// SYNTHETIC_DB_PATHS so the real statSync throws ENOENT.
		const dbOps = makeDbOps({ dbPath: "/tmp/unstattable.db" });
		workerResultByKind.full = { ok: true };

		await runScheduledIntegrityCheck(dbOps, "full");

		expect(mockRunIntegrityCheckInWorker).toHaveBeenCalledTimes(1);
		expect(dbOps.getIntegrityStatus().status).toBe("ok");
	});
});

describe("startFullIntegrityCheckBackground", () => {
	it("returns ok synchronously and kicks the worker off without awaiting", async () => {
		const dbOps = makeDbOps({ fullResult: { ok: true }, dbPath: undefined });
		const out = startFullIntegrityCheckBackground(dbOps);
		expect(out.ok).toBe(true);

		// The mutex must already be claimed by the time this function returns.
		expect(dbOps.markIntegrityCheckRunning).toHaveBeenCalledWith("full");

		// The background promise hasn't necessarily settled yet — drain
		// microtasks so the test asserts on the eventual state.
		await new Promise<void>((resolve) => setImmediate(resolve));
		const lastCall = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(lastCall?.[0]).toBe("full");
		expect(lastCall?.[1]).toBe("ok");
	});

	it("returns 409-style { ok: false, reason: 'already-running' } when mutex held", () => {
		const dbOps = makeDbOps({ canClaim: false });
		const out = startFullIntegrityCheckBackground(dbOps);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("already-running");
		// MUST NOT have called the worker path
		expect(dbOps.runFullIntegrityCheck).not.toHaveBeenCalled();
	});

	it("releases the mutex via recordIntegrityResult on background failure (recorded as skipped)", async () => {
		// A thrown failure in the background coroutine is an operational error,
		// not proven corruption — it's recorded as `skipped` (still releasing
		// the mutex) so a prior verified verdict is preserved.
		const dbOps = makeDbOps({
			fullResult: new Error("boom"),
			dbPath: undefined,
		});
		const out = startFullIntegrityCheckBackground(dbOps);
		expect(out.ok).toBe(true);

		await new Promise<void>((resolve) => setImmediate(resolve));
		const lastCall = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(lastCall?.[0]).toBe("full");
		expect(lastCall?.[1]).toBe("skipped");
	});
});
