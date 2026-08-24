/**
 * The two raw provider-observation tables.
 *
 * Beyond the round-trip, two schema properties carry weight:
 *
 *  - the row key is (attempt, window), NOT (request, window). A retry or
 *    failover produces several responses for one logical request, and keying on
 *    the request would let the second attempt's readings be silently dropped as
 *    duplicates of the first.
 *  - `family_codename` is NOT NULL and carries `''` on root rows. SQLite treats
 *    NULLs as distinct in a UNIQUE index, so a nullable column would leave the
 *    root rows' uniqueness unenforced.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
	CodexWindowObservationRow,
	OpenAiBucketObservationRow,
} from "@clankermux/types";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { CodexWindowObservationRepository } from "../repositories/codex-window-observation.repository";
import { OpenAiBucketObservationRepository } from "../repositories/openai-bucket-observation.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	db.run("PRAGMA foreign_keys = ON");
	return db;
}

function insertAccount(db: Database, id: string): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, 'codex', ?)`,
		[id, id, Date.now()],
	);
}

function codexRow(
	over: Partial<CodexWindowObservationRow> = {},
): CodexWindowObservationRow {
	return {
		observationId: "obs-1",
		requestId: "req-1",
		accountId: "acct-a",
		source: "client",
		httpStatus: 200,
		requestStartedAt: 1_000,
		observedAt: 1_250,
		scope: "root",
		familyCodename: "",
		slot: "primary",
		limitName: null,
		usedPercent: 43.5,
		windowMinutes: 10_080,
		resetAt: 1_760_018_000_000,
		activeLimit: "primary",
		...over,
	};
}

function bucketRow(
	over: Partial<OpenAiBucketObservationRow> = {},
): OpenAiBucketObservationRow {
	return {
		observationId: "obs-1",
		requestId: "req-1",
		accountId: "acct-a",
		source: "client",
		bucket: "tokens",
		requestStartedAt: 1_000,
		observedAt: 1_250,
		httpStatus: 200,
		endpoint: "/v1/chat/completions",
		limitValue: 2_000_000,
		remaining: 1_999_000,
		resetRaw: "6m0s",
		...over,
	};
}

function readCodex(db: Database): Record<string, unknown>[] {
	return db
		.query(
			`SELECT * FROM codex_window_observations
			 ORDER BY observation_id, scope, family_codename, slot`,
		)
		.all() as Record<string, unknown>[];
}

function readBuckets(db: Database): Record<string, unknown>[] {
	return db
		.query(
			`SELECT * FROM openai_bucket_observations ORDER BY observation_id, bucket`,
		)
		.all() as Record<string, unknown>[];
}

describe("CodexWindowObservationRepository", () => {
	let db: Database;
	let repo: CodexWindowObservationRepository;

	beforeEach(() => {
		db = makeDb();
		insertAccount(db, "acct-a");
		repo = new CodexWindowObservationRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("round-trips one attempt's window rows", async () => {
		await repo.insertMany([
			codexRow(),
			codexRow({
				scope: "family",
				familyCodename: "spark",
				slot: "secondary",
				limitName: "GPT-5.3-Codex-Spark",
				usedPercent: 88,
			}),
		]);

		const stored = readCodex(db);
		expect(stored).toHaveLength(2);
		expect(stored[1]).toEqual({
			observation_id: "obs-1",
			request_id: "req-1",
			account_id: "acct-a",
			source: "client",
			http_status: 200,
			request_started_at: 1_000,
			observed_at: 1_250,
			scope: "root",
			family_codename: "",
			slot: "primary",
			limit_name: null,
			used_percent: 43.5,
			window_minutes: 10_080,
			reset_at: 1_760_018_000_000,
			active_limit: "primary",
		});
	});

	it("is a no-op for an empty batch", async () => {
		await repo.insertMany([]);
		expect(readCodex(db)).toHaveLength(0);
	});

	it("keeps a reported zero apart from an absent reading", async () => {
		await repo.insertMany([
			codexRow({ slot: "primary", usedPercent: 0, windowMinutes: 0 }),
			codexRow({ slot: "secondary", usedPercent: null, windowMinutes: null }),
		]);

		const stored = readCodex(db);
		expect(stored.map((r) => r.used_percent)).toEqual([0, null]);
		expect(stored.map((r) => r.window_minutes)).toEqual([0, null]);
	});

	it("keeps the first row when one attempt's window is written twice", async () => {
		await repo.insertMany([codexRow({ usedPercent: 43.5 })]);
		await repo.insertMany([codexRow({ usedPercent: 99 })]);

		const stored = readCodex(db);
		expect(stored).toHaveLength(1);
		expect(stored[0].used_percent).toBe(43.5);
	});

	it("keeps two ATTEMPTS of one request apart", async () => {
		// The failover case: two responses, possibly from different accounts, for
		// one logical request. Keying on the request would drop the second.
		await repo.insertMany([
			codexRow({ observationId: "obs-1", usedPercent: 40 }),
		]);
		await repo.insertMany([
			codexRow({ observationId: "obs-2", usedPercent: 41 }),
		]);

		const stored = readCodex(db);
		expect(stored).toHaveLength(2);
		expect(stored.map((r) => r.used_percent)).toEqual([40, 41]);
		expect(new Set(stored.map((r) => r.request_id))).toEqual(
			new Set(["req-1"]),
		);
	});

	it("enforces uniqueness on ROOT rows too", async () => {
		// This is what the empty-string family codename buys: with a NULL there,
		// SQLite would treat every root row as distinct and this would insert twice.
		await repo.insertMany([codexRow({ familyCodename: "" })]);
		await repo.insertMany([codexRow({ familyCodename: "" })]);
		expect(readCodex(db)).toHaveLength(1);
	});

	it("throws on a NOT NULL violation rather than dropping the row", async () => {
		await expect(
			repo.insertMany([codexRow({ scope: null as unknown as "root" })]),
		).rejects.toThrow();
		expect(readCodex(db)).toHaveLength(0);
	});

	it("cascades away when the owning account is deleted", async () => {
		insertAccount(db, "acct-b");
		await repo.insertMany([
			codexRow({ observationId: "obs-a", accountId: "acct-a" }),
			codexRow({ observationId: "obs-b", accountId: "acct-b" }),
		]);
		db.run(`DELETE FROM accounts WHERE id = 'acct-a'`);
		expect(readCodex(db).map((r) => r.account_id)).toEqual(["acct-b"]);
	});
});

describe("OpenAiBucketObservationRepository", () => {
	let db: Database;
	let repo: OpenAiBucketObservationRepository;

	beforeEach(() => {
		db = makeDb();
		insertAccount(db, "acct-a");
		repo = new OpenAiBucketObservationRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("round-trips both buckets of one attempt", async () => {
		await repo.insertMany([
			bucketRow({ bucket: "requests", limitValue: 10_000, remaining: 9_999 }),
			bucketRow({ bucket: "tokens" }),
		]);

		const stored = readBuckets(db);
		expect(stored).toHaveLength(2);
		expect(stored[1]).toEqual({
			observation_id: "obs-1",
			request_id: "req-1",
			account_id: "acct-a",
			source: "client",
			bucket: "tokens",
			request_started_at: 1_000,
			observed_at: 1_250,
			http_status: 200,
			endpoint: "/v1/chat/completions",
			limit_value: 2_000_000,
			remaining: 1_999_000,
			// Verbatim, never a parsed duration.
			reset_raw: "6m0s",
		});
	});

	it("records the dispatch that produced the attempt", async () => {
		// Without this column a keepalive replay through an openai-compatible
		// account is indistinguishable from client traffic in the bucket series.
		await repo.insertMany([
			bucketRow({ observationId: "obs-probe", source: "keepalive" }),
		]);
		const stored = readBuckets(db).find(
			(r) => r.observation_id === "obs-probe",
		);
		expect(stored?.source).toBe("keepalive");
	});

	it("throws on a missing source rather than dropping the row", async () => {
		await expect(
			repo.insertMany([bucketRow({ source: null as unknown as "client" })]),
		).rejects.toThrow();
		expect(readBuckets(db)).toHaveLength(0);
	});

	it("keeps a remaining of zero as zero", async () => {
		await repo.insertMany([bucketRow({ remaining: 0 })]);
		expect(readBuckets(db)[0].remaining).toBe(0);
	});

	it("stores a malformed reading as NULL while keeping the row", async () => {
		await repo.insertMany([
			bucketRow({ limitValue: null, remaining: null, resetRaw: null }),
		]);
		const stored = readBuckets(db)[0];
		expect(stored.limit_value).toBeNull();
		expect(stored.remaining).toBeNull();
		expect(stored.bucket).toBe("tokens");
	});

	it("keeps the first row when one attempt's bucket is written twice", async () => {
		await repo.insertMany([bucketRow({ remaining: 100 })]);
		await repo.insertMany([bucketRow({ remaining: 5 })]);
		const stored = readBuckets(db);
		expect(stored).toHaveLength(1);
		expect(stored[0].remaining).toBe(100);
	});

	it("cascades away when the owning account is deleted", async () => {
		insertAccount(db, "acct-b");
		await repo.insertMany([
			bucketRow({ observationId: "obs-a", accountId: "acct-a" }),
			bucketRow({ observationId: "obs-b", accountId: "acct-b" }),
		]);
		db.run(`DELETE FROM accounts WHERE id = 'acct-a'`);
		expect(readBuckets(db).map((r) => r.account_id)).toEqual(["acct-b"]);
	});
});

describe("provider observation schema", () => {
	it("creates both tables with their indexes on a fresh database", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			const indexes = (
				db
					.query(
						`SELECT name FROM sqlite_master
						 WHERE type = 'index'
						 AND tbl_name IN ('codex_window_observations', 'openai_bucket_observations')
						 AND name NOT LIKE 'sqlite_%'
						 ORDER BY name`,
					)
					.all() as Array<{ name: string }>
			).map((r) => r.name);

			expect(indexes).toEqual([
				"idx_codex_window_obs_account_time",
				"idx_codex_window_obs_key",
				"idx_codex_window_obs_observed_at",
				"idx_openai_bucket_obs_account_time",
				"idx_openai_bucket_obs_key",
				"idx_openai_bucket_obs_observed_at",
			]);
		} finally {
			db.close();
		}
	});
});
