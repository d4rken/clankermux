/**
 * Tests for AccountRepository account-profile identity persistence via
 * updateTokens(..., identity).
 *
 * Verifies the COALESCE-merge contract: identity arrives piecemeal, so a null
 * field in a later write must NEVER erase a previously-captured value, while a
 * newly-provided non-null field IS written. identity_captured_at advances on
 * every write that carries identity, and identity_profile_fetched_at is never
 * touched by this token-write path (it belongs to the profile-fetch paths).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
import "@clankermux/core";
import type { AccountIdentity } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");

	// Minimal schema — the columns AccountRepository's SELECTs touch, plus the
	// six identity columns.
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

describe("AccountRepository — identity persistence (updateTokens)", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("writes a full identity and findById round-trips every field", async () => {
		insertAccount(db, "acc-1");

		const identity: AccountIdentity = {
			externalAccountId: "ext-123",
			email: "user@example.com",
			organizationName: "Acme Inc",
			planTier: "max",
			rateLimitTier: "20x",
		};
		await repo.updateTokens("acc-1", "tok-1", 1_000, "refresh-1", identity);

		const account = await repo.findById("acc-1");
		expect(account?.identity_external_id).toBe("ext-123");
		expect(account?.identity_email).toBe("user@example.com");
		expect(account?.identity_organization_name).toBe("Acme Inc");
		expect(account?.identity_plan_tier).toBe("max");
		expect(account?.identity_rate_limit_tier).toBe("20x");
		expect(account?.identity_captured_at).not.toBeNull();
		// Token-write path must not stamp the profile-fetch timestamp.
		expect(account?.identity_profile_fetched_at).toBeNull();
	});

	it("COALESCE-merges: a null field does not erase a prior value, a new field updates, captured_at advances", async () => {
		insertAccount(db, "acc-2");

		// First: full capture.
		await repo.updateTokens("acc-2", "tok-1", 1_000, "refresh-1", {
			externalAccountId: "ext-abc",
			email: "keep@example.com",
			organizationName: "Org One",
			planTier: "pro",
			rateLimitTier: "20x",
		});
		const first = await repo.findById("acc-2");
		const firstCapturedAt = first?.identity_captured_at ?? 0;
		expect(firstCapturedAt).toBeGreaterThan(0);

		// Ensure a measurable clock delta for the monotonic assertion.
		await new Promise((r) => setTimeout(r, 5));

		// Second: email arrives null (e.g. Codex refresh without id_token), but a
		// new plan tier is provided. rateLimitTier arrives null (envelope refresh
		// lacks it) and MUST NOT erase the profile-captured "20x".
		await repo.updateTokens("acc-2", "tok-2", 2_000, "refresh-2", {
			externalAccountId: null,
			email: null,
			organizationName: null,
			planTier: "max",
			rateLimitTier: null,
		});

		const second = await repo.findById("acc-2");
		// Nulls preserved the prior values...
		expect(second?.identity_email).toBe("keep@example.com");
		expect(second?.identity_external_id).toBe("ext-abc");
		expect(second?.identity_organization_name).toBe("Org One");
		// ...including the rate-limit tier the null write must not have clobbered.
		expect(second?.identity_rate_limit_tier).toBe("20x");
		// ...but the newly-provided plan tier was updated.
		expect(second?.identity_plan_tier).toBe("max");
		// captured_at advanced (monotonic non-decrease).
		expect(second?.identity_captured_at ?? 0).toBeGreaterThanOrEqual(
			firstCapturedAt,
		);
		// Tokens updated alongside identity.
		expect(second?.access_token).toBe("tok-2");
		expect(second?.refresh_token).toBe("refresh-2");
	});

	it("leaves identity columns untouched when no identity is passed", async () => {
		insertAccount(db, "acc-3");

		await repo.updateTokens("acc-3", "tok-1", 1_000, "refresh-1", {
			externalAccountId: "ext-xyz",
			email: "a@b.com",
			organizationName: null,
			planTier: null,
			rateLimitTier: null,
		});
		const before = await repo.findById("acc-3");

		// A token refresh with no identity arg must not disturb captured identity.
		await repo.updateTokens("acc-3", "tok-2", 2_000, "refresh-2");

		const after = await repo.findById("acc-3");
		expect(after?.identity_external_id).toBe("ext-xyz");
		expect(after?.identity_email).toBe("a@b.com");
		expect(after?.identity_captured_at).toBe(
			before?.identity_captured_at ?? null,
		);
		expect(after?.access_token).toBe("tok-2");
	});

	it("also applies identity on the no-refresh-token UPDATE branch", async () => {
		insertAccount(db, "acc-4");

		// No refreshToken → the second UPDATE branch; identity must still merge.
		await repo.updateTokens("acc-4", "tok-1", 1_000, undefined, {
			externalAccountId: "ext-nr",
			email: "nr@example.com",
			organizationName: null,
			planTier: null,
			rateLimitTier: null,
		});

		const account = await repo.findById("acc-4");
		expect(account?.identity_external_id).toBe("ext-nr");
		expect(account?.identity_email).toBe("nr@example.com");
		expect(account?.identity_captured_at).not.toBeNull();
	});
});

describe("AccountRepository — setAccountIdentityFromProfile", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("stamps identity_profile_fetched_at (the one-time-backfill gate)", async () => {
		insertAccount(db, "acc-1");

		const before = await repo.findById("acc-1");
		expect(before?.identity_profile_fetched_at).toBeNull();

		await repo.setAccountIdentityFromProfile("acc-1", {
			externalAccountId: "ext-1",
			email: "p@example.com",
			organizationName: "Org",
			planTier: "max",
			rateLimitTier: "5x",
		});

		const after = await repo.findById("acc-1");
		expect(after?.identity_external_id).toBe("ext-1");
		expect(after?.identity_email).toBe("p@example.com");
		expect(after?.identity_organization_name).toBe("Org");
		expect(after?.identity_plan_tier).toBe("max");
		expect(after?.identity_rate_limit_tier).toBe("5x");
		// Both timestamps advance — this is the profile-fetch write path.
		expect(after?.identity_captured_at).not.toBeNull();
		expect(after?.identity_profile_fetched_at).not.toBeNull();
	});

	it("COALESCE-merges: a null field preserves a previously-captured value", async () => {
		insertAccount(db, "acc-2");

		// Seed a prior identity (e.g. from a token-write path).
		await repo.updateTokens("acc-2", "tok-1", 1_000, "refresh-1", {
			externalAccountId: "ext-keep",
			email: "keep@example.com",
			organizationName: "Keep Org",
			planTier: "pro",
			rateLimitTier: "20x",
		});

		// A later profile fetch resolves only the plan tier; every other field is
		// null and MUST NOT erase the prior value (including the rate-limit tier).
		await repo.setAccountIdentityFromProfile("acc-2", {
			externalAccountId: null,
			email: null,
			organizationName: null,
			planTier: "max",
			rateLimitTier: null,
		});

		const after = await repo.findById("acc-2");
		expect(after?.identity_external_id).toBe("ext-keep");
		expect(after?.identity_email).toBe("keep@example.com");
		expect(after?.identity_organization_name).toBe("Keep Org");
		expect(after?.identity_plan_tier).toBe("max");
		expect(after?.identity_rate_limit_tier).toBe("20x");
		expect(after?.identity_profile_fetched_at).not.toBeNull();
	});
});
