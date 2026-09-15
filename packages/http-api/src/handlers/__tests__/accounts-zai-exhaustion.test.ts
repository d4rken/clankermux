/**
 * A Z.AI account sitting at 100% used to keep reporting `rateLimitStatus: "OK"`
 * until a real 429 wrote a cooldown, and `/health` never counted it. Both read
 * the account-wide exhaustion verdict, which was typed to the Anthropic payload
 * and saw nothing in a Z.AI one.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type { Account, AccountResponse, ZaiUsageData } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";
import { computePoolStatus, usageCacheResolver } from "../health";

const BASE = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ACCOUNT_ID = "acc-zai-exhausted";

function accountRow() {
	return {
		id: ACCOUNT_ID,
		name: "Z.AI-1",
		provider: "zai",
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: BASE,
		expires_at: BASE + 60_000,
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

function zaiUsage(fiveHourPct: number, weeklyPct: number): ZaiUsageData {
	return {
		time_limit: null,
		tokens_limit: {
			used: fiveHourPct,
			remaining: 100 - fiveHourPct,
			percentage: fiveHourPct,
			resetAt: BASE + 2 * HOUR,
			type: "tokens_limit",
		},
		tokens_limit_weekly: {
			used: weeklyPct,
			remaining: 100 - weeklyPct,
			percentage: weeklyPct,
			resetAt: BASE + 3 * DAY,
			type: "tokens_limit_weekly",
		},
	};
}

describe("Z.AI account-wide exhaustion on /api/accounts", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		usageCache.delete(ACCOUNT_ID);
	});
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		nowSpy.mockRestore();
	});

	async function accountFor(
		usage: ZaiUsageData,
	): Promise<AccountResponse | undefined> {
		usageCache.set(ACCOUNT_ID, usage as never);
		const handler = createAccountsListHandler(makeDbOps(), config);
		const body = (await (await handler()).json()) as AccountResponse[];
		return body.find((a) => a.id === ACCOUNT_ID);
	}

	it("reports a spent weekly window as usage_exhausted bound to `weekly`", async () => {
		const account = await accountFor(zaiUsage(100, 100));
		expect(account?.rateLimitCause).toBe("usage_exhausted");
		expect(account?.rateLimitCauseBinding).toBe("weekly");
		expect(account?.rateLimitStatus).not.toBe("OK");
	});

	it("reports a spent five-hour window as usage_exhausted bound to `session`", async () => {
		const account = await accountFor(zaiUsage(100, 20));
		expect(account?.rateLimitCause).toBe("usage_exhausted");
		expect(account?.rateLimitCauseBinding).toBe("session");
	});

	it("reports a healthy account as ok with no binding", async () => {
		const account = await accountFor(zaiUsage(20, 40));
		expect(account?.rateLimitCause).toBe("ok");
		expect(account?.rateLimitCauseBinding).toBeNull();
	});
});

describe("Z.AI account-wide exhaustion on /health", () => {
	beforeEach(() => {
		usageCache.delete(ACCOUNT_ID);
	});
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
	});

	const zaiAccount = () =>
		({
			id: ACCOUNT_ID,
			name: "Z.AI-1",
			provider: "zai",
			paused: false,
			rate_limited_until: null,
		}) as unknown as Account;

	it("counts a spent Z.AI account as usage_exhausted, not routable", () => {
		usageCache.set(ACCOUNT_ID, zaiUsage(10, 100) as never);
		const status = computePoolStatus([zaiAccount()], BASE, usageCacheResolver);
		expect(status.usage_exhausted).toBe(1);
		expect(status.routable).toBe(0);
		expect(status.next_available_at).toBe(
			new Date(BASE + 3 * DAY).toISOString(),
		);
	});

	it("leaves a Z.AI account with headroom routable", () => {
		usageCache.set(ACCOUNT_ID, zaiUsage(10, 40) as never);
		const status = computePoolStatus([zaiAccount()], BASE, usageCacheResolver);
		expect(status.usage_exhausted).toBe(0);
		expect(status.routable).toBe(1);
	});
});
