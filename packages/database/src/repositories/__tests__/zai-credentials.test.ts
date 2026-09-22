import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@clankermux/core";
import { PAUSE_REASON_NEEDS_REAUTH } from "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

describe("Z.AI credential replacement", () => {
	let db: Database;
	let repo: AccountRepository;
	beforeEach(() => {
		db = new Database(":memory:");
		repo = new AccountRepository(new BunSqlAdapter(db));
		db.run(
			`CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT, api_key TEXT, refresh_token TEXT, access_token TEXT, custom_endpoint TEXT, expires_at INTEGER, paused INTEGER, pause_reason TEXT, name TEXT, priority INTEGER, total_requests INTEGER, rate_limited_until INTEGER, identity_external_id TEXT, identity_email TEXT, identity_organization_name TEXT, identity_organization_uuid TEXT, identity_plan_tier TEXT, identity_rate_limit_tier TEXT, identity_subscription_status TEXT, identity_subscription_started_at INTEGER, identity_subscription_ends_at INTEGER, identity_subscription_will_renew INTEGER, identity_subscription_grace_ends_at INTEGER, identity_subscription_checked_at INTEGER, renewal_anchor TEXT, renewal_anchor_source TEXT, renewal_cadence TEXT, renewal_price_usd_micros INTEGER, renewal_price_source TEXT, identity_captured_at INTEGER, identity_profile_fetched_at INTEGER)`,
		);
		db.run(
			`CREATE TABLE account_tier_history (id INTEGER PRIMARY KEY, account_id TEXT, observed_at INTEGER, plan_tier TEXT, rate_limit_tier TEXT, source TEXT, app_version TEXT)`,
		);
		db.run(
			`INSERT INTO accounts(id,provider,api_key,refresh_token,access_token,expires_at,paused,pause_reason,name,priority,total_requests,rate_limited_until,identity_external_id,identity_email,identity_organization_name) VALUES ('zai','zai','old','old','old',1000,1,?,'My account',7,123,999,'user-1','user@example.test','Org')`,
			[PAUSE_REASON_NEEDS_REAUTH],
		);
	});
	afterEach(() => db.close());
	const replacement = () => ({
		apiKey: "key-1.secret-1",
		expiresAt: 2_000_000_000_000,
		identity: {
			externalAccountId: "user-1",
			email: null,
			organizationName: null,
			planTier: "Pro",
			rateLimitTier: null,
		},
		expectedApiKey: "old",
		expectedExternalId: "user-1",
	});
	it("rewrites every mirrored credential column and the nominal expiry together", async () => {
		expect(await repo.reconnectZaiAccount("zai", replacement())).toBe(true);
		expect(db.query("SELECT * FROM accounts").get()).toMatchObject({
			id: "zai",
			api_key: "key-1.secret-1",
			refresh_token: "key-1.secret-1",
			access_token: "key-1.secret-1",
			expires_at: 2_000_000_000_000,
			paused: 0,
			pause_reason: null,
			name: "My account",
			priority: 7,
			total_requests: 123,
			rate_limited_until: 999,
		});
	});
	it("merges the new identity without erasing previously captured fields", async () => {
		expect(await repo.reconnectZaiAccount("zai", replacement())).toBe(true);
		expect(
			db
				.query(
					"SELECT identity_external_id,identity_email,identity_organization_name,identity_plan_tier FROM accounts",
				)
				.get(),
		).toEqual({
			identity_external_id: "user-1",
			identity_email: "user@example.test",
			identity_organization_name: "Org",
			identity_plan_tier: "Pro",
		});
		expect(
			db.query("SELECT count(*) AS n FROM account_tier_history").get(),
		).toEqual({ n: 1 });
	});
	it("applies a sign-in for an account that has never captured an identity", async () => {
		db.run("UPDATE accounts SET identity_external_id=NULL");
		expect(
			await repo.reconnectZaiAccount("zai", {
				...replacement(),
				expectedExternalId: null,
			}),
		).toBe(true);
		expect(
			db.query("SELECT api_key,identity_external_id FROM accounts").get(),
		).toEqual({ api_key: "key-1.secret-1", identity_external_id: "user-1" });
	});
	it("re-keys without identity when the sign-in reported none", async () => {
		const { identity: _identity, ...rest } = replacement();
		expect(await repo.reconnectZaiAccount("zai", rest)).toBe(true);
		expect(
			db.query("SELECT api_key,identity_plan_tier FROM accounts").get(),
		).toEqual({ api_key: "key-1.secret-1", identity_plan_tier: null });
		expect(
			db.query("SELECT count(*) AS n FROM account_tier_history").get(),
		).toEqual({ n: 0 });
	});
	it("preserves manual pauses", async () => {
		db.run("UPDATE accounts SET pause_reason='manual'");
		expect(await repo.reconnectZaiAccount("zai", replacement())).toBe(true);
		expect(db.query("SELECT paused,pause_reason FROM accounts").get()).toEqual({
			paused: 1,
			pause_reason: "manual",
		});
	});
	it("rejects stale credentials, identities and provider replacements without history writes", async () => {
		for (const change of [
			"api_key='winner'",
			"identity_external_id='user-2'",
			"provider='minimax'",
		]) {
			db.run(
				"UPDATE accounts SET api_key='old',identity_external_id='user-1',provider='zai'",
			);
			db.run(`UPDATE accounts SET ${change}`);
			expect(await repo.reconnectZaiAccount("zai", replacement())).toBe(false);
		}
		expect(
			db.query("SELECT refresh_token,access_token FROM accounts").get(),
		).toEqual({ refresh_token: "old", access_token: "old" });
		expect(
			db.query("SELECT count(*) AS n FROM account_tier_history").get(),
		).toEqual({ n: 0 });
	});
});
