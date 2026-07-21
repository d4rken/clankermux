/**
 * Tests for AccountRepository per-account free-text notes.
 *
 * Verifies that:
 *  - setNotes(id, "text")  persists the note, surfaced via findById().notes
 *  - setNotes(id, null)    clears the note back to NULL
 *  - findAll() also surfaces notes
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");

	// Minimal schema — the columns AccountRepository's SELECTs touch, plus notes.
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
			rate_limited_until INTEGER,
			rate_limited_reason TEXT,
			rate_limited_at INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			priority INTEGER DEFAULT 0,
			auto_fallback_enabled INTEGER DEFAULT 0,
			auto_refresh_enabled INTEGER DEFAULT 0,
			auto_pause_on_overage_enabled INTEGER DEFAULT 0,
			peak_hours_pause_enabled INTEGER DEFAULT 0,
			codex_auto_apply_reset_credits_enabled INTEGER NOT NULL DEFAULT 0,
			codex_auto_apply_reset_on_weekly_limit_enabled INTEGER NOT NULL DEFAULT 0,
			custom_endpoint TEXT,
			model_mappings TEXT,
			cross_region_mode TEXT,
			model_fallbacks TEXT,
			billing_type TEXT,
			pause_reason TEXT,
			refresh_token_issued_at INTEGER,
			consecutive_rate_limits INTEGER DEFAULT 0,
			notes TEXT,
			renewal_anchor TEXT,
			renewal_cadence TEXT,
			renewal_price_usd_micros INTEGER,
			renewal_auto_start_date TEXT,
			identity_external_id TEXT,
			identity_email TEXT,
			identity_organization_name TEXT,
			identity_plan_tier TEXT,
			identity_captured_at INTEGER,
			identity_profile_fetched_at INTEGER
		)
	`);

	const adapter = new BunSqlAdapter(db);
	const repo = new AccountRepository(adapter);
	return { db, repo };
}

function insertAccount(db: Database, id: string): void {
	db.run(`INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)`, [
		id,
		id,
		Date.now(),
	]);
}

describe("AccountRepository — notes", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("defaults to null for a freshly inserted account", async () => {
		insertAccount(db, "acc-1");

		const account = await repo.findById("acc-1");
		expect(account).not.toBeNull();
		expect(account?.notes).toBeNull();
	});

	it("setNotes persists a value and findById round-trips it", async () => {
		insertAccount(db, "acc-2");

		await repo.setNotes("acc-2", "primary work account — do not pause");

		const account = await repo.findById("acc-2");
		expect(account?.notes).toBe("primary work account — do not pause");
	});

	it("setNotes(null) clears a previously set value", async () => {
		insertAccount(db, "acc-3");

		await repo.setNotes("acc-3", "temporary note");
		expect((await repo.findById("acc-3"))?.notes).toBe("temporary note");

		await repo.setNotes("acc-3", null);
		expect((await repo.findById("acc-3"))?.notes).toBeNull();
	});

	it("findAll surfaces notes", async () => {
		insertAccount(db, "acc-4");
		await repo.setNotes("acc-4", "listed note");

		const all = await repo.findAll();
		const found = all.find((a) => a.id === "acc-4");
		expect(found?.notes).toBe("listed note");
	});
});
