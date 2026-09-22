/**
 * anthropic_banked_reset_events arrives on an existing database through
 * ensureSchema()'s CREATE TABLE IF NOT EXISTS, which runMigrations() runs after
 * the additive ALTERs. The constraints are what the ledger's idempotency rests
 * on, so they are exercised on the upgraded table, not only on a fresh one.
 */
import type { Database as DatabaseType } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { createFloorDatabase } from "./schema-floor.fixture";

const TABLE = "anthropic_banked_reset_events";

function tableExists(db: DatabaseType): boolean {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
			)
			.get(TABLE) != null
	);
}

function insert(
	db: DatabaseType,
	row: Partial<Record<string, string | number | null>>,
): void {
	const full = {
		id: crypto.randomUUID(),
		account_id: "acc",
		account_name: "Acc",
		grant_id: "g1",
		trigger: "manual",
		cause: null,
		attempt_seq: null,
		request_id: crypto.randomUUID(),
		status: "pending",
		created_at: 0,
		...row,
	};
	const cols = Object.keys(full);
	db.prepare(
		`INSERT INTO ${TABLE} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
	).run(...(Object.values(full) as Array<string | number | null>));
}

describe("anthropic_banked_reset_events migration", () => {
	let db: DatabaseType;

	beforeEach(() => {
		db = createFloorDatabase();
		expect(tableExists(db)).toBe(false);
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	it("runMigrations() creates the table on a database that predates it", () => {
		expect(tableExists(db)).toBe(true);
	});

	it("rejects unknown trigger, cause and status values", () => {
		expect(() => insert(db, { trigger: "cron" })).toThrow();
		expect(() => insert(db, { cause: "boredom" })).toThrow();
		expect(() => insert(db, { status: "rate_limited" })).toThrow();
		for (const status of [
			"pending",
			"reset",
			"already_used",
			"not_limited",
			"cooldown",
			"ineligible",
			"unavailable",
			"failed",
		]) {
			insert(db, { status });
		}
	});

	it("allows one row per (account, request_id)", () => {
		insert(db, { request_id: "r1" });
		expect(() => insert(db, { request_id: "r1" })).toThrow();
		insert(db, { request_id: "r1", account_id: "other" });
	});

	it("allows one auto row per (account, grant, attempt_seq) and ignores manual rows", () => {
		insert(db, { trigger: "auto", cause: "expiry", attempt_seq: 1 });
		expect(() =>
			insert(db, { trigger: "auto", cause: "expiry", attempt_seq: 1 }),
		).toThrow();
		insert(db, { trigger: "manual", attempt_seq: 1 });
		insert(db, { trigger: "manual", attempt_seq: 1 });
	});

	it("has no foreign key to accounts, so rows outlive the account", () => {
		const fks = db.prepare(`PRAGMA foreign_key_list(${TABLE})`).all();
		expect(fks).toEqual([]);
	});

	it("is idempotent across repeated runs", () => {
		insert(db, { request_id: "kept" });
		runMigrations(db);
		ensureSchema(db);
		const count = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get() as {
			n: number;
		};
		expect(count.n).toBe(1);
	});
});

it("a fresh database gets the same table", () => {
	const db = new Database(":memory:");
	ensureSchema(db);
	expect(tableExists(db)).toBe(true);
	db.close();
});
