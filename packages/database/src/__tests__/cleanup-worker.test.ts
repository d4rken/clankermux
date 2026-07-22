/**
 * Tests for the incremental-vacuum worker's "cleanup" kind and the
 * `DatabaseOperations.cleanupOldRequests()` method that drives it.
 *
 * Background: the hourly retention cleanup used to run its DELETEs synchronously
 * on the main thread. Deleting a batch of aged payload rows (large multi-MB
 * blobs) froze the event loop for seconds (observed: 6177ms). The deletes now
 * run off-thread in the worker (kind "cleanup"), chunked with slot-releasing
 * yields. These tests assert the observable contract: only rows older than each
 * cutoff are deleted, the returned counts are correct, and the batched path
 * spans more than one CLEANUP_DELETE_BATCH_ROWS batch.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";
import {
	CLEANUP_DELETE_BATCH_ROWS,
	SNAPSHOT_DELETE_BATCH_ROWS,
} from "../incremental-vacuum-worker";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-cleanup-test-"));
}

/**
 * Seed matching requests + payloads (so payloads are NOT orphans — only age
 * decides their deletion) plus one aged + one recent snapshot per snapshot
 * table. FK enforcement is off on this connection (bun:sqlite default), so we
 * control rows directly. Returns the counts seeded.
 */
function seed(
	dbPath: string,
	oldTs: number,
	recentTs: number,
	oldCount: number,
	recentCount: number,
): void {
	const db = new Database(dbPath);
	try {
		const insReq = db.prepare(
			"INSERT INTO requests (id, timestamp, method, path) VALUES (?, ?, 'POST', '/v1/m')",
		);
		const insPay = db.prepare(
			"INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)",
		);
		// Child tables that rely on ON DELETE CASCADE (no own age/orphan pass).
		const insRouting = db.prepare(
			"INSERT INTO request_routing (request_id, strategy, decision, created_at) VALUES (?, 's', 'd', ?)",
		);
		const insToolCall = db.prepare(
			"INSERT INTO request_tool_calls (request_id, tool_name) VALUES (?, 't')",
		);
		const insToolErr = db.prepare(
			"INSERT INTO request_tool_errors (request_id, tool_name) VALUES (?, 't')",
		);
		const insChildren = (id: string, ts: number): void => {
			insRouting.run(id, ts);
			insToolCall.run(id);
			insToolErr.run(id);
		};
		db.exec("BEGIN");
		for (let i = 0; i < oldCount; i++) {
			insReq.run(`old-${i}`, oldTs);
			insPay.run(`old-${i}`, "{}", oldTs);
			insChildren(`old-${i}`, oldTs);
		}
		for (let i = 0; i < recentCount; i++) {
			insReq.run(`new-${i}`, recentTs);
			insPay.run(`new-${i}`, "{}", recentTs);
			insChildren(`new-${i}`, recentTs);
		}
		db.prepare(
			"INSERT INTO usage_snapshots (account_id, sampled_at) VALUES (?, ?)",
		).run("acct", oldTs);
		db.prepare(
			"INSERT INTO usage_snapshots (account_id, sampled_at) VALUES (?, ?)",
		).run("acct", recentTs);
		const insMem = db.prepare(
			"INSERT INTO memory_snapshots (sampled_at, rss_bytes, heap_used_bytes) VALUES (?, ?, ?)",
		);
		insMem.run(oldTs, 1, 1);
		insMem.run(recentTs, 1, 1);
		db.exec("COMMIT");
	} finally {
		db.close();
	}
}

function count(dbPath: string, table: string): number {
	const db = new Database(dbPath);
	// Tolerate a brief lock if a just-terminated worker connection lingers.
	db.exec("PRAGMA busy_timeout = 5000");
	try {
		return (
			db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
		).n;
	} finally {
		db.close();
	}
}

