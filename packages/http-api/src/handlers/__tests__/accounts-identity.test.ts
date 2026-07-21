import { describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import type { AccountResponse } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

// Row shape mirrors the handler's inline SELECT (snake_case, identity columns
// nullable). The mock adapter returns these rows verbatim, so seeding the
// identity columns here exercises the full DB-row → AccountResponse mapping.
interface AccountRow {
	id: string;
	name: string;
	provider: string | null;
	request_count: number;
	total_requests: number;
	last_used: number | null;
	created_at: number;
	expires_at: number | null;
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
	rate_limited_at: number | null;
	rate_limit_reset: number | null;
	rate_limit_status: string | null;
	rate_limit_remaining: number | null;
	session_start: number | null;
	session_request_count: number;
	refresh_token: string;
	access_token: string | null;
	paused: 0 | 1;
	priority: number;
	token_valid: 0 | 1;
	rate_limited: 0 | 1;
	session_info: string | null;
	auto_fallback_enabled: 0 | 1;
	auto_refresh_enabled: 0 | 1;
	auto_pause_on_overage_enabled: 0 | 1;
	peak_hours_pause_enabled: 0 | 1;
	codex_auto_apply_reset_credits_enabled: 0 | 1;
	codex_auto_apply_reset_on_weekly_limit_enabled: 0 | 1;
	custom_endpoint: string | null;
	model_mappings: string | null;
	model_fallbacks: string | null;
	billing_type: string | null;
	pause_reason: string | null;
	identity_external_id: string | null;
	identity_email: string | null;
	identity_organization_name: string | null;
	identity_plan_tier: string | null;
	identity_rate_limit_tier: string | null;
	identity_captured_at: number | null;
	identity_profile_fetched_at: number | null;
}

function makeAccountRow(overrides: Partial<AccountRow>): AccountRow {
	return {
		id: "acc-1",
		name: "Account 1",
		provider: "anthropic",
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		expires_at: Date.now() + 60_000,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		session_start: null,
		session_request_count: 0,
		refresh_token: "refresh-token",
		access_token: "access-token",
		paused: 0,
		priority: 0,
		token_valid: 1,
		rate_limited: 0,
		session_info: "-",
		auto_fallback_enabled: 0,
		auto_refresh_enabled: 0,
		auto_pause_on_overage_enabled: 0,
		peak_hours_pause_enabled: 0,
		codex_auto_apply_reset_credits_enabled: 0,
		codex_auto_apply_reset_on_weekly_limit_enabled: 0,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		identity_external_id: null,
		identity_email: null,
		identity_organization_name: null,
		identity_plan_tier: null,
		identity_rate_limit_tier: null,
		identity_captured_at: null,
		identity_profile_fetched_at: null,
		...overrides,
	};
}

function makeDbOps(accounts: AccountRow[]): DatabaseOperations {
	return {
		getAdapter: () => ({
			query: async (sql: string) => {
				if (sql.includes("FROM accounts")) return accounts;
				return [];
			},
			get: async () => null,
		}),
		getStatsRepository: () => ({
			getSessionStats: async () => new Map(),
			getActiveSessionCountsByAccount: async () => new Map(),
		}),
		getLatestUsageSnapshots: async () => [],
		getRecentUsageSnapshotsForAccounts: async () => [],
	} as unknown as DatabaseOperations;
}

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

describe("accounts list — identity fields round-trip", () => {
	it("maps the snake_case identity columns to camelCase response fields", async () => {
		const capturedAt = 1_784_000_000_000;
		const profileFetchedAt = 1_784_000_100_000;
		const handler = createAccountsListHandler(
			makeDbOps([
				makeAccountRow({
					id: "acc-identity",
					name: "Identity Account",
					provider: "anthropic",
					identity_external_id: "ext-123",
					identity_email: "user@example.com",
					identity_organization_name: "Acme Corp",
					identity_plan_tier: "max",
					identity_rate_limit_tier: "20x",
					identity_captured_at: capturedAt,
					identity_profile_fetched_at: profileFetchedAt,
				}),
			]),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];
		const acct = body.find((a) => a.id === "acc-identity");

		expect(response.status).toBe(200);
		expect(acct?.identityExternalId).toBe("ext-123");
		expect(acct?.identityEmail).toBe("user@example.com");
		expect(acct?.identityOrganizationName).toBe("Acme Corp");
		expect(acct?.identityPlanTier).toBe("max");
		expect(acct?.identityRateLimitTier).toBe("20x");
		expect(acct?.identityCapturedAt).toBe(capturedAt);
		expect(acct?.identityProfileFetchedAt).toBe(profileFetchedAt);
	});

	it("carries nulls when identity has not been captured", async () => {
		const handler = createAccountsListHandler(
			makeDbOps([makeAccountRow({ id: "acc-empty", name: "No Identity" })]),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];
		const acct = body.find((a) => a.id === "acc-empty");

		expect(acct?.identityExternalId).toBeNull();
		expect(acct?.identityEmail).toBeNull();
		expect(acct?.identityOrganizationName).toBeNull();
		expect(acct?.identityPlanTier).toBeNull();
		expect(acct?.identityRateLimitTier).toBeNull();
		expect(acct?.identityCapturedAt).toBeNull();
		expect(acct?.identityProfileFetchedAt).toBeNull();
		// No sibling shares its identity → never flagged a duplicate.
		expect(acct?.isDuplicateAccount).toBe(false);
		expect(acct?.duplicateAccountIds).toEqual([]);
	});
});

describe("accounts list — duplicate-login detection", () => {
	it("flags two accounts sharing provider + external id as mutual duplicates", async () => {
		const handler = createAccountsListHandler(
			makeDbOps([
				makeAccountRow({
					id: "dup-a",
					name: "Dup A",
					provider: "anthropic",
					identity_external_id: "shared-ext",
				}),
				makeAccountRow({
					id: "dup-b",
					name: "Dup B",
					provider: "anthropic",
					identity_external_id: "shared-ext",
				}),
				makeAccountRow({
					id: "solo-c",
					name: "Solo C",
					provider: "anthropic",
					identity_external_id: "other-ext",
				}),
			]),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];
		const a = body.find((x) => x.id === "dup-a");
		const b = body.find((x) => x.id === "dup-b");
		const c = body.find((x) => x.id === "solo-c");

		expect(a?.isDuplicateAccount).toBe(true);
		expect(a?.duplicateAccountIds).toEqual(["dup-b"]);
		expect(b?.isDuplicateAccount).toBe(true);
		expect(b?.duplicateAccountIds).toEqual(["dup-a"]);
		// Unrelated account with a distinct external id is not a duplicate.
		expect(c?.isDuplicateAccount).toBe(false);
		expect(c?.duplicateAccountIds).toEqual([]);
	});
});
