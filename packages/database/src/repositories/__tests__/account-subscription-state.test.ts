/**
 * Tests for the provider-reported subscription period:
 * `setAccountSubscriptionState` (the plain-SET column write),
 * `claimAnthropicSubscriptionCheck` (the conditional throttle claim),
 * `syncProviderRenewalAnchor` (the ownership-gated anchor write) and
 * `setAccountIdentityFromProfile`'s access-token compare-and-swap, plus the
 * Anthropic gate on the start-date seeder.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as account-pause-reason.test.ts.
import "@clankermux/core";
import type { AccountIdentity } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

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

	// The identity writes append to the tier history in the SAME transaction.
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
	return { db, repo: new AccountRepository(adapter) };
}

function insertAccount(
	db: Database,
	id: string,
	provider = "anthropic",
	refreshToken = "",
	accessToken: string | null = null,
): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		[id, id, provider, refreshToken, accessToken, Date.now()],
	);
}

/** 2026-09-16 12:00 local — the "now" every relative assertion is measured from. */
const NOW = new Date(2026, 8, 16, 12, 0).getTime();
/** 2026-10-03 12:00 local: a reported period end comfortably in the future. */
const FUTURE_END = new Date(2026, 9, 3, 12, 0).getTime();
/** 2026-08-03 12:00 local: a reported period end already elapsed. */
const PAST_END = new Date(2026, 7, 3, 12, 0).getTime();

describe("AccountRepository — setAccountSubscriptionState", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});
	afterEach(() => {
		db.close();
	});

	it("writes all four columns", async () => {
		insertAccount(db, "sub-a", "codex");

		await repo.setAccountSubscriptionState("sub-a", {
			endsAtMs: FUTURE_END,
			willRenew: true,
			graceEndsAtMs: FUTURE_END + 86_400_000,
			checkedAtMs: NOW,
		});

		const account = await repo.findById("sub-a");
		expect(account?.identity_subscription_ends_at).toBe(FUTURE_END);
		expect(account?.identity_subscription_will_renew).toBe(1);
		expect(account?.identity_subscription_grace_ends_at).toBe(
			FUTURE_END + 86_400_000,
		);
		expect(account?.identity_subscription_checked_at).toBe(NOW);
	});

	it("distinguishes an unreported renewal intent from a reported false", async () => {
		insertAccount(db, "sub-b", "codex");

		await repo.setAccountSubscriptionState("sub-b", {
			endsAtMs: FUTURE_END,
			willRenew: false,
			graceEndsAtMs: null,
			checkedAtMs: NOW,
		});
		expect(
			(await repo.findById("sub-b"))?.identity_subscription_will_renew,
		).toBe(0);

		await repo.setAccountSubscriptionState("sub-b", {
			endsAtMs: FUTURE_END,
			willRenew: null,
			graceEndsAtMs: null,
			checkedAtMs: NOW,
		});
		expect(
			(await repo.findById("sub-b"))?.identity_subscription_will_renew,
		).toBeNull();
	});

	it("clears a grace period the provider stopped reporting", async () => {
		insertAccount(db, "sub-c", "codex");
		await repo.setAccountSubscriptionState("sub-c", {
			endsAtMs: FUTURE_END,
			willRenew: true,
			graceEndsAtMs: NOW + 3_600_000,
			checkedAtMs: NOW,
		});

		// A COALESCE merge could not do this, and the dashboard would keep showing
		// a grace period that has lapsed.
		await repo.setAccountSubscriptionState("sub-c", {
			endsAtMs: FUTURE_END,
			willRenew: true,
			graceEndsAtMs: null,
			checkedAtMs: NOW + 1,
		});

		const account = await repo.findById("sub-c");
		expect(account?.identity_subscription_grace_ends_at).toBeNull();
		expect(account?.identity_subscription_checked_at).toBe(NOW + 1);
	});

	it("stamps checked_at on an attempt that reported nothing", async () => {
		insertAccount(db, "sub-d", "codex");

		await repo.setAccountSubscriptionState("sub-d", {
			endsAtMs: null,
			willRenew: null,
			graceEndsAtMs: null,
			checkedAtMs: NOW,
		});

		const account = await repo.findById("sub-d");
		expect(account?.identity_subscription_checked_at).toBe(NOW);
		expect(account?.identity_subscription_ends_at).toBeNull();
	});
});

