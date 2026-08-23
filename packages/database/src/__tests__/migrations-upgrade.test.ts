/**
 * Synthetic downgrade round-trip: take a fresh, complete database, strip every
 * column `ADDITIVE_COLUMNS` claims to be able to add, and prove
 * `runMigrations()` puts the schema back exactly as it was.
 *
 * This complements migrations-floor.test.ts, which upgrades the real historical
 * floor. The floor already HAS most of the additive columns, so it exercises
 * only the entries that postdate it; this covers all of them, including the
 * DDL's types, NOT NULL/DEFAULT clauses and CHECK constraints.
 *
 * What it deliberately does NOT detect: a column added to a CREATE TABLE with
 * no ADDITIVE_COLUMNS entry. It only drops what the list already names, so an
 * omitted entry means an un-dropped column and the round-trip still passes.
 * schema-invariant.test.ts is what catches that.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { ADDITIVE_COLUMNS, ensureSchema, runMigrations } from "../migrations";

interface ColumnShape {
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

function columnShapes(db: Database, table: string): Map<string, ColumnShape> {
	const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<
		{ name: string } & ColumnShape
	>;
	return new Map(
		rows.map((r) => [
			r.name,
			{ type: r.type, notnull: r.notnull, dflt_value: r.dflt_value, pk: r.pk },
		]),
	);
}

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

/** Named (non-auto) indexes, keyed by name, valued by normalized definition. */
function indexDefinitions(db: Database): Map<string, string> {
	const rows = db
		.prepare(
			`SELECT name, sql FROM sqlite_master
			 WHERE type = 'index' AND sql IS NOT NULL`,
		)
		.all() as Array<{ name: string; sql: string }>;
	return new Map(rows.map((r) => [r.name, r.sql.replace(/\s+/g, " ").trim()]));
}

/**
 * One row per table an ADDITIVE_COLUMNS entry touches. Present BEFORE the
 * columns are re-added, so an entry that lost its DEFAULT from a NOT NULL
 * column fails here: `ADD COLUMN … NOT NULL` without a default is legal on an
 * empty table and an error on a populated one, which is what every real upgrade
 * is.
 */
function seedRows(db: Database): void {
	const ts = 1_700_000_000_000;
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)`,
		["acct-1", "seeded-account", "anthropic", ts],
	);
	db.run(
		`INSERT INTO requests (id, timestamp, method, path) VALUES (?, ?, ?, ?)`,
		["req-1", ts, "POST", "/v1/messages"],
	);
	db.run(
		`INSERT INTO request_payloads (id, json, timestamp, bytes) VALUES (?, ?, ?, ?)`,
		["req-1", "{}", ts, 2],
	);
	db.run(
		`INSERT INTO oauth_sessions (id, account_name, verifier, mode, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		["sess-1", "seeded-account", "verifier", "claude-oauth", ts, ts + 600_000],
	);
	db.run(
		`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		["key-1", "seeded-key", "sha256$abc", "abcdefgh", ts],
	);
	db.run(
		`INSERT INTO memory_snapshots (sampled_at, rss_bytes, heap_used_bytes)
		 VALUES (?, ?, ?)`,
		[ts, 1024, 512],
	);
	db.run(
		`INSERT INTO cache_keepalive_snapshots (
			sampled_at, warm_sessions, promoted_sessions, total_bytes, keepalives_sent,
			hits, misses, failures, spent_usd, saved_usd
		) VALUES (?, 1, 0, 0, 0, 0, 0, 0, 0, 0)`,
		[ts],
	);
	db.run(
		`INSERT INTO codex_reset_credit_events (
			id, account_id, account_name, trigger, idempotency_key, status, created_at
		) VALUES (?, ?, ?, 'manual', ?, 'pending', ?)`,
		["evt-1", "acct-1", "seeded-account", "idem-1", ts],
	);
}

describe("runMigrations() restores every ADDITIVE_COLUMNS entry", () => {
	let db: Database | undefined;

	afterEach(() => {
		db?.close();
		db = undefined;
	});

	it("round-trips a stripped schema back to the fresh one", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		seedRows(db);

		const expectedShapes = new Map(
			tableNames(db).map((t) => [t, columnShapes(db as Database, t)]),
		);
		const expectedIndexes = indexDefinitions(db);
		expect(expectedIndexes.size).toBeGreaterThan(0);

		// Indexes first: SQLite refuses to drop a column an index references, and
		// several additive columns are indexed (request_payloads.bytes among
		// them). ensureSchema() recreates all of them on the way back up.
		for (const name of expectedIndexes.keys()) {
			db.run(`DROP INDEX ${name}`);
		}
		expect(indexDefinitions(db).size).toBe(0);

		for (const { table, column } of ADDITIVE_COLUMNS) {
			// Entries are allowed to duplicate a column the CREATE TABLE already
			// has for a table that predates them, so only drop what is there.
			if (!columnShapes(db, table).has(column)) continue;
			db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
		}

		const stripped = ADDITIVE_COLUMNS.filter(
			({ table, column }) => !columnShapes(db as Database, table).has(column),
		);
		expect(stripped.length).toBe(ADDITIVE_COLUMNS.length);

		runMigrations(db);

		const mismatched: string[] = [];
		for (const [table, want] of expectedShapes) {
			const got = columnShapes(db, table);
			for (const [column, wantShape] of want) {
				const gotShape = got.get(column);
				if (
					!gotShape ||
					gotShape.type !== wantShape.type ||
					gotShape.notnull !== wantShape.notnull ||
					gotShape.dflt_value !== wantShape.dflt_value ||
					gotShape.pk !== wantShape.pk
				) {
					mismatched.push(
						`${table}.${column}: ${JSON.stringify(gotShape ?? null)} != ${JSON.stringify(wantShape)}`,
					);
				}
			}
		}
		expect(mismatched).toEqual([]);

		// Compared by definition, not just by name: CREATE INDEX IF NOT EXISTS is
		// a no-op against a same-named index with a stale definition.
		expect([...indexDefinitions(db)].sort()).toEqual(
			[...expectedIndexes].sort(),
		);
	});
});
