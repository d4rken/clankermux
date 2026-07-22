import { describe, expect, it } from "bun:test";
import type { Account, AccountIdentity } from "@clankermux/types";
import {
	type CodexIdentityBackfillDeps,
	isCodexIdentityBackfillCandidate,
	runCodexIdentityBackfill,
} from "./codex-identity-backfill";

function makeAccount(overrides: Partial<Account>): Account {
	return {
		id: "acc",
		name: "acc",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh",
		access_token: "access",
		expires_at: null,
		created_at: Date.now(),
		last_used: null,
		request_count: 0,
		total_requests: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		codex_auto_apply_reset_on_weekly_limit_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		notes: null,
		refresh_token_issued_at: null,
		renewal_anchor: null,
		renewal_cadence: null,
		renewal_price_usd_micros: null,
		renewal_auto_start_date: null,
		identity_external_id: null,
		identity_email: null,
		identity_organization_name: null,
		identity_plan_tier: null,
		identity_rate_limit_tier: null,
		identity_captured_at: null,
		identity_profile_fetched_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

const FULL_IDENTITY: AccountIdentity = {
	externalAccountId: "ext-1",
	email: "user@example.com",
	organizationName: null,
	planTier: "team",
	rateLimitTier: null,
};

describe("isCodexIdentityBackfillCandidate", () => {
	it("selects a codex account with an access token and missing external id", () => {
		expect(
			isCodexIdentityBackfillCandidate(
				makeAccount({ identity_external_id: null, identity_email: null }),
			),
		).toBe(true);
	});

	it("selects a codex account missing only the email", () => {
		expect(
			isCodexIdentityBackfillCandidate(
				makeAccount({
					identity_external_id: "ext-1",
					identity_email: null,
				}),
			),
		).toBe(true);
	});

	it("does NOT select a codex account that already has external id AND email", () => {
		expect(
			isCodexIdentityBackfillCandidate(
				makeAccount({
					identity_external_id: "ext-1",
					identity_email: "user@example.com",
				}),
			),
		).toBe(false);
	});

	it("does NOT select a codex account with no access token (api-key account)", () => {
		expect(
			isCodexIdentityBackfillCandidate(
				makeAccount({ access_token: null, identity_external_id: null }),
			),
		).toBe(false);
	});

	it("does NOT select a non-codex (anthropic) account", () => {
		expect(
			isCodexIdentityBackfillCandidate(
				makeAccount({ provider: "anthropic", identity_external_id: null }),
			),
		).toBe(false);
	});
});

describe("runCodexIdentityBackfill", () => {
	it("decodes candidates and persists the identity", async () => {
		const writes: Array<{ id: string; identity: AccountIdentity }> = [];
		const deps: CodexIdentityBackfillDeps = {
			getAccounts: async () => [makeAccount({ id: "c1" })],
			extractIdentity: () => FULL_IDENTITY,
			setIdentity: async (id, identity) => {
				writes.push({ id, identity });
			},
		};

		await runCodexIdentityBackfill(deps);

		expect(writes).toEqual([{ id: "c1", identity: FULL_IDENTITY }]);
	});

	it("skips a candidate when the decode returns null", async () => {
		const writes: string[] = [];
		const deps: CodexIdentityBackfillDeps = {
			getAccounts: async () => [makeAccount({ id: "c1" })],
			extractIdentity: () => null,
			setIdentity: async (id) => {
				writes.push(id);
			},
		};

		await runCodexIdentityBackfill(deps);

		expect(writes).toEqual([]);
	});

	it("skips a candidate whose decode yields an all-null identity", async () => {
		const writes: string[] = [];
		const deps: CodexIdentityBackfillDeps = {
			getAccounts: async () => [makeAccount({ id: "c1" })],
			extractIdentity: () => ({
				externalAccountId: null,
				email: null,
				organizationName: null,
				planTier: null,
				rateLimitTier: null,
			}),
			setIdentity: async (id) => {
				writes.push(id);
			},
		};

		await runCodexIdentityBackfill(deps);

		expect(writes).toEqual([]);
	});

	it("persists when at least one identity field is non-null", async () => {
		const writes: string[] = [];
		const deps: CodexIdentityBackfillDeps = {
			getAccounts: async () => [makeAccount({ id: "c1" })],
			extractIdentity: () => ({
				externalAccountId: null,
				email: null,
				organizationName: null,
				planTier: "team",
				rateLimitTier: null,
			}),
			setIdentity: async (id) => {
				writes.push(id);
			},
		};

		await runCodexIdentityBackfill(deps);

		expect(writes).toEqual(["c1"]);
	});

	it("does not select non-candidates (already-identified / non-codex)", async () => {
		const writes: string[] = [];
		const deps: CodexIdentityBackfillDeps = {
			getAccounts: async () => [
				makeAccount({
					id: "done",
					identity_external_id: "ext",
					identity_email: "a@b.com",
				}),
				makeAccount({ id: "anthropic", provider: "anthropic" }),
			],
			extractIdentity: () => FULL_IDENTITY,
			setIdentity: async (id) => {
				writes.push(id);
			},
		};

		await runCodexIdentityBackfill(deps);

		expect(writes).toEqual([]);
	});

	it("continues after one account throws (per-account isolation)", async () => {
		const writes: string[] = [];
		const deps: CodexIdentityBackfillDeps = {
			getAccounts: async () => [
				makeAccount({ id: "boom" }),
				makeAccount({ id: "ok" }),
			],
			extractIdentity: () => FULL_IDENTITY,
			setIdentity: async (id) => {
				if (id === "boom") throw new Error("write failed");
				writes.push(id);
			},
		};

		await runCodexIdentityBackfill(deps);

		// The failing account did not stop the second from being persisted.
		expect(writes).toEqual(["ok"]);
	});

	it("is crash-safe when getAccounts throws (never rejects)", async () => {
		const deps: CodexIdentityBackfillDeps = {
			getAccounts: async () => {
				throw new Error("db down");
			},
			extractIdentity: () => FULL_IDENTITY,
			setIdentity: async () => {},
		};

		// Must resolve, not reject.
		await expect(runCodexIdentityBackfill(deps)).resolves.toBeUndefined();
	});
});