describe("AccountRepository — syncProviderRenewalAnchor", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});
	afterEach(() => {
		db.close();
	});

	const sync = (id: string, endsAtMs: number | null, extra = {}) =>
		repo.syncProviderRenewalAnchor(
			id,
			{ endsAtMs, cadence: null, graceEndsAtMs: null, ...extra },
			NOW,
		);

	it("writes the reported period end on an account with no anchor", async () => {
		insertAccount(db, "anc-1", "codex");

		expect(await sync("anc-1", FUTURE_END, { cadence: "yearly" })).toBe(true);

		const account = await repo.findById("anc-1");
		expect(account?.renewal_anchor).toBe("2026-10-03");
		expect(account?.renewal_cadence).toBe("yearly");
		expect(account?.renewal_anchor_source).toBe("provider");
		// Never a price: the payments auto-recorder is gated on one, so a captured
		// date can't produce a ledger entry on its own.
		expect(account?.renewal_price_usd_micros).toBeNull();
	});

	it("falls back to monthly when the provider reports no period", async () => {
		insertAccount(db, "anc-2", "devin");

		await sync("anc-2", FUTURE_END);

		expect((await repo.findById("anc-2"))?.renewal_cadence).toBe("monthly");
	});

	it("rolls a provider anchor forward on the next capture", async () => {
		insertAccount(db, "anc-3", "codex");
		await sync("anc-3", FUTURE_END);

		const nextCycle = new Date(2026, 10, 3, 12, 0).getTime();
		expect(await sync("anc-3", nextCycle)).toBe(true);

		expect((await repo.findById("anc-3"))?.renewal_anchor).toBe("2026-11-03");
	});

	it("overwrites a derived anchor: an observation replaces a guess", async () => {
		insertAccount(db, "anc-4", "codex");
		db.run(
			`UPDATE accounts SET renewal_anchor = '2026-04-10',
			 renewal_cadence = 'monthly', renewal_anchor_source = 'derived'
			 WHERE id = ?`,
			["anc-4"],
		);

		expect(await sync("anc-4", FUTURE_END)).toBe(true);

		const account = await repo.findById("anc-4");
		expect(account?.renewal_anchor).toBe("2026-10-03");
		expect(account?.renewal_anchor_source).toBe("provider");
	});

	it("never touches a manual anchor", async () => {
		insertAccount(db, "anc-5", "codex");
		await repo.setRenewal("anc-5", "2026-01-02", "yearly", 20_000_000, null);

		expect(await sync("anc-5", FUTURE_END)).toBe(false);

		const account = await repo.findById("anc-5");
		expect(account?.renewal_anchor).toBe("2026-01-02");
		expect(account?.renewal_cadence).toBe("yearly");
		expect(account?.renewal_anchor_source).toBe("manual");
	});

	it("never touches a pre-source anchor (non-null anchor, null source)", async () => {
		insertAccount(db, "anc-6", "codex");
		// What a row set before renewal_anchor_source existed looks like; no
		// migration backfills it, and it may carry a real priced schedule.
		db.run(
			`UPDATE accounts SET renewal_anchor = '2026-02-11', renewal_cadence = 'monthly'
			 WHERE id = ?`,
			["anc-6"],
		);

		expect(await sync("anc-6", FUTURE_END)).toBe(false);

		expect((await repo.findById("anc-6"))?.renewal_anchor).toBe("2026-02-11");
	});

	it("refuses a period end already in the past", async () => {
		insertAccount(db, "anc-7", "codex");

		expect(await sync("anc-7", PAST_END)).toBe(false);

		expect((await repo.findById("anc-7"))?.renewal_anchor).toBeNull();
	});

	it("accepts a past period end while a grace period is still running", async () => {
		insertAccount(db, "anc-8", "codex");

		expect(
			await sync("anc-8", PAST_END, { graceEndsAtMs: NOW + 86_400_000 }),
		).toBe(true);

		expect((await repo.findById("anc-8"))?.renewal_anchor).toBe("2026-08-03");
	});

	it("writes nothing when the provider reports no period end", async () => {
		insertAccount(db, "anc-9", "codex");

		expect(await sync("anc-9", null)).toBe(false);

		expect((await repo.findById("anc-9"))?.renewal_anchor_source).toBeNull();
	});
});

