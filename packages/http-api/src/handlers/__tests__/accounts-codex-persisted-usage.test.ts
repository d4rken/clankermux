/**
 * Codex usage recovery order in the accounts list.
 *
 * The dashboard used to reconstruct a Codex account's usage from the newest
 * STORED REQUEST PAYLOAD whenever the live cache was empty. Those headers can
 * predate the account's current window by hours, so a pre-lock 99% reading was
 * resurrected and re-seeded into the cache as if it were current. Every Codex
 * observation now persists its snapshot on the account row, and that column
 * wins whenever it is at least as new as anything a payload could carry.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type { AccountResponse } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

const HOUR_MS = 60 * 60 * 1000;
const ACCOUNT_ID = "acc-codex-persisted";

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
	codex_usage_json: string | null;
	codex_usage_observed_at: number | null;
}

function makeAccountRow(overrides: Partial<AccountRow>): AccountRow {
	return {
		id: ACCOUNT_ID,
		name: "Codex Persisted",
		provider: "codex",
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
		codex_usage_json: null,
		codex_usage_observed_at: null,
		...overrides,
	};
}

/** A stored request payload row carrying Codex usage response headers. */
function payloadRow(
	timestampMs: number,
	sevenDayPercent: number,
): { json: string; timestamp: number } {
	return {
		timestamp: timestampMs,
		json: JSON.stringify({
			response: {
				status: 200,
				headers: {
					"x-codex-secondary-window-minutes": String(7 * 24 * 60),
					"x-codex-secondary-used-percent": String(sevenDayPercent),
					"x-codex-secondary-reset-at": String(
						Math.floor((timestampMs + 3 * 24 * HOUR_MS) / 1000),
					),
				},
			},
			meta: { timestamp: timestampMs },
		}),
	};
}

function makeDbOps(
	accounts: AccountRow[],
	payloads: Array<{ json: string; timestamp: number }>,
	payloadQueries: string[],
): DatabaseOperations {
	return {
		getAdapter: () => ({
			query: async (sql: string) => {
				if (sql.includes("FROM accounts")) return accounts;
				if (sql.includes("request_payloads")) {
					payloadQueries.push(sql);
					return payloads;
				}
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

async function run(
	row: Partial<AccountRow>,
	payloads: Array<{ json: string; timestamp: number }> = [],
): Promise<{ account: AccountResponse | undefined; payloadQueries: string[] }> {
	const payloadQueries: string[] = [];
	const handler = createAccountsListHandler(
		makeDbOps([makeAccountRow(row)], payloads, payloadQueries),
		config,
	);
	const response = await handler();
	const body = (await response.json()) as AccountResponse[];
	return { account: body.find((a) => a.id === ACCOUNT_ID), payloadQueries };
}

/** The persisted-column snapshot: a live 7d window at `percent`. */
function persistedSnapshot(
	percent: number,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		five_hour: null,
		seven_day: {
			utilization: percent,
			resets_at: new Date(Date.now() + 3 * 24 * HOUR_MS).toISOString(),
		},
		...extra,
	});
}

beforeEach(() => usageCache.delete(ACCOUNT_ID));
afterEach(() => usageCache.delete(ACCOUNT_ID));

describe("accounts list — Codex persisted-usage recovery", () => {
	it("serves the column and skips the payload scan when it is newer than last_used", async () => {
		const now = Date.now();
		const { account, payloadQueries } = await run(
			{
				last_used: now - 2 * HOUR_MS,
				codex_usage_json: persistedSnapshot(100),
				codex_usage_observed_at: now - HOUR_MS,
			},
			[payloadRow(now - 2 * HOUR_MS, 99)],
		);

		expect(account?.usageData?.seven_day?.utilization).toBe(100);
		// The scan is not merely out-voted — it never runs.
		expect(payloadQueries).toHaveLength(0);
	});

	it("prefers a newer payload row over an older column", async () => {
		const now = Date.now();
		const { account, payloadQueries } = await run(
			{
				last_used: now - 10 * 60 * 1000,
				codex_usage_json: persistedSnapshot(40),
				codex_usage_observed_at: now - 6 * HOUR_MS,
			},
			[payloadRow(now - 10 * 60 * 1000, 77)],
		);

		expect(account?.usageData?.seven_day?.utilization).toBe(77);
		expect(payloadQueries).toHaveLength(1);
	});

	it("falls back to the payload scan when the column JSON is malformed", async () => {
		const now = Date.now();
		const { account, payloadQueries } = await run(
			{
				last_used: now - 10 * 60 * 1000,
				codex_usage_json: "{not json",
				codex_usage_observed_at: now,
			},
			[payloadRow(now - 10 * 60 * 1000, 55)],
		);

		expect(account?.usageData?.seven_day?.utilization).toBe(55);
		expect(payloadQueries).toHaveLength(1);
	});

	it("drops a column window whose reset has already passed", async () => {
		const now = Date.now();
		const expired = JSON.stringify({
			five_hour: null,
			seven_day: {
				utilization: 88,
				resets_at: new Date(now - HOUR_MS).toISOString(),
			},
		});

		const { account } = await run({
			last_used: null,
			codex_usage_json: expired,
			codex_usage_observed_at: now,
		});

		// The stale window is zeroed by the normalizer, which then finds nothing
		// live left to serve.
		expect(account?.usageData ?? null).toBeNull();
	});

	it("serves nothing when neither source has anything", async () => {
		const { account } = await run({ last_used: null });
		expect(account?.usageData ?? null).toBeNull();
		expect(account?.usageAsOfIso ?? null).toBeNull();
	});

	it("carries the column's credits state onto the served data", async () => {
		const now = Date.now();
		const { account } = await run({
			last_used: null,
			codex_usage_json: persistedSnapshot(30, {
				codexCredits: {
					hasCredits: true,
					balance: 4.5,
					unlimited: false,
					planType: "pro",
					weeklyUsedPct: 30,
				},
			}),
			codex_usage_observed_at: now,
		});

		expect(account?.codexCredits?.hasCredits).toBe(true);
		expect(account?.codexCredits?.balance).toBe(4.5);
	});

	it("labels served column data with its real observation time", async () => {
		const observedAt = Date.now() - 45 * 60 * 1000;
		const { account } = await run({
			last_used: null,
			codex_usage_json: persistedSnapshot(60),
			codex_usage_observed_at: observedAt,
		});

		expect(account?.usageAsOfIso).toBe(new Date(observedAt).toISOString());
	});

	it("does NOT re-seed the usage cache from the column (no relabelling as fresh)", async () => {
		const now = Date.now();
		await run({
			last_used: null,
			codex_usage_json: persistedSnapshot(70),
			codex_usage_observed_at: now - 3 * HOUR_MS,
		});

		expect(usageCache.peekAge(ACCOUNT_ID)).toBeNull();
	});

	it("still re-seeds the cache when a payload row wins (legacy behavior)", async () => {
		const now = Date.now();
		await run({ last_used: now - 5 * 60 * 1000 }, [
			payloadRow(now - 5 * 60 * 1000, 33),
		]);

		expect(usageCache.peekAge(ACCOUNT_ID)).not.toBeNull();
	});
});
