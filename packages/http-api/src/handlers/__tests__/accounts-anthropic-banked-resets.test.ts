/**
 * The accounts list serves the cached banked-reset status of Anthropic OAuth
 * accounts, and only the management page starts a status read for a stale
 * entry.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { anthropicBankedResetCache } from "@clankermux/providers";
import {
	registerAnthropicBankedResetRefresher,
	resetAnthropicBankedResetSweepForTests,
	unregisterAnthropicBankedResetRefresher,
} from "@clankermux/proxy";
import { listAccountResponses } from "../accounts";

const REFRESHER_ID = "accounts-banked-resets-test";
const ANTHROPIC_ID = "acct-anthropic-banked";
const CODEX_ID = "acct-codex-banked";

let refreshed: Array<{ id: string; force: boolean }> = [];

function row(
	id: string,
	provider: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		name: id,
		provider,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now() - 60_000,
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
		anthropic_auto_apply_banked_resets_enabled: 1,
		anthropic_auto_apply_banked_reset_on_weekly_limit_enabled: 0,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		codex_usage_json: null,
		codex_usage_observed_at: null,
		...overrides,
	};
}

function makeDbOps(accounts: unknown[]): DatabaseOperations {
	return {
		getAdapter: () => ({
			query: async (sql: string) =>
				sql.includes("FROM accounts") ? accounts : [],
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

async function list(
	accounts: unknown[],
	sideEffects: "management" | "read-only" = "management",
) {
	const result = await listAccountResponses(
		makeDbOps(accounts),
		config,
		undefined,
		{ sideEffects },
	);
	await Promise.resolve();
	return result;
}

beforeEach(() => {
	resetAnthropicBankedResetSweepForTests();
	refreshed = [];
	anthropicBankedResetCache.clear();
	registerAnthropicBankedResetRefresher(REFRESHER_ID, async (id, force) => {
		refreshed.push({ id, force });
		return { success: true, message: "ok" };
	});
});

afterEach(() => {
	unregisterAnthropicBankedResetRefresher(REFRESHER_ID);
	anthropicBankedResetCache.clear();
});

describe("accounts list — anthropicBankedResets", () => {
	it("serves the cached status and the toggles for an Anthropic OAuth account", async () => {
		anthropicBankedResetCache.set(ANTHROPIC_ID, {
			eligible: true,
			ineligibleReason: null,
			atLimit: false,
			exhausted: [],
			grants: [
				{
					id: "g1",
					label: null,
					resetsTotal: 2,
					resetsLeft: 2,
					startsAt: null,
					endsAt: null,
					clears: ["seven_day"],
					paused: false,
					usableNow: true,
					useRequiresLimit: true,
					percentUsed: {},
					blocking: [],
				},
			],
			nextGrantId: "g1",
			weeklyResetsAt: null,
			cooldownUntil: null,
		});
		const [anthropic, codex] = await list([
			row(ANTHROPIC_ID, "anthropic"),
			row(CODEX_ID, "codex"),
		]);
		expect(anthropic?.anthropicBankedResets?.resetsLeftTotal).toBe(2);
		expect(anthropic?.anthropicBankedResets?.grants[0]?.isNext).toBe(true);
		expect(anthropic?.autoApplyBankedResetsEnabled).toBe(true);
		expect(anthropic?.autoApplyBankedResetOnWeeklyLimitEnabled).toBe(false);
		expect(codex?.anthropicBankedResets).toBeNull();
		// Fresh entry: nothing to read.
		expect(refreshed).toEqual([]);
	});

	it("serves null and starts a cache-gated read from the management page", async () => {
		const [anthropic] = await list([row(ANTHROPIC_ID, "anthropic")]);
		expect(anthropic?.anthropicBankedResets).toBeNull();
		expect(refreshed).toEqual([{ id: ANTHROPIC_ID, force: false }]);
	});

	it("starts no read from a read-only caller, a disabled or a needs-reauth account", async () => {
		await list([row(ANTHROPIC_ID, "anthropic")], "read-only");
		await list([row(ANTHROPIC_ID, "anthropic", { disabled: 1 })]);
		await list([
			row(ANTHROPIC_ID, "anthropic", {
				paused: 1,
				pause_reason: "oauth_invalid_grant",
			}),
		]);
		expect(refreshed).toEqual([]);
	});

	it("does not treat an Anthropic API-key account as OAuth", async () => {
		const [account] = await list([
			row(ANTHROPIC_ID, "anthropic", { refresh_token: null }),
		]);
		expect(account?.anthropicBankedResets).toBeNull();
		expect(refreshed).toEqual([]);
	});
});
