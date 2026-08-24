/**
 * Tests for UsageScopedSnapshotRepository — the append-only per-model-family
 * weekly-window time-series recorded beside the account-wide `usage_snapshots`
 * series.
 *
 * Covers round-trip reads, null handling, idempotent upserts on the
 * (account, tick, family, display name) key, two generations of one family
 * surviving the same tick, retention pruning, and FK cascade on account
 * deletion.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ScopedUsageSnapshotRow } from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { UsageScopedSnapshotRepository } from "../repositories/usage-scoped-snapshot.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
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

function row(
	overrides: Partial<ScopedUsageSnapshotRow>,
): ScopedUsageSnapshotRow {
	return {
		accountId: "acct-a",
		sampledAt: 1_000,
		family: "opus",
		displayName: "Claude Opus 5",
		pct: 12.5,
		resetAt: 9_000,
		...overrides,
	};
}

describe("UsageScopedSnapshotRepository", () => {
	let db: Database;
	let repo: UsageScopedSnapshotRepository;

	beforeEach(() => {
		db = makeDb();
		insertAccount(db, "acct-a");
		insertAccount(db, "acct-b");
		repo = new UsageScopedSnapshotRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("round-trips one row per family at a single tick", async () => {
		await repo.insertSnapshots([
			row({ family: "opus", displayName: "Claude Opus 5", pct: 63 }),
			row({ family: "sonnet", displayName: "Claude Sonnet 4.6", pct: 12 }),
		]);

		const read = await repo.getRecentSnapshotsForAccounts(["acct-a"], 0);

		expect(read).toHaveLength(2);
		expect(read.map((r) => r.family).sort()).toEqual(["opus", "sonnet"]);
		expect(read.find((r) => r.family === "opus")).toEqual({
			accountId: "acct-a",
			sampledAt: 1_000,
			family: "opus",
			displayName: "Claude Opus 5",
			pct: 63,
			resetAt: 9_000,
		});
	});

	it("preserves nulls rather than coercing them to zero", async () => {
		await repo.insertSnapshots([row({ pct: null, resetAt: null })]);

		const [read] = await repo.getRecentSnapshotsForAccounts(["acct-a"], 0);

		expect(read.pct).toBeNull();
		expect(read.resetAt).toBeNull();
	});

	it("upserts on (account, tick, family, display name) instead of erroring", async () => {
		await repo.insertSnapshots([row({ pct: 10 })]);
		await repo.insertSnapshots([row({ pct: 20 })]);

		const read = await repo.getRecentSnapshotsForAccounts(["acct-a"], 0);

		expect(read).toHaveLength(1);
		expect(read[0].pct).toBe(20);
	});

	it("keeps two generations of one family at the same tick", async () => {
		// Both display names resolve to `opus`, so a key without display_name
		// would insert the first row and then overwrite it with the second,
		// losing a whole scoped series with no way to recover it. This is the
		// case the column was added to preserve.
		await repo.insertSnapshots([
			row({ family: "opus", displayName: "Claude Opus 4.8", pct: 41 }),
			row({ family: "opus", displayName: "Claude Opus 5", pct: 77 }),
		]);

		const read = await repo.getRecentSnapshotsForAccounts(["acct-a"], 0);

		expect(read).toHaveLength(2);
		expect(read.map((r) => `${r.displayName}=${r.pct}`).sort()).toEqual([
			"Claude Opus 4.8=41",
			"Claude Opus 5=77",
		]);
	});

	it("rejects a row with no display name", async () => {
		// The label is what the family was resolved FROM, so a scoped window
		// always has one; a null here means the write path lost it.
		await expect(
			repo.insertSnapshots([row({ displayName: null as unknown as string })]),
		).rejects.toThrow();
	});

	it("keeps rows for different families at the same tick distinct", async () => {
		await repo.insertSnapshots([
			row({ family: "opus" }),
			row({ family: "fable" }),
		]);

		expect(
			await repo.getRecentSnapshotsForAccounts(["acct-a"], 0),
		).toHaveLength(2);
	});

	it("filters by account and by sinceMs", async () => {
		await repo.insertSnapshots([
			row({ accountId: "acct-a", sampledAt: 1_000 }),
			row({ accountId: "acct-a", sampledAt: 5_000 }),
			row({ accountId: "acct-b", sampledAt: 5_000 }),
		]);

		const read = await repo.getRecentSnapshotsForAccounts(["acct-a"], 2_000);

		expect(read).toHaveLength(1);
		expect(read[0].sampledAt).toBe(5_000);
	});

	it("returns [] without querying for an empty account list", async () => {
		await repo.insertSnapshots([row({})]);
		expect(await repo.getRecentSnapshotsForAccounts([], 0)).toEqual([]);
	});

	it("prunes strictly older than the cutoff", async () => {
		await repo.insertSnapshots([
			row({ sampledAt: 1_000 }),
			row({ sampledAt: 2_000 }),
			row({ sampledAt: 3_000 }),
		]);

		const removed = await repo.deleteOlderThan(2_000);

		expect(removed).toBe(1);
		const read = await repo.getRecentSnapshotsForAccounts(["acct-a"], 0);
		expect(read.map((r) => r.sampledAt)).toEqual([2_000, 3_000]);
	});

	it("cascades away with its account", async () => {
		await repo.insertSnapshots([row({ accountId: "acct-a" })]);

		db.run(`DELETE FROM accounts WHERE id = ?`, ["acct-a"]);

		expect(await repo.getRecentSnapshotsForAccounts(["acct-a"], 0)).toEqual([]);
	});
});