describe("incremental-vacuum worker: cleanup kind", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = makeTempDir();
		dbPath = path.join(tmpDir, "test.db");
		const dbOps = new DatabaseOperations(dbPath);
		await dbOps.close();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("deletes only aged rows across tables, spanning multiple batches", async () => {
		const OLD = 1_000_000;
		const RECENT = 9_000_000_000_000;
		const CUTOFF = 5_000_000_000_000;
		// > one batch of aged payloads/requests so the reclaim loop runs twice.
		const oldCount = CLEANUP_DELETE_BATCH_ROWS + 15;
		const recentCount = 8;
		seed(dbPath, OLD, RECENT, oldCount, recentCount);
		expect(count(dbPath, "request_payloads")).toBe(oldCount + recentCount);

		const worker = new Worker(
			new URL("../incremental-vacuum-worker.ts", import.meta.url).href,
		);
		let result: {
			ok: boolean;
			cleanup?: {
				removedRequests: number;
				removedPayloads: number;
				removedSnapshots: number;
				removedMemorySnapshots: number;
			};
			error?: string;
		};
		try {
			result = await new Promise((resolve, reject) => {
				worker.onmessage = (e: MessageEvent) => resolve(e.data);
				worker.onerror = (e: ErrorEvent) =>
					reject(new Error(e.message ?? "worker error"));
				worker.postMessage({
					dbPath,
					kind: "cleanup",
					payloadCutoff: CUTOFF,
					requestCutoff: CUTOFF,
					usageSnapshotCutoff: CUTOFF,
					memorySnapshotCutoff: CUTOFF,
				});
			});
		} finally {
			worker.terminate();
		}

		expect(result.ok).toBe(true);
		expect(result.cleanup?.removedPayloads).toBe(oldCount);
		expect(result.cleanup?.removedRequests).toBe(oldCount);
		expect(result.cleanup?.removedSnapshots).toBe(1);
		expect(result.cleanup?.removedMemorySnapshots).toBe(1);

		// Only the recent rows survive.
		expect(count(dbPath, "request_payloads")).toBe(recentCount);
		expect(count(dbPath, "requests")).toBe(recentCount);
		expect(count(dbPath, "usage_snapshots")).toBe(1);
		expect(count(dbPath, "memory_snapshots")).toBe(1);

		// Cascade children (no own age/orphan pass) must be cleaned via FK
		// ON DELETE CASCADE when their parent request is deleted — regression
		// guard: worker must run with foreign_keys = ON.
		expect(count(dbPath, "request_routing")).toBe(recentCount);
		expect(count(dbPath, "request_tool_calls")).toBe(recentCount);
		expect(count(dbPath, "request_tool_errors")).toBe(recentCount);
	});

	it("cleanupOldRequests() drives the worker end-to-end and returns counts", async () => {
		const HOUR = 60 * 60 * 1000;
		const now = Date.now();
		const oldTs = now - 2 * HOUR;
		seed(dbPath, oldTs, now, 20, 5);

		const dbOps = new DatabaseOperations(dbPath);
		try {
			const res = await dbOps.cleanupOldRequests(HOUR, HOUR, HOUR, HOUR);
			expect(res.removedPayloads).toBe(20);
			expect(res.removedRequests).toBe(20);
			expect(res.removedSnapshots).toBe(1);
			expect(res.removedMemorySnapshots).toBe(1);
		} finally {
			await dbOps.close();
		}

		expect(count(dbPath, "request_payloads")).toBe(5);
		expect(count(dbPath, "requests")).toBe(5);
	});

	it("reports orphaned payloads (no matching request) in removedPayloads", async () => {
		// A payload whose request row is gone, with a RECENT timestamp: the
		// age pass skips it, so only the orphan sweep removes it — and it must
		// still be counted in removedPayloads.
		const db = new Database(dbPath);
		try {
			db.run(
				"INSERT INTO request_payloads (id, json, timestamp) VALUES ('orphan', '{}', ?)",
				[Date.now()],
			);
		} finally {
			db.close();
		}

		const dbOps = new DatabaseOperations(dbPath);
		try {
			const res = await dbOps.cleanupOldRequests(60 * 60 * 1000);
			expect(res.removedPayloads).toBe(1);
		} finally {
			await dbOps.close();
		}
		expect(count(dbPath, "request_payloads")).toBe(0);
	});

	it("prunes a large usage_snapshots table across many batches, keeping recent rows", async () => {
		// Regression for the 3650 → 90 day default drop: the first prune can remove
		// millions of rows, so the worker must batch it (tryDeleteSnapshotsBatched)
		// rather than issue one writer-slot-holding DELETE. Seed > 2 * batch aged
		// rows so the loop runs at least three iterations, plus a few recent rows
		// that must survive.
		const OLD_BASE = 1_000_000;
		const RECENT = 9_000_000_000_000;
		const CUTOFF = 5_000_000_000_000;
		const oldCount = 2 * SNAPSHOT_DELETE_BATCH_ROWS + 37;
		const recentCount = 4;

		const seedDb = new Database(dbPath);
		try {
			const insUsage = seedDb.prepare(
				"INSERT INTO usage_snapshots (account_id, sampled_at) VALUES ('acct', ?)",
			);
			seedDb.exec("BEGIN");
			// Distinct sampled_at values (composite PK is account_id, sampled_at).
			for (let i = 0; i < oldCount; i++) insUsage.run(OLD_BASE + i);
			for (let i = 0; i < recentCount; i++) insUsage.run(RECENT + i);
			seedDb.exec("COMMIT");
		} finally {
			seedDb.close();
		}
		expect(count(dbPath, "usage_snapshots")).toBe(oldCount + recentCount);

		const worker = new Worker(
			new URL("../incremental-vacuum-worker.ts", import.meta.url).href,
		);
		let result: {
			ok: boolean;
			cleanup?: { removedSnapshots: number };
			error?: string;
		};
		try {
			result = await new Promise((resolve, reject) => {
				worker.onmessage = (e: MessageEvent) => resolve(e.data);
				worker.onerror = (e: ErrorEvent) =>
					reject(new Error(e.message ?? "worker error"));
				worker.postMessage({
					dbPath,
					kind: "cleanup",
					// Nothing seeded in payloads/requests; only the snapshot prune matters.
					payloadCutoff: CUTOFF,
					requestCutoff: CUTOFF,
					usageSnapshotCutoff: CUTOFF,
					memorySnapshotCutoff: CUTOFF,
				});
			});
		} finally {
			worker.terminate();
		}

		expect(result.ok).toBe(true);
		expect(result.cleanup?.removedSnapshots).toBe(oldCount);
		// Only the recent rows survive — batching drained everything below the cutoff.
		expect(count(dbPath, "usage_snapshots")).toBe(recentCount);
	});

	it("returns an all-zero count shape when nothing is old enough", async () => {
		const HOUR = 60 * 60 * 1000;
		// Two distinct-but-recent timestamps (both well within the 1h window) —
		// distinct so the snapshot-table primary keys don't collide during seed.
		seed(dbPath, Date.now() - 1000, Date.now(), 3, 3);

		const dbOps = new DatabaseOperations(dbPath);
		try {
			const res = await dbOps.cleanupOldRequests(HOUR, HOUR, HOUR, HOUR);
			// Exact shape (no stray fields) + nothing deleted.
			expect(res).toEqual({
				removedRequests: 0,
				removedPayloads: 0,
				removedSnapshots: 0,
				removedMemorySnapshots: 0,
			});
		} finally {
			await dbOps.close();
		}
	});
});
