/**
 * The grok-subscription half of the early-release path, end to end from the
 * billing read to the clear: a poll that observes weekly headroom must report
 * capacity-restored evidence, and the listener must release a cooldown whose
 * reason is quota-derived.
 *
 * Polling is started through `startUsagePollingFor`, the way the server starts
 * it, because the registration is the joint: an emitter and a listener that are
 * each correct still do nothing if the poller was never handed the callback.
 * The only reasons the listener will act on are written by the proxy's
 * account-wide exhaustion rung, which covers grok-subscription (pinned in
 * `packages/proxy/src/handlers/__tests__/proxy-operations-grok-subscription-exhausted.test.ts`).
 * Polling is the ONLY channel that observes a locked account recovering, so
 * without every link a cooldown here runs to its deadline however early the
 * weekly pool refilled.
 *
 * The other half of this file is the reverse property: every reading the parser
 * cannot vouch for must emit NO evidence at all. A fabricated number in the
 * optimistic direction releases a real lock on an account that is in fact
 * exhausted, and nothing un-clears a lock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import type { CapacityRestoredEvidence } from "@clankermux/providers";
import {
	clearGrokSubscriptionUserIdCache,
	usageCache,
} from "@clankermux/providers";
import { mockFetch } from "@clankermux/test-support";
import type { Account, GrokSubscriptionUsageData } from "@clankermux/types";
import {
	type CapacityRestoredLogger,
	type CapacityRestoredProbeMarker,
	clearRateLimitOnCapacityRestored,
} from "./capacity-restored";
import {
	startUsagePollingFor,
	type UsagePollingStarters,
} from "./usage-polling-dispatch";

const ACCOUNT_ID = "acc-grok-locked";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface ClearCall {
	accountId: string;
	expectedUntil: number;
	expectedAt: number | null;
	expectedReason: string;
	fetchStartedAt: number;
}

function makeHarness(account: Account | null) {
	const clearCalls: ClearCall[] = [];
	const debugMsgs: string[] = [];
	let generation = 0;
	return {
		clearCalls,
		debugMsgs,
		marker: {
			markPending: (accountId: string) => {
				generation += 1;
				return { accountId, generation, previous: null, rolledBack: false };
			},
			rollbackPending: () => {},
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

function lockedAccount(
	reason: string,
	until: number,
	at: number | null,
): Account {
	return {
		id: ACCOUNT_ID,
		name: "SuperGrok-1",
		provider: "grok-subscription",
		// Created the device-flow way: no API key at all.
		api_key: null,
		access_token: "grok-access",
		refresh_token: "grok-refresh",
		rate_limited_until: until,
		rate_limited_at: at,
		rate_limited_reason: reason,
		rate_limit_reset: null,
		paused: false,
	} as unknown as Account;
}

/** One `GET /v1/billing?format=credits` body, as the endpoint serves it. */
function billingResponse(
	config: Record<string, unknown>,
	resetAt = Date.now() + 5 * DAY,
): Response {
	return Response.json({
		config: {
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: new Date(resetAt - 7 * DAY).toISOString(),
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

const starters = (
	onCapacityRestored: (evidence: CapacityRestoredEvidence) => void,
): UsagePollingStarters => ({
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
	onCapacityRestored,
	getApiKey: async () => null,
	intervalMs: () => 3_600_000,
});

/**
 * Run one real billing poll against a stubbed endpoint, started through the
 * dispatcher the server itself uses, and settle whatever the listener did with
 * the evidence. `onRequest` runs at the instant the billing request reaches the
 * stub — i.e. while it is in flight — which is how the in-flight cooldown below
 * is written. Returns the reported evidence, or null when none was reported.
 */
async function pollThroughDispatch(
	serve: () => Response,
	account: Account,
	h: ReturnType<typeof makeHarness>,
	onRequest: () => void = () => {},
): Promise<CapacityRestoredEvidence | null> {
	let reported: CapacityRestoredEvidence | null = null;
	const listening: Promise<void>[] = [];
	globalThis.fetch = mockFetch(async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/v1/user")) return Response.json({ userId: "u-1" });
		onRequest();
		return serve();
	});
	const started = startUsagePollingFor(
		account,
		starters((evidence) => {
			reported = evidence;
			listening.push(
				clearRateLimitOnCapacityRestored(h.dbOps, h.logger, evidence, h.marker),
			);
		}),
	);
	expect(started).toBe(true);
	try {
		await usageCache.refreshNow(ACCOUNT_ID);
		await Promise.all(listening);
	} finally {
		// Snapshot BEFORE stopping: stopPolling drops the cache entry along with
		// the poller, so a read after it always answers "no reading".
		lastCached = usageCache.get(ACCOUNT_ID) as GrokSubscriptionUsageData | null;
		usageCache.stopPolling(ACCOUNT_ID);
	}
	return reported;
}

/** What the poll left in the cache, captured by {@link pollThroughDispatch}. */
let lastCached: GrokSubscriptionUsageData | null = null;

function cached(): GrokSubscriptionUsageData | null {
	return lastCached;
}

/** The rejection token the listener logged, without its account-specific tail. */
function skipTokens(debugMsgs: string[]): string[] {
	return debugMsgs.flatMap((m) => {
		const match = m.match(/capacity_restored_skip (\w+)/);
		return match ? [match[1]] : [];
	});
}

describe("a grok-subscription poll releases a quota-derived cooldown early", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		lastCached = null;
		usageCache.delete(ACCOUNT_ID);
		clearGrokSubscriptionUserIdCache(ACCOUNT_ID);
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		usageCache.stopPolling(ACCOUNT_ID);
		usageCache.delete(ACCOUNT_ID);
		clearGrokSubscriptionUserIdCache(ACCOUNT_ID);
	});

	it("clears a weekly_exhausted_429 lock when the poll sees headroom", async () => {
		// The cooldown was written BEFORE the poll goes out, so it is orderable
		// against the evidence that poll reports.
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 5 * DAY,
			Date.now() - 5_000,
		);
		const resetAt = Date.now() + 3 * DAY;
		const h = makeHarness(account);
		let respondedAt = 0;
		const evidence = await pollThroughDispatch(
			() => billingResponse({ creditUsagePercent: 20 }, resetAt),
			account,
			h,
			() => {
				respondedAt = Date.now();
			},
		);
		if (!evidence) throw new Error("the poll reported no evidence");
		expect(evidence.accountId).toBe(ACCOUNT_ID);
		expect(evidence.utilization).toBe(20);
		// No overage axis: on-demand spend is cents against a cap, not a window.
		expect(evidence.extraUsageUtilization).toBeNull();
		// The one window there is, so the listener's staleness test has the weekly
		// refill to match a recorded reset against.
		expect(evidence.observedWindows).toEqual([
			{ resetMs: resetAt, utilization: 20 },
		]);
		// The causal boundary is the instant the request LEFT, not the instant it
		// landed: anything later would let evidence appear to predate a cooldown
		// that was in fact written first.
		expect(evidence.fetchStartedAt).toBeLessThanOrEqual(respondedAt);

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

	it("reports nothing at all while the weekly pool is still spent", async () => {
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 5 * DAY,
			Date.now() - 5_000,
		);
		const h = makeHarness(account);
		expect(
			await pollThroughDispatch(
				() => billingResponse({ creditUsagePercent: 100 }),
				account,
				h,
			),
		).toBeNull();
		expect(h.clearCalls).toEqual([]);
	});

	it("reports an absent percentage in the current period as 0% evidence", async () => {
		// The billing schema drops `creditUsagePercent` exactly when it is 0, so a
		// running week with the field absent is a measured, untouched pool.
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 5 * DAY,
			Date.now() - 5_000,
		);
		const h = makeHarness(account);
		const evidence = await pollThroughDispatch(
			() => billingResponse({}),
			account,
			h,
		);
		expect(evidence?.utilization).toBe(0);
		expect(h.clearCalls).toHaveLength(1);
	});

	it("reports nothing when the percentage is UNKNOWN", async () => {
		// An explicit null is not the wire's zero. Reported as 0% it would read as
		// full headroom and release the lock on an account nobody measured.
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 5 * DAY,
			Date.now() - 5_000,
		);
		const h = makeHarness(account);
		expect(
			await pollThroughDispatch(
				() => billingResponse({ creditUsagePercent: null }),
				account,
				h,
			),
		).toBeNull();
		expect(h.clearCalls).toEqual([]);
		// The reading itself is still cached — it carries a real weekly reset —
		// but its percentage stays null rather than collapsing to a number.
		expect(cached()?.weeklyUtilization).toBeNull();
	});

	it("reports nothing when the payload shape is unrecognized", async () => {
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 5 * DAY,
			Date.now() - 5_000,
		);
		const h = makeHarness(account);
		const evidence = await pollThroughDispatch(
			() =>
				Response.json({
					config: {
						currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
						creditUsagePercent: 4,
						isUnifiedBillingUser: false,
					},
				}),
			account,
			h,
		);
		// Nothing was cached and nothing was reported, so the 4% in a shape this
		// parser does not vouch for cannot reach the lock.
		expect(evidence).toBeNull();
		expect(cached()).toBeNull();
		expect(h.clearCalls).toEqual([]);
	});

	it("reports nothing when the billing period has already ended", async () => {
		// A reset that has already arrived means the payload predates a roll: the
		// parser refuses it, so no evidence carries an elapsed reset instant.
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 5 * DAY,
			Date.now() - 5_000,
		);
		const h = makeHarness(account);
		expect(
			await pollThroughDispatch(
				() => billingResponse({ creditUsagePercent: 10 }, Date.now() - HOUR),
				account,
				h,
			),
		).toBeNull();
		expect(cached()).toBeNull();
		expect(h.clearCalls).toEqual([]);
	});

	it("reports nothing when the percentage is present but unusable", async () => {
		// Out of range: the parser fails the fetch rather than clamping, which
		// would invent a number in the most damaging direction available.
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 5 * DAY,
			Date.now() - 5_000,
		);
		const h = makeHarness(account);
		expect(
			await pollThroughDispatch(
				() => billingResponse({ creditUsagePercent: -5 }),
				account,
				h,
			),
		).toBeNull();
		expect(cached()).toBeNull();
		expect(h.clearCalls).toEqual([]);
	});

	it("refuses to release a lock whose reason is not quota-derived", async () => {
		// A per-IP burst 429 is unrelated to the weekly pool; releasing one on
		// quota evidence just re-storms it.
		const account = lockedAccount(
			"upstream_429_with_reset",
			Date.now() + 60_000,
			Date.now() - 5_000,
		);
		const h = makeHarness(account);
		expect(
			await pollThroughDispatch(
				() => billingResponse({ creditUsagePercent: 20 }),
				account,
				h,
			),
		).not.toBeNull();
		expect(h.clearCalls).toEqual([]);
		expect(skipTokens(h.debugMsgs)).toEqual(["ineligible_reason"]);
	});

	it("does not release a cooldown written while the billing request was in flight", async () => {
		// The cooldown starts absent and is written at the instant the request
		// reaches the endpoint, so its write instant is at or after the boundary
		// this poll captured before sending. Such a cooldown is temporally
		// ambiguous against the reading: the next poll re-reports and re-decides.
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 5 * DAY,
			null,
		);
		const h = makeHarness(account);
		const inFlight = { writtenAt: 0 };
		const evidence = await pollThroughDispatch(
			() => billingResponse({ creditUsagePercent: 20 }),
			account,
			h,
			() => {
				inFlight.writtenAt = Date.now();
				account.rate_limited_at = inFlight.writtenAt;
			},
		);
		if (!evidence) throw new Error("the poll reported no evidence");
		expect(inFlight.writtenAt).toBeGreaterThanOrEqual(evidence.fetchStartedAt);
		expect(h.clearCalls).toEqual([]);
		expect(skipTokens(h.debugMsgs)).toEqual(["cooldown_newer_than_evidence"]);
	});

	it("reports nothing when the billing endpoint fails", async () => {
		const account = lockedAccount(
			"weekly_exhausted_429",
			Date.now() + 5 * DAY,
			Date.now() - 5_000,
		);
		const h = makeHarness(account);
		expect(
			await pollThroughDispatch(
				() => new Response("", { status: 503 }),
				account,
				h,
			),
		).toBeNull();
		expect(h.clearCalls).toEqual([]);
	});
});
