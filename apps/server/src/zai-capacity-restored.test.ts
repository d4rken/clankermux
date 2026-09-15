/**
 * The Z.AI half of the early-release path, end to end from the poll to the
 * clear: a usage poll that observes account-wide headroom must report
 * capacity-restored evidence, and the listener must release a cooldown whose
 * reason is quota-derived.
 *
 * The two halves were separately inert. The zai poll branch never fired
 * `capacityRestoredCallbacks`, so nothing was ever reported; and the only
 * reasons the listener will act on are written by the proxy's account-wide
 * exhaustion rung, which excluded zai (pinned in
 * `packages/proxy/src/handlers/__tests__/proxy-operations-zai-exhausted.test.ts`).
 * Polling is the ONLY channel that observes a locked account recovering, so
 * without both a Z.AI cooldown ran to its deadline however early the quota came
 * back.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import type { CapacityRestoredEvidence } from "@clankermux/providers";
import { usageCache } from "@clankermux/providers";
import { mockFetch } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import {
	type CapacityRestoredLogger,
	type CapacityRestoredProbeMarker,
	clearRateLimitOnCapacityRestored,
} from "./capacity-restored";

const ACCOUNT_ID = "acc-zai-locked";
const HOUR = 60 * 60 * 1000;

interface ClearCall {
	accountId: string;
	expectedUntil: number;
	expectedAt: number | null;
	expectedReason: string;
	fetchStartedAt: number;
}

/** A Z.AI quota payload, as the endpoint serves it. */
function quotaResponse(percentage: number, resetAt: number) {
	return Response.json({
		success: true,
		data: {
			limits: [
				{
					type: "CREDIT_LIMIT",
					unit: 3,
					number: 5,
					usage: 2000,
					currentValue: 0,
					remaining: 2000 - percentage,
					percentage,
					nextResetTime: resetAt,
				},
				{
					type: "CREDIT_LIMIT",
					unit: 6,
					number: 1,
					usage: 10000,
					currentValue: 0,
					remaining: 10000 - percentage,
					percentage,
					nextResetTime: resetAt + 72 * HOUR,
				},
			],
		},
	});
}

function makeHarness(account: Account | null) {
	const clearCalls: ClearCall[] = [];
	const debugMsgs: string[] = [];
	const markerCalls: string[] = [];
	let generation = 0;
	return {
		clearCalls,
		debugMsgs,
		markerCalls,
		marker: {
			markPending: (accountId: string) => {
				generation += 1;
				markerCalls.push(`mark:${generation}`);
				return { accountId, generation, previous: null, rolledBack: false };
			},
			rollbackPending: (reservation) => {
				markerCalls.push(`rollback:${reservation.generation}`);
			},
		} satisfies CapacityRestoredProbeMarker,
		logger: {
			debug: (m: string) => debugMsgs.push(m),
			info: () => {},
			warn: () => {},
		} satisfies CapacityRestoredLogger,
		dbOps: {
			getAccount: async () => account,
			clearRateLimitOnCapacityRestore: async (
				accountId: string,
				expectedUntil: number,
				expectedAt: number | null,
				expectedReason: string,
				fetchStartedAt: number,
			) => {
				clearCalls.push({
					accountId,
					expectedUntil,
					expectedAt,
					expectedReason,
					fetchStartedAt,
				});
				return true;
			},
			stampObservedRateLimitReset: async () => true,
		} as unknown as Pick<
			DatabaseOperations,
			| "getAccount"
			| "clearRateLimitOnCapacityRestore"
			| "stampObservedRateLimitReset"
		>,
	};
}

function lockedAccount(reason: string, until: number, at: number): Account {
	return {
		id: ACCOUNT_ID,
		name: "Z.AI-1",
		provider: "zai",
		rate_limited_until: until,
		rate_limited_at: at,
		rate_limited_reason: reason,
		rate_limit_reset: null,
		paused: false,
	} as unknown as Account;
}

/**
 * Run one real Z.AI usage poll against a stubbed endpoint and return whatever
 * evidence it reported, or null when it reported none.
 */
async function pollForEvidence(
	percentage: number,
): Promise<CapacityRestoredEvidence | null> {
	let reported: CapacityRestoredEvidence | null = null;
	globalThis.fetch = mockFetch(async () =>
		quotaResponse(percentage, Date.now() + 2 * HOUR),
	);
	usageCache.startPolling(
		ACCOUNT_ID,
		"zai-key",
		"zai",
		3_600_000,
		undefined,
		undefined,
		(evidence) => {
			reported = evidence;
		},
	);
	try {
		expect(await usageCache.refreshNow(ACCOUNT_ID)).toBe(true);
	} finally {
		usageCache.stopPolling(ACCOUNT_ID);
	}
	return reported;
}

describe("a Z.AI poll releases a quota-derived cooldown early", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		usageCache.delete(ACCOUNT_ID);
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		usageCache.stopPolling(ACCOUNT_ID);
		usageCache.delete(ACCOUNT_ID);
	});

	it("clears a weekly_exhausted_429 lock when the poll sees headroom", async () => {
		const evidence = await pollForEvidence(20);
		if (!evidence) throw new Error("the poll reported no evidence");
		expect(evidence.accountId).toBe(ACCOUNT_ID);
		expect(evidence.utilization).toBe(20);
		expect(evidence.extraUsageUtilization).toBeNull();
		// Two windows with resets, so the listener's staleness test has something
		// to match a recorded reset against.
		expect(evidence.observedWindows).toHaveLength(2);

		// The cooldown was written BEFORE the poll went out, so it is orderable
		// against this evidence.
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 48 * HOUR,
			evidence.fetchStartedAt - 5_000,
		);
		const h = makeHarness(account);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence,
			h.marker,
		);

		expect(h.clearCalls).toEqual([
			{
				accountId: ACCOUNT_ID,
				expectedUntil: account.rate_limited_until as number,
				expectedAt: account.rate_limited_at as number,
				expectedReason: "weekly_exhausted_429",
				fetchStartedAt: evidence.fetchStartedAt,
			},
		]);
	});

	it("reports nothing at all while a window is still spent", async () => {
		expect(await pollForEvidence(100)).toBeNull();
	});

	it("refuses to release a lock whose reason is not quota-derived", async () => {
		const evidence = await pollForEvidence(20);
		if (!evidence) throw new Error("the poll reported no evidence");
		const h = makeHarness(
			lockedAccount(
				"upstream_429_with_reset",
				Date.now() + 60_000,
				evidence.fetchStartedAt - 5_000,
			),
		);
		await clearRateLimitOnCapacityRestored(
			h.dbOps,
			h.logger,
			evidence,
			h.marker,
		);
		expect(h.clearCalls).toEqual([]);
	});
});
