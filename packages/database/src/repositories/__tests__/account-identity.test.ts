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
			refresh_token_expires_at INTEGER,
			consecutive_rate_limits INTEGER DEFAULT 0,
			notes TEXT,
			renewal_anchor TEXT,
			renewal_anchor_source TEXT,
			renewal_cadence TEXT,
			renewal_price_usd_micros INTEGER,
			renewal_auto_start_date TEXT,
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

	// The identity writes append to the tier history in the SAME transaction, so
	// the minimal schema has to carry it. Deliberately not made optional in the
	// repository: a missing table here would be a real migration failure, and
	// swallowing it would hide the loss of the whole series.
	db.run(`
		CREATE TABLE account_tier_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id TEXT NOT NULL,
			observed_at INTEGER NOT NULL,
			plan_tier TEXT,
			rate_limit_tier TEXT,
			source TEXT NOT NULL,
			app_version TEXT
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

describe("AccountRepository — setAccountIdentity (token decode, no profile fetch)", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("writes identity and bumps identity_captured_at WITHOUT stamping identity_profile_fetched_at", async () => {
		insertAccount(db, "acc-1");

		const before = await repo.findById("acc-1");
		expect(before?.identity_captured_at).toBeNull();
		expect(before?.identity_profile_fetched_at).toBeNull();

		await repo.setAccountIdentity("acc-1", {
			externalAccountId: "ext-codex",
			email: "codex@example.com",
			organizationName: null,
			planTier: "team",
			rateLimitTier: null,
		});

		const after = await repo.findById("acc-1");
		expect(after?.identity_external_id).toBe("ext-codex");
		expect(after?.identity_email).toBe("codex@example.com");
		expect(after?.identity_plan_tier).toBe("team");
		// captured_at advances...
		expect(after?.identity_captured_at).not.toBeNull();
		// ...but the profile-fetch gate is left untouched (Codex has no profile fetch).
		expect(after?.identity_profile_fetched_at).toBeNull();
	});

	it("COALESCE-merges: a null field preserves a previously-captured value", async () => {
		insertAccount(db, "acc-2");

		// Seed a prior identity via the token-write path.
		await repo.updateTokens("acc-2", "tok-1", 1_000, "refresh-1", {
			externalAccountId: "ext-keep",
			email: "keep@example.com",
			organizationName: "Keep Org",
			planTier: "pro",
			rateLimitTier: null,
		});

		// A later decode resolves only the plan tier; every other field is null and
		// MUST NOT erase the prior value.
		await repo.setAccountIdentity("acc-2", {
			externalAccountId: null,
			email: null,
			organizationName: null,
			planTier: "team",
			rateLimitTier: null,
		});

		const after = await repo.findById("acc-2");
		expect(after?.identity_external_id).toBe("ext-keep");
		expect(after?.identity_email).toBe("keep@example.com");
		expect(after?.identity_organization_name).toBe("Keep Org");
		expect(after?.identity_plan_tier).toBe("team");
		// Never stamps the profile-fetch gate.
		expect(after?.identity_profile_fetched_at).toBeNull();
	});
});

describe("AccountRepository — updateTokens compare-and-swap (expectedRefreshToken)", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
		db.run(
			`INSERT INTO accounts (id, name, created_at, refresh_token, access_token, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
			["cas-1", "cas-1", Date.now(), "rt-current", "tok-old", 1_000],
		);
	});

	afterEach(() => {
		db.close();
	});

	it("returns false and does NOT change the row when the expected refresh token no longer matches", async () => {
		const applied = await repo.updateTokens(
			"cas-1",
			"tok-stale",
			5_000,
			"rt-stale-new",
			null,
			"rt-EXCHANGED-but-superseded",
		);
		expect(applied).toBe(false);

		const row = await repo.findById("cas-1");
		// Untouched: the concurrent-reauth generation is preserved.
		expect(row?.access_token).toBe("tok-old");
		expect(row?.expires_at).toBe(1_000);
		expect(row?.refresh_token).toBe("rt-current");
	});

	it("returns true and updates the row when the expected refresh token matches", async () => {
		const applied = await repo.updateTokens(
			"cas-1",
			"tok-new",
			9_000,
			"rt-rotated",
			null,
			"rt-current",
		);
		expect(applied).toBe(true);

		const row = await repo.findById("cas-1");
		expect(row?.access_token).toBe("tok-new");
		expect(row?.expires_at).toBe(9_000);
		expect(row?.refresh_token).toBe("rt-rotated");
	});

	it("applies unconditionally (returns true) when no expected refresh token is supplied", async () => {
		const applied = await repo.updateTokens(
			"cas-1",
			"tok-uncond",
			7_000,
			"rt-uncond",
		);
		expect(applied).toBe(true);

		const row = await repo.findById("cas-1");
		expect(row?.access_token).toBe("tok-uncond");
		expect(row?.refresh_token).toBe("rt-uncond");
	});
});

