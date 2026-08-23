/**
 * The reconstruction invariant: the current schema must be exactly
 *
 *     (what the table shipped with) - (what was deliberately retired)
 *                                   + (what ADDITIVE_COLUMNS adds)
 *
 * for every table, floor-era or post-floor. That is the property that makes a
 * migration COMPLETE — an upgraded database only ever gets a column from its
 * own CREATE TABLE or from an ADDITIVE_COLUMNS entry, so a column present in a
 * fresh install and reachable by neither is missing forever on every existing
 * database.
 *
 * This is the test that catches the mistake the migration floor was lost to: a
 * column added to a CREATE TABLE in ensureSchema() with no matching entry. It
 * fails at the moment the column is added rather than years later on someone
 * else's install, and it covers floor and post-floor tables alike.
 *
 * When it fails, the fix is one of: add the ADDITIVE_COLUMNS entry (nearly
 * always), add a baseline for a new table, or record a deliberate drop in
 * RETIRED_AFTER_FLOOR. Never "refresh" the fixture from the current schema —
 * see the header of schema-floor.fixture.ts.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ADDITIVE_COLUMNS, ensureSchema } from "../migrations";
import {
	createFloorDatabase,
	POST_FLOOR_TABLE_BASELINES,
	RETIRED_AFTER_FLOOR,
} from "./schema-floor.fixture";

function tableNames(db: Database): string[] {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
				 ORDER BY name`,
			)
			.all() as Array<{ name: string }>
	).map((r) => r.name);
}

function columnNames(db: Database, table: string): string[] {
	return (
		db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
	).map((c) => c.name);
}

/** Columns ADDITIVE_COLUMNS can add to `table`. */
function additiveColumns(table: string): string[] {
	return ADDITIVE_COLUMNS.filter((e) => e.table === table).map((e) => e.column);
}

/** Columns retired from `table` since it shipped. */
function retiredColumns(table: string): string[] {
	return RETIRED_AFTER_FLOOR.columns
		.filter((c) => c.table === table)
		.map((c) => c.column);
}

describe("schema reconstruction invariant", () => {
	let fresh: Database;
	let floor: Database;
	let freshTables: string[];
	let floorTables: string[];

	beforeAll(() => {
		fresh = new Database(":memory:");
		ensureSchema(fresh);
		floor = createFloorDatabase();
		freshTables = tableNames(fresh);
		floorTables = tableNames(floor);
	});

	afterAll(() => {
		fresh.close();
		floor.close();
	});

	it("accounts for every table in the current schema", () => {
		// A new table must be declared somewhere, or the per-table column
		// invariant below would silently skip it and the guard would shrink as
		// the schema grows.
		const known = new Set([
			...floorTables,
			...Object.keys(POST_FLOOR_TABLE_BASELINES),
			...RETIRED_AFTER_FLOOR.tables,
		]);
		const unaccounted = freshTables.filter((t) => !known.has(t));
		expect(unaccounted).toEqual([]);
	});

	it("keeps every floor table unless it was deliberately retired", () => {
		const present = new Set(freshTables);
		const retired = new Set<string>(RETIRED_AFTER_FLOOR.tables);
		const vanished = floorTables.filter(
			(t) => !present.has(t) && !retired.has(t),
		);
		expect(vanished).toEqual([]);
	});

	it("reconstructs every table's columns from its baseline plus ADDITIVE_COLUMNS", () => {
		const retiredTables = new Set<string>(RETIRED_AFTER_FLOOR.tables);
		const mismatches: string[] = [];
		let checked = 0;

		const baselines = new Map<string, readonly string[]>();
		for (const table of floorTables) {
			if (retiredTables.has(table)) continue;
			baselines.set(table, columnNames(floor, table));
		}
		for (const [table, baseline] of Object.entries(
			POST_FLOOR_TABLE_BASELINES,
		)) {
			if (retiredTables.has(table)) continue;
			baselines.set(table, baseline.columns);
		}

		for (const [table, baseline] of baselines) {
			const dropped = new Set(retiredColumns(table));
			const expected = new Set(baseline.filter((c) => !dropped.has(c)));
			for (const column of additiveColumns(table)) expected.add(column);

			const actual = new Set(columnNames(fresh, table));
			const missing = [...expected].filter((c) => !actual.has(c));
			const unreachable = [...actual].filter((c) => !expected.has(c));
			if (missing.length || unreachable.length) {
				mismatches.push(
					`${table}: missing=[${missing.join(", ")}] unreachable-on-upgrade=[${unreachable.join(", ")}]`,
				);
			}
			checked++;
		}

		expect(mismatches).toEqual([]);
		// Every current table participated — no silent skip.
		expect(checked).toBe(freshTables.length);
	});

	it("keeps RETIRED_AFTER_FLOOR honest", () => {
		// Each retired column must still exist in its baseline (otherwise the
		// entry is stale and should go) and must be gone from the current schema
		// (otherwise it was quietly re-added and is no longer retired).
		for (const { table, column } of RETIRED_AFTER_FLOOR.columns) {
			const baseline = POST_FLOOR_TABLE_BASELINES[table]?.columns
				? [...POST_FLOOR_TABLE_BASELINES[table].columns]
				: columnNames(floor, table);
			expect(
				`${table}.${column} in baseline: ${baseline.includes(column)}`,
			).toBe(`${table}.${column} in baseline: true`);
			expect(
				`${table}.${column} in current schema: ${columnNames(fresh, table).includes(column)}`,
			).toBe(`${table}.${column} in current schema: false`);
		}

		const floorTableSet = new Set(floorTables);
		const freshTableSet = new Set(freshTables);
		for (const table of RETIRED_AFTER_FLOOR.tables) {
			expect(`${table} in baseline: ${floorTableSet.has(table)}`).toBe(
				`${table} in baseline: true`,
			);
			expect(`${table} in current schema: ${freshTableSet.has(table)}`).toBe(
				`${table} in current schema: false`,
			);
		}
	});

	it("has no orphaned ADDITIVE_COLUMNS entries", () => {
		// An entry naming a column the current schema does not have adds it to
		// upgraded databases only — the exact drift accounts.cross_region_mode
		// was in before it was removed.
		const orphans = ADDITIVE_COLUMNS.filter(({ table, column }) => {
			if (!freshTables.includes(table)) return true;
			return !columnNames(fresh, table).includes(column);
		}).map(({ table, column }) => `${table}.${column}`);
		expect(orphans).toEqual([]);
	});
});
