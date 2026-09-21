/**
 * The MAIN-thread connection's busy handling: the steady-state
 * `PRAGMA busy_timeout` value, the widened window construction runs under, and
 * the two startup operations that have to carry that window themselves.
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

import { Database } from "bun:sqlite";
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

/**
 * Hold the database's write lock from a SEPARATE PROCESS and release it after
 * `holdMs`. Resolves once the lock is actually held; the returned `release`
 * waits for the child to exit.
 *
 * A separate process is required, not a timer: every operation these tests
 * exercise blocks synchronously inside SQLite, so a timer in this process
 * could never fire to release the lock.
 */
async function holdWriteLock(
	dbPath: string,
	opts: {
		holdMs: number;
		begin?: "IMMEDIATE" | "EXCLUSIVE";
		/** Statements to run while holding, before COMMIT. */
		writeSql?: string[];
		/** DDL to run (and commit) before taking the lock. */
		setupSql?: string[];
	},
): Promise<{ release: () => Promise<void> }> {
	const begin = opts.begin ?? "IMMEDIATE";
	const script = `
		const { Database } = require("bun:sqlite");
		const db = new Database(${JSON.stringify(dbPath)}, { create: true });
		db.exec("PRAGMA busy_timeout = 0");
		for (const sql of ${JSON.stringify(opts.setupSql ?? [])}) db.exec(sql);
		db.exec("BEGIN ${begin}");
		for (const sql of ${JSON.stringify(opts.writeSql ?? [])}) db.run(sql);
		console.log("held");
		setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${opts.holdMs});
	`;
	const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
	const reader = child.stdout.getReader();
	await reader.read();
	reader.releaseLock();
	return {
		release: async () => {
			await child.exited;
		},
	};
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
		const dbPath = path.join(tmpDir, "contended.db");
		const holder = await holdWriteLock(dbPath, {
			holdMs: 400,
			setupSql: ["PRAGMA journal_mode = WAL"],
			writeSql: ["CREATE TABLE IF NOT EXISTS hold (id INTEGER PRIMARY KEY)"],
		});

		let dbOps: DatabaseOperations | undefined;
		try {
			dbOps = new DatabaseOperations(dbPath);
			const { timeout } = dbOps
				.getAdapter()
				.getSQLiteDb()
				.query("PRAGMA busy_timeout")
				.get() as { timeout: number };
			// Construction survived the lock, and the widened window is gone.
			expect(timeout).toBe(MAIN_CONNECTION_BUSY_TIMEOUT_MS);
			expect(STARTUP_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
		} finally {
			await dbOps?.close();
			await holder.release();
		}
	});

	it("opens an existing rollback-journal database that another process holds EXCLUSIVE", async () => {
		// The constructor reads `PRAGMA auto_vacuum` and switches journal_mode
		// before any of its own configuration runs. bun opens every connection
		// at busy_timeout 0, so installing the startup window any later than the
		// open itself leaves those first statements unprotected — and on a
		// rollback-journal database a concurrent BEGIN EXCLUSIVE blocks readers,
		// not just writers.
		const dbPath = path.join(tmpDir, "rollback.db");
		const holder = await holdWriteLock(dbPath, {
			holdMs: 400,
			begin: "EXCLUSIVE",
			setupSql: ["CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY)"],
			writeSql: ["INSERT INTO seed (id) VALUES (1)"],
		});

		let dbOps: DatabaseOperations | undefined;
		try {
			dbOps = new DatabaseOperations(dbPath);
			expect(
				dbOps.getAdapter().getSQLiteDb().query("PRAGMA busy_timeout").get(),
			).toEqual({ timeout: MAIN_CONNECTION_BUSY_TIMEOUT_MS });
		} finally {
			await dbOps?.close();
			await holder.release();
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

describe("bootstrapAutoVacuum under contention", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDbDir();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/**
	 * A NON-EMPTY database at auto_vacuum=NONE — the only shape that reaches
	 * the migration VACUUM. configureSqlite's `PRAGMA auto_vacuum =
	 * INCREMENTAL` is silently rejected on a database that already has pages,
	 * so the mode stays 0 and bootstrapAutoVacuum has work to do.
	 */
	function seedModeZeroDb(dbPath: string): void {
		const db = new Database(dbPath, { create: true });
		db.exec("PRAGMA journal_mode = WAL");
		db.run("CREATE TABLE legacy (id INTEGER PRIMARY KEY, v TEXT)");
		db.run("INSERT INTO legacy (v) VALUES ('x')");
		db.close();
	}

	it("waits out a concurrent writer instead of aborting boot", async () => {
		// bootstrapAutoVacuum runs AFTER construction, from server.ts, which
		// rethrows on failure — so a VACUUM that cannot get the writer slot
		// takes the whole process down. VACUUM cannot run inside a transaction,
		// so it cannot borrow the adapter's transactional retry; it carries the
		// startup window itself.
		const dbPath = path.join(tmpDir, "modezero.db");
		seedModeZeroDb(dbPath);

		let dbOps: DatabaseOperations | undefined;
		let holder: Awaited<ReturnType<typeof holdWriteLock>> | undefined;
		try {
			dbOps = new DatabaseOperations(dbPath);
			holder = await holdWriteLock(dbPath, {
				holdMs: 400,
				writeSql: ["INSERT INTO legacy (v) VALUES ('held')"],
			});

			const result = dbOps.bootstrapAutoVacuum();
			expect(result.migrated).toBe(true);
			expect(result.modeBefore).toBe(0);
			expect(result.modeAfter).toBe(2);

			// The widened window is a loan, not a new setting.
			expect(
				dbOps.getAdapter().getSQLiteDb().query("PRAGMA busy_timeout").get(),
			).toEqual({ timeout: MAIN_CONNECTION_BUSY_TIMEOUT_MS });
		} finally {
			await holder?.release();
			await dbOps?.close();
		}
	});

	it("restores the steady-state timeout when the VACUUM fails", async () => {
		const dbPath = path.join(tmpDir, "failing.db");
		seedModeZeroDb(dbPath);

		const dbOps = new DatabaseOperations(dbPath);
		try {
			const handle = dbOps.getAdapter().getSQLiteDb();
			const realExec = handle.exec.bind(handle);
			// biome-ignore lint/suspicious/noExplicitAny: test stub replacing the DB method
			(handle as any).exec = (...args: any[]) => {
				if (typeof args[0] === "string" && args[0].includes("VACUUM")) {
					throw new Error("database or disk is full");
				}
				// biome-ignore lint/suspicious/noExplicitAny: delegating to the real method
				return (realExec as any)(...args);
			};
			try {
				expect(() => dbOps.bootstrapAutoVacuum()).toThrow("disk is full");
			} finally {
				// biome-ignore lint/suspicious/noExplicitAny: restoring the real method
				(handle as any).exec = realExec;
			}

			expect(handle.query("PRAGMA busy_timeout").get()).toEqual({
				timeout: MAIN_CONNECTION_BUSY_TIMEOUT_MS,
			});
		} finally {
			await dbOps.close();
		}
	});
});
