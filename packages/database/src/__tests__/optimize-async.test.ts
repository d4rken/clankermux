/**
 * Tests for `DatabaseOperations.optimizeAsync()` and the `kind` discriminator
 * added to the incremental-vacuum worker protocol.
 *
 * Background: the 5-minute "wal-checkpoint" job used to call a synchronous
 * `optimize()` that ran `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)`
 * on the MAIN thread via `sqliteDb.exec()`. When another connection (e.g. the
 * hourly incremental-vacuum worker) held the write lock, `PRAGMA optimize`'s
 * internal ANALYZE blocked inside SQLite's C-level busy handler for the full
 * busy_timeout (10 s), freezing the entire event loop, then threw "database
 * is locked".
 *
 * The fix routes the work through the existing incremental-vacuum worker
 * (kind: "optimize") on its own connection with `busy_timeout = 0`:
 *   - main thread never blocks (worker round-trip is async),
 *   - lock contention resolves instantly as `{ ok: true, skipped: true }`
 *     instead of a 10 s C-level sleep — skipping a 5-minute cycle is normal
 *     when maintenance contends.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-optimize-test-"));
}

describe("DatabaseOperations.optimizeAsync", () => {
	let tmpDir: string;
	let dbPath: string;
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		tmpDir = makeTempDir();
		dbPath = path.join(tmpDir, "test.db");
		// Constructor runs ensureSchema → real schema with indexed,
		// never-ANALYZEd tables, so `PRAGMA optimize` on the worker's fresh
		// connection has genuine ANALYZE work to attempt (SQLite ≥ 3.46
		// analyzes indexed tables that lack sqlite_stat1 entries).
		dbOps = new DatabaseOperations(dbPath);
	});

	afterEach(async () => {
		await dbOps.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves ok (not skipped) on an idle DB and TRUNCATE-reclaims the WAL", async () => {
		// Grow the WAL so the TRUNCATE checkpoint has frames to flush and zero.
		const writer = new Database(dbPath);
		try {
			writer.exec(
				"CREATE TABLE IF NOT EXISTS optimize_smoke (id INTEGER PRIMARY KEY, v TEXT)",
			);
			const ins = writer.prepare("INSERT INTO optimize_smoke (v) VALUES (?)");
			for (let i = 0; i < 500; i++) ins.run(`val-${i}`);
		} finally {
			writer.close();
		}
		const walBefore = await dbOps.getWalSizeBytes();
		expect(walBefore).toBeGreaterThan(0);

		const result = await dbOps.optimizeAsync();
		expect(result.ok).toBe(true);
		expect(result.skipped).toBe(false);
		expect(result.error).toBeUndefined();
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		// With no reader holding frames, wal_checkpoint(TRUNCATE) zeroes the WAL
		// file — the reclamation the main connection no longer does itself
		// (wal_autocheckpoint=0). PASSIVE would have left the WAL at its grown
		// size, so this assertion is what distinguishes the two modes.
		const walAfter = await dbOps.getWalSizeBytes();
		expect(walAfter).toBeLessThan(walBefore);
	});

	it("returns skipped:true quickly when another connection holds the write lock (regression: 10s event-loop freeze)", async () => {
		// Simulate the production contention: the hourly incremental-vacuum
		// worker holds SQLite's single writer slot while the 5-minute
		// optimize tick fires. BEGIN IMMEDIATE takes the same write lock.
		const holder = new Database(dbPath);
		try {
			holder.exec("BEGIN IMMEDIATE");

			const start = Date.now();
			const result = await dbOps.optimizeAsync();
			const elapsed = Date.now() - start;

			// The buggy version slept ~10 s (busy_timeout) inside SQLite's C
			// busy handler — on the main thread. The worker runs with
			// busy_timeout = 0 and reports the contention as a normal skip.
			expect(result.ok).toBe(true);
			expect(result.skipped).toBe(true);
			expect(elapsed).toBeLessThan(2000);
		} finally {
			try {
				holder.exec("ROLLBACK");
			} catch {
				// Transaction may already be gone; closing is what matters.
			}
			holder.close();
		}
	});

	it("does not expose the old synchronous optimize() anymore", () => {
		// The sync method was the bug — it must not silently come back.
		expect(
			(dbOps as unknown as Record<string, unknown>).optimize,
		).toBeUndefined();
	});
});

describe("incremental-vacuum worker protocol: kind discriminator", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
		dbPath = path.join(tmpDir, "test.db");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function spawnWorker(): Worker {
		return new Worker(
			new URL("../incremental-vacuum-worker.ts", import.meta.url).href,
		);
	}

	function roundTrip<T>(worker: Worker, message: unknown): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			worker.onmessage = (event: MessageEvent) => resolve(event.data as T);
			worker.onerror = (event: ErrorEvent) =>
				reject(new Error(event.message ?? "worker error"));
			worker.postMessage(message);
		});
	}

	it("kind-less messages still run the vacuum path (backward compat)", async () => {
		// ensureSchema (via the DatabaseOperations constructor) creates the DB
		// in auto_vacuum=INCREMENTAL mode, which the vacuum path requires.
		const dbOps = new DatabaseOperations(dbPath);
		await dbOps.close();

		const worker = spawnWorker();
		try {
			const result = await roundTrip<{ ok: boolean; mode?: number }>(worker, {
				dbPath,
				pages: 1,
			});
			expect(result.ok).toBe(true);
			expect(result.mode).toBe(2);
		} finally {
			worker.terminate();
		}
	});

	it('kind "optimize" succeeds on an idle DB without requiring auto_vacuum=2', async () => {
		// optimize/checkpoint has no auto_vacuum precondition — verify the
		// worker doesn't apply the vacuum path's mode gate to it. Plain DB,
		// auto_vacuum=0.
		{
			const db = new Database(dbPath, { create: true });
			try {
				db.exec("PRAGMA journal_mode = WAL");
				db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, v TEXT)");
				db.exec("CREATE INDEX idx_smoke_v ON smoke(v)");
				db.exec("INSERT INTO smoke (v) VALUES ('a'), ('b'), ('c')");
			} finally {
				db.close();
			}
		}

		const worker = spawnWorker();
		try {
			const result = await roundTrip<{ ok: boolean; skipped?: boolean }>(
				worker,
				{ dbPath, kind: "optimize" },
			);
			expect(result.ok).toBe(true);
			expect(result.skipped).toBe(false);
		} finally {
			worker.terminate();
		}
	});

	it('kind "optimize" still runs ANALYZE under PRAGMA analysis_limit (bounds, does not disable, analysis)', async () => {
		// The residual-stall fix caps ANALYZE with `PRAGMA analysis_limit = 400`
		// so it can't hold the writer slot for seconds. That must BOUND the scan,
		// not switch analysis off — otherwise the query planner loses its stats.
		// Seed a freshly-created indexed table with >analysis_limit rows: SQLite
		// (>= 3.46) analyzes an indexed table lacking a sqlite_stat1 entry, and
		// the row count exceeds the 400-row limit so the limit is genuinely in
		// effect. After the optimize kind runs, sqlite_stat1 must hold a row for
		// the table's index — proving ANALYZE executed.
		{
			const db = new Database(dbPath, { create: true });
			try {
				db.exec("PRAGMA journal_mode = WAL");
				db.exec("CREATE TABLE analyzed (id INTEGER PRIMARY KEY, v TEXT)");
				db.exec("CREATE INDEX idx_analyzed_v ON analyzed(v)");
				const ins = db.prepare("INSERT INTO analyzed (v) VALUES (?)");
				db.exec("BEGIN");
				for (let i = 0; i < 1000; i++) ins.run(`val-${i % 50}`);
				db.exec("COMMIT");
			} finally {
				db.close();
			}
		}

		const worker = spawnWorker();
		try {
			const result = await roundTrip<{ ok: boolean; skipped?: boolean }>(
				worker,
				{ dbPath, kind: "optimize" },
			);
			expect(result.ok).toBe(true);
			expect(result.skipped).toBe(false);
		} finally {
			worker.terminate();
		}

		// ANALYZE writes estimated stats into sqlite_stat1 even when
		// analysis_limit caps the scan — assert a row exists for our index.
		const check = new Database(dbPath);
		try {
			const row = check
				.query<{ n: number }, []>(
					"SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE idx = 'idx_analyzed_v'",
				)
				.get();
			expect(row?.n ?? 0).toBeGreaterThan(0);
		} finally {
			check.close();
		}
	});

	it('kind "optimize" refreshes an EXISTING stale sqlite_stat1 row', async () => {
		// The regression: a bare `PRAGMA optimize` only reconsiders tables the
		// CALLING connection has itself queried, and this maintenance connection
		// queries none — so stale statistics never self-healed. On the live DB
		// that left `request_routing` recorded at 71 rows against 362k real ones,
		// and the planner drove the activeSessions join the wrong way round.
		//
		// A test that only checks a MISSING stat gets created would pass under the
		// bare pragma too (SQLite >= 3.46 analyzes tables with no stat1 entry), so
		// this seeds a stat row that exists and is wrong.
		{
			const db = new Database(dbPath, { create: true });
			try {
				db.exec("PRAGMA journal_mode = WAL");
				db.exec("CREATE TABLE stale (id INTEGER PRIMARY KEY, v TEXT)");
				db.exec("CREATE INDEX idx_stale_v ON stale(v)");
				const ins = db.prepare("INSERT INTO stale (v) VALUES (?)");
				db.exec("BEGIN");
				for (let i = 0; i < 2000; i++) ins.run(`val-${i % 50}`);
				db.exec("COMMIT");
				// Real stats first, then corrupt the row count the way the live DB's
				// did: recorded when the table was almost empty and never refreshed.
				db.exec("ANALYZE");
				db.exec(
					"UPDATE sqlite_stat1 SET stat = '7 1' WHERE idx = 'idx_stale_v'",
				);
			} finally {
				db.close();
			}
		}

		const worker = spawnWorker();
		try {
			const result = await roundTrip<{ ok: boolean; skipped?: boolean }>(
				worker,
				{ dbPath, kind: "optimize" },
			);
			expect(result.ok).toBe(true);
			expect(result.skipped).toBe(false);
		} finally {
			worker.terminate();
		}

		const check = new Database(dbPath);
		try {
			const row = check
				.query<{ stat: string }, []>(
					"SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_stale_v'",
				)
				.get();
			// Leading token is the estimated row count. `analysis_limit = 400` makes
			// it an estimate rather than exactly 2000, so assert it left the fiction
			// behind rather than pinning a number the sampler does not promise.
			const rowCount = Number(row?.stat.split(" ")[0]);
			expect(rowCount).toBeGreaterThan(100);
		} finally {
			check.close();
		}
	});
});
