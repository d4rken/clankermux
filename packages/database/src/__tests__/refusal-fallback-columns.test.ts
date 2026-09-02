import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { RequestRepository } from "../repositories/request.repository";

const COLUMNS = [
	"stop_reason",
	"refusal_category",
	"fallback_credit_claimed",
	"fallback_from_model",
] as const;

function columnNames(db: Database): Set<string> {
	return new Set(
		(
			db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>
		).map((column) => column.name),
	);
}

function readRow(db: Database, id: string) {
	return db
		.prepare(
			`SELECT stop_reason, refusal_category, fallback_credit_claimed, fallback_from_model
			 FROM requests WHERE id = ?`,
		)
		.get(id) as {
		stop_reason: string | null;
		refusal_category: string | null;
		fallback_credit_claimed: number | null;
		fallback_from_model: string | null;
	};
}

describe("requests refusal/fallback columns", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => db.close());

	it("are present for fresh databases", () => {
		ensureSchema(db);
		const cols = columnNames(db);
		for (const column of COLUMNS) expect(cols.has(column)).toBe(true);
	});

	it("are added idempotently to an existing requests table", () => {
		ensureSchema(db);
		// The partial index references two of the columns, so it has to go first
		// — exactly the state a database predating this feature is in.
		db.run("DROP INDEX IF EXISTS idx_requests_refusal_fallback");
		for (const column of COLUMNS) {
			db.run(`ALTER TABLE requests DROP COLUMN ${column}`);
		}
		const dropped = columnNames(db);
		for (const column of COLUMNS) expect(dropped.has(column)).toBe(false);

		runMigrations(db);
		const restored = columnNames(db);
		for (const column of COLUMNS) expect(restored.has(column)).toBe(true);
		expect(() => runMigrations(db)).not.toThrow();
	});

	it("persists all four fields on save", async () => {
		ensureSchema(db);
		const repository = new RequestRepository(new BunSqlAdapter(db));
		await repository.save({
			id: "req-refusal",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			projectAttributionSource: null,
			stopReason: "refusal",
			refusalCategory: "cyber",
		});
		await repository.save({
			id: "req-retry",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 12,
			failoverAttempts: 0,
			projectAttributionSource: null,
			stopReason: "end_turn",
			fallbackCreditClaimed: true,
			fallbackFromModel: "claude-fable-5-1",
		});

		const refusal = readRow(db, "req-refusal");
		expect(refusal.stop_reason).toBe("refusal");
		expect(refusal.refusal_category).toBe("cyber");
		expect(refusal.fallback_credit_claimed).toBeNull();
		expect(refusal.fallback_from_model).toBeNull();

		const retry = readRow(db, "req-retry");
		expect(retry.stop_reason).toBe("end_turn");
		expect(retry.refusal_category).toBeNull();
		expect(retry.fallback_credit_claimed).toBe(1);
		expect(retry.fallback_from_model).toBe("claude-fable-5-1");
	});

	it("stores no credit marker (NULL, not 0) when the request claimed none", async () => {
		ensureSchema(db);
		const repository = new RequestRepository(new BunSqlAdapter(db));
		await repository.save({
			id: "req-plain",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			projectAttributionSource: null,
			stopReason: "end_turn",
			fallbackCreditClaimed: false,
		});
		expect(readRow(db, "req-plain").fallback_credit_claimed).toBeNull();
	});

	it("keeps stored values across a re-upsert that omits them", async () => {
		ensureSchema(db);
		const repository = new RequestRepository(new BunSqlAdapter(db));
		const base = {
			id: "req-upsert",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			projectAttributionSource: null,
		} as const;

		await repository.save({
			...base,
			stopReason: "refusal",
			refusalCategory: "unknown",
			fallbackCreditClaimed: true,
			fallbackFromModel: "claude-fable-5-1",
		});
		await repository.save({ ...base, responseTime: 11 });

		const row = readRow(db, "req-upsert");
		expect(row.stop_reason).toBe("refusal");
		expect(row.refusal_category).toBe("unknown");
		expect(row.fallback_credit_claimed).toBe(1);
		expect(row.fallback_from_model).toBe("claude-fable-5-1");
	});

	it("patches the response columns from updateUsage without any usage vector", async () => {
		ensureSchema(db);
		const repository = new RequestRepository(new BunSqlAdapter(db));
		await repository.save({
			id: "req-late",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			projectAttributionSource: null,
			fallbackCreditClaimed: true,
			fallbackFromModel: "claude-fable-5-1",
		});

		await repository.updateUsage("req-late", undefined, null, {
			stopReason: "refusal",
			refusalCategory: "unknown",
		});

		const row = readRow(db, "req-late");
		expect(row.stop_reason).toBe("refusal");
		expect(row.refusal_category).toBe("unknown");
		// The ingress-side marks are untouched by the response-side patch.
		expect(row.fallback_credit_claimed).toBe(1);
		expect(row.fallback_from_model).toBe("claude-fable-5-1");
	});

	it("leaves the response columns alone when the patch carries no stop reason", async () => {
		ensureSchema(db);
		const repository = new RequestRepository(new BunSqlAdapter(db));
		await repository.save({
			id: "req-usage-only",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
			projectAttributionSource: null,
			stopReason: "refusal",
			refusalCategory: "cyber",
		});

		await repository.updateUsage("req-usage-only", { outputTokens: 12 }, 1234);

		const row = readRow(db, "req-usage-only");
		expect(row.stop_reason).toBe("refusal");
		expect(row.refusal_category).toBe("cyber");
		const usage = db
			.prepare("SELECT output_tokens FROM requests WHERE id = ?")
			.get("req-usage-only") as { output_tokens: number | null };
		expect(usage.output_tokens).toBe(12);
	});
});
