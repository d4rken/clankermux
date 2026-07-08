/**
 * Tests for the batched reclamation added to the incremental-vacuum worker
 * (kind: "vacuum").
 *
 * Background: the worker used to reclaim its whole per-tick budget in a single
 * `PRAGMA incremental_vacuum(N)` — one transaction holding SQLite's writer slot
 * for its full (multi-second, on a large DB) duration, stalling the event loop
 * for any main-thread write that landed during it. It now reclaims in
 * `INCREMENTAL_VACUUM_BATCH_PAGES`-sized batches, each its own transaction that
 * releases the slot, with a short yield between — and breaks early once the
 * freelist is drained so a large budget costs nothing on a caught-up DB.
 *
 * These tests assert the observable contract: a freelist bigger than one batch
 * is fully drained across multiple batches; a fully-contended tick (writer slot
 * held elsewhere, zero reclaimed) reports { ok: false } so the consecutive-skip
 * escalation still fires; and an over-sized budget on an empty freelist returns
 * promptly via the early-break rather than looping.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";
import { INCREMENTAL_VACUUM_BATCH_PAGES } from "../incremental-vacuum-worker";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-vac-batch-test-"));
}

function freelistCount(dbPath: string): number {
	const db = new Database(dbPath);
	try {
		return (
			db.query("PRAGMA freelist_count").get() as { freelist_count: number }
		).freelist_count;
	} finally {
		db.close();
	}
}

/**
 * Seed the DB with more than one batch worth of free pages: insert ~1-page
 * blobs then delete them. auto_vacuum=INCREMENTAL (set by ensureSchema at
 * creation) keeps the freed pages on the freelist until an incremental_vacuum,
 * so freelist_count reflects the backlog.
 */
function seedFreelist(dbPath: string, pages: number): void {
	const db = new Database(dbPath);
	try {
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("CREATE TABLE bulk (id INTEGER PRIMARY KEY, blob BLOB)");
		// ~4 KiB blob ≈ one 4 KiB page per row.
		const blob = Buffer.alloc(4000, 0x61);
		const insert = db.prepare("INSERT INTO bulk (blob) VALUES (?)");
		db.exec("BEGIN");
		for (let i = 0; i < pages; i++) insert.run(blob);
		db.exec("COMMIT");
		db.exec("DELETE FROM bulk");
		// Checkpoint so the deletes land in the main DB file and hit the freelist.
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		db.close();
	}
}

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

describe("incremental-vacuum worker: batched reclamation", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = makeTempDir();
		dbPath = path.join(tmpDir, "test.db");
		// Constructor's ensureSchema creates the DB in auto_vacuum=INCREMENTAL.
		const dbOps = new DatabaseOperations(dbPath);
		await dbOps.close();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("drains a freelist larger than one batch across multiple batches", async () => {
		// Exceed one batch so the reclaim loop must run at least twice.
		const seedPages = INCREMENTAL_VACUUM_BATCH_PAGES + 800;
		seedFreelist(dbPath, seedPages);

		const before = freelistCount(dbPath);
		// Precondition: the backlog genuinely spans more than one batch, otherwise
		// this wouldn't be testing multi-batch behavior at all.
		expect(before).toBeGreaterThan(INCREMENTAL_VACUUM_BATCH_PAGES);

		const worker = spawnWorker();
		try {
			// Budget far exceeds the freelist, so the loop drains it and then
			// early-breaks rather than looping on an empty freelist.
			const result = await roundTrip<{ ok: boolean; mode?: number }>(worker, {
				dbPath,
				pages: 40000,
			});
			expect(result.ok).toBe(true);
			expect(result.mode).toBe(2);
		} finally {
			worker.terminate();
		}

		const after = freelistCount(dbPath);
		// Substantially drained — well below a single batch, proving the loop
		// reclaimed across multiple batches and honored the early-break.
		expect(after).toBeLessThan(before);
		expect(after).toBeLessThan(INCREMENTAL_VACUUM_BATCH_PAGES);
	});

	it("reports ok:false when the writer slot is held for the whole tick (zero reclaimed → feeds skip escalation)", async () => {
		// A backlog exists, but a second connection holds the write lock for the
		// entire tick, so no batch can commit. With nothing reclaimed the worker
		// must surface { ok: false } — the pre-batching single-call semantics that
		// the consecutive-skip escalation in incrementalVacuum() relies on. (If a
		// transient lock only hit AFTER some batches committed, the worker instead
		// reports success; that partial-progress path isn't deterministically
		// reproducible without racing the lock, so it's covered by review, not here.)
		seedFreelist(dbPath, INCREMENTAL_VACUUM_BATCH_PAGES + 800);
		expect(freelistCount(dbPath)).toBeGreaterThan(
			INCREMENTAL_VACUUM_BATCH_PAGES,
		);

		const holder = new Database(dbPath);
		holder.exec("PRAGMA busy_timeout = 0");
		// BEGIN IMMEDIATE takes SQLite's write lock without committing, so the
		// worker's incremental_vacuum can never claim the slot (its busy_timeout
		// is 200ms) and BUSYs on the very first batch.
		holder.exec("BEGIN IMMEDIATE");
		const worker = spawnWorker();
		try {
			const result = await roundTrip<{ ok: boolean; error?: string }>(worker, {
				dbPath,
				pages: 40000,
			});
			expect(result.ok).toBe(false);
			expect(result.error).toBeTruthy();
		} finally {
			worker.terminate();
			holder.exec("ROLLBACK");
			holder.close();
		}
	});

	it("returns promptly with an over-sized budget on an empty freelist (early-break, no hang)", async () => {
		// Fresh schema-only DB: freelist is ~0. A 40000-page budget must not loop.
		expect(freelistCount(dbPath)).toBeLessThan(INCREMENTAL_VACUUM_BATCH_PAGES);

		const worker = spawnWorker();
		try {
			const start = performance.now();
			const result = await roundTrip<{ ok: boolean; mode?: number }>(worker, {
				dbPath,
				pages: 40000,
			});
			const elapsed = performance.now() - start;
			expect(result.ok).toBe(true);
			expect(result.mode).toBe(2);
			// Early-break means this returns in milliseconds, not 20 sleeps of work.
			expect(elapsed).toBeLessThan(2000);
		} finally {
			worker.terminate();
		}
	});
});
