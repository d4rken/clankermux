/**
 * Tests for MemorySnapshotRepository — the append-only process-memory
 * time-series (RSS + JS heap) that backs the dashboard "Memory Usage" graph.
 *
 * Covers round-trip + MAX-per-bucket reads (column-wise, NOT last-value),
 * nullable heap_total handling, idempotent upserts, sinceMs filtering, and
 * retention pruning.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MemorySnapshotRow } from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { MemorySnapshotRepository } from "../repositories/memory-snapshot.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	return db;
}

function makeRepo(db: Database): MemorySnapshotRepository {
	return new MemorySnapshotRepository(new BunSqlAdapter(db));
}

function row(overrides: Partial<MemorySnapshotRow>): MemorySnapshotRow {
	return {
		sampledAt: 1_000,
		rssBytes: 100,
		heapUsedBytes: 50,
		heapTotalBytes: 80,
		...overrides,
	};
}

describe("MemorySnapshotRepository", () => {
	let db: Database;
	let repo: MemorySnapshotRepository;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("insert", () => {
		it("round-trips a single row", async () => {
			await repo.insert(
				row({
					sampledAt: 1_000,
					rssBytes: 123,
					heapUsedBytes: 45,
					heapTotalBytes: 67,
				}),
			);
			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result).toHaveLength(1);
			expect(result[0].ts).toBe(1_000);
			expect(result[0].rssBytes).toBe(123);
			expect(result[0].heapUsedBytes).toBe(45);
			expect(result[0].heapTotalBytes).toBe(67);
		});
	});

	describe("getSnapshots — MAX per bucket", () => {
		it("returns the column-wise max within each bucket (not last-value)", async () => {
			const bucketMs = 1_000;
			// Bucket 0 = [0, 1000). Two samples whose maxima come from DIFFERENT
			// samples — proves the aggregate is per-column MAX, not last-value.
			await repo.insert(
				row({
					sampledAt: 100,
					rssBytes: 100,
					heapUsedBytes: 10,
					heapTotalBytes: 20,
				}),
			);
			await repo.insert(
				row({
					sampledAt: 900,
					rssBytes: 80,
					heapUsedBytes: 55,
					heapTotalBytes: 90,
				}),
			);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs });
			expect(result).toHaveLength(1);
			expect(result[0].ts).toBe(0);
			expect(result[0].rssBytes).toBe(100); // from the 100-sample
			expect(result[0].heapUsedBytes).toBe(55); // from the 900-sample
			expect(result[0].heapTotalBytes).toBe(90); // from the 900-sample
		});

		it("floors ts to the bucket start", async () => {
			await repo.insert(row({ sampledAt: 12_345 }));
			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result).toHaveLength(1);
			expect(result[0].ts).toBe(12_000); // floor(12345/1000)*1000
		});

		it("groups into separate buckets and orders by ts", async () => {
			await repo.insert(row({ sampledAt: 1_500, rssBytes: 30 }));
			await repo.insert(row({ sampledAt: 200, rssBytes: 10 }));
			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result.map((r) => r.ts)).toEqual([0, 1_000]);
		});

		it("excludes rows older than sinceMs", async () => {
			await repo.insert(row({ sampledAt: 500 }));
			await repo.insert(row({ sampledAt: 5_000 }));
			const result = await repo.getSnapshots({
				sinceMs: 1_000,
				bucketMs: 1_000,
			});
			expect(result).toHaveLength(1);
			expect(result[0].ts).toBe(5_000);
		});
	});

	describe("nullable heap_total handling", () => {
		it("round-trips a null heap_total as null", async () => {
			await repo.insert(row({ sampledAt: 1_000, heapTotalBytes: null }));
			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result[0].heapTotalBytes).toBeNull();
		});

		it("MAX ignores a null heap_total within a bucket", async () => {
			await repo.insert(row({ sampledAt: 100, heapTotalBytes: null }));
			await repo.insert(row({ sampledAt: 900, heapTotalBytes: 200 }));
			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result[0].heapTotalBytes).toBe(200);
		});
	});

	describe("upsert semantics", () => {
		it("inserting the same sampled_at twice keeps one row and applies the latest values", async () => {
			await repo.insert(row({ sampledAt: 1_000, rssBytes: 100 }));
			await repo.insert(row({ sampledAt: 1_000, rssBytes: 555 }));

			const n = db
				.query("SELECT COUNT(*) as n FROM memory_snapshots")
				.get() as { n: number };
			expect(n.n).toBe(1);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result).toHaveLength(1);
			expect(result[0].rssBytes).toBe(555);
		});
	});

	describe("deleteOlderThan", () => {
		it("removes only rows strictly older than cutoff and returns the count", async () => {
			await repo.insert(row({ sampledAt: 100 }));
			await repo.insert(row({ sampledAt: 500 }));
			await repo.insert(row({ sampledAt: 1_000 })); // == cutoff, kept
			await repo.insert(row({ sampledAt: 2_000 }));

			const deleted = await repo.deleteOlderThan(1_000);
			expect(deleted).toBe(2); // 100 and 500

			const remaining = db
				.query("SELECT sampled_at FROM memory_snapshots ORDER BY sampled_at")
				.all() as Array<{ sampled_at: number }>;
			expect(remaining.map((r) => r.sampled_at)).toEqual([1_000, 2_000]);
		});

		it("returns 0 when nothing matches", async () => {
			await repo.insert(row({ sampledAt: 5_000 }));
			const deleted = await repo.deleteOlderThan(1_000);
			expect(deleted).toBe(0);
		});
	});
});
