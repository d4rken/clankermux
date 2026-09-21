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
 * The admission tests at the bottom drive a hand-written fake worker instead:
 * a real scan of a temp DB finishes in milliseconds, so two calls never
 * actually overlap, and a real worker cannot be held open, failed on demand,
 * or left silent.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { tempDbTracker } from "@clankermux/test-support";
import {
	resetStorageUsageAdmissionStateForTests,
	runStorageUsageScanInWorker,
	setStorageUsageWorkerFactoryForTests,
	validateScanTables,
} from "../storage-usage-runner";
import type { StorageUsageScanResult } from "../storage-usage-worker";

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

type FakeWorker = {
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	postMessage: (data: unknown) => void;
	terminate: () => void;
	/** Finish this worker's scan with `result`. */
	respond: (result: StorageUsageScanResult) => void;
};

/**
 * Install a worker factory whose workers do nothing on their own: each is
 * finished by hand with `respond`, or left silent so the runner's timeout
 * fires. `events` records construction and termination in call order, which is
 * how "two scans, never at the same time" is asserted.
 */
function installFakeWorkers() {
	const workers: FakeWorker[] = [];
	const events: string[] = [];
	const awaited = new Map<number, () => void>();

	setStorageUsageWorkerFactoryForTests(() => {
		const index = workers.length + 1;
		const fake: FakeWorker = {
			onmessage: null,
			onerror: null,
			postMessage: () => {},
			terminate: () => {
				events.push(`terminate:${index}`);
			},
			respond: (result) => {
				fake.onmessage?.({ data: result } as MessageEvent);
			},
		};
		workers.push(fake);
		events.push(`construct:${index}`);
		awaited.get(index)?.();
		awaited.delete(index);
		return fake as unknown as Worker;
	});

	return {
		events,
		get count(): number {
			return workers.length;
		},
		/** Resolves once the nth worker (1-based) has been constructed. */
		async nth(index: number): Promise<FakeWorker> {
			if (workers.length < index) {
				await new Promise<void>((resolve) => {
					awaited.set(index, resolve);
				});
			}
			return workers[index - 1];
		},
	};
}

/** Let every pending continuation run, so "no worker was built" is a real claim. */
async function settleQueue(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
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
