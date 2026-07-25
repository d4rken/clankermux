import { describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import type { AccountResponse } from "@clankermux/types";
import { RATE_LIMIT_REASONS } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

/**
 * Regression guard for the hand-maintained allowlist that used to live in
 * `accounts.ts`: it omitted `family_weekly_exhausted_429`, so that reason was
 * written to the DB by the proxy and then silently nulled by `/api/accounts` —
 * its dashboard error card could never render. The validator now derives from
 * the same runtime tuple the `RateLimitReason` union comes from, so every member
 * must survive the round-trip.
 */

interface AccountRow {
	id: string;
	name: string;
	provider: string;
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
		id: "acc-reason",
		name: "Reason",
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

async function listAccounts(rows: AccountRow[]): Promise<AccountResponse[]> {
	const handler = createAccountsListHandler(makeDbOps(rows), config);
	const response = await handler();
	return (await response.json()) as AccountResponse[];
}

describe("/api/accounts — rate_limited_reason round-trip", () => {
	it("preserves EVERY reason in RATE_LIMIT_REASONS", async () => {
		const rows = RATE_LIMIT_REASONS.map((reason, i) =>
			makeAccountRow({
				id: `acc-${i}`,
				name: reason,
				rate_limited_reason: reason,
			}),
		);
		const body = await listAccounts(rows);
		for (const [i, reason] of RATE_LIMIT_REASONS.entries()) {
			const account = body.find((a) => a.id === `acc-${i}`);
			expect(account?.rateLimitedReason).toBe(reason);
		}
	});

	it("still nulls a reason the current build does not know", async () => {
		const body = await listAccounts([
			makeAccountRow({
				id: "acc-unknown",
				rate_limited_reason: "reason_from_a_future_version",
			}),
		]);
		expect(body.find((a) => a.id === "acc-unknown")?.rateLimitedReason).toBe(
			null,
		);
	});
});
