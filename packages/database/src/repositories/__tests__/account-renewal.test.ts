/**
 * Tests for AccountRepository renewal writes — the operator's date
 * (setRenewal) and the hand-back to automatic tracking
 * (resetRenewalToAutomatic).
 *
 * Verifies that:
 *  - setRenewal(id, anchor, cadence, priceUsdMicros, autoStartDate) writes all four columns
 *  - setRenewal(id, null, null, null, null) clears the renewal
 *  - findById() surfaces the columns as renewal_anchor / renewal_cadence
 *  - resetRenewalToAutomatic(id) nulls all five renewal columns, price included
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as account-pause-reason.test.ts.
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");

	// Minimal schema — only the columns AccountRepository touches, plus renewal_*
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
			refresh_token_expires_at INTEGER,
			renewal_anchor TEXT,
			renewal_anchor_source TEXT,
			renewal_cadence TEXT,
			renewal_price_usd_micros INTEGER,
			renewal_auto_start_date TEXT,
			consecutive_rate_limits INTEGER DEFAULT 0,
			notes TEXT,
			identity_external_id TEXT,
			identity_email TEXT,
			identity_organization_name TEXT,
			identity_plan_tier TEXT,
			identity_rate_limit_tier TEXT,
			identity_subscription_status TEXT,
			identity_subscription_started_at INTEGER,
			identity_subscription_ends_at INTEGER,
			identity_subscription_will_renew INTEGER,
			identity_subscription_grace_ends_at INTEGER,
			identity_subscription_checked_at INTEGER,
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

interface RawRenewal {
	renewal_anchor: string | null;
	renewal_anchor_source: string | null;
	renewal_cadence: string | null;
	renewal_price_usd_micros: number | null;
	renewal_auto_start_date: string | null;
}

function getRaw(db: Database, id: string): RawRenewal {
	return db
		.query<RawRenewal, [string]>(
			"SELECT renewal_anchor, renewal_anchor_source, renewal_cadence, renewal_price_usd_micros, renewal_auto_start_date FROM accounts WHERE id = ?",
		)
		.get(id) as RawRenewal;
}

describe("AccountRepository — setRenewal", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("writes renewal_anchor and renewal_cadence", async () => {
		insertAccount(db, "acc-1");

		await repo.setRenewal(
			"acc-1",
			"2026-01-14",
			"monthly",
			20_000_000,
			"2026-01-14",
		);

		const row = getRaw(db, "acc-1");
		expect(row.renewal_anchor).toBe("2026-01-14");
		expect(row.renewal_cadence).toBe("monthly");
		expect(row.renewal_price_usd_micros).toBe(20_000_000);
		expect(row.renewal_auto_start_date).toBe("2026-01-14");
	});

	it("clears both columns when anchor and cadence are null", async () => {
		insertAccount(db, "acc-2");
		await repo.setRenewal("acc-2", "2026-03-31", "yearly", 100_000_000, null);

		await repo.setRenewal("acc-2", null, null, null, null);

		const row = getRaw(db, "acc-2");
		expect(row.renewal_anchor).toBeNull();
		expect(row.renewal_cadence).toBeNull();
		expect(row.renewal_price_usd_micros).toBeNull();
		expect(row.renewal_auto_start_date).toBeNull();
	});

	it("surfaces the columns through findById()", async () => {
		insertAccount(db, "acc-3");
		await repo.setRenewal("acc-3", "2026-06-09", "none", null, null);

		const account = await repo.findById("acc-3");
		expect(account).not.toBeNull();
		expect(account?.renewal_anchor).toBe("2026-06-09");
		expect(account?.renewal_cadence).toBe("none");
	});

	it("marks the anchor manual, including when the call clears it", async () => {
		insertAccount(db, "acc-4");

		await repo.setRenewal("acc-4", "2026-06-09", "monthly", null, null);
		expect((await repo.findById("acc-4"))?.renewal_anchor_source).toBe(
			"manual",
		);

		await repo.setRenewal("acc-4", null, null, null, null);
		expect((await repo.findById("acc-4"))?.renewal_anchor_source).toBe(
			"manual",
		);
	});
});

describe("AccountRepository — resetRenewalToAutomatic", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("nulls all five renewal columns, price included", async () => {
		insertAccount(db, "auto-1");
		await repo.setRenewal(
			"auto-1",
			"2026-01-14",
			"monthly",
			20_000_000,
			"2026-01-14",
		);

		await repo.resetRenewalToAutomatic("auto-1");

		const row = getRaw(db, "auto-1");
		expect(row.renewal_anchor).toBeNull();
		expect(row.renewal_anchor_source).toBeNull();
		expect(row.renewal_cadence).toBeNull();
		// The price is the safety half: the payments auto-recorder fires on
		// anchor + cadence + price, and the anchor is about to become a guess
		// again. A price left behind would let that guess invent ledger entries.
		expect(row.renewal_price_usd_micros).toBeNull();
		expect(row.renewal_auto_start_date).toBeNull();
	});

	it("hands back an account the operator cleared, not just one with a date", async () => {
		insertAccount(db, "auto-2");
		await repo.setRenewal("auto-2", null, null, null, null);
		expect(getRaw(db, "auto-2").renewal_anchor_source).toBe("manual");

		await repo.resetRenewalToAutomatic("auto-2");

		expect(getRaw(db, "auto-2").renewal_anchor_source).toBeNull();
	});

	it("touches only the named account", async () => {
		insertAccount(db, "auto-3");
		insertAccount(db, "auto-4");
		await repo.setRenewal("auto-3", "2026-01-14", "monthly", null, null);
		await repo.setRenewal("auto-4", "2026-02-20", "yearly", null, null);

		await repo.resetRenewalToAutomatic("auto-3");

		const other = getRaw(db, "auto-4");
		expect(other.renewal_anchor).toBe("2026-02-20");
		expect(other.renewal_anchor_source).toBe("manual");
	});
});
