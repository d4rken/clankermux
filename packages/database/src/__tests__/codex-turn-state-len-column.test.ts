import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { RequestRepository } from "../repositories/request.repository";

const COLUMN = "codex_turn_state_len";

function columnNames(db: Database): Set<string> {
	return new Set(
		(
			db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>
		).map((column) => column.name),
	);
}

function readLen(db: Database, id: string): number | null {
	return (
		db.prepare(`SELECT ${COLUMN} FROM requests WHERE id = ?`).get(id) as {
			codex_turn_state_len: number | null;
		}
	).codex_turn_state_len;
}

const BASE = {
	method: "POST",
	path: "/backend-api/codex/responses",
	accountUsed: null,
	statusCode: 200,
	success: true,
	errorMessage: null,
	responseTime: 10,
	failoverAttempts: 0,
	projectAttributionSource: null,
} as const;

describe("requests.codex_turn_state_len", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => db.close());

	it("is present for fresh databases", () => {
		ensureSchema(db);
		expect(columnNames(db).has(COLUMN)).toBe(true);
	});

	it("is added idempotently to an existing requests table", () => {
		ensureSchema(db);
		db.run(`ALTER TABLE requests DROP COLUMN ${COLUMN}`);
		expect(columnNames(db).has(COLUMN)).toBe(false);

		runMigrations(db);
		expect(columnNames(db).has(COLUMN)).toBe(true);
		expect(() => runMigrations(db)).not.toThrow();
	});

	it("persists the recorded length", async () => {
		ensureSchema(db);
		const repository = new RequestRepository(new BunSqlAdapter(db));
		await repository.save({
			...BASE,
			id: "req-292",
			codexTurnStateLen: 292,
		});
		expect(readLen(db, "req-292")).toBe(292);
	});

	it("stores 0 as 0 and an absent header as NULL", async () => {
		ensureSchema(db);
		const repository = new RequestRepository(new BunSqlAdapter(db));
		// The whole point of the column is comparing length distributions, so a
		// zero-length token must not collapse into "no token" via `|| null`.
		await repository.save({ ...BASE, id: "req-zero", codexTurnStateLen: 0 });
		await repository.save({ ...BASE, id: "req-absent" });

		expect(readLen(db, "req-zero")).toBe(0);
		expect(readLen(db, "req-absent")).toBeNull();
	});

	it("keeps the stored length across a re-upsert that omits it", async () => {
		ensureSchema(db);
		const repository = new RequestRepository(new BunSqlAdapter(db));
		await repository.save({ ...BASE, id: "req-patch", codexTurnStateLen: 312 });
		// The usage-patch re-upsert carries no ingress facts.
		await repository.save({ ...BASE, id: "req-patch", responseTime: 11 });

		expect(readLen(db, "req-patch")).toBe(312);
	});
});
