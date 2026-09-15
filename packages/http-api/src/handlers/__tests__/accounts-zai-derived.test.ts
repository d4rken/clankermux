/**
 * Z.AI reports the same two account-wide windows Anthropic does, so the derived
 * surfaces built on the snapshot series — the exhaustion prediction, the
 * last-known-usage fallback and the revision anchors — apply to it unchanged.
 * Each gate below dropped Z.AI accounts on its own. Harness mirrors
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
import type {
	AccountResponse,
	RankedSnapshot,
	UsageSnapshotSample,
} from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ACCOUNT_ID = "acc-zai";

function accountRow(provider = "zai") {
	return {
		id: ACCOUNT_ID,
		name: "Z.AI-1",
		provider,
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

function makeDbOps(
	latestSnapshots: RankedSnapshot[] = [],
	recentSnapshots: UsageSnapshotSample[] = [],
): DatabaseOperations {
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
		getLatestUsageSnapshots: async (ids: string[]) =>
			latestSnapshots.filter((s) => ids.includes(s.accountId)),
		getRecentUsageSnapshotsForAccounts: async (ids: string[]) =>
			recentSnapshots.filter((s) => ids.includes(s.accountId)),
	} as unknown as DatabaseOperations;
}

const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

async function fetchAccount(
	dbOps: DatabaseOperations,
): Promise<AccountResponse> {
	const handler = createAccountsListHandler(dbOps, config);
	const body = (await (await handler()).json()) as AccountResponse[];
	const account = body.find((a) => a.id === ACCOUNT_ID);
	if (!account) throw new Error("account missing from response");
	return account;
}

/** A live Z.AI reading with both account-wide windows. */
function zaiUsage(fiveHourReset: number, sevenDayReset: number) {
	return {
		time_limit: null,
		tokens_limit: {
			used: 60,
			remaining: 40,
			percentage: 60,
			resetAt: fiveHourReset,
			type: "tokens_limit",
		},
		tokens_limit_weekly: {
			used: 20,
			remaining: 80,
			percentage: 20,
			resetAt: sevenDayReset,
			type: "tokens_limit_weekly",
		},
	};
}

function snapshotSample(
	overrides: Partial<UsageSnapshotSample>,
): UsageSnapshotSample {
	return {
		accountId: ACCOUNT_ID,
		provider: "zai",
		sampledAt: Date.now(),
		fiveHourPct: null,
		fiveHourReset: null,
		sevenDayPct: null,
		sevenDayReset: null,
		observedAt: null,
		planTier: null,
		rateLimitTier: null,
		...overrides,
	};
}

describe("Z.AI accounts on the derived usage surfaces", () => {
	beforeEach(() => {
		usageCache.delete(ACCOUNT_ID);
		clearUsageRevisionAnchors(ACCOUNT_ID);
	});
	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		clearUsageRevisionAnchors(ACCOUNT_ID);
	});

	it("attaches a rising exhaustion prediction from stored snapshots plus the live reading", async () => {
		const now = Date.now();
		const reset = now + 3 * HOUR_MS;
		usageCache.set(ACCOUNT_ID, zaiUsage(reset, now + 3 * DAY_MS) as never);

		const account = await fetchAccount(
			makeDbOps(
				[],
				[10, 20, 30].map((pct, index) =>
					snapshotSample({
						sampledAt: now - (3 - index) * HOUR_MS,
						fiveHourPct: pct,
						fiveHourReset: reset,
					}),
				),
			),
		);

		expect(account.prediction?.fiveHour?.state).toBe("rising");
	});

	it("falls back to the last persisted snapshot when the live cache is cold", async () => {
		const now = Date.now();
		const account = await fetchAccount(
			makeDbOps([
				{
					accountId: ACCOUNT_ID,
					provider: "zai",
					ts: now - MINUTE_MS,
					fiveHourPct: 42,
					fiveHourReset: now + 90 * MINUTE_MS,
					sevenDayPct: 85,
					sevenDayReset: now + 3 * DAY_MS,
				},
			]),
		);

		expect(account.usageData).toBeNull();
		expect(account.staleUsage?.fiveHour?.utilization).toBe(42);
		expect(account.staleUsage?.sevenDay?.utilization).toBe(85);
	});

	it("serves the burn anchor detected for the window the reading belongs to", async () => {
		const now = Date.now();
		const sevenReset = now + 2 * DAY_MS;
		const giftAt = now - 6 * HOUR_MS;

		observeUsageReading(ACCOUNT_ID, "seven_day", {
			pct: 55,
			resetMs: sevenReset,
			observedAtMs: giftAt - 2 * MINUTE_MS,
		});
		observeUsageReading(ACCOUNT_ID, "seven_day", {
			pct: 3,
			resetMs: sevenReset,
			observedAtMs: giftAt,
		});

		usageCache.set(
			ACCOUNT_ID,
			zaiUsage(now + 3 * HOUR_MS, sevenReset) as never,
		);

		const account = await fetchAccount(makeDbOps());

		expect(account.burnAnchors?.sevenDay).toEqual({
			anchorMs: giftAt,
			anchorPct: 3,
			windowResetMs: sevenReset,
		});
	});
});
