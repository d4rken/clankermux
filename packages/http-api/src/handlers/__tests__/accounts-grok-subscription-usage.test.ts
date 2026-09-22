/**
 * `/api/accounts` resolves usage through an `if/else if` chain keyed on the
 * account's provider, with no fall-through: an unlisted provider assigns
 * nothing and the response carries nulls even though the cache holds a good
 * reading. These tests assert the grok-subscription arm of that chain, plus
 * the account-wide exhaustion verdict the same response derives.
 *
 * Harness mirrors accounts-zai-derived.test.ts (same fake adapter surface).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type {
	AccountResponse,
	GrokSubscriptionUsageData,
} from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ACCOUNT_ID = "acc-grok";

function accountRow() {
	return {
		id: ACCOUNT_ID,
		name: "Grok-1",
		provider: "grok-subscription",
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
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
	};
}

function makeDbOps(): DatabaseOperations {
	return {
		getAdapter: () => ({
			query: async (sql: string) => {
				if (sql.includes("FROM accounts")) return [accountRow()];
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

async function fetchAccount(): Promise<AccountResponse> {
	const handler = createAccountsListHandler(makeDbOps(), config);
	const body = (await (await handler()).json()) as AccountResponse[];
	const account = body.find((a) => a.id === ACCOUNT_ID);
	if (!account) throw new Error("account missing from response");
	return account;
}

function grokUsage(
	weeklyUtilization: number | null,
	weeklyResetAt: number,
): GrokSubscriptionUsageData {
	return {
		kind: "grok-subscription",
		weeklyUtilization,
		weeklyResetAt,
		weeklyPeriodStartAt: weeklyResetAt - 7 * DAY_MS,
		onDemandCapCents: 0,
		onDemandUsedCents: 0,
		prepaidBalanceCents: null,
	};
}

describe("grok-subscription usage on /api/accounts", () => {
	beforeEach(() => usageCache.delete(ACCOUNT_ID));
	afterEach(() => usageCache.delete(ACCOUNT_ID));

	it("serves a cached weekly reading rather than discarding it", async () => {
		const reset = Date.now() + 3 * DAY_MS;
		usageCache.set(ACCOUNT_ID, grokUsage(41.5, reset));

		const account = await fetchAccount();

		expect(account.usageUtilization).toBe(41.5);
		expect(account.usageWindow).toBe("weekly");
		expect(account.usageData).toEqual(grokUsage(41.5, reset));
	});

	it("serves an unknown reading as null utilization, never as 0", async () => {
		const reset = Date.now() + 3 * DAY_MS;
		usageCache.set(ACCOUNT_ID, grokUsage(null, reset));

		const account = await fetchAccount();

		expect(account.usageUtilization).toBeNull();
		// The window itself is still real and named: the reset is a deadline the
		// page can show even with no percentage to put beside it.
		expect(account.usageWindow).toBe("weekly");
		expect(account.usageData).toEqual(grokUsage(null, reset));
	});

	it("reports a spent weekly pool as account-wide exhaustion", async () => {
		const reset = Date.now() + 2 * DAY_MS;
		usageCache.set(ACCOUNT_ID, grokUsage(100, reset));

		const account = await fetchAccount();

		expect(account.rateLimitCause).toBe("usage_exhausted");
		expect(account.rateLimitCauseBinding).toBe("weekly");
		expect(account.rateLimitCauseResetMs).toBe(reset);
	});

	it("never reports exhaustion from an unknown reading", async () => {
		usageCache.set(ACCOUNT_ID, grokUsage(null, Date.now() + 2 * DAY_MS));

		const account = await fetchAccount();

		expect(account.rateLimitCause).toBe("ok");
		expect(account.rateLimitCauseBinding).toBeNull();
	});
});
