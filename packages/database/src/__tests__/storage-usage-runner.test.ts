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
import { runStorageUsageScanInWorker } from "../storage-usage-runner";

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

	it("returns zeros for a missing table instead of failing the scan", async () => {
		const path = tmpDb.next();
		seedDb(path);

		const result = await runStorageUsageScanInWorker(path, {
			tables: [
				{ key: "things", table: "things" },
				{ key: "ghost", table: "no_such_table" },
			],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.types.find((t) => t.key === "ghost")).toEqual({
			key: "ghost",
			table: "no_such_table",
			rowCount: 0,
			approxBytes: 0,
		});
		// The good table still measured.
		expect(result.types.find((t) => t.key === "things")?.rowCount).toBe(3);
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
