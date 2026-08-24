/**
 * The accounts list serves each account's revision anchors keyed to the SAME
 * reading it serves — an anchor from another window instance must be omitted,
 * not shipped for the client to mis-apply. Harness mirrors
 * accounts-prediction.test.ts (same fake adapter surface).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import {
	clearUsageRevisionAnchors,
	observeUsageReading,
} from "@clankermux/proxy";
import type { AccountResponse } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

const HOUR_MS = 60 * 60 * 1000;
const ACCOUNT_ID = "acc-anchored";

function makeDbOps(accounts: unknown[]): DatabaseOperations {
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

function accountRow() {
	return {
		id: ACCOUNT_ID,
		name: "Anchored",
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
	};
}

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

async function fetchAccount(): Promise<AccountResponse> {
	const handler = createAccountsListHandler(makeDbOps([accountRow()]), config);
	const response = await handler();
	const body = (await response.json()) as AccountResponse[];
	const account = body.find((a) => a.id === ACCOUNT_ID);
	if (!account) throw new Error("account missing from response");
	return account;
}

describe("accounts list burn-anchor wiring", () => {
	beforeEach(() => {
		usageCache.delete(ACCOUNT_ID);
		clearUsageRevisionAnchors(ACCOUNT_ID);
	});
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		clearUsageRevisionAnchors(ACCOUNT_ID);
	});

	it("serves the anchor when it matches the served reading's window", async () => {
		const now = Date.now();
		const sevenReset = now + 2 * 24 * HOUR_MS;
		const giftAt = now - 6 * HOUR_MS;

		observeUsageReading(ACCOUNT_ID, "seven_day", {
			pct: 55,
			resetMs: sevenReset,
			observedAtMs: giftAt - 2 * 60_000,
		});
		observeUsageReading(ACCOUNT_ID, "seven_day", {
			pct: 3,
			resetMs: sevenReset,
			observedAtMs: giftAt,
		});

		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(now + 3 * HOUR_MS).toISOString(),
			},
			seven_day: {
				utilization: 20,
				resets_at: new Date(sevenReset).toISOString(),
			},
		});

		const account = await fetchAccount();
		expect(account.burnAnchors?.sevenDay).toEqual({
			anchorMs: giftAt,
			anchorPct: 3,
			windowResetMs: sevenReset,
		});
		expect(account.burnAnchors?.fiveHour ?? null).toBeNull();
	});

	it("omits an anchor whose window no longer matches the served reading", async () => {
		const now = Date.now();
		const oldReset = now - 1 * 24 * HOUR_MS;

		// Anchor observed in a window that has since rolled over.
		observeUsageReading(ACCOUNT_ID, "seven_day", {
			pct: 55,
			resetMs: oldReset,
			observedAtMs: now - 30 * HOUR_MS,
		});
		observeUsageReading(ACCOUNT_ID, "seven_day", {
			pct: 3,
			resetMs: oldReset,
			observedAtMs: now - 29 * HOUR_MS,
		});

		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(now + 3 * HOUR_MS).toISOString(),
			},
			seven_day: {
				utilization: 20,
				// The CURRENT window: a different instance than the anchor's.
				resets_at: new Date(now + 6 * 24 * HOUR_MS).toISOString(),
			},
		});

		const account = await fetchAccount();
		expect(account.burnAnchors ?? null).toBeNull();
	});
});