describe("Anchor provenance — seeder vs provider report", () => {
	let db: Database;
	let repo: AccountRepository;

	/** 2026-04-10 local midday, so the local calendar day is unambiguous. */
	const SUB_START = new Date(2026, 3, 10, 12, 0).getTime();

	const identity = (): AccountIdentity => ({
		externalAccountId: "ext-sub",
		email: null,
		organizationName: null,
		planTier: "plus",
		rateLimitTier: null,
		subscriptionStatus: "active",
		subscriptionStartedAt: SUB_START,
	});

	beforeEach(() => {
		({ db, repo } = makeDb());
	});
	afterEach(() => {
		db.close();
	});

	it("does not seed a derived anchor on a non-Anthropic account", async () => {
		insertAccount(db, "seed-1", "codex");

		await repo.setAccountIdentityFromProfile("seed-1", identity());

		const account = await repo.findById("seed-1");
		expect(account?.renewal_anchor).toBeNull();
		expect(account?.renewal_anchor_source).toBeNull();
		// The start date itself is still captured — only the GUESS is withheld.
		expect(account?.identity_subscription_started_at).toBe(SUB_START);
	});

	it("still seeds a derived anchor on an Anthropic account", async () => {
		insertAccount(db, "seed-2", "anthropic");

		await repo.setAccountIdentityFromProfile("seed-2", identity());

		const account = await repo.findById("seed-2");
		expect(account?.renewal_anchor).toBe("2026-04-10");
		expect(account?.renewal_anchor_source).toBe("derived");
	});

	it("a first capture carrying both a start and a period end keeps the period end", async () => {
		insertAccount(db, "seed-3", "codex");

		// Order matters only if the gates are wrong: the seeder must skip the
		// non-Anthropic row, AND a derived anchor would be overwritten anyway.
		await repo.setAccountIdentityFromProfile("seed-3", identity());
		await repo.syncProviderRenewalAnchor(
			"seed-3",
			{ endsAtMs: FUTURE_END, cadence: "monthly", graceEndsAtMs: null },
			NOW,
		);

		const account = await repo.findById("seed-3");
		expect(account?.renewal_anchor).toBe("2026-10-03");
		expect(account?.renewal_anchor_source).toBe("provider");
	});
});

/** The window the Anthropic subscription re-read passes into the claim. */
const THROTTLE_MS = 6 * 60 * 60 * 1000;

describe("AccountRepository — claimAnthropicSubscriptionCheck", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});
	afterEach(() => {
		db.close();
	});

	it("claims an account that has never been checked, and stamps it", async () => {
		insertAccount(db, "clm-a", "anthropic", "r");

		expect(
			await repo.claimAnthropicSubscriptionCheck("clm-a", NOW, THROTTLE_MS),
		).toBe(true);
		expect(
			(await repo.findById("clm-a"))?.identity_subscription_checked_at,
		).toBe(NOW);
	});

	// The point of the single statement: the second caller re-tests the window
	// against what the first one wrote, not against what it read earlier.
	it("refuses a second claim inside the window, and leaves the stamp alone", async () => {
		insertAccount(db, "clm-b", "anthropic", "r");

		expect(
			await repo.claimAnthropicSubscriptionCheck("clm-b", NOW, THROTTLE_MS),
		).toBe(true);
		expect(
			await repo.claimAnthropicSubscriptionCheck("clm-b", NOW + 1, THROTTLE_MS),
		).toBe(false);
		expect(
			(await repo.findById("clm-b"))?.identity_subscription_checked_at,
		).toBe(NOW);
	});

	it("claims again the instant the window has elapsed", async () => {
		insertAccount(db, "clm-c", "anthropic", "r");
		await repo.claimAnthropicSubscriptionCheck("clm-c", NOW, THROTTLE_MS);

		expect(
			await repo.claimAnthropicSubscriptionCheck(
				"clm-c",
				NOW + THROTTLE_MS - 1,
				THROTTLE_MS,
			),
		).toBe(false);
		expect(
			await repo.claimAnthropicSubscriptionCheck(
				"clm-c",
				NOW + THROTTLE_MS,
				THROTTLE_MS,
			),
		).toBe(true);
	});

	it("refuses a non-Anthropic account", async () => {
		insertAccount(db, "clm-d", "codex", "r");

		expect(
			await repo.claimAnthropicSubscriptionCheck("clm-d", NOW, THROTTLE_MS),
		).toBe(false);
		expect(
			(await repo.findById("clm-d"))?.identity_subscription_checked_at,
		).toBeNull();
	});

	// An Anthropic row with no refresh token is an API-key account: no OAuth
	// profile endpoint to read.
	it("refuses an Anthropic account with no refresh token", async () => {
		insertAccount(db, "clm-e", "anthropic", "");

		expect(
			await repo.claimAnthropicSubscriptionCheck("clm-e", NOW, THROTTLE_MS),
		).toBe(false);
	});

	it("refuses an account that no longer exists", async () => {
		expect(
			await repo.claimAnthropicSubscriptionCheck("gone", NOW, THROTTLE_MS),
		).toBe(false);
	});
});

