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
	sumCounterDeltas,
} from "./cache-keepalive-snapshot.repository";

/** Minimal CounterRow for the sumCounterDeltas fold tests. */
function counter(over: Partial<Record<string, number>> = {}) {
	return {
		keepalives_sent: 0,
		hits: 0,
		misses: 0,
		failures: 0,
		spent_usd: 0,
		saved_usd: 0,
		warm_resumes: 0,
		saved_usd_5m: 0,
		...over,
	} as Parameters<typeof sumCounterDeltas>[1][number];
}

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
		warmResumes: 2,
		savedUsd5m: 0.15,
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

		it("round-trips the warm_resumes + saved_usd_5m columns", async () => {
			await repo.insertSnapshot(
				row({ sampledAt: 1_000, warmResumes: 7, savedUsd5m: 3.25 }),
			);
			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result).toHaveLength(1);
			expect(result[0].warmResumes).toBe(7);
			expect(result[0].savedUsd5m).toBe(3.25);
		});
	});

	describe("getLatestSnapshot", () => {
		it("returns null on an empty table", async () => {
			expect(await repo.getLatestSnapshot()).toBeNull();
		});

		it("returns the row with the greatest sampled_at", async () => {
			await repo.insertSnapshot(row({ sampledAt: 1_000, hits: 5 }));
			await repo.insertSnapshot(
				row({ sampledAt: 9_000, hits: 42, warmResumes: 9, savedUsd5m: 6.5 }),
			);
			await repo.insertSnapshot(row({ sampledAt: 3_000, hits: 20 }));
			const latest = await repo.getLatestSnapshot();
			expect(latest?.sampledAt).toBe(9_000);
			expect(latest?.hits).toBe(42);
			expect(latest?.warmResumes).toBe(9);
			expect(latest?.savedUsd5m).toBe(6.5);
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

	describe("sumCounterDeltas (window-total fold)", () => {
		it("with no anchor, counts the first sample in full + later increments", () => {
			const t = sumCounterDeltas(null, [
				counter({ hits: 3, saved_usd_5m: 1.5 }),
				counter({ hits: 8, saved_usd_5m: 4.0 }),
			]);
			// 3 (full first) + (8-3)=5 → 8; 1.5 + 2.5 → 4.0
			expect(t.hits).toBe(8);
			expect(t.savedUsd5m).toBeCloseTo(4.0, 10);
		});

		it("with an anchor, the first in-window sample counts only its increment", () => {
			const anchor = counter({ hits: 10, saved_usd_5m: 5 });
			const t = sumCounterDeltas(anchor, [
				counter({ hits: 12, saved_usd_5m: 6 }), // +2 / +1
				counter({ hits: 15, saved_usd_5m: 7.5 }), // +3 / +1.5
			]);
			expect(t.hits).toBe(5);
			expect(t.savedUsd5m).toBeCloseTo(2.5, 10);
		});

		it("clamps a restart reset within the window (counts the post-reset value)", () => {
			const t = sumCounterDeltas(null, [
				counter({ hits: 5 }),
				counter({ hits: 9 }), // +4
				counter({ hits: 2 }), // reset → +2 (not negative)
				counter({ hits: 6 }), // +4
			]);
			// 5 + 4 + 2 + 4 = 15
			expect(t.hits).toBe(15);
		});

		it("returns all-zero for an empty window", () => {
			expect(sumCounterDeltas(null, []).hits).toBe(0);
		});
	});

	describe("getWindowCounterTotals", () => {
		it("sums in-window activity, anchored on the sample before the window", async () => {
			// Pre-window anchor at 500, in-window samples at 1000/2000.
			await repo.insertSnapshot(
				row({ sampledAt: 500, hits: 10, warmResumes: 1 }),
			);
			await repo.insertSnapshot(
				row({ sampledAt: 1_000, hits: 14, warmResumes: 2 }),
			);
			await repo.insertSnapshot(
				row({ sampledAt: 2_000, hits: 20, warmResumes: 5 }),
			);
			// Window [1000, ∞): anchored on the 500 sample → (14-10)+(20-14)=10 hits,
			// (2-1)+(5-2)=4 resumes.
			const t = await repo.getWindowCounterTotals(1_000);
			expect(t.hits).toBe(10);
			expect(t.warmResumes).toBe(4);
		});

		it("counts the first-ever sample in full when there is no anchor", async () => {
			await repo.insertSnapshot(row({ sampledAt: 1_000, hits: 7 }));
			await repo.insertSnapshot(row({ sampledAt: 2_000, hits: 12 }));
			const t = await repo.getWindowCounterTotals(0);
			expect(t.hits).toBe(12); // 7 (full) + 5
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
