import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@clankermux/core";
import { PAUSE_REASON_NEEDS_REAUTH } from "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

describe("Devin credential replacement", () => {
	let db: Database;
	let repo: AccountRepository;
	beforeEach(() => {
		db = new Database(":memory:");
		repo = new AccountRepository(new BunSqlAdapter(db));
		db.run(
			`CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT, api_key TEXT, custom_endpoint TEXT, expires_at INTEGER, paused INTEGER, pause_reason TEXT, name TEXT, priority INTEGER, total_requests INTEGER, rate_limited_until INTEGER, identity_external_id TEXT, identity_email TEXT, identity_organization_name TEXT, identity_plan_tier TEXT, identity_rate_limit_tier TEXT, identity_captured_at INTEGER, identity_profile_fetched_at INTEGER)`,
		);
		db.run(
			`CREATE TABLE account_tier_history (id INTEGER PRIMARY KEY, account_id TEXT, observed_at INTEGER, plan_tier TEXT, rate_limit_tier TEXT, source TEXT, app_version TEXT)`,
		);
		db.run(
			`INSERT INTO accounts(id,provider,api_key,custom_endpoint,paused,pause_reason,name,priority,total_requests,rate_limited_until,identity_external_id,identity_plan_tier) VALUES ('devin','devin','old',NULL,1,?,'My account',7,123,999,'user-1','Free')`,
			[PAUSE_REASON_NEEDS_REAUTH],
		);
	});
	afterEach(() => db.close());
	const replacement = () => ({
		apiKey: "new",
		expiresAt: 2_000_000_000_000,
		identity: {
			externalAccountId: "user-1",
			email: "user@example.test",
			organizationName: "Org",
			planTier: "Pro",
			rateLimitTier: null,
		},
		expectedApiKey: "old",
		expectedEndpoint: null,
		expectedExternalId: "user-1",
	});
	it("reconnects in place, records identity atomically and resumes only the auth pause", async () => {
		expect(await repo.reconnectDevinAccount("devin", replacement())).toBe(true);
		expect(db.query("SELECT * FROM accounts").get()).toMatchObject({
			id: "devin",
			api_key: "new",
			expires_at: 2_000_000_000_000,
			paused: 0,
			pause_reason: null,
			name: "My account",
			priority: 7,
			total_requests: 123,
			rate_limited_until: 999,
			identity_email: "user@example.test",
			identity_organization_name: "Org",
			identity_plan_tier: "Pro",
		});
		expect(
			db.query("SELECT count(*) AS n FROM account_tier_history").get(),
		).toEqual({ n: 1 });
	});
	it("preserves manual pauses", async () => {
		db.run("UPDATE accounts SET pause_reason='manual'");
		expect(await repo.reconnectDevinAccount("devin", replacement())).toBe(true);
		expect(db.query("SELECT paused,pause_reason FROM accounts").get()).toEqual({
			paused: 1,
			pause_reason: "manual",
		});
	});
	it("rejects stale credentials, endpoints, identities and provider replacements without history writes", async () => {
		for (const change of [
			"api_key='winner'",
			"custom_endpoint='https://new.example'",
			"identity_external_id='user-2'",
			"provider='codex'",
		]) {
			db.run(
				"UPDATE accounts SET api_key='old',custom_endpoint=NULL,identity_external_id='user-1',provider='devin'",
			);
			db.run(`UPDATE accounts SET ${change}`);
			expect(await repo.reconnectDevinAccount("devin", replacement())).toBe(
				false,
			);
		}
		expect(
			db.query("SELECT count(*) AS n FROM account_tier_history").get(),
		).toEqual({ n: 0 });
	});
	it("backfills only the current session expiry without changing its pause", async () => {
		expect(
			await repo.updateDevinSessionExpiry("devin", "stale", null, null),
		).toBe(false);
		expect(
			await repo.updateDevinSessionExpiry("devin", "old", null, null),
		).toBe(true);
		expect(
			db.query("SELECT expires_at,paused,pause_reason FROM accounts").get(),
		).toEqual({
			expires_at: null,
			paused: 1,
			pause_reason: PAUSE_REASON_NEEDS_REAUTH,
		});
	});
	it("marks confirmed rejected sessions for reconnect without clobbering manual pauses or new credentials", async () => {
		expect(await repo.pauseDevinAccountForReauth("devin", "old", null)).toBe(
			false,
		);
		db.run("UPDATE accounts SET paused=0,pause_reason=NULL");
		expect(await repo.pauseDevinAccountForReauth("devin", "stale", null)).toBe(
			false,
		);
		expect(
			await repo.pauseDevinAccountForReauth(
				"devin",
				"old",
				"https://stale.example",
			),
		).toBe(false);
		expect(await repo.pauseDevinAccountForReauth("devin", "old", null)).toBe(
			true,
		);
		expect(db.query("SELECT pause_reason FROM accounts").get()).toEqual({
			pause_reason: PAUSE_REASON_NEEDS_REAUTH,
		});
	});
});