/**
 * The compare-and-swap the periodic subscription re-read passes: the profile it
 * fetched describes whichever account those credentials belonged to, so the
 * write must not land once they have been replaced.
 */
describe("AccountRepository — setAccountIdentityFromProfile access-token CAS", () => {
	let db: Database;
	let repo: AccountRepository;

	/** 2026-04-10 local midday, so the derived anchor's calendar day is unambiguous. */
	const SUB_START = new Date(2026, 3, 10, 12, 0).getTime();

	const identity = (): AccountIdentity => ({
		externalAccountId: "ext-cas",
		email: "u@example.test",
		organizationName: null,
		planTier: "max",
		rateLimitTier: "20x",
		subscriptionStatus: "active",
		subscriptionStartedAt: SUB_START,
	});

	const tierHistoryCount = (): number =>
		(
			db.query(`SELECT COUNT(*) AS n FROM account_tier_history`).get() as {
				n: number;
			}
		).n;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});
	afterEach(() => {
		db.close();
	});

	it("writes while the row still holds the token the profile was read with", async () => {
		insertAccount(db, "cas-a", "anthropic", "r", "t-live");

		expect(
			await repo.setAccountIdentityFromProfile("cas-a", identity(), "t-live"),
		).toBe(true);

		const account = await repo.findById("cas-a");
		expect(account?.identity_email).toBe("u@example.test");
		// The anchor seeding and the tier-history append ride the same write.
		expect(account?.renewal_anchor).toBe("2026-04-10");
		expect(account?.renewal_anchor_source).toBe("derived");
		expect(tierHistoryCount()).toBe(1);
	});

	// A re-auth installs new credentials AND the identity of the account they
	// belong to. Rejecting here is what keeps the previously-read account's
	// email, organization and subscription state off that row.
	it("rejects the write once the access token has changed", async () => {
		insertAccount(db, "cas-b", "anthropic", "r", "t-reauthed");

		expect(
			await repo.setAccountIdentityFromProfile("cas-b", identity(), "t-live"),
		).toBe(false);

		const account = await repo.findById("cas-b");
		expect(account?.identity_email).toBeNull();
		expect(account?.identity_captured_at).toBeNull();
		expect(account?.identity_profile_fetched_at).toBeNull();
		// Nothing behind the write may run against a row it did not touch.
		expect(account?.renewal_anchor).toBeNull();
		expect(tierHistoryCount()).toBe(0);
	});

	// Account add and reauth hold the credentials they just installed, so they
	// expect no token and keep writing unconditionally.
	it("writes unconditionally when no token is expected", async () => {
		insertAccount(db, "cas-c", "anthropic", "r", "t-reauthed");

		expect(await repo.setAccountIdentityFromProfile("cas-c", identity())).toBe(
			true,
		);
		expect((await repo.findById("cas-c"))?.identity_email).toBe(
			"u@example.test",
		);
	});
});
