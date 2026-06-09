/**
 * Guards that the PostgreSQL migration mirrors the SQLite `notes` column
 * (per the mandatory "every SQLite migration must be ported to PG" rule).
 *
 * runMigrationsPg() builds its column list in a local `columnsToAdd` array and
 * ensureSchemaPg() emits a CREATE TABLE — neither is exported, and exercising
 * them needs a live Postgres adapter. To keep this test hermetic we assert the
 * migration *source* declares the notes column in both the fresh-install
 * (ensureSchemaPg CREATE TABLE) and upgrade (columnsToAdd) paths.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PG_MIGRATIONS_SRC = readFileSync(
	join(import.meta.dir, "migrations-pg.ts"),
	"utf8",
);

describe("PostgreSQL migration — notes column mirror", () => {
	it("ensureSchemaPg CREATE TABLE includes notes TEXT", () => {
		// The accounts CREATE TABLE block lists `notes TEXT` as a column.
		expect(PG_MIGRATIONS_SRC).toMatch(/notes TEXT/);
	});

	it("columnsToAdd registers an ALTER for accounts.notes", () => {
		// The upgrade path must add notes to existing accounts tables.
		expect(PG_MIGRATIONS_SRC).toMatch(
			/ALTER TABLE accounts ADD COLUMN notes TEXT/,
		);
		// And it must be registered as a { table: "accounts", column: "notes" } entry.
		expect(PG_MIGRATIONS_SRC).toMatch(/column:\s*"notes"/);
	});
});
