import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { LockContentionStats } from "../lock-contention-stats";

/**
 * These drive a REAL writer-slot conflict through the adapter rather than
 * feeding synthetic durations to the accumulator. That distinction is the
 * whole point: the adapter catches SQLITE_BUSY, sleeps and retries, so the
 * error is invisible to every layer above it. A test that only exercised the
 * accumulator would happily pass while the production counter read zero
 * through a contention storm.
 */
function withTempDb(
	run: (path: string) => void | Promise<void>,
): Promise<void> | void {
	const dir = mkdtempSync(join(tmpdir(), "clankermux-lock-"));
	const path = join(dir, "test.db");
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		const result = run(path);
		if (result instanceof Promise) return result.finally(cleanup);
		cleanup();
	} catch (err) {
		cleanup();
		throw err;
	}
}

describe("BunSqlAdapter lock instrumentation", () => {
	it("counts a real SQLITE_BUSY that the adapter swallows", async () => {
		await withTempDb(async (path) => {
			const holder = new Database(path);
			holder.exec("PRAGMA journal_mode = WAL");
			holder.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

			const victim = new Database(path);
			// Fail fast so the test does not sit in the C-level busy handler.
			victim.exec("PRAGMA busy_timeout = 0");
			const stats = new LockContentionStats();
			const adapter = new BunSqlAdapter(victim, stats);

			// Hold the writer slot so the adapter's write cannot proceed.
			holder.exec("BEGIN IMMEDIATE");
			holder.run("INSERT INTO t (v) VALUES (?)", ["held"]);

			// The adapter retries on a 500ms timer for up to ten minutes, so this
			// promise stays pending until the slot is released. Releasing it from a
			// timer proves the retry path ran and that the BUSY was counted even
			// though the caller never sees an error.
			const writePromise = adapter.run("INSERT INTO t (v) VALUES (?)", [
				"waiting",
			]);

			await new Promise<void>((resolve) => setTimeout(resolve, 750));
			const duringContention = stats.snapshot();

			holder.exec("COMMIT");
			await writePromise;

			// The caller saw a clean success...
			const rows = await adapter.query<{ v: string }>("SELECT v FROM t");
			expect(rows.map((r) => r.v).sort()).toEqual(["held", "waiting"]);

			// ...but the swallowed contention was still recorded.
			expect(duringContention.busyOccurrences).toBeGreaterThan(0);

			holder.close();
			await adapter.close();
		});
	});

	it("labels a timed statement with its SQL rather than leaving it anonymous", async () => {
		await withTempDb(async (path) => {
			const db = new Database(path);
			db.exec("CREATE TABLE labelled (id INTEGER PRIMARY KEY)");
			const stats = new LockContentionStats();
			const adapter = new BunSqlAdapter(db, stats);

			await adapter.query("SELECT id FROM labelled");

			const snap = stats.snapshot();
			expect(snap.operations).toBeGreaterThan(0);
			expect(snap.maxOperation).toContain("SELECT id FROM labelled");

			await adapter.close();
		});
	});

	it("collapses whitespace so a multi-line statement yields one label", async () => {
		await withTempDb(async (path) => {
			const db = new Database(path);
			db.exec("CREATE TABLE multi (id INTEGER PRIMARY KEY)");
			const stats = new LockContentionStats();
			const adapter = new BunSqlAdapter(db, stats);

			await adapter.query("SELECT\n\tid\nFROM\n\tmulti");

			expect(stats.snapshot().maxOperation).toBe("SELECT id FROM multi");

			await adapter.close();
		});
	});

	it("records a successful statement without inventing contention", async () => {
		await withTempDb(async (path) => {
			const db = new Database(path);
			db.exec("CREATE TABLE quiet (id INTEGER PRIMARY KEY)");
			const stats = new LockContentionStats();
			const adapter = new BunSqlAdapter(db, stats);

			await adapter.run("INSERT INTO quiet (id) VALUES (?)", [1]);

			const snap = stats.snapshot();
			expect(snap.operations).toBe(1);
			expect(snap.busyOccurrences).toBe(0);
			expect(snap.busyExhausted).toBe(0);
			expect(snap.classifierGap).toBe(0);

			await adapter.close();
		});
	});
});
