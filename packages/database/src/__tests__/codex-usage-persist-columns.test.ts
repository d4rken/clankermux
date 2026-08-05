/**
 * Tests for accounts.codex_usage_json / accounts.codex_usage_observed_at — the
 * persisted Codex usage snapshot the dashboard falls back to after a restart or
 * a cache eviction.
 *
 * Covers BOTH halves of the mandatory two-step migration rule:
 *   1. ensureSchema() includes the columns for fresh installs.
 *   2. runMigrations()'s ADDITIVE_COLUMNS adds them to a pre-existing live DB.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";

const COLUMNS = ["codex_usage_json", "codex_usage_observed_at"] as const;

function columnNames(db: Database, table: string): Set<string> {
	return new Set(
		(
			db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
			}>
		).map((c) => c.name),
	);
}

describe("accounts codex usage persistence columns", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("ensureSchema() creates both columns on a fresh DB", () => {
		ensureSchema(db);
		const cols = columnNames(db, "accounts");
		for (const col of COLUMNS) {
			expect(cols.has(col)).toBe(true);
		}
	});

	it("runMigrations() adds both columns to an existing DB that lacks them", () => {
		ensureSchema(db);
		for (const col of COLUMNS) {
			db.run(`ALTER TABLE accounts DROP COLUMN ${col}`);
		}
		const before = columnNames(db, "accounts");
		for (const col of COLUMNS) {
			expect(before.has(col)).toBe(false);
		}

		runMigrations(db);

		const after = columnNames(db, "accounts");
		for (const col of COLUMNS) {
			expect(after.has(col)).toBe(true);
		}
	});

	it("runMigrations() is idempotent when the columns already exist", () => {
		ensureSchema(db);
		runMigrations(db);
		expect(() => runMigrations(db)).not.toThrow();
		const cols = columnNames(db, "accounts");
		for (const col of COLUMNS) {
			expect(cols.has(col)).toBe(true);
		}
	});
});
