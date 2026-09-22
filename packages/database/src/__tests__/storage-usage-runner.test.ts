/**
 * Tests for runStorageUsageScanInWorker — the off-thread per-table scan
 * behind `GET /api/storage/usage`.
 *
 * The scan moved to a worker because bun:sqlite is synchronous and the byte
 * sums are full-table scans: on the live multi-GB DB with a cold page cache
 * they froze the main event loop (and all HTTP serving) for 94–130 s. These
 * tests run the worker in source-mode (empty embedded constant) against real
 * temp-file DBs and assert the sums match direct SQL, plus the operational
 * failure paths (unopenable file, timeout) that must report `ok: false`
 * instead of throwing or hanging.
 *
 * The admission tests at the bottom drive the fake worker from
 * `fake-storage-usage-worker.fixture.ts` instead, for the reasons its header
 * gives.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { dirname, join } from "node:path";
import { tempDbTracker } from "@clankermux/test-support";
import { EMBEDDED_STORAGE_USAGE_WORKER_CODE } from "../inline-storage-usage-worker";
import {
	resetStorageUsageAdmissionStateForTests,
	runStorageUsageScanInWorker,
	setStorageUsageWorkerFactoryForTests,
	validateScanTables,
} from "../storage-usage-runner";
import type { StorageUsageScanResult } from "../storage-usage-worker";
import {
	installFakeWorkers,
	settleQueue,
} from "./fake-storage-usage-worker.fixture";

const tmpDb = tempDbTracker("test-storage-usage-worker");

afterEach(() => {
	// Both resets matter for the real-worker tests: a leaked fake factory would
	// replace their worker, and a leaked cooldown would refuse their scan.
	setStorageUsageWorkerFactoryForTests(null);
	resetStorageUsageAdmissionStateForTests();
	tmpDb.cleanup();
});

function seedDb(path: string): void {
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("CREATE TABLE things (id TEXT PRIMARY KEY, blob_col TEXT)");
	db.exec("CREATE TABLE empties (id TEXT PRIMARY KEY)");
	const insert = db.prepare("INSERT INTO things (id, blob_col) VALUES (?, ?)");
	insert.run("a", "x".repeat(100));
	insert.run("b", "y".repeat(50));
	insert.run("c", null);
	db.close();
}

describe("runStorageUsageScanInWorker", () => {
	it("measures row counts and logical bytes matching direct SQL", async () => {
		const path = tmpDb.next();
		seedDb(path);

		const result = await runStorageUsageScanInWorker(path, {
			tables: [
				{ key: "things", table: "things" },
				{ key: "empties", table: "empties" },
			],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const things = result.types.find((t) => t.key === "things");
		// 3 ids (1 byte each) + 100 + 50 content bytes, NULL counted as 0.
		expect(things?.rowCount).toBe(3);
		expect(things?.approxBytes).toBe(153);
		const empties = result.types.find((t) => t.key === "empties");
		expect(empties?.rowCount).toBe(0);
		expect(empties?.approxBytes).toBe(0);
	});

	it("fails the whole scan for a missing table rather than reporting it as empty", async () => {
		// Zeros from a table that could not be measured are indistinguishable
		// from zeros from a table that is genuinely empty, and the card renders
		// both as a measured size. The measurement is all-or-nothing instead.
		const path = tmpDb.next();
		seedDb(path);

		const result = await runStorageUsageScanInWorker(path, {
			tables: [
				{ key: "things", table: "things" },
				{ key: "ghost", table: "no_such_table" },
			],
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("no_such_table");
	});

	it("still reports genuine zeros for a table that exists and is empty", async () => {
		const path = tmpDb.next();
		seedDb(path);

		const result = await runStorageUsageScanInWorker(path, {
			tables: [{ key: "empties", table: "empties" }],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.types).toEqual([
			{ key: "empties", table: "empties", rowCount: 0, approxBytes: 0 },
		]);
	});

	it("reports ok:false when the file cannot be opened", async () => {
		// readonly open cannot create, so a nonexistent path fails at open —
		// the one class of error that must surface as available:false rather
		// than as silent zeros.
		const result = await runStorageUsageScanInWorker(
			join(dirname(tmpDb.next()), "no-such-dir", "x.db"),
			{ tables: [{ key: "things", table: "things" }] },
		);

		expect(result.ok).toBe(false);
	});

	it("reports ok:false for a file that is not a database", async () => {
		// SQLite opens garbage lazily, so the open succeeds — the worker's
		// journal-mode probe is the first query and throws NOTADB. Surfacing
		// that as unavailable beats the old in-process behaviour of confident
		// zeros over an unreadable file.
		const path = tmpDb.next();
		await Bun.write(path, "not a sqlite file at all");

		const result = await runStorageUsageScanInWorker(path, {
			tables: [{ key: "things", table: "things" }],
		});

		expect(result.ok).toBe(false);
	});

	it("refuses a rollback-journal database instead of stalling its writer", async () => {
		// In rollback-journal mode this scan's minutes-long SELECT would hold a
		// shared lock that blocks every writer commit — the same event-loop
		// damage the worker exists to prevent, relocated into SQLite's busy
		// handler. The worker must refuse, and the caller reports unavailable.
		const path = tmpDb.next();
		const setup = new Database(path);
		setup.exec("CREATE TABLE things (id TEXT PRIMARY KEY)");
		setup.close();

		const result = await runStorageUsageScanInWorker(path, {
			tables: [{ key: "things", table: "things" }],
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("journal_mode");
	});

	it("acknowledges its close when it refuses a rollback-journal database", async () => {
		// The refusal returns from inside the worker's `try`, so it is the path
		// where the acknowledgement has to be posted from the `finally`. Losing
		// it would quarantine the path over a scan that ended perfectly cleanly.
		const path = tmpDb.next();
		const setup = new Database(path);
		setup.exec("CREATE TABLE things (id TEXT PRIMARY KEY)");
		setup.close();
		const scan = {
			tables: [{ key: "things", table: "things" }],
			failureCooldownMs: 0,
			quarantineMs: 60_000,
			cleanupGraceMs: 2000,
		};

		expect((await runStorageUsageScanInWorker(path, scan)).ok).toBe(false);

		// A quarantine would refuse this call instead of scanning again.
		const second = await runStorageUsageScanInWorker(path, scan);
		expect(refusalReason(second)).toContain("journal_mode");
	});

	it("acknowledges its close when the database could not be opened", async () => {
		// Nothing was ever opened, so there is nothing that could still be
		// reading the file — a clean close, not an unconfirmed one.
		const path = join(dirname(tmpDb.next()), "no-such-dir", "x.db");
		const scan = {
			tables: [{ key: "things", table: "things" }],
			failureCooldownMs: 0,
			quarantineMs: 60_000,
			cleanupGraceMs: 2000,
		};

		expect((await runStorageUsageScanInWorker(path, scan)).ok).toBe(false);

		const second = await runStorageUsageScanInWorker(path, scan);
		expect(refusalReason(second)).not.toContain("quarantine");
	});

	it("resolves ok:false on timeout instead of hanging", async () => {
		// In WAL mode readers never block on a writer, so this DB is seeded in
		// the default rollback-journal mode instead of via seedDb — there a
		// BEGIN EXCLUSIVE locks readers out, keeping the worker's busy_timeout
		// spinning past the runner's cap.
		const path = tmpDb.next();
		const setup = new Database(path);
		setup.exec("CREATE TABLE things (id TEXT PRIMARY KEY)");
		setup.close();

		const blocker = new Database(path);
		blocker.exec("BEGIN EXCLUSIVE");
		try {
			const result = await runStorageUsageScanInWorker(path, {
				tables: [{ key: "things", table: "things" }],
				busyTimeoutMs: 30000,
				timeoutMs: 1000,
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toContain("timed out");
		} finally {
			blocker.exec("ROLLBACK");
			blocker.close();
		}
	});
});

const TABLES = [{ key: "things", table: "things" }] as const;

type ScanOverrides = {
	timeoutMs?: number;
	failureCooldownMs?: number;
	quarantineMs?: number;
	cleanupGraceMs?: number;
};

function startScan(
	path: string,
	overrides: ScanOverrides = {},
): Promise<StorageUsageScanResult> {
	return runStorageUsageScanInWorker(path, {
		tables: [...TABLES],
		...overrides,
	});
}

/** A result distinguishable per scan, so a shared one can be told apart. */
function measured(rowCount: number): StorageUsageScanResult {
	return {
		ok: true,
		types: [
			{ key: "things", table: "things", rowCount, approxBytes: rowCount * 10 },
		],
	};
}

