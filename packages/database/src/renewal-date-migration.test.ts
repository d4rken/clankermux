/**
 * Tests for the renewal-date migration.
 *
 * runMigrations() adds two nullable TEXT columns to the accounts table:
 *  - renewal_anchor  — original subscription renewal anchor date (YYYY-MM-DD); NULL = off
 *  - renewal_cadence — 'monthly' | 'yearly' | 'none'; NULL when no anchor
 *
 * No backfill — both columns default to NULL on existing rows.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "./migrations";

function makePreMigrationDb(): Database {
	const db = new Database(":memory:");

	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT DEFAULT '',
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			priority INTEGER DEFAULT 0,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			auto_fallback_enabled INTEGER DEFAULT 0,
			auto_refresh_enabled INTEGER DEFAULT 0,
			auto_pause_on_overage_enabled INTEGER DEFAULT 0,
			custom_endpoint TEXT,
			model_mappings TEXT,
			cross_region_mode TEXT,
			model_fallbacks TEXT,
			billing_type TEXT
		)
	`);

	return db;
}

interface RenewalRow {
	id: string;
	renewal_anchor: string | null;
	renewal_cadence: string | null;
}

function getAccount(db: Database, id: string): RenewalRow {
	return db
		.query<RenewalRow, [string]>(
			"SELECT id, renewal_anchor, renewal_cadence FROM accounts WHERE id = ?",
		)
		.get(id) as RenewalRow;
}

function columnNames(db: Database): string[] {
	const cols = db.prepare("PRAGMA table_info(accounts)").all() as Array<{
		name: string;
	}>;
	return cols.map((c) => c.name);
}

describe("Database migration — renewal_anchor / renewal_cadence", () => {
	let db: Database;

	beforeEach(() => {
		db = makePreMigrationDb();
	});

	afterEach(() => {
		db.close();
	});

	it("adds the renewal_anchor and renewal_cadence columns during migration", () => {
		runMigrations(db);

		const names = columnNames(db);
		expect(names).toContain("renewal_anchor");
		expect(names).toContain("renewal_cadence");
	});

	it("defaults both columns to NULL for existing accounts (no backfill)", () => {
		db.run(`
			INSERT INTO accounts (id, name, created_at)
			VALUES ('acc-1', 'acc-1', ${Date.now()})
		`);

		runMigrations(db);

		const row = getAccount(db, "acc-1");
		expect(row.renewal_anchor).toBeNull();
		expect(row.renewal_cadence).toBeNull();
	});

	it("is idempotent — running migrations twice does not throw", () => {
		runMigrations(db);
		expect(() => runMigrations(db)).not.toThrow();

		const names = columnNames(db);
		expect(names).toContain("renewal_anchor");
		expect(names).toContain("renewal_cadence");
	});

	it("round-trips written values through the new columns", () => {
		db.run(`
			INSERT INTO accounts (id, name, created_at)
			VALUES ('acc-2', 'acc-2', ${Date.now()})
		`);

		runMigrations(db);

		db.run(
			"UPDATE accounts SET renewal_anchor = ?, renewal_cadence = ? WHERE id = ?",
			["2026-01-14", "monthly", "acc-2"],
		);

		const row = getAccount(db, "acc-2");
		expect(row.renewal_anchor).toBe("2026-01-14");
		expect(row.renewal_cadence).toBe("monthly");
	});

	it("allows clearing the renewal back to NULL", () => {
		db.run(`
			INSERT INTO accounts (id, name, created_at)
			VALUES ('acc-3', 'acc-3', ${Date.now()})
		`);

		runMigrations(db);

		db.run(
			"UPDATE accounts SET renewal_anchor = ?, renewal_cadence = ? WHERE id = ?",
			["2026-02-28", "yearly", "acc-3"],
		);
		db.run(
			"UPDATE accounts SET renewal_anchor = NULL, renewal_cadence = NULL WHERE id = ?",
			["acc-3"],
		);

		const row = getAccount(db, "acc-3");
		expect(row.renewal_anchor).toBeNull();
		expect(row.renewal_cadence).toBeNull();
	});
});
