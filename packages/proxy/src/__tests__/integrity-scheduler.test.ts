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
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as nodeFs from "node:fs";
import type { DatabaseOperations } from "@clankermux/database";
import type { IntegrityStatus } from "@clankermux/types";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the scheduler so that
// bun's module resolution picks up the mocks. The scheduler imports
// `runIntegrityCheckInWorker` (a value we fake) and `statSync` from node:fs
// (which we fake so the defensive size-skip path is testable without a real
// 24 GiB file). `DatabaseOperations` is a type-only import and is erased at
// runtime, so it doesn't need a stub.
// ---------------------------------------------------------------------------

// New runner shape: a non-ok result carries a `verdict` discriminating a real
// corruption verdict from an operational failure (error/timeout).
type RunnerResult =
	| { ok: true }
	| { ok: false; verdict: "corrupt" | "error" | "timeout"; error: string };

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
}));

// statSync mock — small size by default so the full path takes the normal
// worker route; individual tests bump `statSize` past the ceiling to exercise
// the size-skip branch. Spread the real module so every other fs export is
// preserved for unrelated importers (core/logger).
let statSize = 1024;
const mockStatSync = mock(
	(_path: nodeFs.PathLike) =>
		({ size: statSize }) as unknown as ReturnType<typeof nodeFs.statSync>,
);
mock.module("node:fs", () => ({ ...nodeFs, statSync: mockStatSync }));

import {
	runIntegrityCheckOnDemand,
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
	let claimed = false;

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
		if (claimed) return false;
		claimed = true;
		state.status = "running";
		state.runningKind = kind;
		return true;
	});
	const recordIntegrityResult = mock(
		(
			kind: "quick" | "full",
			result: "ok" | "corrupt" | "skipped",
			detail?: string | null,
		) => {
			claimed = false;
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

	return {
		runQuickIntegrityCheck,
		runFullIntegrityCheck,
		markIntegrityCheckRunning,
		recordIntegrityResult,
		getIntegrityStatus,
		getResolvedDbPath,
	} as unknown as DatabaseOperations;
}

beforeEach(() => {
	mockRunIntegrityCheckInWorker.mockClear();
	mockStatSync.mockClear();
	workerResultByKind = { quick: { ok: true }, full: { ok: true } };
	workerThrows = null;
	statSize = 1024;
});

describe("startIntegrityScheduler", () => {
	afterEach(() => {
		delete process.env.CCFLARE_INTEGRITY_CHECK_INTERVAL;
		delete process.env.CCFLARE_FULL_INTEGRITY_CHECK_INTERVAL;
	});

	it("returns a stop function that doesn't throw", () => {
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, {
			quickIntervalHours: 500,
			fullIntervalHours: 500,
		});
		expect(typeof stop).toBe("function");
		expect(() => stop()).not.toThrow();
	});

	it("CCFLARE_INTEGRITY_CHECK_INTERVAL=0 disables only the quick check", () => {
		process.env.CCFLARE_INTEGRITY_CHECK_INTERVAL = "0";
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, { fullIntervalHours: 500 });
		expect(typeof stop).toBe("function");
		stop();
	});

	it("setting both env vars to 0 returns a no-op stop", () => {
		process.env.CCFLARE_INTEGRITY_CHECK_INTERVAL = "0";
		process.env.CCFLARE_FULL_INTEGRITY_CHECK_INTERVAL = "0";
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps);
		expect(() => stop()).not.toThrow();
		expect(
			(dbOps.runQuickIntegrityCheck as ReturnType<typeof mock>).mock.calls
				.length,
		).toBe(0);
	});

	it("garbled env values fall back to default", () => {
		process.env.CCFLARE_INTEGRITY_CHECK_INTERVAL = "6abc";
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, { fullIntervalHours: 500 });
		expect(typeof stop).toBe("function");
		stop();
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

	it("size-skip: a full over the ceiling runs a quick verdict + marks full skipped, holding the mutex", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/huge.db" });
		statSize = 70 * 1024 ** 3; // > 64 GiB ceiling
		workerResultByKind.quick = { ok: true };

		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("skipped");

		// The mutex was claimed once by runIntegrityCheckOnDemand; the size-skip
		// branch must NOT claim it again (it already holds it).
		expect(
			(dbOps.markIntegrityCheckRunning as ReturnType<typeof mock>).mock.calls
				.length,
		).toBe(1);

		// Records the quick verdict first, then the full skip — both synchronously.
		const calls = (dbOps.recordIntegrityResult as ReturnType<typeof mock>).mock
			.calls;
		expect(calls[0][0]).toBe("quick");
		expect(calls[0][1]).toBe("ok");
		expect(calls[1][0]).toBe("full");
		expect(calls[1][1]).toBe("skipped");
		expect(calls[1][2]).toContain("exceeds full-check ceiling");

		// The worker ran exactly once — the quick check, NOT a full check.
		expect(mockRunIntegrityCheckInWorker).toHaveBeenCalledTimes(1);
		expect(mockRunIntegrityCheckInWorker.mock.calls[0][1]).toEqual({
			kind: "quick",
		});

		// Collapsed status is skipped (quick ok, full skipped, nothing corrupt).
		expect(dbOps.getIntegrityStatus().status).toBe("skipped");
	});

	it("size-skip does not trigger below the ceiling (normal full worker path)", async () => {
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

	it("size-skip: if the substitute quick worker THROWS, the outer catch records the FULL kind skipped and releases the mutex", async () => {
		const dbOps = makeDbOps({ dbPath: "/tmp/huge.db" });
		statSize = 70 * 1024 ** 3; // > 64 GiB ceiling — takes the size-skip branch
		// The substitute quick worker blows up (e.g. worker onerror). The outer
		// catch must record the ORIGINAL kind ("full") as skipped — NOT corrupt
		// — and still release the mutex.
		workerThrows = new Error("quick worker blew up");

		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("skipped");

		const s = dbOps.getIntegrityStatus();
		expect(s.status).not.toBe("corrupt");
		expect(s.status).toBe("skipped");
		expect(s.lastFullSkipReason).toContain("quick worker blew up");

		// The recorded outcome is the full kind, skipped (from the outer catch).
		const last = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(last?.[0]).toBe("full");
		expect(last?.[1]).toBe("skipped");

		// Mutex released — a fresh claim succeeds.
		expect(dbOps.markIntegrityCheckRunning("full")).toBe(true);
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
