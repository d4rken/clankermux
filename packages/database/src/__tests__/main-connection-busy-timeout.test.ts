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
import { ADDITIVE_COLUMNS, ensureSchema, runMigrations } from "../migrations";

function makeTempDbDir(): string {
	return fs.mkdtempSync(
		path.join(os.tmpdir(), "clankermux-busy-timeout-test-"),
	);
}

/** How long a holder keeps the lock once the caller says it is about to block. */
const HOLD_MS = 400;

/** Ceiling on waiting for the holder to announce that it has the lock. */
const READY_TIMEOUT_MS = 10_000;

/**
 * Per-test ceiling. Each contention test spawns a holder and then deliberately
 * blocks for HOLD_MS, so bun's 5s default is too tight to distinguish a slow
 * machine from a hang.
 */
const CONTENTION_TEST_TIMEOUT_MS = 30_000;

/**
 * A lock held by a SEPARATE PROCESS.
 *
 * A separate process is required, not a timer: every operation these tests
 * exercise blocks synchronously inside SQLite, so a timer in this process
 * could never fire to release the lock.
 */
interface HeldLock {
	/**
	 * Start the release countdown and return. Call it immediately before the
	 * blocking operation under test, so the window opens when the caller is
	 * about to contend rather than whenever the child finished starting up —
	 * a fixed lifetime measured from spawn can expire before the caller ever
	 * reaches the contended call, which passes the test for the wrong reason.
	 */
	openWindow(): void;
	/** Wait for the holder to commit and exit, failing if it did not exit cleanly. */
	release(): Promise<void>;
}

/**
 * Take the database's write lock in a child process and wait until it is
 * genuinely held.
 *
 * Every failure mode here has to be loud. A holder that dies during setup and
 * a holder that never started look identical from the parent — the operation
 * under test simply runs uncontended and passes — so this validates the
 * readiness line itself, treats EOF and a non-zero exit as failures, and
 * bounds both waits rather than hanging.
 */
