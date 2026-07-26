import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import type { AccountResponse, AnthropicUsageData } from "@clankermux/types";
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

	it("emits the structured rate-limit cause fields alongside the string", async () => {
		const until = Date.now() + 30 * 60_000;
		const body = await listAccounts([
			makeAccountRow({
				id: "acc-cause",
				rate_limit_status: "rejected",
				rate_limited: 1,
				rate_limited_until: until,
			}),
		]);
		const account = body.find((a) => a.id === "acc-cause");
		// `rejected` normalizes to the rate_limited cause; the raw value survives.
		expect(account?.rateLimitCause).toBe("rate_limited");
		expect(account?.rateLimitProviderStatus).toBe("rejected");
		expect(account?.rateLimitCauseResetMs).toBe(until);
		expect(account?.rateLimitStatus).toBe("rate_limited (30m)");
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

/**
 * End-to-end wiring of the account-wide exhaustion verdict through the
 * serialized `/api/accounts` payload. The resolver unit tests above take the
 * verdict as an argument, so only this level can prove the handler actually
 * derives it — which is exactly what regressed: the handler called the
 * weekly-only helper, so a session-exhausted account was serialized as
 * `rate_limited` even though the proxy had classified it
 * `session_exhausted_429`.
 */
describe("/api/accounts — usage_exhausted binding", () => {
	const ACCOUNT_ID = "acc-binding";
	const BASE = 1_785_000_000_000;
	const MINUTE = 60_000;
	const HOUR = 60 * MINUTE;
	let nowSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		nowSpy = spyOn(Date, "now").mockReturnValue(BASE);
		usageCache.delete(ACCOUNT_ID);
	});
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		nowSpy.mockRestore();
	});

	/** Flat Anthropic usage with the two account-wide window percentages. */
	function usage(sessionPct: number, weeklyPct: number): AnthropicUsageData {
		return {
			five_hour: {
				utilization: sessionPct,
				resets_at: new Date(BASE + 2 * HOUR).toISOString(),
			},
			seven_day: {
				utilization: weeklyPct,
				resets_at: new Date(BASE + 3 * 24 * HOUR).toISOString(),
			},
		} as AnthropicUsageData;
	}

	async function accountFor(
		data: AnthropicUsageData,
		ageMs = 0,
	): Promise<AccountResponse | undefined> {
		usageCache.set(ACCOUNT_ID, data); // stamped at the mocked BASE
		nowSpy.mockReturnValue(BASE + ageMs);
		const body = await listAccounts([
			makeAccountRow({ id: ACCOUNT_ID, provider: "anthropic" }),
		]);
		return body.find((a) => a.id === ACCOUNT_ID);
	}

	it("reports a session-exhausted account as usage_exhausted bound to `session`", async () => {
		const account = await accountFor(usage(100, 40));
		expect(account?.rateLimitCause).toBe("usage_exhausted");
		expect(account?.rateLimitCauseBinding).toBe("session");
	});

	it("reports a weekly-exhausted account as usage_exhausted bound to `weekly`", async () => {
		const account = await accountFor(usage(20, 100));
		expect(account?.rateLimitCause).toBe("usage_exhausted");
		expect(account?.rateLimitCauseBinding).toBe("weekly");
	});

	it("reports a null binding for a healthy account", async () => {
		const account = await accountFor(usage(20, 40));
		expect(account?.rateLimitCause).toBe("ok");
		expect(account?.rateLimitCauseBinding).toBeNull();
	});

	// FRESH-GATE: past the 10-minute routing TTL but inside the 30-minute UI
	// horizon, the reading is still rendered (with its age) — but the fast-moving
	// 5h session window may no longer be asserted from it. The slow weekly
	// windows still may.
	it("stops asserting SESSION exhaustion once the reading is past the routing TTL", async () => {
		const account = await accountFor(usage(100, 40), 12 * MINUTE);
		// The bars still render from the aged reading…
		expect(account?.usageData).not.toBeNull();
		// …but the session claim is withdrawn.
		expect(account?.rateLimitCause).not.toBe("usage_exhausted");
		expect(account?.rateLimitCauseBinding).toBeNull();
	});

	it("still asserts WEEKLY exhaustion from the same aged reading", async () => {
		const account = await accountFor(usage(20, 100), 12 * MINUTE);
		expect(account?.rateLimitCause).toBe("usage_exhausted");
		expect(account?.rateLimitCauseBinding).toBe("weekly");
	});
});
