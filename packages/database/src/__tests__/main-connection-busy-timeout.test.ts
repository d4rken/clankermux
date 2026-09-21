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

/** Ceiling on any single wait in the lock-holder handshake. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Per-test ceiling. Each contention test spawns a child process and blocks on
 * a real lock, so bun's 5s default is too tight to distinguish a slow machine
 * from a hang.
 */
const CONTENTION_TEST_TIMEOUT_MS = 30_000;

const DEADLINE = Symbol("deadline");

/**
 * Race `work` against a deadline, always clearing the loser's timer so a
 * settled wait cannot keep the loop alive.
 */
async function withDeadline<T>(
	work: Promise<T>,
	ms: number,
): Promise<T | typeof DEADLINE> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<typeof DEADLINE>((resolve) => {
				timer = setTimeout(() => resolve(DEADLINE), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * A lock held by a SEPARATE PROCESS, which also reports whether the caller's
 * operation was still blocked at the moment the lock was released.
 *
 * A separate process is required, not a timer: every operation these tests
 * exercise blocks the thread synchronously inside SQLite, so nothing in this
 * process could run to release the lock — and for the same reason this process
 * cannot observe its own blocked state. The holder does the observing instead.
 */
interface HeldLock {
	/**
	 * Whether the lock is genuinely held on THIS database at this instant,
	 * observed by having a throwaway zero-timeout connection refused with
	 * SQLITE_BUSY.
	 *
	 * {@link observedBlocking} on its own cannot tell a caller blocked on the
	 * lock from a caller that is merely slow, so it is not sufficient: this is
	 * what ties the contention to the right database. It cannot flake — the
	 * holder does not release until it sees the started marker, which the
	 * caller writes after this returns.
	 */
	lockIsHeld(): boolean;
	/** Call immediately BEFORE the blocking operation under test. */
	markOperationStarted(): void;
	/** Call immediately AFTER it returns or throws. */
	markOperationSettled(): void;
	/**
	 * Whether the operation was still unsettled when the holder released.
	 *
	 * This is an observation, not an inference from elapsed time. The holder
	 * checks for the settled marker immediately before it commits, and a
	 * genuinely blocked caller cannot have written that marker yet, because
	 * writing it requires the operation to have returned, which requires the
	 * lock the holder is still holding. A caller that never contended has
	 * written it, and reads back false.
	 */
	observedBlocking(): Promise<boolean>;
	/** Wait for the holder to exit, failing if it did not exit cleanly. */
	release(): Promise<void>;
}

/**
 * Take the database's write lock in a child process and wait until it is
 * genuinely held.
 *
 * Every failure mode here has to be loud. A holder that died during setup and
 * a holder that is working look identical at the call site — the operation
 * under test simply runs uncontended and passes — so this validates the
 * readiness marker itself, treats EOF and a non-zero exit as failures, and
 * bounds every wait.
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
	const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "clankermux-lock-"));
	const startedMarker = path.join(markerDir, "started");
	const settledMarker = path.join(markerDir, "settled");

	const script = `
		const { Database } = require("bun:sqlite");
		const { existsSync } = require("node:fs");
		const db = new Database(${JSON.stringify(dbPath)}, { create: true });
		db.exec("PRAGMA busy_timeout = 0");
		for (const sql of ${JSON.stringify(opts.setupSql ?? [])}) db.exec(sql);
		db.exec("BEGIN ${begin}");
		for (const sql of ${JSON.stringify(opts.writeSql ?? [])}) db.run(sql);
		console.log("HELD");

		// Wait for the parent to say it is entering the operation.
		const giveUpAt = Date.now() + ${HANDSHAKE_TIMEOUT_MS};
		let started = false;
		while (Date.now() < giveUpAt) {
			if (existsSync(${JSON.stringify(startedMarker)})) { started = true; break; }
			await Bun.sleep(2);
		}

		// Sampled while the lock is STILL HELD: a caller that is genuinely
		// blocked on it cannot have written the settled marker, because writing
		// it requires the operation to have returned.
		const observed = !started
			? "NOT_STARTED"
			: existsSync(${JSON.stringify(settledMarker)})
				? "SETTLED"
				: "BLOCKED";
		console.log("OBSERVED:" + observed);

		db.exec("COMMIT");
		db.close();
		process.exit(0);
	`;
	const child = Bun.spawn(["bun", "-e", script], {
		stdout: "pipe",
		stderr: "pipe",
	});

	let disposed = false;
	const cleanup = () => {
		if (disposed) return;
		disposed = true;
		fs.rmSync(markerDir, { recursive: true, force: true });
	};

	const fail = async (reason: string): Promise<never> => {
		child.kill();
		const drained = await withDeadline(
			new Response(child.stderr).text().catch(() => ""),
			HANDSHAKE_TIMEOUT_MS,
		);
		const stderr = drained === DEADLINE ? "" : drained;
		cleanup();
		throw new Error(
			`lock holder ${reason}${stderr.trim() ? `\n--- holder stderr ---\n${stderr.trim()}` : ""}`,
		);
	};

	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let seen = "";

	/** Read the holder's stdout until `marker` appears, or fail. */
	const readUntil = async (marker: string, what: string): Promise<void> => {
		const by = Date.now() + HANDSHAKE_TIMEOUT_MS;
		while (!seen.includes(marker)) {
			const left = by - Date.now();
			if (left <= 0) return await fail(`did not ${what} in time`);
			const next = await withDeadline(reader.read(), left);
			if (next === DEADLINE) return await fail(`did not ${what} in time`);
			if (next.done) {
				const code = await withDeadline(child.exited, HANDSHAKE_TIMEOUT_MS);
				return await fail(
					`exited (code ${code === DEADLINE ? "unknown" : code}) before it could ${what}`,
				);
			}
			seen += decoder.decode(next.value, { stream: true });
		}
	};

	await readUntil("HELD", "announce the lock");

	return {
		lockIsHeld: () => {
			const probe = new Database(dbPath, { create: true });
			try {
				probe.exec("PRAGMA busy_timeout = 0");
				probe.exec("BEGIN IMMEDIATE");
				// Got the writer slot, so nothing was holding it.
				probe.exec("ROLLBACK");
				return false;
			} catch (err) {
				const code = (err as { code?: string }).code ?? "";
				if (code.startsWith("SQLITE_BUSY")) return true;
				throw err;
			} finally {
				probe.close();
			}
		},
		markOperationStarted: () => fs.writeFileSync(startedMarker, ""),
		markOperationSettled: () => fs.writeFileSync(settledMarker, ""),
		observedBlocking: async () => {
			await readUntil("OBSERVED:", "report what it observed");
			const verdict = /OBSERVED:(\w+)/.exec(seen)?.[1];
			if (verdict === undefined) return await fail("reported no verdict");
			return verdict === "BLOCKED";
		},
		release: async () => {
			const code = await withDeadline(child.exited, HANDSHAKE_TIMEOUT_MS);
			if (code === DEADLINE) return await fail("never exited");
			if (code !== 0) return await fail(`exited with code ${code}`);
			cleanup();
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
			).rejects.toThrow(/before it could announce the lock/);
		},
		CONTENTION_TEST_TIMEOUT_MS,
	);

	it(
		"reports not-blocking for an operation that had already settled",
		async () => {
			// The other half of the instrument: observedBlocking() has to be able
			// to come back false, or asserting it is true proves nothing. Marking
			// settled before started is the degenerate "this never blocked" case,
			// and it is ordered rather than timed, so the holder cannot sample
			// between the two marks.
			const holder = await holdWriteLock(path.join(tmpDir, "uncontended.db"), {
				setupSql: ["CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)"],
			});
			try {
				holder.markOperationSettled();
				holder.markOperationStarted();
				expect(await holder.observedBlocking()).toBe(false);
			} finally {
				await holder.release();
			}
		},
		CONTENTION_TEST_TIMEOUT_MS,
	);

	it(
		"reports the lock held only while the holder actually holds it",
		async () => {
			// The probe has to be able to say no, or asserting yes proves nothing.
			// Ordered against the holder's exit rather than timed.
			const dbPath = path.join(tmpDir, "probe.db");
			const holder = await holdWriteLock(dbPath, {
				setupSql: ["CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)"],
			});
			expect(holder.lockIsHeld()).toBe(true);
			holder.markOperationStarted();
			await holder.release();
			expect(holder.lockIsHeld()).toBe(false);
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
				expect(holder.lockIsHeld()).toBe(true);
				holder.markOperationStarted();
				dbOps = new DatabaseOperations(dbPath);
				holder.markOperationSettled();
				// The lock was held on this database, and construction had still
				// not returned when the holder let go. Neither half is sufficient
				// alone: the probe cannot tell how long the caller waited, and an
				// unsettled caller might merely be slow.
				expect(await holder.observedBlocking()).toBe(true);

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
				expect(holder.lockIsHeld()).toBe(true);
				holder.markOperationStarted();
				dbOps = new DatabaseOperations(dbPath);
				holder.markOperationSettled();
				expect(await holder.observedBlocking()).toBe(true);

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

				expect(holder.lockIsHeld()).toBe(true);
				holder.markOperationStarted();
				const result = dbOps.bootstrapAutoVacuum();
				holder.markOperationSettled();
				// The VACUUM was still waiting on the holder when it let go.
				expect(await holder.observedBlocking()).toBe(true);
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
				expect(holder.lockIsHeld()).toBe(true);
				holder.markOperationStarted();
				runMigrations(db);
				holder.markOperationSettled();
				expect(await holder.observedBlocking()).toBe(true);

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
