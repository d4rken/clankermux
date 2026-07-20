/**
 * Tests for the codex_reset_credit_events.cause column (why an auto consume
 * attempt was claimed: 'expiry' | 'weekly-limit'; NULL on manual rows).
 *
 * Covers BOTH halves of the mandatory two-step migration rule:
 *   1. ensureSchema() includes the column for fresh installs.
 *   2. runMigrations()'s ADDITIVE_COLUMNS adds it to a pre-existing live DB
 *      whose codex_reset_credit_events table predates the column.
 * (Defense-in-depth: the table and the column ship together on this lineage,
 * but the ADDITIVE_COLUMNS entry insures partial-deploy scenarios.)
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";

const TABLE = "codex_reset_credit_events";
const COLUMN = "cause";

function columnNames(db: Database, table: string): Set<string> {
	return new Set(
		(
			db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
			}>
		).map((c) => c.name),
	);
}

describe("codex_reset_credit_events.cause migration", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("ensureSchema() creates the column on a fresh DB", () => {
		ensureSchema(db);
		expect(columnNames(db, TABLE).has(COLUMN)).toBe(true);
	});

	it("runMigrations() adds the column to an existing DB that lacks it", () => {
		// Simulate a live DB whose table predates the column: full current
		// schema, then drop just this column (its CHECK is a column constraint on
		// the column itself, so SQLite drops it along with the column; it is not
		// part of any index).
		ensureSchema(db);
		db.run(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
		expect(columnNames(db, TABLE).has(COLUMN)).toBe(false);

		runMigrations(db);
		expect(columnNames(db, TABLE).has(COLUMN)).toBe(true);
	});

	it("the migrated column still enforces the cause CHECK constraint", () => {
		ensureSchema(db);
		db.run(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
		runMigrations(db);

		expect(() =>
			db.run(
				`INSERT INTO ${TABLE} (id, account_id, account_name, trigger, cause, idempotency_key, status, created_at)
				 VALUES ('x', 'a', 'A', 'auto', 'not-a-cause', 'k', 'pending', 0)`,
			),
		).toThrow();
		// Valid causes and NULL are accepted.
		db.run(
			`INSERT INTO ${TABLE} (id, account_id, account_name, trigger, cause, idempotency_key, status, created_at)
			 VALUES ('y', 'a', 'A', 'auto', 'weekly-limit', 'k2', 'pending', 0)`,
		);
		db.run(
			`INSERT INTO ${TABLE} (id, account_id, account_name, trigger, cause, idempotency_key, status, created_at)
			 VALUES ('z', 'a', 'A', 'manual', NULL, 'k3', 'pending', 0)`,
		);
	});

	it("runMigrations() is idempotent when the column already exists", () => {
		ensureSchema(db);
		runMigrations(db);
		expect(() => runMigrations(db)).not.toThrow();
		expect(columnNames(db, TABLE).has(COLUMN)).toBe(true);
	});
});
