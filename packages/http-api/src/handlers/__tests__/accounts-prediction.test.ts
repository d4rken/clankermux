import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type { AccountResponse, UsageSnapshotSample } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

const HOUR_MS = 60 * 60 * 1000;

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
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		...overrides,
	};
}

function makeDbOps(
	accounts: AccountRow[],
	recentSnapshots: UsageSnapshotSample[],
): DatabaseOperations {
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
		getRecentUsageSnapshotsForAccounts: async (accountIds: string[]) =>
			recentSnapshots.filter((s) => accountIds.includes(s.accountId)),
	} as unknown as DatabaseOperations;
}

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

describe("accounts list usage prediction wiring", () => {
	const RISING_ID = "acc-rising";
	const NONE_ID = "acc-none";

	beforeEach(() => {
		usageCache.delete(RISING_ID);
		usageCache.delete(NONE_ID);
	});

	afterEach(() => {
		usageCache.delete(RISING_ID);
		usageCache.delete(NONE_ID);
	});

	it("attaches a rising 5h prediction from stored snapshots + live usage, and null when there is no data", async () => {
		const now = Date.now();
		// Reset comfortably in the future so no window is "at reset". The same ms
		// feeds both the stored snapshots (epoch ms) and the live reading (ISO) so
		// the regression segments them together (within the 60s jitter tolerance).
		const reset = now + 3 * HOUR_MS;

		// Live current 5h reading for the rising account — off the extrapolated
		// history line so the injected live point bends the slope up.
		usageCache.set(RISING_ID, {
			five_hour: { utilization: 60, resets_at: new Date(reset).toISOString() },
			seven_day: { utilization: 20, resets_at: new Date(reset).toISOString() },
		});

		// Rising 5h history: 10/20/30 over the last 3h (mirrors the pure service
		// test's proven "rising" seeds; all within the 6h lookback).
		const snapshots: UsageSnapshotSample[] = [
			{
				accountId: RISING_ID,
				provider: "anthropic",
				sampledAt: now - 3 * HOUR_MS,
				fiveHourPct: 10,
				fiveHourReset: reset,
				sevenDayPct: 20,
				sevenDayReset: reset,
			},
			{
				accountId: RISING_ID,
				provider: "anthropic",
				sampledAt: now - 2 * HOUR_MS,
				fiveHourPct: 20,
				fiveHourReset: reset,
				sevenDayPct: 20,
				sevenDayReset: reset,
			},
			{
				accountId: RISING_ID,
				provider: "anthropic",
				sampledAt: now - 1 * HOUR_MS,
				fiveHourPct: 30,
				fiveHourReset: reset,
				sevenDayPct: 20,
				sevenDayReset: reset,
			},
		];

		const handler = createAccountsListHandler(
			makeDbOps(
				[
					makeAccountRow({
						id: RISING_ID,
						name: "Rising",
						provider: "anthropic",
					}),
					// No live usage cache entry and no snapshots -> prediction null.
					makeAccountRow({ id: NONE_ID, name: "None", provider: "anthropic" }),
				],
				snapshots,
			),
			config,
		);

		const response = await handler();
		const body = (await response.json()) as AccountResponse[];

		expect(response.status).toBe(200);

		const rising = body.find((a) => a.id === RISING_ID);
		const none = body.find((a) => a.id === NONE_ID);

		expect(rising?.prediction?.fiveHour?.state).toBe("rising");
		expect(none?.prediction).toBeNull();
	});
});
