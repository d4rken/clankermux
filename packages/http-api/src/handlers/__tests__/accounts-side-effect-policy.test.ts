/**
 * The side-effect policy on the shared account assembler.
 *
 * `listAccountResponses` is consumed by two surfaces with different rights: the
 * management accounts page, which owns the Codex reset-credit recovery and is
 * entitled to refresh what the proxy can see, and the UNAUTHENTICATED
 * `GET /public/v1/pacing`, which reads the same array through the pacing scan.
 * Reusing the assembler gave the public read both of the management surface's
 * writes: a background upstream refresh per Codex account, and a payload-scan
 * re-seed of the usage cache that ROUTING reads.
 *
 * The policy is the enforcement, so it is asserted from both sides: the default
 * still does exactly what the management page has always done, and `read-only`
 * performs neither write while resolving the SAME reading.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import {
	codexRateLimitResetCreditsCache,
	usageCache,
} from "@clankermux/providers";
import {
	registerCodexResetCreditsRefresher,
	unregisterCodexResetCreditsRefresher,
} from "@clankermux/proxy";
import type { AccountResponse } from "@clankermux/types";

import { listAccountResponses } from "../accounts";

const HOUR_MS = 60 * 60 * 1000;
const ACCOUNT_ID = "acct-codex-policy";
const REFRESHER_ID = "side-effect-policy-test";

/** Accounts a refresh was dispatched for, in call order. */
let refreshed: string[] = [];

/** A stored request payload carrying Codex usage response headers. */
function payloadRow(timestampMs: number, sevenDayPercent: number) {
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

function makeDbOps(lastUsedMs: number): DatabaseOperations {
	const accounts = [
		{
			id: ACCOUNT_ID,
			name: "Codex Policy",
			provider: "codex",
			request_count: 0,
			total_requests: 0,
			last_used: lastUsedMs,
			created_at: lastUsedMs - HOUR_MS,
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
		},
	];
	return {
		getAdapter: () => ({
			query: async (sql: string) => {
				if (sql.includes("FROM accounts")) return accounts;
				if (sql.includes("request_payloads")) {
					return [payloadRow(lastUsedMs, 33)];
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
	sideEffects?: "management" | "read-only",
): Promise<AccountResponse | undefined> {
	const accounts = await listAccountResponses(
		makeDbOps(Date.now() - 5 * 60_000),
		config,
		undefined,
		sideEffects === undefined ? undefined : { sideEffects },
	);
	// The dispatch is `void`-ed on purpose; let its microtask land before the
	// assertion reads the call list.
	await Promise.resolve();
	return accounts.find((a) => a.id === ACCOUNT_ID);
}

beforeEach(() => {
	refreshed = [];
	usageCache.delete(ACCOUNT_ID);
	codexRateLimitResetCreditsCache.clear();
	registerCodexResetCreditsRefresher(REFRESHER_ID, async (accountId) => {
		refreshed.push(accountId);
		return { success: true };
	});
});

afterEach(() => {
	unregisterCodexResetCreditsRefresher(REFRESHER_ID);
	usageCache.delete(ACCOUNT_ID);
	codexRateLimitResetCreditsCache.clear();
});

describe("account assembly side effects — management (the default)", () => {
	it("refreshes Codex reset credits upstream", async () => {
		await run();
		expect(refreshed).toEqual([ACCOUNT_ID]);
	});

	it("re-seeds the usage cache the proxy reads", async () => {
		await run();
		expect(usageCache.peekAge(ACCOUNT_ID)).not.toBeNull();
	});

	it("does the same when the policy is stated explicitly", async () => {
		await run("management");
		expect(refreshed).toEqual([ACCOUNT_ID]);
		expect(usageCache.peekAge(ACCOUNT_ID)).not.toBeNull();
	});
});

describe("account assembly side effects — read-only", () => {
	it("initiates no upstream Codex reset-credit refresh", async () => {
		// An anonymous GET must not be able to start a provider request, nor the
		// token-refresh handling behind one.
		await run("read-only");
		expect(refreshed).toEqual([]);
	});

	it("writes nothing into the usage cache that routing consumes", async () => {
		// The payload tier still WINS — the reading is identical — but the
		// re-seed that would put it in front of routing, throttling and capacity
		// decisions is withheld.
		await run("read-only");
		expect(usageCache.peekAge(ACCOUNT_ID)).toBeNull();
	});

	it("resolves the same reading the management policy does", async () => {
		const managed = await run("management");
		usageCache.delete(ACCOUNT_ID);
		codexRateLimitResetCreditsCache.clear();
		const readOnly = await run("read-only");
		expect(readOnly?.usageData?.seven_day?.utilization).toBe(33);
		expect(readOnly?.usageData).toEqual(managed?.usageData ?? null);
	});
});
