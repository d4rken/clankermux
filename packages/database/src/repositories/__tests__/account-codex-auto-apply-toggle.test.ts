/**
 * Regression test: the `codex_auto_apply_reset_credits_enabled` and
 * `codex_auto_apply_reset_on_weekly_limit_enabled` toggles must be projected by
 * AccountRepository's SELECT lists (findAll/findById).
 *
 * If a column is missing from the SELECT, `toAccount()` sees `undefined` and
 * coerces the toggle to false (`!!undefined`), so getAccount()/getAllAccounts()
 * silently report it disabled even when the row has it set — which makes the
 * CodexResetCreditApplyScheduler find no candidates and the feature inert.
 *
 * Goes through the REAL repository SQL against an in-memory SQLite DB.
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

	// Minimal schema — the columns AccountRepository's SELECTs touch, plus the
	// codex auto-apply toggle under test.
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
			renewal_auto_start_date TEXT
		)
	`);

	const adapter = new BunSqlAdapter(db);
	const repo = new AccountRepository(adapter);
	return { db, repo };
}

function insertAccount(db: Database, id: string): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, 'codex', ?)`,
		[id, id, Date.now()],
	);
}

describe("AccountRepository — codex_auto_apply_reset_credits_enabled projection", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("defaults to false for a freshly inserted account", async () => {
		insertAccount(db, "acc-1");

		const account = await repo.findById("acc-1");
		expect(account).not.toBeNull();
		expect(account?.codex_auto_apply_reset_credits_enabled).toBe(false);
		expect(account?.codex_auto_apply_reset_on_weekly_limit_enabled).toBe(false);
	});

	it("findById surfaces the toggle after it is enabled", async () => {
		insertAccount(db, "acc-2");

		// Same UPDATE DatabaseOperations.setCodexAutoApplyResetCreditsEnabled runs.
		db.run(
			`UPDATE accounts SET codex_auto_apply_reset_credits_enabled = 1 WHERE id = ?`,
			["acc-2"],
		);

		const account = await repo.findById("acc-2");
		expect(account?.codex_auto_apply_reset_credits_enabled).toBe(true);
	});

	it("findAll surfaces the toggle after it is enabled", async () => {
		insertAccount(db, "acc-3");
		db.run(
			`UPDATE accounts SET codex_auto_apply_reset_credits_enabled = 1 WHERE id = ?`,
			["acc-3"],
		);

		const all = await repo.findAll();
		const found = all.find((a) => a.id === "acc-3");
		expect(found?.codex_auto_apply_reset_credits_enabled).toBe(true);
	});

	it("findById surfaces the weekly-limit toggle after it is enabled", async () => {
		insertAccount(db, "acc-4");

		// Same UPDATE DatabaseOperations.setCodexAutoApplyResetOnWeeklyLimitEnabled runs.
		db.run(
			`UPDATE accounts SET codex_auto_apply_reset_on_weekly_limit_enabled = 1 WHERE id = ?`,
			["acc-4"],
		);

		const account = await repo.findById("acc-4");
		expect(account?.codex_auto_apply_reset_on_weekly_limit_enabled).toBe(true);
		// Independent toggles — enabling one must not flip the other.
		expect(account?.codex_auto_apply_reset_credits_enabled).toBe(false);
	});

	it("findAll surfaces the weekly-limit toggle after it is enabled", async () => {
		insertAccount(db, "acc-5");
		db.run(
			`UPDATE accounts SET codex_auto_apply_reset_on_weekly_limit_enabled = 1 WHERE id = ?`,
			["acc-5"],
		);

		const all = await repo.findAll();
		const found = all.find((a) => a.id === "acc-5");
		expect(found?.codex_auto_apply_reset_on_weekly_limit_enabled).toBe(true);
	});
});