async function holdWriteLock(
	dbPath: string,
	opts: {
		begin?: "IMMEDIATE" | "EXCLUSIVE";
		/** Statements to run while holding, before COMMIT. */
		writeSql?: string[];
		/** DDL to run (and commit) before taking the lock. */
		setupSql?: string[];
	} = {},
): Promise<HeldLock> {
	const begin = opts.begin ?? "IMMEDIATE";
	const script = `
		const { Database } = require("bun:sqlite");
		const db = new Database(${JSON.stringify(dbPath)}, { create: true });
		db.exec("PRAGMA busy_timeout = 0");
		for (const sql of ${JSON.stringify(opts.setupSql ?? [])}) db.exec(sql);
		db.exec("BEGIN ${begin}");
		for (const sql of ${JSON.stringify(opts.writeSql ?? [])}) db.run(sql);
		console.log("HELD");
		// Hold until the parent says it is about to block, then for HOLD_MS.
		const reader = Bun.stdin.stream().getReader();
		const { done } = await reader.read();
		if (done) process.exit(3);
		await Bun.sleep(${HOLD_MS});
		db.exec("COMMIT");
		db.close();
		// Explicit: the open stdin reader would otherwise keep the loop alive
		// and the parent's wait-for-exit would hang.
		process.exit(0);
	`;
	const child = Bun.spawn(["bun", "-e", script], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const fail = async (reason: string): Promise<never> => {
		child.kill();
		const stderr = await new Response(child.stderr).text().catch(() => "");
		throw new Error(
			`lock holder ${reason}${stderr.trim() ? `\n--- holder stderr ---\n${stderr.trim()}` : ""}`,
		);
	};

	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let seen = "";
	const readyBy = Date.now() + READY_TIMEOUT_MS;
	try {
		while (!seen.includes("HELD")) {
			const left = readyBy - Date.now();
			if (left <= 0) return await fail("did not announce the lock in time");
			const next = await Promise.race([
				reader.read(),
				Bun.sleep(left).then(() => "timeout" as const),
			]);
			if (next === "timeout") {
				return await fail("did not announce the lock in time");
			}
			if (next.done) {
				return await fail(
					`exited (code ${await child.exited}) before taking the lock`,
				);
			}
			seen += decoder.decode(next.value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}

	return {
		openWindow: () => {
			child.stdin.write("go\n");
			child.stdin.flush();
		},
		release: async () => {
			const code = await Promise.race([
				child.exited,
				Bun.sleep(HOLD_MS + READY_TIMEOUT_MS).then(() => "timeout" as const),
			]);

			if (code === "timeout") return await fail("never exited");
			if (code !== 0) return await fail(`exited with code ${code}`);
		},
	};
}

describe("holdWriteLock", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDbDir();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it(
		"rejects when the holder dies before taking the lock",
		async () => {
			// Guards every contention test below. A holder that never took the lock
			// is indistinguishable from a working one at the call site — the
			// operation under test just runs uncontended and passes — so the helper
			// has to refuse rather than resolve on the child's EOF.
			await expect(
				holdWriteLock(path.join(tmpDir, "never-held.db"), {
					setupSql: ["THIS IS NOT VALID SQL"],
				}),
			).rejects.toThrow(/before taking the lock/);
		},
		CONTENTION_TEST_TIMEOUT_MS,
	);
});

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

	it(
		"boots through a transient lock held by another process",
		async () => {
			// runMigrations and runOneShotBackfills write through the raw handle,
			// before the adapter's async retry exists, so the startup window keeps a
			// real C-level busy_timeout. A restart genuinely races here: the
			// outgoing process holds the database exclusively for its shutdown
			// wal_checkpoint(TRUNCATE) while the incoming one opens its handle.
			const dbPath = path.join(tmpDir, "contended.db");
			const holder = await holdWriteLock(dbPath, {
				setupSql: ["PRAGMA journal_mode = WAL"],
				writeSql: ["CREATE TABLE IF NOT EXISTS hold (id INTEGER PRIMARY KEY)"],
			});

			let dbOps: DatabaseOperations | undefined;
			try {
				holder.openWindow();
				const start = performance.now();
				dbOps = new DatabaseOperations(dbPath);
				const elapsed = performance.now() - start;
				// Construction actually waited for the holder. Without this the test
				// would pass just as well against a holder that never took the lock.
				expect(elapsed).toBeGreaterThan(HOLD_MS / 2);

				const { timeout } = dbOps
					.getAdapter()
					.getSQLiteDb()
					.query("PRAGMA busy_timeout")
					.get() as { timeout: number };
				// The widened window is gone by the time construction returns.
				expect(timeout).toBe(MAIN_CONNECTION_BUSY_TIMEOUT_MS);
				expect(STARTUP_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
			} finally {
				await dbOps?.close();
				await holder.release();
			}
		},
		CONTENTION_TEST_TIMEOUT_MS,
	);

	it(
		"opens an existing rollback-journal database that another process holds EXCLUSIVE",
		async () => {
			// The constructor reads `PRAGMA auto_vacuum` and switches journal_mode
			// before any of its own configuration runs. bun opens every connection
			// at busy_timeout 0, so installing the startup window any later than the
			// open itself leaves those first statements unprotected — and on a
			// rollback-journal database a concurrent BEGIN EXCLUSIVE blocks readers,
			// not just writers.
			const dbPath = path.join(tmpDir, "rollback.db");
			const holder = await holdWriteLock(dbPath, {
				begin: "EXCLUSIVE",
				setupSql: ["CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY)"],
				writeSql: ["INSERT INTO seed (id) VALUES (1)"],
			});

			let dbOps: DatabaseOperations | undefined;
			try {
				holder.openWindow();
				const start = performance.now();
				dbOps = new DatabaseOperations(dbPath);
				const elapsed = performance.now() - start;
				expect(elapsed).toBeGreaterThan(HOLD_MS / 2);

				expect(
					dbOps.getAdapter().getSQLiteDb().query("PRAGMA busy_timeout").get(),
				).toEqual({ timeout: MAIN_CONNECTION_BUSY_TIMEOUT_MS });
			} finally {
				await dbOps?.close();
				await holder.release();
			}
		},
		CONTENTION_TEST_TIMEOUT_MS,
	);

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

	it(
		"waits out a concurrent writer instead of aborting boot",
		async () => {
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
					writeSql: ["INSERT INTO legacy (v) VALUES ('held')"],
				});

				holder.openWindow();
				const result = dbOps.bootstrapAutoVacuum();
				// bootstrapAutoVacuum times itself, so its own number is the proof
				// that the VACUUM waited for the holder rather than running free.
				expect(result.durationMs).toBeGreaterThan(HOLD_MS / 2);
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
		},
		CONTENTION_TEST_TIMEOUT_MS,
	);

	it("widens for the VACUUM and restores the steady-state timeout when it fails", async () => {
		const dbPath = path.join(tmpDir, "failing.db");
		seedModeZeroDb(dbPath);

		const dbOps = new DatabaseOperations(dbPath);
		try {
			const handle = dbOps.getAdapter().getSQLiteDb();
			const realExec = handle.exec.bind(handle);
			// Sampling the timeout AT the VACUUM is what makes this test
			// discriminating: the steady-state value is zero, so asserting only
			// on the value afterwards passes against an implementation that
			// never widened at all.
			const observed: { atVacuum: number | null } = { atVacuum: null };
			// biome-ignore lint/suspicious/noExplicitAny: test stub replacing the DB method
			(handle as any).exec = (...args: any[]) => {
				if (typeof args[0] === "string" && args[0].includes("VACUUM")) {
					observed.atVacuum = (
						handle.query("PRAGMA busy_timeout").get() as { timeout: number }
					).timeout;
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

			expect(observed.atVacuum).toBe(STARTUP_BUSY_TIMEOUT_MS);
			expect(handle.query("PRAGMA busy_timeout").get()).toEqual({
				timeout: MAIN_CONNECTION_BUSY_TIMEOUT_MS,
			});
		} finally {
			await dbOps.close();
		}
	});
});

describe("runMigrations under contention", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDbDir();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it(
		"applies a pending ALTER while another process is committing",
		async () => {
			// The additive-column pass reads schema metadata and then ALTERs. Under
			// a DEFERRED transaction those reads pin a snapshot, and a writer that
			// commits before the ALTER lands kills it: SQLite refuses the upgrade
			// immediately and the busy handler is never consulted, so no amount of
			// busy_timeout repairs it. Nothing retries runMigrations, so the
			// constructor fails and the process does not boot.
			const dbPath = path.join(tmpDir, "pending-alter.db");
			const setup = new Database(dbPath, { create: true });
			setup.exec("PRAGMA journal_mode = WAL");
			ensureSchema(setup);
			const pending = ADDITIVE_COLUMNS.find(({ table, column }) =>
				(
					setup.prepare(`PRAGMA table_info(${table})`).all() as Array<{
						name: string;
					}>
				).some((c) => c.name === column),
			);
			if (!pending) throw new Error("no additive column to strip");
			setup.run(`ALTER TABLE ${pending.table} DROP COLUMN ${pending.column}`);
			setup.close();

			const db = new Database(dbPath);
			db.exec(`PRAGMA busy_timeout = ${STARTUP_BUSY_TIMEOUT_MS}`);
			const holder = await holdWriteLock(dbPath, {
				writeSql: [
					"INSERT INTO strategies (name, config, updated_at) VALUES ('contention-probe', '{}', 1)",
				],
			});

			try {
				holder.openWindow();
				const start = performance.now();
				runMigrations(db);
				expect(performance.now() - start).toBeGreaterThan(HOLD_MS / 2);

				const columns = (
					db.prepare(`PRAGMA table_info(${pending.table})`).all() as Array<{
						name: string;
					}>
				).map((c) => c.name);
				expect(columns).toContain(pending.column);
				// The other process's write survived — this waited for it rather
				// than racing it.
				expect(
					db
						.query(
							"SELECT name FROM strategies WHERE name = 'contention-probe'",
						)
						.get(),
				).not.toBeNull();
			} finally {
				await holder.release();
				db.close();
			}
		},
		CONTENTION_TEST_TIMEOUT_MS,
	);
});
