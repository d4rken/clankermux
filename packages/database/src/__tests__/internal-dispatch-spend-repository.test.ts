/**
 * Tests for InternalDispatchSpendRepository and the `internal_dispatch_spend`
 * schema — the per-dispatch token vectors of the proxy's own probe traffic.
 *
 * The null-vs-zero distinction is the point of the table: a probe whose response
 * carried no usage must be distinguishable from one that genuinely spent zero,
 * or the aggregate burn is silently understated.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { InternalDispatchSpendRow } from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { InternalDispatchSpendRepository } from "../repositories/internal-dispatch-spend.repository";

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
	overrides: Partial<InternalDispatchSpendRow> = {},
): InternalDispatchSpendRow {
	return {
		id: "req-1",
		accountId: "acct-a",
		source: "keepalive",
		model: "claude-sonnet-4-5",
		httpStatus: 200,
		startedAt: 1_000,
		completedAt: 1_500,
		inputTokens: 12,
		outputTokens: 3,
		cacheReadInputTokens: 40_000,
		cacheCreationInputTokens: 0,
		...overrides,
	};
}

interface StoredRow {
	id: string;
	account_id: string;
	source: string;
	model: string | null;
	http_status: number;
	started_at: number;
	completed_at: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
}

function readAll(db: Database): StoredRow[] {
	return db
		.query(`SELECT * FROM internal_dispatch_spend ORDER BY id`)
		.all() as StoredRow[];
}

describe("InternalDispatchSpendRepository", () => {
	let db: Database;
	let repo: InternalDispatchSpendRepository;

	beforeEach(() => {
		db = makeDb();
		insertAccount(db, "acct-a");
		repo = new InternalDispatchSpendRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("round-trips one dispatch's token vector", async () => {
		await repo.insert(row());
		expect(readAll(db)[0]).toEqual({
			id: "req-1",
			account_id: "acct-a",
			source: "keepalive",
			model: "claude-sonnet-4-5",
			http_status: 200,
			started_at: 1_000,
			completed_at: 1_500,
			input_tokens: 12,
			output_tokens: 3,
			cache_read_input_tokens: 40_000,
			// A reported zero, NOT an absent reading.
			cache_creation_input_tokens: 0,
		});
	});

	it("keeps a reading of zero and an absent reading apart", async () => {
		await repo.insert(row({ id: "req-zero", inputTokens: 0 }));
		await repo.insert(row({ id: "req-null", inputTokens: null }));
		const stored = readAll(db);
		expect(stored.map((r) => r.input_tokens)).toEqual([null, 0]);
	});

	it("records a probe whose response carried no usage at all", async () => {
		await repo.insert(
			row({
				httpStatus: 429,
				model: null,
				completedAt: null,
				inputTokens: null,
				outputTokens: null,
				cacheReadInputTokens: null,
				cacheCreationInputTokens: null,
			}),
		);
		const stored = readAll(db)[0];
		expect(stored.http_status).toBe(429);
		expect(stored.model).toBeNull();
		expect(stored.completed_at).toBeNull();
		expect(stored.output_tokens).toBeNull();
	});

	it("records both source kinds", async () => {
		await repo.insert(row({ id: "req-k", source: "keepalive" }));
		await repo.insert(row({ id: "req-r", source: "auto-refresh" }));
		expect(readAll(db).map((r) => r.source)).toEqual([
			"keepalive",
			"auto-refresh",
		]);
	});

	it("keeps the first row when the same dispatch is written twice", async () => {
		await repo.insert(row({ inputTokens: 12 }));
		await repo.insert(row({ inputTokens: 999 }));
		const stored = readAll(db);
		expect(stored).toHaveLength(1);
		expect(stored[0].input_tokens).toBe(12);
	});

	it("throws on a NOT NULL violation rather than dropping the row", async () => {
		await expect(
			repo.insert(row({ httpStatus: null as unknown as number })),
		).rejects.toThrow();
		expect(readAll(db)).toHaveLength(0);
	});

	it("cascades away when the owning account is deleted", async () => {
		insertAccount(db, "acct-b");
		await repo.insert(row({ id: "req-a", accountId: "acct-a" }));
		await repo.insert(row({ id: "req-b", accountId: "acct-b" }));
		db.run(`DELETE FROM accounts WHERE id = 'acct-a'`);
		expect(readAll(db).map((r) => r.account_id)).toEqual(["acct-b"]);
	});
});

describe("internal_dispatch_spend schema", () => {
	it("creates the table and its indexes on a fresh database", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			const cols = (
				db.query(`PRAGMA table_info(internal_dispatch_spend)`).all() as Array<{
					name: string;
				}>
			).map((c) => c.name);
			expect(cols).toEqual([
				"id",
				"account_id",
				"source",
				"model",
				"http_status",
				"started_at",
				"completed_at",
				"input_tokens",
				"output_tokens",
				"cache_read_input_tokens",
				"cache_creation_input_tokens",
			]);
			const indexes = (
				db
					.query(
						`SELECT name FROM sqlite_master
						 WHERE type = 'index' AND tbl_name = 'internal_dispatch_spend'
						 AND name NOT LIKE 'sqlite_%'
						 ORDER BY name`,
					)
					.all() as Array<{ name: string }>
			).map((r) => r.name);
			expect(indexes).toEqual([
				"idx_internal_dispatch_spend_account_time",
				"idx_internal_dispatch_spend_started_at",
			]);
		} finally {
			db.close();
		}
	});
});