function refusalReason(result: StorageUsageScanResult): string {
	expect(result.ok).toBe(false);
	return result.ok ? "" : result.error;
}

function remainingMsIn(reason: string): number {
	const match = /ends in (\d+)ms/.exec(reason);
	expect(match).not.toBeNull();
	return Number(match?.[1]);
}

describe("storage-usage scan admission", () => {
	it("runs two overlapping calls as two workers, strictly in sequence", async () => {
		// The second caller must not adopt the first scan's numbers: it asked
		// because something invalidated exactly that snapshot.
		const log = installFakeWorkers();
		const path = tmpDb.next();

		const first = startScan(path);
		const second = startScan(path);
		const worker1 = await log.nth(1);
		await settleQueue();
		expect(log.count).toBe(1);

		worker1.respond(measured(1));
		expect(await first).toEqual(measured(1));

		const worker2 = await log.nth(2);
		worker2.respond(measured(2));
		expect(await second).toEqual(measured(2));

		expect(log.events).toEqual([
			"construct:1",
			"terminate:1",
			"construct:2",
			"terminate:2",
		]);
	});

	it("collapses a third concurrent caller onto the queued successor", async () => {
		const log = installFakeWorkers();
		const path = tmpDb.next();

		const first = startScan(path);
		const second = startScan(path);
		const third = startScan(path);

		(await log.nth(1)).respond(measured(1));
		await first;
		(await log.nth(2)).respond(measured(2));

		expect(await second).toEqual(measured(2));
		expect(await third).toEqual(measured(2));
		await settleQueue();
		expect(log.count).toBe(2);
	});

	it("queues a fresh successor for a caller arriving after promotion", async () => {
		const log = installFakeWorkers();
		const path = tmpDb.next();

		const first = startScan(path);
		const second = startScan(path);
		(await log.nth(1)).respond(measured(1));
		await first;
		const worker2 = await log.nth(2);

		// The successor is running now. Joining it would hand this caller a scan
		// that started before it arrived.
		const third = startScan(path);
		worker2.respond(measured(2));
		expect(await second).toEqual(measured(2));

		(await log.nth(3)).respond(measured(3));
		expect(await third).toEqual(measured(3));
		expect(log.count).toBe(3);
	});

	it("refuses the next call after a failed scan, naming the cooldown", async () => {
		const log = installFakeWorkers();
		const path = tmpDb.next();

		const first = startScan(path, { failureCooldownMs: 60_000 });
		(await log.nth(1)).respond({ ok: false, error: "disk went away" });
		expect((await first).ok).toBe(false);

		const refused = await startScan(path, { failureCooldownMs: 60_000 });
		expect(refusalReason(refused)).toContain("cooldown");
		await settleQueue();
		expect(log.count).toBe(1);
	});

	it("refuses an already-queued successor when its predecessor times out", async () => {
		// Admission decided on arrival would have let this one through: it was
		// queued while the predecessor still looked healthy. That ordering is
		// the motivating one — a cleanup landing mid-scan on a struggling disk.
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const windows = {
			timeoutMs: 1000,
			failureCooldownMs: 60_000,
			quarantineMs: 60_000,
		};

		const first = startScan(path, windows);
		await log.nth(1); // held open: never responds, so the runner times out
		const queued = startScan(path, windows);

		expect(refusalReason(await first)).toContain("timed out");
		expect(refusalReason(await queued)).toContain("quarantine");
		expect(log.count).toBe(1);
	});

	it("admits the next call once the quarantine expires", async () => {
		// Deliberate: the terminated worker is never confirmed stopped, and
		// elapsed time is the only evidence there is.
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const windows = {
			timeoutMs: 1000,
			failureCooldownMs: 20,
			quarantineMs: 20,
		};

		const first = startScan(path, windows);
		await log.nth(1);
		expect((await first).ok).toBe(false);
		await Bun.sleep(80);

		const second = startScan(path, windows);
		(await log.nth(2)).respond(measured(1));
		expect(await second).toEqual(measured(1));
	});

	it("leaves no cooldown behind a successful scan", async () => {
		const log = installFakeWorkers();
		const path = tmpDb.next();

		const first = startScan(path);
		(await log.nth(1)).respond(measured(1));
		await first;

		const second = startScan(path);
		(await log.nth(2)).respond(measured(2));
		expect(await second).toEqual(measured(2));
	});

	it("does not push the cooldown deadline out on every refusal", async () => {
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const failureCooldownMs = 400;

		const first = startScan(path, { failureCooldownMs });
		(await log.nth(1)).respond({ ok: false, error: "disk went away" });
		await first;
		const failedAt = Date.now();

		const remaining: number[] = [];
		while (Date.now() - failedAt < 150) {
			const refused = await startScan(path, { failureCooldownMs });
			remaining.push(remainingMsIn(refusalReason(refused)));
			await Bun.sleep(30);
		}
		expect(remaining.length).toBeGreaterThan(2);
		for (let i = 1; i < remaining.length; i++) {
			expect(remaining[i]).toBeLessThan(remaining[i - 1]);
		}
		expect(log.count).toBe(1);

		// The deadline the failure set still governs, refusals notwithstanding.
		await Bun.sleep(
			Math.max(0, failedAt + failureCooldownMs + 100 - Date.now()),
		);
		const admitted = startScan(path, { failureCooldownMs });
		(await log.nth(2)).respond(measured(1));
		expect((await admitted).ok).toBe(true);
	});

	it("releases the path without quarantine once the close is acknowledged", async () => {
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const windows = { quarantineMs: 60_000, cleanupGraceMs: 2000 };

		const first = startScan(path, windows);
		const worker1 = await log.nth(1);
		worker1.respondWithoutAck(measured(1));
		// A tick behind the result, well inside the grace.
		await settleQueue();
		worker1.acknowledge();
		expect(await first).toEqual(measured(1));

		const second = startScan(path, windows);
		(await log.nth(2)).respond(measured(2));
		expect(await second).toEqual(measured(2));
	});

	it("observes an acknowledgement posted in the same tick as the result", async () => {
		// With no grace at all, only a listener installed before the result is
		// awaited can still catch an acknowledgement posted right behind it.
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const windows = { quarantineMs: 60_000, cleanupGraceMs: 0 };

		const first = startScan(path, windows);
		(await log.nth(1)).respond(measured(1));
		expect(await first).toEqual(measured(1));

		const second = startScan(path, windows);
		(await log.nth(2)).respond(measured(2));
		expect(await second).toEqual(measured(2));
	});

	it("returns the measurement but quarantines a path whose close is never acknowledged", async () => {
		// The bytes were measured correctly, so the caller gets them. What is
		// unknown is whether that worker let go of the file.
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const windows = { quarantineMs: 60_000, cleanupGraceMs: 30 };

		const first = startScan(path, windows);
		(await log.nth(1)).respondWithoutAck(measured(1));
		expect(await first).toEqual(measured(1));

		const refused = await startScan(path, windows);
		expect(refusalReason(refused)).toContain("quarantine");
		await settleQueue();
		expect(log.count).toBe(1);
	});

	it("quarantines a path whose worker reports a failed close", async () => {
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const windows = { quarantineMs: 60_000, cleanupGraceMs: 2000 };

		const first = startScan(path, windows);
		const worker1 = await log.nth(1);
		worker1.respondWithoutAck(measured(1));
		worker1.acknowledge("close failed: disk I/O error");
		expect(await first).toEqual(measured(1));

		const refused = await startScan(path, windows);
		expect(refusalReason(refused)).toContain("quarantine");
	});

	it("keeps the quarantine when a timed-out worker acknowledges late", async () => {
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const windows = {
			timeoutMs: 1000,
			failureCooldownMs: 60_000,
			quarantineMs: 60_000,
			cleanupGraceMs: 2000,
		};

		const first = startScan(path, windows);
		const worker1 = await log.nth(1);
		expect(refusalReason(await first)).toContain("timed out");
		// Posted after the runner gave up and terminated: it says nothing about
		// what that thread was doing while the runner waited.
		worker1.acknowledge();

		const refused = await startScan(path, windows);
		expect(refusalReason(refused)).toContain("quarantine");
	});

	it("admits the next call when the scan timer fires during the acknowledgement wait", async () => {
		// The measurement already landed and the worker then confirmed a clean
		// close, so nothing about this path is uncertain. The scan cap exists to
		// bound a worker that never reported; it must not still be armed once the
		// result is in, where it would turn a clean scan into a held path.
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const windows = {
			// 1000ms is the floor `resolveTimeoutMs` clamps to, so this is the
			// shortest cap the runner will honour.
			timeoutMs: 1000,
			failureCooldownMs: 60_000,
			quarantineMs: 60_000,
			cleanupGraceMs: 10_000,
		};

		const first = startScan(path, windows);
		const worker1 = await log.nth(1);
		worker1.respondWithoutAck(measured(1));
		await settleQueue();
		// Armed before this sleep and for a shorter delay, so the cap is due
		// first however loaded the loop is — and both are far inside the grace.
		await Bun.sleep(1250);
		worker1.acknowledge();
		expect(await first).toEqual(measured(1));

		const second = startScan(path, windows);
		await settleQueue();
		// Checked before the worker is driven: a path held over that expired cap
		// refuses this call and builds nothing, which shows up here.
		expect(log.count).toBe(2);
		(await log.nth(2)).respond(measured(2));
		expect(await second).toEqual(measured(2));
	});

	it("quarantines a path whose worker errors during the acknowledgement wait", async () => {
		// An uncaught error in the worker thread says nothing about what that
		// thread had already done with its file handle, and a close message that
		// arrives afterwards cannot vouch for it. The bytes measured before the
		// error are still good, so the caller keeps them and only the path is
		// held.
		const log = installFakeWorkers();
		const path = tmpDb.next();
		const windows = {
			// Only reached if the quarantine fails to refuse; it caps the stray
			// scan so this test cannot hang on a worker nothing will answer.
			timeoutMs: 1000,
			failureCooldownMs: 60_000,
			quarantineMs: 60_000,
			cleanupGraceMs: 2000,
		};

		const first = startScan(path, windows);
		const worker1 = await log.nth(1);
		worker1.respondWithoutAck(measured(1));
		await settleQueue();
		worker1.errorOut("worker thread crashed");
		await settleQueue();
		worker1.acknowledge();
		expect(await first).toEqual(measured(1));

		const second = startScan(path, windows);
		await settleQueue();
		// Checked before the call is awaited: the refusal owes nothing to a
		// worker, so an admitted scan shows up here as a second construction.
		expect(log.count).toBe(1);
		expect(refusalReason(await second)).toContain("quarantine");
	});

	it("revokes the worker blob URL on every path, quarantined ones included", async () => {
		const log = installFakeWorkers();
		const created: string[] = [];
		const revoked: string[] = [];
		const realCreate = URL.createObjectURL.bind(URL);
		const realRevoke = URL.revokeObjectURL.bind(URL);
		const createSpy = spyOn(URL, "createObjectURL").mockImplementation(
			(blob: Blob) => {
				const url = realCreate(blob);
				created.push(url);
				return url;
			},
		);
		const revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(
			(url: string) => {
				revoked.push(url);
				realRevoke(url);
			},
		);
		try {
			const path = tmpDb.next();
			const windows = { quarantineMs: 60_000, cleanupGraceMs: 30 };

			const clean = startScan(path, windows);
			(await log.nth(1)).respond(measured(1));
			expect((await clean).ok).toBe(true);

			// Same path, straight into quarantine: measured, never acknowledged.
			const unconfirmed = startScan(path, windows);
			(await log.nth(2)).respondWithoutAck(measured(2));
			expect((await unconfirmed).ok).toBe(true);

			expect(revoked).toEqual(created);
			// A source-mode run (empty embedded constant) builds no blob at all,
			// so the equality above only claims something when one was built.
			if (EMBEDDED_STORAGE_USAGE_WORKER_CODE) expect(created.length).toBe(2);
		} finally {
			createSpy.mockRestore();
			revokeSpy.mockRestore();
		}
	});
});

