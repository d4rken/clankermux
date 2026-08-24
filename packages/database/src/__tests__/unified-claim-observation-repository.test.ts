/**
 * Tests for UnifiedClaimObservationRepository and the
 * `unified_claim_observations` schema — the request-aligned time-series of the
 * per-claim rate-limit readings Anthropic returns on every response.
 *
 * Covers the multi-row insert, the (request_id, claim) idempotency that lets a
 * retried write land twice harmlessly, the deliberate NON-suppression of real
 * constraint violations, the schema/index shape on a fresh DB and on a repeated
 * ensureSchema(), and the FK cascade on account deletion.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { UnifiedClaimObservationRow } from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { UnifiedClaimObservationRepository } from "../repositories/unified-claim-observation.repository";

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
	overrides: Partial<UnifiedClaimObservationRow> = {},
): UnifiedClaimObservationRow {
	return {
		requestId: "req-1",
		accountId: "acct-a",
		source: "client",
		requestStartedAt: 1_000,
		observedAt: 1_250,
		httpStatus: 200,
		claim: "5h",
		status: "allowed",
		utilization: 0.42,
		resetAt: 9_000,
		surpassedThreshold: null,
		...overrides,
	};
}

interface StoredRow {
	request_id: string;
	account_id: string;
	source: string;
	request_started_at: number;
	observed_at: number;
	http_status: number;
	claim: string;
	status: string;
	utilization: number | null;
	reset_at: number | null;
	surpassed_threshold: number | null;
}

function readAll(db: Database): StoredRow[] {
	return db
		.query(
			`SELECT * FROM unified_claim_observations ORDER BY request_id, claim`,
		)
		.all() as StoredRow[];
}

describe("UnifiedClaimObservationRepository", () => {
	let db: Database;
	let repo: UnifiedClaimObservationRepository;

	beforeEach(() => {
		db = makeDb();
		insertAccount(db, "acct-a");
		repo = new UnifiedClaimObservationRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("inserts every claim of one response as its own row", async () => {
		await repo.insertMany([
			row({ claim: "5h", status: "allowed", utilization: 0.42 }),
			row({ claim: "7d", status: "allowed_warning", utilization: 0.94 }),
			row({ claim: "7d_oi", status: "rejected", utilization: 1 }),
		]);

		const stored = readAll(db);
		expect(stored.map((r) => r.claim)).toEqual(["5h", "7d", "7d_oi"]);
		expect(stored[0]).toEqual({
			request_id: "req-1",
			account_id: "acct-a",
			source: "client",
			request_started_at: 1_000,
			observed_at: 1_250,
			http_status: 200,
			claim: "5h",
			status: "allowed",
			utilization: 0.42,
			reset_at: 9_000,
			surpassed_threshold: null,
		});
	});

	it("stores a zero surpassed-threshold as 0 and an absent one as NULL", async () => {
		await repo.insertMany([
			row({ claim: "5h", surpassedThreshold: 0 }),
			row({ claim: "7d", surpassedThreshold: 0.75 }),
			row({ claim: "7d_oi", surpassedThreshold: null }),
		]);

		const stored = readAll(db);
		expect(stored.map((r) => r.surpassed_threshold)).toEqual([0, 0.75, null]);
	});

	it("is a no-op for an empty batch", async () => {
		await repo.insertMany([]);
		expect(readAll(db)).toHaveLength(0);
	});

	it("stores a zero utilization as 0 and an absent one as NULL", async () => {
		await repo.insertMany([
			row({ claim: "5h", utilization: 0 }),
			row({ claim: "7d", utilization: null, resetAt: null }),
		]);

		const stored = readAll(db);
		expect(stored[0].utilization).toBe(0);
		expect(stored[1].utilization).toBeNull();
		expect(stored[1].reset_at).toBeNull();
	});

	it("keeps the first row when the same (request, claim) is written twice", async () => {
		await repo.insertMany([row({ claim: "5h", utilization: 0.42 })]);
		await repo.insertMany([row({ claim: "5h", utilization: 0.99 })]);

		const stored = readAll(db);
		expect(stored).toHaveLength(1);
		// DO NOTHING, not an upsert: the first observation is the one that was
		// actually aligned with the response, so a duplicate must not rewrite it.
		expect(stored[0].utilization).toBe(0.42);
	});

	it("records the same claim for two different requests", async () => {
		await repo.insertMany([
			row({ requestId: "req-1", claim: "5h" }),
			row({ requestId: "req-2", claim: "5h" }),
		]);
		expect(readAll(db).map((r) => r.request_id)).toEqual(["req-1", "req-2"]);
	});

	it("records both source kinds of internal traffic", async () => {
		await repo.insertMany([
			row({ requestId: "req-k", source: "keepalive" }),
			row({ requestId: "req-r", source: "auto-refresh" }),
		]);
		expect(readAll(db).map((r) => r.source)).toEqual([
			"keepalive",
			"auto-refresh",
		]);
	});

	// The conflict clause is deliberately narrow (ON CONFLICT on the key, not
	// INSERT OR IGNORE): a NOT NULL violation is a bug in the caller and must
	// surface, not be swallowed alongside the benign duplicate.
	it("throws on a NOT NULL violation rather than dropping the row", async () => {
		await expect(
			repo.insertMany([
				row({ status: null as unknown as string }),
				row({ claim: "7d" }),
			]),
		).rejects.toThrow();
		expect(readAll(db)).toHaveLength(0);
	});
});

describe("unified_claim_observations schema", () => {
	function indexNames(db: Database): string[] {
		return (
			db
				.query(
					`SELECT name FROM sqlite_master
					 WHERE type = 'index' AND tbl_name = 'unified_claim_observations'
					 AND name NOT LIKE 'sqlite_%'
					 ORDER BY name`,
				)
				.all() as Array<{ name: string }>
		).map((r) => r.name);
	}

	it("creates the table and its indexes on a fresh database", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			const cols = (
				db
					.query(`PRAGMA table_info(unified_claim_observations)`)
					.all() as Array<{ name: string }>
			).map((c) => c.name);
			expect(cols).toEqual([
				"request_id",
				"account_id",
				"source",
				"request_started_at",
				"observed_at",
				"http_status",
				"claim",
				"status",
				"utilization",
				"reset_at",
				"surpassed_threshold",
			]);
			expect(indexNames(db)).toEqual([
				"idx_unified_claim_obs_account_time",
				"idx_unified_claim_obs_observed_at",
			]);
		} finally {
			db.close();
		}
	});

	it("survives a repeated ensureSchema() with its rows intact", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			insertAccount(db, "acct-a");
			db.run(
				`INSERT INTO unified_claim_observations
				 (request_id, account_id, source, request_started_at, observed_at,
				  http_status, claim, status, utilization, reset_at)
				 VALUES ('req-1', 'acct-a', 'client', 1, 2, 200, '5h', 'allowed', 0.1, 3)`,
			);
			ensureSchema(db);
			expect(readAll(db)).toHaveLength(1);
			expect(indexNames(db)).toEqual([
				"idx_unified_claim_obs_account_time",
				"idx_unified_claim_obs_observed_at",
			]);
		} finally {
			db.close();
		}
	});

	it("cascades away when the owning account is deleted", async () => {
		const db = makeDb();
		try {
			insertAccount(db, "acct-a");
			insertAccount(db, "acct-b");
			const repo = new UnifiedClaimObservationRepository(new BunSqlAdapter(db));
			await repo.insertMany([
				row({ requestId: "req-a", accountId: "acct-a" }),
				row({ requestId: "req-b", accountId: "acct-b" }),
			]);

			db.run(`DELETE FROM accounts WHERE id = 'acct-a'`);

			expect(readAll(db).map((r) => r.account_id)).toEqual(["acct-b"]);
		} finally {
			db.close();
		}
	});
});
