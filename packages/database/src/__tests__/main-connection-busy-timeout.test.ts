/**
 * Verifies that the MAIN-thread connection's `PRAGMA busy_timeout` is zero
 * rather than `dbConfig.busyTimeoutMs` (default 10 000).
 *
 * Background: bun:sqlite's busy handler waits at the C level (usleep) — the
 * entire Bun event loop freezes for however long busy_timeout is whenever a
 * main-thread call hits SQLITE_BUSY (e.g. while the vacuum/integrity worker
 * holds the write lock). The async retry layer (BunSqlAdapter.withBusyRetry)
 * turns SQLITE_BUSY into non-blocking setTimeout retries, so the C-level wait
 * buys nothing the retry loop does not already do, without the freeze.
 *
 * `dbConfig.busyTimeoutMs` stays intact for WORKER connections (vacuum,
 * integrity-check, dashboard workers), where long C-level blocking is fine.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DatabaseOperations,
	MAIN_CONNECTION_BUSY_TIMEOUT_MS,
	STARTUP_BUSY_TIMEOUT_MS,
} from "../database-operations";

function makeTempDbDir(): string {
	return fs.mkdtempSync(
		path.join(os.tmpdir(), "clankermux-busy-timeout-test-"),
	);
}

describe("configureSqlite: main-connection busy_timeout", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDbDir();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("leaves the default main connection with no C-level busy wait", async () => {
		const dbOps = new DatabaseOperations(path.join(tmpDir, "default.db"));
		try {
			const { timeout } = dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("PRAGMA busy_timeout")
				.get() as { timeout: number };
			expect(timeout).toBe(MAIN_CONNECTION_BUSY_TIMEOUT_MS);
			expect(timeout).toBe(0);
		} finally {
			await dbOps.close();
		}
	});

	it("boots through a transient lock held by another process", async () => {
		// runMigrations and runOneShotBackfills write through the raw handle,
		// before the adapter's async retry exists, so the startup window keeps a
		// real C-level busy_timeout. A restart genuinely races here: the
		// outgoing process holds the database exclusively for its shutdown
		// wal_checkpoint(TRUNCATE) while the incoming one opens its handle.
		//
		// The lock is held from a SEPARATE PROCESS on purpose — the constructor
		// blocks synchronously inside SQLite, so a timer in THIS process could
		// never fire to release it.
		const dbPath = path.join(tmpDir, "contended.db");
		const holder = Bun.spawn([
			"bun",
			"-e",
			`
			const { Database } = require("bun:sqlite");
			const db = new Database(${JSON.stringify(dbPath)}, { create: true });
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("BEGIN EXCLUSIVE");
			db.run("CREATE TABLE IF NOT EXISTS hold (id INTEGER PRIMARY KEY)");
			console.log("held");
			setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);
			`,
		]);
		try {
			// Wait for the child to actually hold the lock before racing it.
			const reader = holder.stdout.getReader();
			await reader.read();
			reader.releaseLock();

			const dbOps = new DatabaseOperations(dbPath);
			try {
				const { timeout } = dbOps
					.getAdapter()
					.getSQLiteDb()
					.query("PRAGMA busy_timeout")
					.get() as { timeout: number };
				// Construction survived the lock, and the widened window is gone.
				expect(timeout).toBe(MAIN_CONNECTION_BUSY_TIMEOUT_MS);
				expect(STARTUP_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
			} finally {
				await dbOps.close();
			}
		} finally {
			holder.kill();
			await holder.exited;
		}
	});

	it("ignores a large dbConfig.busyTimeoutMs for the main connection (workers still consume it)", async () => {
		// busyTimeoutMs is a WORKER-connection setting; the main connection must
		// stay at zero no matter what the config says.
		const dbOps = new DatabaseOperations(path.join(tmpDir, "override.db"), {
			busyTimeoutMs: 10_000,
		});
		try {
			const { timeout } = dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("PRAGMA busy_timeout")
				.get() as { timeout: number };
			expect(timeout).toBe(MAIN_CONNECTION_BUSY_TIMEOUT_MS);
		} finally {
			await dbOps.close();
		}
	});
});
