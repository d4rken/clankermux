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
import {
	BUSY_RETRY_MAX_DELAY_MS,
	BunSqlAdapter,
	busyRetryDelayMs,
} from "../bun-sql-adapter";

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

	describe("runTransaction() retries on SQLITE_BUSY", () => {
		it("re-runs the whole body on a second attempt after one SQLITE_BUSY", async () => {
			// Multi-statement writes that need atomicity used to call
			// db.transaction(fn)() on the raw handle, which drops them to the bare
			// C-level busy_timeout — a token refresh racing the vacuum worker for the
			// writer slot then fails outright instead of retrying.
			const sqliteDb = (adapter as unknown as { sqliteDb: Database }).sqliteDb;
			const restore = stubBusyOnce(sqliteDb, "run");
			let bodyRuns = 0;
			try {
				const changes = await adapter.runTransaction(() => {
					bodyRuns++;
					sqliteDb.run("INSERT INTO t (id, val) VALUES (?, ?)", [
						5,
						"in-transaction",
					]);
					return sqliteDb.run("UPDATE t SET val = ? WHERE id = ?", [
						"retried",
						5,
					]).changes;
				});
				expect(changes).toBe(1);
				// The busy attempt was rolled back in full, so the retry starts from
				// the same state and the row exists exactly once.
				expect(bodyRuns).toBe(2);
				const rows = sqliteDb.query("SELECT val FROM t WHERE id = 5").all() as {
					val: string;
				}[];
				expect(rows).toEqual([{ val: "retried" }]);
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
			// Mirrors production: the main connection's busy_timeout is 0 (see
			// MAIN_CONNECTION_BUSY_TIMEOUT_MS), so a write hitting a worker-held
			// lock never blocks the event loop at the C level — the JS layer
			// yields and retries via setTimeout.
			const dir = mkdtempSync(join(tmpdir(), "clankermux-busy-contention-"));
			const dbPath = join(dir, "contention.db");
			const main = new Database(dbPath, { create: true });
			const writer = new Database(dbPath);
			try {
				main.exec("PRAGMA journal_mode = WAL");
				main.exec("PRAGMA busy_timeout = 0");
				main.run(
					"CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)",
				);
				const contendedAdapter = new BunSqlAdapter(main);

				writer.exec("PRAGMA busy_timeout = 0");
				writer.exec("BEGIN IMMEDIATE"); // hold the write lock

				// The synchronous portion of an adapter call is everything up to
				// the first await. With no C-level busy wait the event loop is
				// handed back essentially at once.
				const syncStart = performance.now();
				const pending = contendedAdapter.run(
					"INSERT INTO t (id, val) VALUES (?, ?)",
					[1, "through-retry"],
				);
				const syncMs = performance.now() - syncStart;
				expect(syncMs).toBeLessThan(100);

				// Release the lock while the adapter is parked in an async retry
				// sleep — the next attempt must succeed.
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
			// close() runs PRAGMA wal_checkpoint(TRUNCATE). Even with the widened
			// shutdown timeout that checkpoint can come back busy while a worker
			// holds the lock — shutdown must degrade gracefully (skip the
			// truncate), never throw.
			const dir = mkdtempSync(join(tmpdir(), "clankermux-busy-close-"));
			const dbPath = join(dir, "close.db");
			const main = new Database(dbPath, { create: true });
			const writer = new Database(dbPath);
			try {
				main.exec("PRAGMA journal_mode = WAL");
				main.exec("PRAGMA busy_timeout = 0");
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

	describe("retry backoff", () => {
		it("stays inside [base/2, base) for each attempt, with base capped", () => {
			const bases = [10, 20, 40, 80, 100, 100, 100];
			for (const [index, base] of bases.entries()) {
				const attempt = index + 1;
				expect(base).toBeLessThanOrEqual(BUSY_RETRY_MAX_DELAY_MS);
				for (let i = 0; i < 200; i++) {
					const delay = busyRetryDelayMs(attempt);
					expect(delay).toBeGreaterThanOrEqual(base / 2);
					expect(delay).toBeLessThan(base);
				}
			}
		});

		it("never exceeds the ceiling however many attempts have passed", () => {
			for (const attempt of [8, 20, 64, 1000]) {
				const delay = busyRetryDelayMs(attempt);
				expect(delay).toBeGreaterThanOrEqual(BUSY_RETRY_MAX_DELAY_MS / 2);
				expect(delay).toBeLessThan(BUSY_RETRY_MAX_DELAY_MS);
			}
		});

		it("spreads colliding callers instead of waking them together", () => {
			// Every caller that lost the same writer slot starts its sleep at the
			// same instant, so an unjittered delay would wake them in lockstep.
			const seen = new Set<number>();
			for (let i = 0; i < 200; i++) seen.add(busyRetryDelayMs(5));
			expect(seen.size).toBeGreaterThan(100);
		});
	});

	describe("wake-up latency when the lock is released mid-sleep", () => {
		it("picks the write back up within tens of milliseconds", async () => {
			const dir = mkdtempSync(join(tmpdir(), "clankermux-busy-wakeup-"));
			const dbPath = join(dir, "wakeup.db");
			const main = new Database(dbPath, { create: true });
			const writer = new Database(dbPath);
			try {
				main.exec("PRAGMA journal_mode = WAL");
				main.exec("PRAGMA busy_timeout = 0");
				main.run(
					"CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)",
				);
				const contendedAdapter = new BunSqlAdapter(main);

				writer.exec("PRAGMA busy_timeout = 0");
				writer.exec("BEGIN IMMEDIATE");

				const start = performance.now();
				const pending = contendedAdapter.run(
					"INSERT INTO t (id, val) VALUES (?, ?)",
					[1, "prompt"],
				);
				setTimeout(() => writer.exec("COMMIT"), 40);
				await pending;
				const elapsed = performance.now() - start;

				// The lock frees at ~40ms; the retry cadence must notice inside
				// roughly one capped backoff rather than a fixed half-second.
				expect(elapsed).toBeLessThan(250);
				const row = main.query("SELECT val FROM t WHERE id = 1").get() as {
					val: string;
				} | null;
				expect(row?.val).toBe("prompt");
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
