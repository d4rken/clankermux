import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import {
	codexRateLimitResetCreditsCache,
	usageCache,
} from "@clankermux/providers";
import type { AccountResponse, AnthropicUsageData } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

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

describe("accounts list — limits[]-only usage population", () => {
	const LIMITS_ID = "acc-limits-only";

	beforeEach(() => usageCache.delete(LIMITS_ID));
	afterEach(() => usageCache.delete(LIMITS_ID));

	it("populates usageUtilization/usageWindow/usageData for a limits[]-only anthropic account", async () => {
		const reset = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
		// No flat five_hour/seven_day keys — the upstream limits[]-only shape.
		const usage: AnthropicUsageData = {
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 40,
					resets_at: reset,
					scope: null,
					is_active: true,
				},
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 60,
					resets_at: reset,
					scope: null,
					is_active: true,
				},
			],
		};
		usageCache.set(LIMITS_ID, usage);

		const handler = createAccountsListHandler(
			makeDbOps([
				makeAccountRow({
					id: LIMITS_ID,
					name: "Limits Only",
					provider: "anthropic",
				}),
			]),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];

		expect(response.status).toBe(200);
		const acct = body.find((a) => a.id === LIMITS_ID);
		// Account-wide representative = max(session 40, weeklyAll 60) = 60.
		expect(acct?.usageUtilization).toBe(60);
		// Binding window name comes from the normalizer fallback.
		expect(acct?.usageWindow).toBe("seven_day");
		// Full usage payload is surfaced (drives the dashboard usage bars).
		expect(acct?.usageData).not.toBeNull();
	});
});

describe("accounts list — Codex earned reset metadata", () => {
	const ACCOUNT_ID = "acc-codex-resets";

	beforeEach(() => {
		usageCache.delete(ACCOUNT_ID);
		codexRateLimitResetCreditsCache.delete(ACCOUNT_ID);
	});
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		codexRateLimitResetCreditsCache.delete(ACCOUNT_ID);
	});

	it("surfaces the cached authoritative count and ISO expiry details", async () => {
		codexRateLimitResetCreditsCache.set(
			ACCOUNT_ID,
			{
				availableCount: 3,
				credits: [
					{
						id: "reset-1",
						resetType: "codexRateLimits",
						status: "available",
						grantedAt: 1_782_935_292,
						expiresAt: 1_785_527_292,
						title: "Full reset",
						description: "One free reset.",
					},
				],
			},
			1_784_000_000_000,
		);

		const handler = createAccountsListHandler(
			makeDbOps([
				makeAccountRow({
					id: ACCOUNT_ID,
					name: "Codex resets",
					provider: "codex",
				}),
			]),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];
		const resets = body[0]?.codexRateLimitResetCredits;

		expect(resets?.availableCount).toBe(3);
		expect(resets?.fetchedAt).toBe("2026-07-14T03:33:20.000Z");
		expect(resets?.credits?.[0]?.expiresAt).toBe("2026-07-31T19:48:12.000Z");
		// The opaque credit id is only useful for redemption, so the read-only
		// dashboard contract intentionally does not expose it.
		expect(JSON.stringify(resets)).not.toContain("reset-1");
	});

	it("surfaces the per-account auto-apply reset-credits toggle", async () => {
		const handler = createAccountsListHandler(
			makeDbOps([
				makeAccountRow({
					id: ACCOUNT_ID,
					name: "Codex resets",
					provider: "codex",
					codex_auto_apply_reset_credits_enabled: 1,
				}),
				makeAccountRow({ id: "acc-plain", name: "Plain" }),
			]),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];

		expect(
			body.find((a) => a.id === ACCOUNT_ID)?.autoApplyResetCreditsEnabled,
		).toBe(true);
		expect(
			body.find((a) => a.id === "acc-plain")?.autoApplyResetCreditsEnabled,
		).toBe(false);
	});

	it("surfaces the per-account auto-apply-on-weekly-limit toggle", async () => {
		const handler = createAccountsListHandler(
			makeDbOps([
				makeAccountRow({
					id: ACCOUNT_ID,
					name: "Codex resets",
					provider: "codex",
					codex_auto_apply_reset_on_weekly_limit_enabled: 1,
				}),
				makeAccountRow({ id: "acc-plain", name: "Plain" }),
			]),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];

		expect(
			body.find((a) => a.id === ACCOUNT_ID)?.autoApplyResetOnWeeklyLimitEnabled,
		).toBe(true);
		// Independent of the sibling expiring-credits toggle.
		expect(
			body.find((a) => a.id === ACCOUNT_ID)?.autoApplyResetCreditsEnabled,
		).toBe(false);
		expect(
			body.find((a) => a.id === "acc-plain")
				?.autoApplyResetOnWeeklyLimitEnabled,
		).toBe(false);
	});
});
