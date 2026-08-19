/**
 * Tests for `AccountRepository.updateTokens(..., { refreshTokenExpiresAt })`.
 *
 * The deadline describes ONE specific refresh token, so the write moves with
 * that token:
 *   - a reported deadline always wins, rotation or not — it is what the
 *     provider just said about the token it just issued;
 *   - with none reported, an ECHOED token keeps its stored deadline (Qwen
 *     echoes on every refresh and Anthropic does whenever its response omits
 *     `refresh_token`, so this is the common path, not an edge case);
 *   - with none reported and the token ROTATED, the stored deadline is
 *     cleared: it described a credential that is now dead upstream.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

function makeDb(): { db: Database; repo: AccountRepository } {
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
			model_fallbacks TEXT,
			billing_type TEXT,
			pause_reason TEXT,
			refresh_token_issued_at INTEGER,
			refresh_token_expires_at INTEGER,
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
			identity_rate_limit_tier TEXT,
			identity_captured_at INTEGER,
			identity_profile_fetched_at INTEGER
		)
	`);
	const repo = new AccountRepository(new BunSqlAdapter(db));
	return { db, repo };
}

function insertAccount(db: Database, id: string, refreshToken: string): void {
	db.run(
		`INSERT INTO accounts (id, name, created_at, refresh_token) VALUES (?, ?, ?, ?)`,
		[id, id, Date.now(), refreshToken],
	);
}

describe("AccountRepository — refresh-token deadline persistence", () => {
	let db: Database;
	let repo: AccountRepository;
	let deadline: number;

	beforeEach(() => {
		({ db, repo } = makeDb());
		deadline = Date.now() + NINETY_DAYS;
	});

	afterEach(() => {
		db.close();
	});

	it("stores the deadline alongside a rotated refresh token", async () => {
		insertAccount(db, "acc-1", "rt-old");

		await repo.updateTokens("acc-1", "at-1", 1_000, "rt-new", null, null, {
			refreshTokenExpiresAt: deadline,
		});

		const account = await repo.findById("acc-1");
		expect(account?.refresh_token).toBe("rt-new");
		expect(account?.refresh_token_expires_at).toBe(deadline);
	});

	it("stores a reported deadline even when the token is unchanged", async () => {
		// The provider is the authority on the token it just issued. If it reports
		// a deadline while echoing the same token value back, that date has to
		// land — gating the write on rotation alone would silently discard it.
		insertAccount(db, "acc-1", "rt-same");

		await repo.updateTokens("acc-1", "at-1", 1_000, "rt-same", null, null, {
			refreshTokenExpiresAt: deadline,
		});

		const account = await repo.findById("acc-1");
		expect(account?.refresh_token_expires_at).toBe(deadline);
	});

	it("keeps the stored deadline when the refresh echoes the same token", async () => {
		insertAccount(db, "acc-1", "rt-same");
		await repo.updateTokens("acc-1", "at-1", 1_000, "rt-same", null, null, {
			refreshTokenExpiresAt: deadline,
		});

		// A later refresh returns no new refresh token, so callers pass null. The
		// credential is unchanged, so erasing its known deadline would be a lie.
		await repo.updateTokens("acc-1", "at-2", 2_000, "rt-same", null, null, {
			refreshTokenExpiresAt: null,
		});

		const account = await repo.findById("acc-1");
		expect(account?.access_token).toBe("at-2");
		expect(account?.refresh_token_expires_at).toBe(deadline);
	});

	it("clears the deadline when a rotation reports none", async () => {
		insertAccount(db, "acc-1", "rt-old");
		await repo.updateTokens("acc-1", "at-1", 1_000, "rt-old", null, null, {
			refreshTokenExpiresAt: deadline,
		});

		await repo.updateTokens("acc-1", "at-2", 2_000, "rt-new", null, null, {
			refreshTokenExpiresAt: null,
		});

		const account = await repo.findById("acc-1");
		expect(account?.refresh_token).toBe("rt-new");
		// The old date belonged to rt-old, which is dead upstream. Carrying it
		// forward would advertise a deadline for a credential that is gone.
		expect(account?.refresh_token_expires_at).toBeNull();
	});

	it("leaves the deadline untouched when the compare-and-swap misses", async () => {
		insertAccount(db, "acc-1", "rt-current");
		await repo.updateTokens("acc-1", "at-1", 1_000, "rt-current", null, null, {
			refreshTokenExpiresAt: deadline,
		});

		// A delayed write anchored on a generation the row has moved past: it must
		// not land, and must not drag its deadline in either.
		const persisted = await repo.updateTokens(
			"acc-1",
			"at-stale",
			9_000,
			"rt-stale",
			null,
			"rt-someone-else",
			{ refreshTokenExpiresAt: deadline + 5_000 },
		);

		expect(persisted).toBe(false);
		const account = await repo.findById("acc-1");
		expect(account?.refresh_token).toBe("rt-current");
		expect(account?.refresh_token_expires_at).toBe(deadline);
	});

	it("does not touch the deadline on an access-token-only write", async () => {
		insertAccount(db, "acc-1", "rt-current");
		await repo.updateTokens("acc-1", "at-1", 1_000, "rt-current", null, null, {
			refreshTokenExpiresAt: deadline,
		});

		// No refresh token argument at all — the API-key/console path.
		await repo.updateTokens("acc-1", "at-2", 2_000);

		const account = await repo.findById("acc-1");
		expect(account?.refresh_token_expires_at).toBe(deadline);
	});
});