describe("AccountRepository — subscription capture and anchor seeding", () => {
	let db: Database;
	let repo: AccountRepository;

	/** 2026-04-10, local midday so the local calendar day is unambiguous. */
	const SUB_START = new Date(2026, 3, 10, 12, 0).getTime();

	const withSubscription = (
		overrides: Partial<AccountIdentity> = {},
	): AccountIdentity => ({
		externalAccountId: "ext-sub",
		email: null,
		organizationName: null,
		planTier: "max",
		rateLimitTier: null,
		subscriptionStatus: "active",
		subscriptionStartedAt: SUB_START,
		...overrides,
	});

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("stores the subscription status and start", async () => {
		insertAccount(db, "sub-1");
		await repo.setAccountIdentityFromProfile("sub-1", withSubscription());

		const account = await repo.findById("sub-1");
		expect(account?.identity_subscription_status).toBe("active");
		expect(account?.identity_subscription_started_at).toBe(SUB_START);
	});

	it("seeds the renewal anchor from the subscription start, marked derived", async () => {
		insertAccount(db, "sub-2");
		await repo.setAccountIdentityFromProfile("sub-2", withSubscription());

		const account = await repo.findById("sub-2");
		expect(account?.renewal_anchor).toBe("2026-04-10");
		expect(account?.renewal_cadence).toBe("monthly");
		expect(account?.renewal_anchor_source).toBe("derived");
		// A derived date must never feed the payments auto-recorder, which is
		// gated on a price being set.
		expect(account?.renewal_price_usd_micros).toBeNull();
	});

	it("never overwrites an anchor the operator already set", async () => {
		insertAccount(db, "sub-3");
		await repo.setRenewal("sub-3", "2026-01-02", "yearly", null, null);

		await repo.setAccountIdentityFromProfile("sub-3", withSubscription());

		const account = await repo.findById("sub-3");
		expect(account?.renewal_anchor).toBe("2026-01-02");
		expect(account?.renewal_cadence).toBe("yearly");
		expect(account?.renewal_anchor_source).toBe("manual");
	});

	it("never re-seeds an anchor the operator cleared", async () => {
		insertAccount(db, "sub-4");
		await repo.setAccountIdentityFromProfile("sub-4", withSubscription());
		await repo.setRenewal("sub-4", null, null, null, null);

		// Second profile fetch: the cleared state has to survive it, or the
		// seeding is level-triggered and the operator can never turn it off.
		await repo.setAccountIdentityFromProfile("sub-4", withSubscription());

		const account = await repo.findById("sub-4");
		expect(account?.renewal_anchor).toBeNull();
		expect(account?.renewal_anchor_source).toBe("manual");
	});

	it("re-derives the estimate when the subscription start moves", async () => {
		insertAccount(db, "sub-5");
		await repo.setAccountIdentityFromProfile("sub-5", withSubscription());

		// Cancel and re-subscribe on another day of the month. A derived anchor
		// IS the estimate from the start, so once the start moves the stored date
		// is stale by construction and re-deriving overwrites nobody's decision.
		await repo.setAccountIdentityFromProfile(
			"sub-5",
			withSubscription({
				subscriptionStartedAt: new Date(2026, 6, 20, 12, 0).getTime(),
			}),
		);

		const account = await repo.findById("sub-5");
		expect(account?.renewal_anchor).toBe("2026-07-20");
		expect(account?.renewal_anchor_source).toBe("derived");
		// Re-deriving stays as far from the payments auto-recorder as the first
		// seed does: still a guess, still no price.
		expect(account?.renewal_price_usd_micros).toBeNull();
	});

	it("leaves a derived anchor alone when the start is unchanged", async () => {
		insertAccount(db, "sub-5b");
		await repo.setAccountIdentityFromProfile("sub-5b", withSubscription());
		// A marker only a re-run of the seeder would erase: it always stamps the
		// seeded cadence, so a surviving 'yearly' proves it did not write.
		db.run(`UPDATE accounts SET renewal_cadence = 'yearly' WHERE id = ?`, [
			"sub-5b",
		] as never[]);

		await repo.setAccountIdentityFromProfile("sub-5b", withSubscription());

		const account = await repo.findById("sub-5b");
		expect(account?.renewal_anchor).toBe("2026-04-10");
		expect(account?.renewal_cadence).toBe("yearly");
	});

	it("never re-derives a manual anchor, even when the start moves", async () => {
		insertAccount(db, "sub-5c");
		await repo.setRenewal("sub-5c", "2026-01-02", "yearly", null, null);

		await repo.setAccountIdentityFromProfile(
			"sub-5c",
			withSubscription({
				subscriptionStartedAt: new Date(2026, 6, 20, 12, 0).getTime(),
			}),
		);

		const account = await repo.findById("sub-5c");
		expect(account?.renewal_anchor).toBe("2026-01-02");
		expect(account?.renewal_cadence).toBe("yearly");
		expect(account?.renewal_anchor_source).toBe("manual");
	});

	it("re-seeds an account handed back to automatic tracking", async () => {
		insertAccount(db, "sub-5d");
		await repo.setRenewal("sub-5d", "2026-01-02", "yearly", 20_000_000, null);

		await repo.resetRenewalToAutomatic("sub-5d");
		await repo.setAccountIdentityFromProfile("sub-5d", withSubscription());

		const account = await repo.findById("sub-5d");
		expect(account?.renewal_anchor).toBe("2026-04-10");
		expect(account?.renewal_cadence).toBe("monthly");
		expect(account?.renewal_anchor_source).toBe("derived");
		expect(account?.renewal_price_usd_micros).toBeNull();
	});

	it("leaves the anchor untouched when the provider reports no subscription start", async () => {
		insertAccount(db, "sub-6");
		await repo.setAccountIdentityFromProfile(
			"sub-6",
			withSubscription({ subscriptionStartedAt: null }),
		);

		const account = await repo.findById("sub-6");
		expect(account?.renewal_anchor).toBeNull();
		expect(account?.renewal_anchor_source).toBeNull();
		expect(account?.identity_subscription_status).toBe("active");
	});

	it("COALESCE-merges the subscription fields like the rest of the identity", async () => {
		insertAccount(db, "sub-7");
		await repo.setAccountIdentityFromProfile("sub-7", withSubscription());
		// A later capture without the organization block (the token envelope)
		// must not erase what the profile fetch established.
		await repo.setAccountIdentityFromProfile("sub-7", {
			externalAccountId: "ext-sub",
			email: null,
			organizationName: null,
			planTier: null,
			rateLimitTier: null,
		});

		const account = await repo.findById("sub-7");
		expect(account?.identity_subscription_status).toBe("active");
		expect(account?.identity_subscription_started_at).toBe(SUB_START);
	});

	it("records a status change (an expiring subscription is visible)", async () => {
		insertAccount(db, "sub-8");
		await repo.setAccountIdentityFromProfile("sub-8", withSubscription());
		await repo.setAccountIdentityFromProfile(
			"sub-8",
			withSubscription({ subscriptionStatus: "canceled" }),
		);

		const account = await repo.findById("sub-8");
		expect(account?.identity_subscription_status).toBe("canceled");
	});
});
