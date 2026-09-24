/**
 * /api/accounts with 5h/7d readings taken from response headers: the bars show
 * them, each with its own as-of, while `usageAsOfIso` keeps the poll's time.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { type UsageData, usageCache } from "@clankermux/providers";
import type { AccountResponse } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BASE = 1_700_000_000_000;
const ACCOUNT_ID = "acc-header-usage";
const FIVE_RESET = BASE + 2 * HOUR_MS;
const WEEK_RESET = BASE + 3 * DAY_MS;

function makeDbOps(): DatabaseOperations {
	const row = {
		id: ACCOUNT_ID,
		name: "Header-fed",
		provider: "anthropic",
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: BASE,
		expires_at: BASE + HOUR_MS,
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
	return {
		getAdapter: () => ({
			query: async (sql: string) =>
				sql.includes("FROM accounts") ? [row] : [],
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

function config(throttling: boolean): Config {
	return {
		getUsageThrottlingFiveHourEnabled: () => throttling,
		getUsageThrottlingWeeklyEnabled: () => throttling,
	} as unknown as Config;
}

async function list(throttling = false): Promise<AccountResponse | undefined> {
	const handler = createAccountsListHandler(makeDbOps(), config(throttling));
	const body = (await (await handler()).json()) as AccountResponse[];
	return body.find((a) => a.id === ACCOUNT_ID);
}

function pollReading(fivePct: number, weekPct: number): UsageData {
	return {
		five_hour: {
			utilization: fivePct,
			resets_at: new Date(FIVE_RESET + 219).toISOString(),
		},
		seven_day: {
			utilization: weekPct,
			resets_at: new Date(WEEK_RESET + 431).toISOString(),
		},
		seven_day_opus: { utilization: 7, resets_at: null },
	};
}

function feed(fivePct: number, weekPct: number, observedAt: number): void {
	usageCache.recordUsageHeaders(
		ACCOUNT_ID,
		usageCache.usageHeaderEpoch(ACCOUNT_ID),
		[
			{
				claim: "5h",
				status: "allowed",
				utilization: fivePct / 100,
				resetMs: FIVE_RESET,
				surpassedThreshold: null,
			},
			{
				claim: "7d",
				status: "allowed",
				utilization: weekPct / 100,
				resetMs: WEEK_RESET,
				surpassedThreshold: null,
			},
		],
		observedAt,
	);
}

describe("accounts list — header-fed 5h/7d windows", () => {
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		usageCache.startPolling(
			ACCOUNT_ID,
			async () => "token",
			"anthropic",
			90_000,
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 10 * HOUR_MS },
		);
	});
	afterEach(() => {
		usageCache.stopPolling(ACCOUNT_ID);
		usageCache.delete(ACCOUNT_ID);
		nowSpy.mockRestore();
	});

	it("shows the header readings, each window stamped with its own as-of", async () => {
		usageCache.set(ACCOUNT_ID, pollReading(20, 30)); // polled at BASE
		feed(45, 35, BASE + 4 * MINUTE_MS);
		nowSpy.mockReturnValue(BASE + 5 * MINUTE_MS);

		const acc = await list();
		const data = acc?.usageData as UsageData | null;

		expect(data?.five_hour?.utilization).toBe(45);
		expect(data?.seven_day.utilization).toBe(35);
		// Windows no header carries are the poll's, as polled.
		expect(data?.seven_day_opus?.utilization).toBe(7);
		expect(acc?.usageAsOfIso).toBe(new Date(BASE).toISOString());
		expect(acc?.usageWindowAsOfIso).toEqual({
			five_hour: new Date(BASE + 4 * MINUTE_MS).toISOString(),
			seven_day: new Date(BASE + 4 * MINUTE_MS).toISOString(),
		});
	});

	it("carries no per-window stamps without header readings", async () => {
		usageCache.set(ACCOUNT_ID, pollReading(20, 30));

		const acc = await list();

		expect((acc?.usageData as UsageData | null)?.five_hour?.utilization).toBe(
			20,
		);
		expect(acc?.usageWindowAsOfIso ?? null).toBeNull();
	});

	it("annotates throttling from the view the proxy throttles on", async () => {
		// Three hours into the 5h window: 99% is far ahead of pace, 20% is not.
		usageCache.setWithAgeForTests(ACCOUNT_ID, pollReading(20, 10), 0);
		feed(99, 10, BASE);

		const acc = await list(true);

		expect(acc?.usageThrottledUntil).not.toBeNull();
		expect(acc?.usageThrottledWindows).toContain("five_hour");
	});
});
