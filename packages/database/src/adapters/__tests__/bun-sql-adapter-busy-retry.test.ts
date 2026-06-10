/**
 * Tests for BunSqlAdapter.withBusyRetry (exercised through public methods).
 *
 * withBusyRetry is private, but it is called by query(), get(), run(), and
 * runWithChanges() for every SQLite operation.  We simulate SQLITE_BUSY by
 * replacing the internal sqliteDb methods with stubs that throw once before
 * succeeding, using `(adapter as any).sqliteDb` to reach the private field.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqlAdapter } from "../bun-sql-adapter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBusyError(): Error {
	return Object.assign(new Error("database is locked"), {
		code: "SQLITE_BUSY",
	});
}

/**
 * Replace a method on the underlying sqliteDb with a stub that throws
 * SQLITE_BUSY on the first call and delegates to the real method thereafter.
 *
 * Returns a cleanup function that restores the original.
 */
function stubBusyOnce(sqliteDb: Database, method: "run" | "query"): () => void {
	const original = sqliteDb[method].bind(sqliteDb);
	let calls = 0;
	// biome-ignore lint/suspicious/noExplicitAny: test stub replacing internal DB method
	(sqliteDb as any)[method] = (...args: any[]) => {
		calls++;
		if (calls === 1) throw makeBusyError();
		// biome-ignore lint/suspicious/noExplicitAny: delegating to real implementation
		return (original as any)(...args);
	};
	return () => {
		// biome-ignore lint/suspicious/noExplicitAny: restoring original method
		(sqliteDb as any)[method] = original;
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BunSqlAdapter withBusyRetry", () => {
	let db: Database;
	let adapter: BunSqlAdapter;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)");
		adapter = new BunSqlAdapter(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("query() retries on SQLITE_BUSY", () => {
		it("returns result on second attempt after one SQLITE_BUSY", async () => {
			db.run("INSERT INTO t (id, val) VALUES (1, 'hello')");

			const sqliteDb = (adapter as unknown as { sqliteDb: Database }).sqliteDb;
			const restore = stubBusyOnce(sqliteDb, "query");
			try {
				const rows = await adapter.query<{ id: number; val: string }>(
					"SELECT id, val FROM t",
				);
				expect(rows).toHaveLength(1);
				expect(rows[0].val).toBe("hello");
			} finally {
				restore();
			}
		});
	});

	describe("get() retries on SQLITE_BUSY", () => {
		it("returns the row on second attempt after one SQLITE_BUSY", async () => {
			db.run("INSERT INTO t (id, val) VALUES (2, 'world')");

			const sqliteDb = (adapter as unknown as { sqliteDb: Database }).sqliteDb;
			const restore = stubBusyOnce(sqliteDb, "query");
			try {
				const row = await adapter.get<{ id: number; val: string }>(
					"SELECT id, val FROM t WHERE id = ?",
					[2],
				);
				expect(row).not.toBeNull();
				expect(row?.val).toBe("world");
			} finally {
				restore();
			}
		});
	});

	describe("run() retries on SQLITE_BUSY", () => {
		it("completes successfully on second attempt after one SQLITE_BUSY", async () => {
			const sqliteDb = (adapter as unknown as { sqliteDb: Database }).sqliteDb;
			const restore = stubBusyOnce(sqliteDb, "run");
			try {
				await adapter.run("INSERT INTO t (id, val) VALUES (?, ?)", [
					3,
					"retry-run",
				]);
				const row = db.query("SELECT val FROM t WHERE id = 3").get() as {
					val: string;
				} | null;
				expect(row?.val).toBe("retry-run");
			} finally {
				restore();
			}
		});
	});

	describe("runWithChanges() retries on SQLITE_BUSY", () => {
		it("returns affected-row count on second attempt after one SQLITE_BUSY", async () => {
			db.run("INSERT INTO t (id, val) VALUES (4, 'before')");

			const sqliteDb = (adapter as unknown as { sqliteDb: Database }).sqliteDb;
			const restore = stubBusyOnce(sqliteDb, "run");
			try {
				const changes = await adapter.runWithChanges(
					"UPDATE t SET val = ? WHERE id = ?",
					["after", 4],
				);
				expect(changes).toBe(1);
			} finally {
				restore();
			}
		});
	});

	describe("non-SQLITE_BUSY errors are not retried", () => {
		it("propagates a non-busy error immediately without retrying", async () => {
			// Inject an error whose code is NOT SQLITE_BUSY
			const sqliteDb = (adapter as unknown as { sqliteDb: Database }).sqliteDb;
			const original = sqliteDb.query.bind(sqliteDb);
			let calls = 0;
			(
				sqliteDb as unknown as { query: (...args: unknown[]) => unknown }
			).query = (...args: unknown[]) => {
				calls++;
				throw Object.assign(new Error("disk I/O error"), {
					code: "SQLITE_IOERR",
				});
				// biome-ignore lint/correctness/noUnreachable: intentional unreachable for type
				return (original as (...a: unknown[]) => unknown)(...args);
			};

			try {
				await expect(adapter.query("SELECT id FROM t")).rejects.toThrow(
					"disk I/O error",
				);
				// Should have thrown immediately — only one call
				expect(calls).toBe(1);
			} finally {
				// biome-ignore lint/suspicious/noExplicitAny: restoring original
				(sqliteDb as any).query = original;
			}
		});
	});

	describe("real lock contention with a bounded main busy_timeout", () => {
		it("resolves via async retry while a second connection holds BEGIN IMMEDIATE, without a multi-second synchronous block", async () => {
			// Mirrors production: the main connection's busy_timeout is bounded
			// to 250ms (see MAIN_CONNECTION_BUSY_TIMEOUT_MS), so a write hitting
			// a worker-held lock blocks the event loop for at most ~250ms at the
			// C level, then the JS layer yields and retries via setTimeout.
			const dir = mkdtempSync(join(tmpdir(), "ccflare-busy-contention-"));
			const dbPath = join(dir, "contention.db");
			const main = new Database(dbPath, { create: true });
			const writer = new Database(dbPath);
			try {
				main.exec("PRAGMA journal_mode = WAL");
				main.exec("PRAGMA busy_timeout = 250");
				main.run(
					"CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)",
				);
				const contendedAdapter = new BunSqlAdapter(main);

				writer.exec("PRAGMA busy_timeout = 0");
				writer.exec("BEGIN IMMEDIATE"); // hold the write lock

				// The synchronous portion of an adapter call is everything up to
				// the first await: one C-level busy wait of <= busy_timeout. With
				// the old 10s timeout this took ~10s; bounded it must stay well
				// under 1s.
				const syncStart = performance.now();
				const pending = contendedAdapter.run(
					"INSERT INTO t (id, val) VALUES (?, ?)",
					[1, "through-retry"],
				);
				const syncMs = performance.now() - syncStart;
				expect(syncMs).toBeLessThan(1000);

				// Release the lock while the adapter is parked in its async
				// 500ms retry sleep — the next attempt must succeed.
				setTimeout(() => writer.exec("COMMIT"), 300);
				await pending;

				const row = main.query("SELECT val FROM t WHERE id = 1").get() as {
					val: string;
				} | null;
				expect(row?.val).toBe("through-retry");
			} finally {
				try {
					writer.close();
				} catch {}
				try {
					main.close();
				} catch {}
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("close() under contention", () => {
		it("does not crash shutdown when another connection holds the write lock", async () => {
			// close() runs PRAGMA wal_checkpoint(TRUNCATE). With the bounded main
			// busy_timeout that checkpoint can come back busy while a worker
			// holds the lock — shutdown must degrade gracefully (skip the
			// truncate), never throw.
			const dir = mkdtempSync(join(tmpdir(), "ccflare-busy-close-"));
			const dbPath = join(dir, "close.db");
			const main = new Database(dbPath, { create: true });
			const writer = new Database(dbPath);
			try {
				main.exec("PRAGMA journal_mode = WAL");
				main.exec("PRAGMA busy_timeout = 250");
				main.run(
					"CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)",
				);
				const closingAdapter = new BunSqlAdapter(main);

				writer.exec("PRAGMA busy_timeout = 0");
				writer.exec("BEGIN IMMEDIATE");
				writer.run("INSERT INTO t (id, val) VALUES (9, 'held')");

				await expect(closingAdapter.close()).resolves.toBeUndefined();

				writer.exec("COMMIT");
			} finally {
				try {
					writer.close();
				} catch {}
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("SQLITE_BUSY past deadline is propagated", () => {
		it("throws SQLITE_BUSY when Date.now() is already past the retry deadline", async () => {
			const sqliteDb = (adapter as unknown as { sqliteDb: Database }).sqliteDb;
			const originalQuery = sqliteDb.query.bind(sqliteDb);
			const originalDateNow = Date.now;

			// Make every query call throw SQLITE_BUSY
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			(sqliteDb as any).query = (..._args: any[]) => {
				throw makeBusyError();
			};
			// Make the deadline already expired by putting Date.now far in the future
			// relative to the deadline check: deadline = Date.now() + 10min, so if
			// Date.now() returns a value 11min ahead on the *second* check, the retry
			// is skipped.
			let callCount = 0;
			Date.now = () => {
				callCount++;
				// First call (setting deadline): return real time.
				// Subsequent calls (deadline check): return real time + 11 minutes.
				return callCount === 1
					? originalDateNow()
					: originalDateNow() + 11 * 60 * 1000;
			};

			try {
				await expect(adapter.query("SELECT id FROM t")).rejects.toMatchObject({
					code: "SQLITE_BUSY",
				});
			} finally {
				// biome-ignore lint/suspicious/noExplicitAny: restoring original
				(sqliteDb as any).query = originalQuery;
				Date.now = originalDateNow;
			}
		});
	});
});
