/**
 * Tests for the requests.reasoning_effort column (per-request reasoning effort:
 * "thinking:<budget>" / "thinking" for Anthropic bodies, the raw effort string
 * for OpenAI Responses bodies, NULL when absent).
 *
 * Covers BOTH halves of the mandatory two-step migration rule:
 *   1. ensureSchema() includes the column for fresh installs.
 *   2. runMigrations()'s ADDITIVE_COLUMNS adds it to a pre-existing live DB
 *      whose requests table predates the column.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";

const COLUMN = "reasoning_effort";

function columnNames(db: Database, table: string): Set<string> {
	return new Set(
		(
			db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
			}>
		).map((c) => c.name),
	);
}

describe("requests.reasoning_effort migration", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("ensureSchema() creates the column on a fresh DB", () => {
		ensureSchema(db);
		expect(columnNames(db, "requests").has(COLUMN)).toBe(true);
	});

	it("runMigrations() adds the column to an existing DB that lacks it", () => {
		// Simulate a live DB created before this column existed: full current
		// schema, then drop just this column (it is not part of any index).
		ensureSchema(db);
		db.run(`ALTER TABLE requests DROP COLUMN ${COLUMN}`);
		expect(columnNames(db, "requests").has(COLUMN)).toBe(false);

		runMigrations(db);
		expect(columnNames(db, "requests").has(COLUMN)).toBe(true);
	});

	it("runMigrations() is idempotent when the column already exists", () => {
		ensureSchema(db);
		runMigrations(db);
		expect(() => runMigrations(db)).not.toThrow();
		expect(columnNames(db, "requests").has(COLUMN)).toBe(true);
	});
});
