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
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { tempDbTracker } from "@clankermux/test-support";
import {
	runStorageUsageScanInWorker,
	validateScanTables,
} from "../storage-usage-runner";

const tmpDb = tempDbTracker("test-storage-usage-worker");

afterEach(() => {
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
