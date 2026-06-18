/**
 * Tests for CacheKeepaliveSnapshotRepository — the append-only cache-keepalive
 * time-series backing the dashboard analytics panel.
 *
 * Covers round-trip; GAUGE columns read back as MAX-per-bucket; CUMULATIVE
 * counter columns read back as the value at the latest sample in the bucket
 * (robust across a process restart, where a counter resets to a smaller value);
 * idempotent upserts; sinceMs filtering; and retention pruning.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import {
	CacheKeepaliveSnapshotRepository,
	type CacheKeepaliveSnapshotRow,
} from "./cache-keepalive-snapshot.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	return db;
}

function makeRepo(db: Database): CacheKeepaliveSnapshotRepository {
	return new CacheKeepaliveSnapshotRepository(new BunSqlAdapter(db));
}

function row(
	overrides: Partial<CacheKeepaliveSnapshotRow>,
): CacheKeepaliveSnapshotRow {
	return {
		sampledAt: 1_000,
		warmSessions: 3,
		promotedSessions: 1,
		totalBytes: 4_096,
		keepalivesSent: 10,
		hits: 7,
		misses: 2,
		failures: 1,
		spentUsd: 0.05,
		savedUsd: 0.25,
		...overrides,
	};
}

describe("CacheKeepaliveSnapshotRepository", () => {
	let db: Database;
	let repo: CacheKeepaliveSnapshotRepository;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("insertSnapshot", () => {
		it("round-trips a single row", async () => {
			await repo.insertSnapshot(
				row({
					sampledAt: 1_000,
					warmSessions: 5,
					promotedSessions: 2,
					totalBytes: 8_192,
					keepalivesSent: 42,
					hits: 30,
					misses: 12,
					failures: 3,
					spentUsd: 1.5,
					savedUsd: 9.75,
				}),
			);
			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result).toHaveLength(1);
			expect(result[0].ts).toBe(1_000);
			expect(result[0].warmSessions).toBe(5);
			expect(result[0].promotedSessions).toBe(2);
			expect(result[0].totalBytes).toBe(8_192);
			expect(result[0].keepalivesSent).toBe(42);
			expect(result[0].hits).toBe(30);
			expect(result[0].misses).toBe(12);
			expect(result[0].failures).toBe(3);
			expect(result[0].spentUsd).toBe(1.5);
			expect(result[0].savedUsd).toBe(9.75);
		});
	});

	describe("getSnapshots — gauges MAX, counters latest-in-bucket", () => {
		it("takes the column-wise MAX of gauges within a bucket", async () => {
			const bucketMs = 1_000;
			// Bucket 0 = [0, 1000). Gauge maxima come from DIFFERENT samples —
			// proves gauges aggregate as per-column MAX.
			await repo.insertSnapshot(
				row({
					sampledAt: 100,
					warmSessions: 9,
					promotedSessions: 1,
					totalBytes: 100,
				}),
			);
			await repo.insertSnapshot(
				row({
					sampledAt: 900,
					warmSessions: 2,
					promotedSessions: 4,
					totalBytes: 999,
				}),
			);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs });
			expect(result).toHaveLength(1);
			expect(result[0].ts).toBe(0);
			expect(result[0].warmSessions).toBe(9); // from the 100-sample
			expect(result[0].promotedSessions).toBe(4); // from the 900-sample
			expect(result[0].totalBytes).toBe(999); // from the 900-sample
		});

		it("takes the latest (greatest sampled_at) cumulative counters within a bucket", async () => {
			const bucketMs = 1_000;
			// Counters are monotonic within a run; the latest sample in the bucket
			// carries the running totals to report.
			await repo.insertSnapshot(
				row({
					sampledAt: 100,
					keepalivesSent: 10,
					hits: 5,
					misses: 1,
					failures: 0,
					spentUsd: 0.1,
					savedUsd: 0.5,
				}),
			);
			await repo.insertSnapshot(
				row({
					sampledAt: 900,
					keepalivesSent: 25,
					hits: 18,
					misses: 4,
					failures: 2,
					spentUsd: 0.3,
					savedUsd: 1.8,
				}),
			);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs });
			expect(result).toHaveLength(1);
			expect(result[0].keepalivesSent).toBe(25);
			expect(result[0].hits).toBe(18);
			expect(result[0].misses).toBe(4);
			expect(result[0].failures).toBe(2);
			expect(result[0].spentUsd).toBe(0.3);
			expect(result[0].savedUsd).toBe(1.8);
		});

		it("reports the latest counter value even when it is smaller (restart reset)", async () => {
			const bucketMs = 10_000;
			// Same bucket; the later sample has SMALLER counters (process restarted).
			// latest-in-bucket must report the reset value, not MAX.
			await repo.insertSnapshot(
				row({ sampledAt: 1_000, keepalivesSent: 100, hits: 90, savedUsd: 5.0 }),
			);
			await repo.insertSnapshot(
				row({ sampledAt: 2_000, keepalivesSent: 3, hits: 1, savedUsd: 0.1 }),
			);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs });
			expect(result).toHaveLength(1);
			expect(result[0].keepalivesSent).toBe(3); // latest, NOT 100
			expect(result[0].hits).toBe(1);
			expect(result[0].savedUsd).toBe(0.1);
		});

		it("floors ts to the bucket start", async () => {
			await repo.insertSnapshot(row({ sampledAt: 12_345 }));
			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result).toHaveLength(1);
			expect(result[0].ts).toBe(12_000); // floor(12345/1000)*1000
		});

		it("groups into separate buckets and orders by ts ascending", async () => {
			await repo.insertSnapshot(row({ sampledAt: 1_500, warmSessions: 30 }));
			await repo.insertSnapshot(row({ sampledAt: 200, warmSessions: 10 }));
			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result.map((r) => r.ts)).toEqual([0, 1_000]);
		});

		it("excludes rows older than sinceMs", async () => {
			await repo.insertSnapshot(row({ sampledAt: 500 }));
			await repo.insertSnapshot(row({ sampledAt: 5_000 }));
			const result = await repo.getSnapshots({
				sinceMs: 1_000,
				bucketMs: 1_000,
			});
			expect(result).toHaveLength(1);
			expect(result[0].ts).toBe(5_000);
		});
	});

	describe("upsert semantics", () => {
		it("inserting the same sampled_at twice keeps one row and applies the latest values", async () => {
			await repo.insertSnapshot(row({ sampledAt: 1_000, warmSessions: 3 }));
			await repo.insertSnapshot(row({ sampledAt: 1_000, warmSessions: 99 }));

			const n = db
				.query("SELECT COUNT(*) as n FROM cache_keepalive_snapshots")
				.get() as { n: number };
			expect(n.n).toBe(1);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result).toHaveLength(1);
			expect(result[0].warmSessions).toBe(99);
		});
	});

	describe("deleteOlderThan", () => {
		it("removes only rows strictly older than cutoff and returns the count", async () => {
			await repo.insertSnapshot(row({ sampledAt: 100 }));
			await repo.insertSnapshot(row({ sampledAt: 500 }));
			await repo.insertSnapshot(row({ sampledAt: 1_000 })); // == cutoff, kept
			await repo.insertSnapshot(row({ sampledAt: 2_000 }));

			const deleted = await repo.deleteOlderThan(1_000);
			expect(deleted).toBe(2); // 100 and 500

			const remaining = db
				.query(
					"SELECT sampled_at FROM cache_keepalive_snapshots ORDER BY sampled_at",
				)
				.all() as Array<{ sampled_at: number }>;
			expect(remaining.map((r) => r.sampled_at)).toEqual([1_000, 2_000]);
		});

		it("returns 0 when nothing matches", async () => {
			await repo.insertSnapshot(row({ sampledAt: 5_000 }));
			const deleted = await repo.deleteOlderThan(1_000);
			expect(deleted).toBe(0);
		});
	});
});
