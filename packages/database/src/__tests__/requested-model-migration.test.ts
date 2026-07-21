import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { RequestRepository } from "../repositories/request.repository";

const COLUMN = "requested_model";

function columnNames(db: Database): Set<string> {
	return new Set(
		(
			db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>
		).map((column) => column.name),
	);
}

describe("requests.requested_model", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => db.close());

	it("is present for fresh databases", () => {
		ensureSchema(db);
		expect(columnNames(db).has(COLUMN)).toBe(true);
	});

	it("is added idempotently to existing databases", () => {
		ensureSchema(db);
		db.run(`ALTER TABLE requests DROP COLUMN ${COLUMN}`);
		expect(columnNames(db).has(COLUMN)).toBe(false);
		runMigrations(db);
		expect(columnNames(db).has(COLUMN)).toBe(true);
		expect(() => runMigrations(db)).not.toThrow();
	});

	it("persists independently from provider-reported model and survives a null re-save", async () => {
		ensureSchema(db);
		const repository = new RequestRepository(new BunSqlAdapter(db));
		await repository.save({
			id: "req-model",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: false,
			errorMessage: "overloaded_error",
			responseTime: 10,
			failoverAttempts: 0,
			requestedModel: "claude-haiku-4-5-20251001",
			usage: { model: "provider-model" },
		});

		await repository.save({
			id: "req-model",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: false,
			errorMessage: "overloaded_error",
			responseTime: 11,
			failoverAttempts: 0,
			requestedModel: null,
		});

		const row = db
			.prepare("SELECT model, requested_model FROM requests WHERE id = ?")
			.get("req-model") as {
			model: string | null;
			requested_model: string | null;
		};
		expect(row.model).toBeNull();
		expect(row.requested_model).toBe("claude-haiku-4-5-20251001");
	});
});
