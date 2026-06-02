/**
 * Tests for UsageSnapshotRepository — the append-only per-account rate-limit
 * utilization time-series that backs the dashboard "sawtooth" graph.
 *
 * Covers round-trip + last-value-per-bucket reads, null handling, idempotent
 * upserts, retention pruning, and FK cascade on account deletion.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { UsageSnapshotRow } from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { UsageSnapshotRepository } from "../repositories/usage-snapshot.repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	// Enforce foreign keys so the cascade test exercises real behavior.
	db.run("PRAGMA foreign_keys = ON");
	return db;
}

function insertAccount(db: Database, id: string, name = id): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, 'anthropic', ?)`,
		[id, name, Date.now()],
	);
}

function makeRepo(db: Database): UsageSnapshotRepository {
	return new UsageSnapshotRepository(new BunSqlAdapter(db));
}

function row(overrides: Partial<UsageSnapshotRow>): UsageSnapshotRow {
	return {
		accountId: "acct-a",
		provider: "anthropic",
		sampledAt: 1_000,
		fiveHourPct: 10,
		fiveHourReset: 5_000,
		sevenDayPct: 20,
		sevenDayReset: 9_000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UsageSnapshotRepository", () => {
	let db: Database;
	let repo: UsageSnapshotRepository;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
		insertAccount(db, "acct-a");
		insertAccount(db, "acct-b");
	});

	afterEach(() => {
		db.close();
	});

	describe("insertSnapshots", () => {
		it("is a no-op for an empty array", async () => {
			await repo.insertSnapshots([]);
			const n = db.query("SELECT COUNT(*) as n FROM usage_snapshots").get() as {
				n: number;
			};
			expect(n.n).toBe(0);
		});

		it("bulk-inserts multiple rows", async () => {
			await repo.insertSnapshots([
				row({ accountId: "acct-a", sampledAt: 1_000 }),
				row({ accountId: "acct-b", sampledAt: 1_000 }),
			]);
			const n = db.query("SELECT COUNT(*) as n FROM usage_snapshots").get() as {
				n: number;
			};
			expect(n.n).toBe(2);
		});
	});

	describe("getSnapshots — last value per bucket", () => {
		it("returns exactly one row per (account, bucket), the latest sampled_at", async () => {
			const bucketMs = 1_000;
			// Two accounts, several timestamps. Bucket 0 = [0,1000), bucket 1 = [1000,2000).
			await repo.insertSnapshots([
				// acct-a bucket 0: two samples, latest at 900 → pct 11
				row({ accountId: "acct-a", sampledAt: 100, fiveHourPct: 10 }),
				row({ accountId: "acct-a", sampledAt: 900, fiveHourPct: 11 }),
				// acct-a bucket 1: one sample
				row({ accountId: "acct-a", sampledAt: 1_500, fiveHourPct: 30 }),
				// acct-b bucket 0: two samples, latest at 500 → pct 99
				row({ accountId: "acct-b", sampledAt: 200, fiveHourPct: 50 }),
				row({ accountId: "acct-b", sampledAt: 500, fiveHourPct: 99 }),
			]);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs });

			// 3 distinct (account, bucket) pairs.
			expect(result.length).toBe(3);

			// Ordered by ts, then account_id.
			const aBucket0 = result.find(
				(r) => r.accountId === "acct-a" && r.ts === 0,
			);
			const bBucket0 = result.find(
				(r) => r.accountId === "acct-b" && r.ts === 0,
			);
			const aBucket1 = result.find(
				(r) => r.accountId === "acct-a" && r.ts === 1_000,
			);

			expect(aBucket0?.fiveHourPct).toBe(11); // latest in bucket 0
			expect(bBucket0?.fiveHourPct).toBe(99); // latest in bucket 0
			expect(aBucket1?.fiveHourPct).toBe(30);
		});

		it("floors ts to the bucket start and round-trips all fields", async () => {
			await repo.insertSnapshots([
				row({
					accountId: "acct-a",
					sampledAt: 12_345,
					fiveHourPct: 42.5,
					fiveHourReset: 99_000,
					sevenDayPct: 7.25,
					sevenDayReset: 88_000,
				}),
			]);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result.length).toBe(1);
			const r = result[0];
			expect(r.accountId).toBe("acct-a");
			expect(r.provider).toBe("anthropic");
			expect(r.ts).toBe(12_000); // floor(12345/1000)*1000
			expect(r.fiveHourPct).toBe(42.5);
			expect(r.fiveHourReset).toBe(99_000);
			expect(r.sevenDayPct).toBe(7.25);
			expect(r.sevenDayReset).toBe(88_000);
		});

		it("excludes rows older than sinceMs", async () => {
			await repo.insertSnapshots([
				row({ accountId: "acct-a", sampledAt: 500 }),
				row({ accountId: "acct-a", sampledAt: 5_000 }),
			]);

			const result = await repo.getSnapshots({
				sinceMs: 1_000,
				bucketMs: 1_000,
			});
			expect(result.length).toBe(1);
			expect(result[0].ts).toBe(5_000);
		});
	});

	describe("null handling", () => {
		it("round-trips a null five_hour_pct as null", async () => {
			await repo.insertSnapshots([
				row({
					accountId: "acct-a",
					sampledAt: 1_000,
					fiveHourPct: null,
					fiveHourReset: null,
				}),
			]);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result.length).toBe(1);
			expect(result[0].fiveHourPct).toBeNull();
			expect(result[0].fiveHourReset).toBeNull();
			expect(result[0].sevenDayPct).toBe(20);
		});

		it("round-trips a null provider as null", async () => {
			await repo.insertSnapshots([
				row({ accountId: "acct-a", sampledAt: 1_000, provider: null }),
			]);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result[0].provider).toBeNull();
		});
	});

	describe("upsert semantics", () => {
		it("inserting the same (account_id, sampled_at) twice keeps one row and applies the latest values", async () => {
			await repo.insertSnapshots([
				row({ accountId: "acct-a", sampledAt: 1_000, fiveHourPct: 10 }),
			]);
			await repo.insertSnapshots([
				row({ accountId: "acct-a", sampledAt: 1_000, fiveHourPct: 55 }),
			]);

			const n = db.query("SELECT COUNT(*) as n FROM usage_snapshots").get() as {
				n: number;
			};
			expect(n.n).toBe(1);

			const result = await repo.getSnapshots({ sinceMs: 0, bucketMs: 1_000 });
			expect(result.length).toBe(1);
			expect(result[0].fiveHourPct).toBe(55);
		});
	});

	describe("deleteOlderThan", () => {
		it("removes only rows strictly older than cutoff and returns the count", async () => {
			await repo.insertSnapshots([
				row({ accountId: "acct-a", sampledAt: 100 }),
				row({ accountId: "acct-a", sampledAt: 500 }),
				row({ accountId: "acct-a", sampledAt: 1_000 }), // == cutoff, kept
				row({ accountId: "acct-b", sampledAt: 2_000 }),
			]);

			const deleted = await repo.deleteOlderThan(1_000);
			expect(deleted).toBe(2); // 100 and 500

			const remaining = db
				.query("SELECT sampled_at FROM usage_snapshots ORDER BY sampled_at")
				.all() as Array<{ sampled_at: number }>;
			expect(remaining.map((r) => r.sampled_at)).toEqual([1_000, 2_000]);
		});

		it("returns 0 when nothing matches", async () => {
			await repo.insertSnapshots([
				row({ accountId: "acct-a", sampledAt: 5_000 }),
			]);
			const deleted = await repo.deleteOlderThan(1_000);
			expect(deleted).toBe(0);
		});
	});

	describe("FK cascade", () => {
		it("deleting an account removes its snapshots", async () => {
			await repo.insertSnapshots([
				row({ accountId: "acct-a", sampledAt: 1_000 }),
				row({ accountId: "acct-a", sampledAt: 2_000 }),
				row({ accountId: "acct-b", sampledAt: 1_000 }),
			]);

			db.run("DELETE FROM accounts WHERE id = 'acct-a'");

			const remaining = db
				.query("SELECT account_id FROM usage_snapshots")
				.all() as Array<{ account_id: string }>;
			expect(remaining.length).toBe(1);
			expect(remaining[0].account_id).toBe("acct-b");
		});
	});
});
