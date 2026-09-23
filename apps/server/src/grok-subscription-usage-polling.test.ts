/**
 * The grok-subscription weekly pool, from the lifecycle entry point down to the
 * cache entry.
 *
 * Polling is started through `startUsagePollingFor`, the way the server starts
 * it from boot, re-auth, account-add priming and the manual refresh button,
 * because the registration is the joint: a working fetcher still reads nothing
 * if no lifecycle path installs a poller. These assert on the billing URL
 * actually being dialled rather than on a status code — the refresh endpoint
 * answers HTTP 200 with a JSON failure when no poller is installed, so a 200
 * proves nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { GrokSubscriptionUsageData } from "@clankermux/providers";
import {
	clearGrokSubscriptionUserIdCache,
	usageCache,
} from "@clankermux/providers";
import { mockFetch } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import {
	startUsagePollingFor,
	type UsagePollingStarters,
} from "./usage-polling-dispatch";

const ACCOUNT_ID = "acc-grok-weekly";
const HOUR = 60 * 60 * 1000;

function grokAccount(patch: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "SuperGrok-1",
		provider: "grok-subscription",
		// Created the device-flow way: no API key at all.
		api_key: null,
		access_token: "grok-access",
		refresh_token: "grok-refresh",
		paused: false,
		...patch,
	} as unknown as Account;
}

const starters = (): UsagePollingStarters => ({
	startAnthropic: () => {
		throw new Error("a grok-subscription account must not take this path");
	},
	startDevin: () => {
		throw new Error("a grok-subscription account must not take this path");
	},
	createTokenProvider: () => async () => "grok-access",
	resetAccountSession: () => {
		throw new Error("a weekly pool has no session window to reset");
	},
	onCapacityRestored: () => {},
	getApiKey: async () => null,
	intervalMs: () => 3_600_000,
});

function billingResponse(
	config: Record<string, unknown> = {},
	resetAt = Date.now() + 5 * 24 * HOUR,
): Response {
	return Response.json({
		config: {
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: new Date(resetAt - 7 * 24 * HOUR).toISOString(),
				end: new Date(resetAt).toISOString(),
			},
			onDemandCap: { val: 0 },
			onDemandUsed: { val: 0 },
			prepaidBalance: { val: 0 },
			isUnifiedBillingUser: true,
			...config,
		},
	});
}

describe("a grok-subscription account is polled and cached", () => {
	let originalFetch: typeof globalThis.fetch;
	let dialled: string[] = [];

	function serveBilling(next: () => Response): void {
		globalThis.fetch = mockFetch(async (input) => {
			const url = String(input instanceof Request ? input.url : input);
			dialled.push(url);
			if (url.includes("/v1/user")) return Response.json({ userId: "u-1" });
			return next();
		});
	}

	function cached(): GrokSubscriptionUsageData | null {
		return usageCache.get(ACCOUNT_ID) as GrokSubscriptionUsageData | null;
	}

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		dialled = [];
		usageCache.delete(ACCOUNT_ID);
		clearGrokSubscriptionUserIdCache(ACCOUNT_ID);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		usageCache.stopPolling(ACCOUNT_ID);
		usageCache.delete(ACCOUNT_ID);
		clearGrokSubscriptionUserIdCache(ACCOUNT_ID);
	});

	it("dials the billing endpoint and fills the cache from one poll", async () => {
		const resetAt = Date.now() + 5 * 24 * HOUR;
		serveBilling(() => billingResponse({ creditUsagePercent: 63 }, resetAt));

		expect(startUsagePollingFor(grokAccount(), starters())).toBe(true);
		// Cold start: the cache is a process-local Map, so until this first poll
		// lands there is no reading at all. Unavailable, never 0%.
		expect(cached()).toBeNull();

		expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);

		expect(
			dialled.some((url) =>
				url.startsWith("https://cli-chat-proxy.grok.com/v1/billing"),
			),
		).toBe(true);
		expect(cached()).toEqual({
			kind: "grok-subscription",
			weeklyUtilization: 63,
			weeklyResetAt: resetAt,
			weeklyPeriodStartAt: resetAt - 7 * 24 * HOUR,
			onDemandCapCents: 0,
			onDemandUsedCents: 0,
			prepaidBalanceCents: 0,
		});
	});

	it("caches an absent percentage in the current period as 0%", async () => {
		serveBilling(() => billingResponse());

		startUsagePollingFor(grokAccount(), starters());
		expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);

		expect(cached()?.weeklyUtilization).toBe(0);
	});

	it("caches an explicit null percentage as unknown rather than as 0%", async () => {
		serveBilling(() => billingResponse({ creditUsagePercent: null }));

		startUsagePollingFor(grokAccount(), starters());
		expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);

		expect(cached()?.weeklyUtilization).toBeNull();
	});

	it("starts from a refresh token alone", async () => {
		serveBilling(() => billingResponse({ creditUsagePercent: 5 }));

		expect(
			startUsagePollingFor(
				grokAccount({ access_token: undefined }),
				starters(),
			),
		).toBe(true);
		expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);
		expect(cached()?.weeklyUtilization).toBe(5);
	});

	it("keeps the previous reading when the payload shape is unrecognized", async () => {
		let body = billingResponse({ creditUsagePercent: 63 });
		serveBilling(() => body);

		startUsagePollingFor(grokAccount(), starters());
		expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);
		const writtenAt = usageCache.peekWrittenAt(ACCOUNT_ID);

		// Not a weekly unified-billing period any more: nothing to cache, but
		// nothing failed either, so the poller must not back off and the known
		// reading must survive.
		body = Response.json({
			config: {
				currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
				isUnifiedBillingUser: false,
			},
		});
		expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);

		expect(cached()?.weeklyUtilization).toBe(63);
		expect(usageCache.peekWrittenAt(ACCOUNT_ID)).toBe(writtenAt);
	});

	it("keeps the previous reading when the billing endpoint fails", async () => {
		let body = billingResponse({ creditUsagePercent: 63 });
		serveBilling(() => body);

		startUsagePollingFor(grokAccount(), starters());
		expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);
		const writtenAt = usageCache.peekWrittenAt(ACCOUNT_ID);

		body = new Response("", { status: 503 });
		expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(false);

		expect(cached()?.weeklyUtilization).toBe(63);
		expect(usageCache.peekWrittenAt(ACCOUNT_ID)).toBe(writtenAt);
	});
});