describe("validateScanTables", () => {
	const requested = [
		{ key: "things", table: "things" },
		{ key: "empties", table: "empties" },
	];

	function measured(
		over: Array<
			Partial<{
				key: string;
				table: string;
				rowCount: number;
				approxBytes: number;
			}>
		> = [],
	) {
		return [
			{ key: "things", table: "things", rowCount: 3, approxBytes: 153 },
			{ key: "empties", table: "empties", rowCount: 0, approxBytes: 0 },
		].map((row, i) => ({ ...row, ...(over[i] ?? {}) }));
	}

	it("accepts a complete, correctly identified result", () => {
		expect(validateScanTables(requested, measured())).toBeNull();
	});

	it("rejects a short result", () => {
		expect(validateScanTables(requested, measured().slice(0, 1))).toContain(
			"1 of 2",
		);
	});

	it("rejects a result whose entry names a different table", () => {
		expect(
			validateScanTables(requested, measured([{ table: "somewhere_else" }])),
		).toContain("somewhere_else");
	});

	it("rejects a duplicated table", () => {
		const dup = measured();
		dup[1] = { ...dup[0] };
		expect(validateScanTables(requested, dup)).toContain("things");
	});

	it("rejects non-numeric or negative measurements", () => {
		expect(
			validateScanTables(requested, measured([{ rowCount: Number.NaN }])),
		).toContain("things");
		expect(
			validateScanTables(
				requested,
				measured([{ approxBytes: Number.POSITIVE_INFINITY }]),
			),
		).toContain("things");
		expect(
			validateScanTables(requested, measured([{ approxBytes: -1 }])),
		).toContain("things");
	});
});
