import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type { AccountResponse, RankedSnapshot } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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
	latestSnapshots: RankedSnapshot[],
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
		getLatestUsageSnapshots: async (ids: string[]) =>
			latestSnapshots.filter((s) => ids.includes(s.accountId)),
		getRecentUsageSnapshotsForAccounts: async () => [],
	} as unknown as DatabaseOperations;
}

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

const ACCOUNT_ID = "acc-stale";

function snapshot(overrides: Partial<RankedSnapshot>): RankedSnapshot {
	return {
		accountId: ACCOUNT_ID,
		provider: "anthropic",
		ts: Date.now(),
		fiveHourPct: null,
		fiveHourReset: null,
		sevenDayPct: null,
		sevenDayReset: null,
		...overrides,
	};
}

async function runHandler(
	snapshots: RankedSnapshot[],
): Promise<AccountResponse | undefined> {
	const handler = createAccountsListHandler(
		makeDbOps(
			[
				makeAccountRow({
					id: ACCOUNT_ID,
					name: "Stale",
					provider: "anthropic",
				}),
			],
			snapshots,
		),
		config,
	);
	const response = await handler();
	const body = (await response.json()) as AccountResponse[];
	return body.find((a) => a.id === ACCOUNT_ID);
}

describe("accounts list staleUsage builder", () => {
	// The builder only runs for accounts whose live usage cache is cold, so keep
	// the cache empty for the account under test throughout.
	beforeEach(() => {
		usageCache.delete(ACCOUNT_ID);
	});
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
	});

	it("carries a fresh 5h-only snapshot (within 4 min) with the weekly window absent", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now - 1 * MINUTE_MS,
				fiveHourPct: 42,
				fiveHourReset: now + 90 * MINUTE_MS,
				// No weekly data.
			}),
		]);
		expect(acc?.staleUsage?.fiveHour?.utilization).toBe(42);
		expect(acc?.staleUsage?.fiveHour?.resetIso).toBe(
			new Date(now + 90 * MINUTE_MS).toISOString(),
		);
		expect(acc?.staleUsage?.sevenDay).toBeUndefined();
	});

	it("omits the 5h window when the snapshot is older than 4 min but keeps the ungated weekly window", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now - 5 * MINUTE_MS, // older than 2 * SAMPLE_INTERVAL_MS (~4 min)
				fiveHourPct: 42,
				fiveHourReset: now + 90 * MINUTE_MS,
				sevenDayPct: 85,
				sevenDayReset: now + 3 * DAY_MS,
			}),
		]);
		expect(acc?.staleUsage?.fiveHour).toBeUndefined();
		expect(acc?.staleUsage?.sevenDay?.utilization).toBe(85);
	});

	it("omits the 5h window when its reset is already in the past", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now - 1 * MINUTE_MS,
				fiveHourPct: 42,
				fiveHourReset: now - 5 * MINUTE_MS, // already rolled
			}),
		]);
		expect(acc?.staleUsage).toBeNull();
	});

	it("drops the whole snapshot when its timestamp is in the future (clock anomaly)", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now + 5 * MINUTE_MS, // future
				fiveHourPct: 42,
				fiveHourReset: now + 90 * MINUTE_MS,
				sevenDayPct: 85,
				sevenDayReset: now + 3 * DAY_MS,
			}),
		]);
		expect(acc?.staleUsage).toBeNull();
	});

	it("carries both windows when the snapshot is fresh and both are valid", async () => {
		const now = Date.now();
		const acc = await runHandler([
			snapshot({
				ts: now - 1 * MINUTE_MS,
				fiveHourPct: 42,
				fiveHourReset: now + 90 * MINUTE_MS,
				sevenDayPct: 85,
				sevenDayReset: now + 3 * DAY_MS,
			}),
		]);
		expect(acc?.staleUsage?.fiveHour?.utilization).toBe(42);
		expect(acc?.staleUsage?.sevenDay?.utilization).toBe(85);
		expect(acc?.staleUsage?.asOfIso).toBe(
			new Date(now - 1 * MINUTE_MS).toISOString(),
		);
	});
});
