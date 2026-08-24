/**
 * Tests for UnifiedSummaryObservationRepository and the
 * `unified_summary_observations` schema — the response-level unified block that
 * sits beside the per-claim series.
 *
 * Covers the round-trip (including the verbatim-text columns whose units are
 * unknown), the request_id idempotency, the deliberate NON-suppression of real
 * constraint violations, the schema/index shape, and the FK cascade.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { UnifiedSummaryObservationRow } from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { UnifiedSummaryObservationRepository } from "../repositories/unified-summary-observation.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
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
	overrides: Partial<UnifiedSummaryObservationRow> = {},
): UnifiedSummaryObservationRow {
	return {
		requestId: "req-1",
		accountId: "acct-a",
		source: "client",
		httpStatus: 429,
		requestStartedAt: 1_000,
		observedAt: 1_250,
		status: "rejected",
		resetAt: 1_785_736_800_000,
		remaining: "0",
		representativeClaim: "seven_day_overage_included",
		fallback: "sonnet",
		fallbackPercentage: 0.5,
		overageStatus: "rejected",
		overageDisabledReason: "org_level_disabled",
		retryAfter: "51811",
		...overrides,
	};
}

interface StoredRow {
	request_id: string;
	account_id: string;
	source: string;
	http_status: number;
	request_started_at: number;
	observed_at: number;
	status: string | null;
	reset_at: number | null;
	remaining: string | null;
	representative_claim: string | null;
	fallback: string | null;
	fallback_percentage: number | null;
	overage_status: string | null;
	overage_disabled_reason: string | null;
	retry_after: string | null;
}

function readAll(db: Database): StoredRow[] {
	return db
		.query(`SELECT * FROM unified_summary_observations ORDER BY request_id`)
		.all() as StoredRow[];
}

describe("UnifiedSummaryObservationRepository", () => {
	let db: Database;
	let repo: UnifiedSummaryObservationRepository;

	beforeEach(() => {
		db = makeDb();
		insertAccount(db, "acct-a");
		repo = new UnifiedSummaryObservationRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("round-trips the whole summary block", async () => {
		await repo.insert(row());
		expect(readAll(db)[0]).toEqual({
			request_id: "req-1",
			account_id: "acct-a",
			source: "client",
			http_status: 429,
			request_started_at: 1_000,
			observed_at: 1_250,
			status: "rejected",
			reset_at: 1_785_736_800_000,
			// Verbatim text, NOT a number: the unit is undocumented.
			remaining: "0",
			representative_claim: "seven_day_overage_included",
			fallback: "sonnet",
			fallback_percentage: 0.5,
			overage_status: "rejected",
			overage_disabled_reason: "org_level_disabled",
			retry_after: "51811",
		});
	});

	it("writes a retry-after-only burst row, with every other field NULL", async () => {
		await repo.insert(
			row({
				status: null,
				resetAt: null,
				remaining: null,
				representativeClaim: null,
				fallback: null,
				fallbackPercentage: null,
				overageStatus: null,
				overageDisabledReason: null,
				retryAfter: "5",
			}),
		);
		const stored = readAll(db)[0];
		expect(stored.retry_after).toBe("5");
		expect(stored.status).toBeNull();
		expect(stored.reset_at).toBeNull();
	});

	it("stores a zero fallback percentage as 0, an absent one as NULL", async () => {
		await repo.insert(row({ requestId: "req-zero", fallbackPercentage: 0 }));
		await repo.insert(row({ requestId: "req-null", fallbackPercentage: null }));
		expect(readAll(db).map((r) => r.fallback_percentage)).toEqual([null, 0]);
	});

	it("keeps the first row when the same request is written twice", async () => {
		await repo.insert(row({ status: "allowed" }));
		await repo.insert(row({ status: "rejected" }));
		const stored = readAll(db);
		expect(stored).toHaveLength(1);
		expect(stored[0].status).toBe("allowed");
	});

	it("throws on a NOT NULL violation rather than dropping the row", async () => {
		await expect(
			repo.insert(row({ source: null as unknown as "client" })),
		).rejects.toThrow();
		expect(readAll(db)).toHaveLength(0);
	});

	it("cascades away when the owning account is deleted", async () => {
		insertAccount(db, "acct-b");
		await repo.insert(row({ requestId: "req-a", accountId: "acct-a" }));
		await repo.insert(row({ requestId: "req-b", accountId: "acct-b" }));
		db.run(`DELETE FROM accounts WHERE id = 'acct-a'`);
		expect(readAll(db).map((r) => r.account_id)).toEqual(["acct-b"]);
	});
});

describe("unified_summary_observations schema", () => {
	it("creates the table and its indexes on a fresh database", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			const cols = (
				db
					.query(`PRAGMA table_info(unified_summary_observations)`)
					.all() as Array<{ name: string }>
			).map((c) => c.name);
			expect(cols).toEqual([
				"request_id",
				"account_id",
				"source",
				"http_status",
				"request_started_at",
				"observed_at",
				"status",
				"reset_at",
				"remaining",
				"representative_claim",
				"fallback",
				"fallback_percentage",
				"overage_status",
				"overage_disabled_reason",
				"retry_after",
			]);
			const indexes = (
				db
					.query(
						`SELECT name FROM sqlite_master
						 WHERE type = 'index' AND tbl_name = 'unified_summary_observations'
						 AND name NOT LIKE 'sqlite_%'
						 ORDER BY name`,
					)
					.all() as Array<{ name: string }>
			).map((r) => r.name);
			expect(indexes).toEqual([
				"idx_unified_summary_obs_account_time",
				"idx_unified_summary_obs_observed_at",
			]);
		} finally {
			db.close();
		}
	});
});
