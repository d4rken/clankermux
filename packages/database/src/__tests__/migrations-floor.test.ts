/**
 * Upgrading a REAL floor database — the oldest schema `runMigrations()` still
 * supports (see schema-floor.fixture.ts for what "floor" means and how the
 * fixture was measured).
 *
 * The starting point is the fixture verbatim: historical indexes, the two inert
 * leftover tables, and the retired columns all present, exactly as someone's
 * on-disk database has them. Nothing is cleaned up first, because nothing
 * cleans them up in production either.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { createFloorDatabase } from "./schema-floor.fixture";

interface ColumnShape {
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

/**
 * Columns whose DEFAULT legitimately differs between a fresh install and a
 * migrated database, with the reason. Pinned, and asserted by EQUALITY rather
 * than as an upper bound — a new divergence must fail this test rather than be
 * absorbed by it.
 *
 * accounts.auto_pause_on_overage_enabled: the floor (and the live production
 * database) has DEFAULT 0; c20d32c3 changed it to DEFAULT 1 inside the CREATE
 * TABLE, which reaches fresh installs only. `ALTER TABLE ADD COLUMN` cannot
 * alter an existing column's default and table rebuilds are out of scope, so no
 * migration can ever repair this. It is defused instead of repaired: every
 * production `INSERT INTO accounts` names the column explicitly and passes 1,
 * so the table default is not load-bearing, and a one-shot backfill
 * (backfills.ts) lifts the pre-existing rows once.
 */
const KNOWN_DEFAULT_DIVERGENCES = new Set([
	"accounts.auto_pause_on_overage_enabled",
]);

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

/**
 * Index definitions keyed by normalized SQL, not by name. `CREATE INDEX IF NOT
 * EXISTS` is a no-op against a same-named index with a STALE definition, so
 * comparing names would pass while the migrated database served queries from a
 * different index than a fresh one. Auto-indexes (UNIQUE/PRIMARY KEY, sql NULL)
 * are excluded — they are implied by the table definition.
 */
function indexDefinitions(db: Database): Set<string> {
	const rows = db
		.prepare(
			`SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`,
		)
		.all() as Array<{ sql: string }>;
	return new Set(rows.map((r) => r.sql.replace(/\s+/g, " ").trim()));
}

/**
 * Rows in the tables a NOT NULL ALTER can trip over. Seeded BEFORE migrating on
 * purpose: `ALTER TABLE t ADD COLUMN c INTEGER NOT NULL` succeeds on an empty
 * table and fails once a row exists, so an entry that lost its DEFAULT would
 * pass against an empty fixture and break every real upgrade.
 */
function seedFloorRows(db: Database): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)`,
		["acct-1", "seeded-account", "anthropic", 1_700_000_000_000],
	);
	db.run(
		`INSERT INTO oauth_sessions (id, account_name, verifier, mode, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			"sess-1",
			"seeded-account",
			"verifier",
			"claude-oauth",
			1_700_000_000_000,
			1_700_000_600_000,
		],
	);
	db.run(
		`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		["key-1", "seeded-key", "sha256$abc", "abcdefgh", 1_700_000_000_000],
	);
	db.run(
		`INSERT INTO requests (id, timestamp, method, path) VALUES (?, ?, ?, ?)`,
		["req-1", 1_700_000_000_000, "POST", "/v1/messages"],
	);
}

describe("runMigrations() on a floor database", () => {
	let floor: Database | undefined;
	let fresh: Database | undefined;

	afterEach(() => {
		floor?.close();
		fresh?.close();
		floor = undefined;
		fresh = undefined;
	});

	function upgradeFloor(): { floor: Database; fresh: Database } {
		floor = createFloorDatabase();
		seedFloorRows(floor);
		runMigrations(floor);
		fresh = new Database(":memory:");
		ensureSchema(fresh);
		return { floor, fresh };
	}

	it("does not throw on a populated floor database", () => {
		const db = createFloorDatabase();
		floor = db;
		seedFloorRows(db);
		expect(() => runMigrations(db)).not.toThrow();
	});

	it("produces every table a fresh install has", () => {
		const { floor: migrated, fresh: reference } = upgradeFloor();
		const migratedTables = new Set(tableNames(migrated));
		for (const table of tableNames(reference)) {
			expect(migratedTables.has(table)).toBe(true);
		}
	});

	it("produces every column a fresh install has, with the same shape", () => {
		const { floor: migrated, fresh: reference } = upgradeFloor();
		const missing: string[] = [];
		const mismatched: string[] = [];
		const defaultDivergences: string[] = [];

		for (const table of tableNames(reference)) {
			const expected = columnShapes(reference, table);
			const actual = columnShapes(migrated, table);

			for (const [column, want] of expected) {
				const got = actual.get(column);
				if (!got) {
					missing.push(`${table}.${column}`);
					continue;
				}

				// type / notnull / pk are strict for every column, no exceptions.
				if (
					got.type !== want.type ||
					got.notnull !== want.notnull ||
					got.pk !== want.pk
				) {
					mismatched.push(
						`${table}.${column}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
					);
				}

				if (got.dflt_value !== want.dflt_value) {
					defaultDivergences.push(`${table}.${column}`);
				}
			}
		}

		expect(missing).toEqual([]);
		expect(mismatched).toEqual([]);
		// EQUALITY, not containment: an unexpected default divergence fails, and
		// so does a pinned one that has silently been fixed or removed.
		expect(new Set(defaultDivergences)).toEqual(KNOWN_DEFAULT_DIVERGENCES);
	});

	it("keeps the floor-only leftovers rather than dropping them", () => {
		const { floor: migrated } = upgradeFloor();
		const tables = new Set(tableNames(migrated));
		expect(tables.has("agent_preferences")).toBe(true);
		expect(tables.has("model_translations")).toBe(true);
		expect(columnShapes(migrated, "accounts").has("cross_region_mode")).toBe(
			true,
		);
		expect(columnShapes(migrated, "requests").has("agent_used")).toBe(true);
	});

	it("gives pre-existing rows the intended defaults for the restored columns", () => {
		const { floor: migrated } = upgradeFloor();

		const account = migrated
			.prepare(
				`SELECT consecutive_rate_limits, notes, renewal_anchor, renewal_cadence
				 FROM accounts WHERE id = ?`,
			)
			.get("acct-1") as {
			consecutive_rate_limits: number;
			notes: string | null;
			renewal_anchor: string | null;
			renewal_cadence: string | null;
		};
		expect(account.consecutive_rate_limits).toBe(0);
		expect(account.notes).toBeNull();
		expect(account.renewal_anchor).toBeNull();
		expect(account.renewal_cadence).toBeNull();

		const session = migrated
			.prepare(`SELECT priority FROM oauth_sessions WHERE id = ?`)
			.get("sess-1") as { priority: number };
		expect(session.priority).toBe(0);

		const key = migrated
			.prepare(
				`SELECT pinned_account_id, pinned_providers FROM api_keys WHERE id = ?`,
			)
			.get("key-1") as {
			pinned_account_id: string | null;
			pinned_providers: string | null;
		};
		expect(key.pinned_account_id).toBeNull();
		expect(key.pinned_providers).toBeNull();
	});

	it("produces every index a fresh install has, compared by definition", () => {
		const { floor: migrated, fresh: reference } = upgradeFloor();
		const migratedIndexes = indexDefinitions(migrated);
		const missing = [...indexDefinitions(reference)].filter(
			(definition) => !migratedIndexes.has(definition),
		);
		expect(missing).toEqual([]);
	});
});
