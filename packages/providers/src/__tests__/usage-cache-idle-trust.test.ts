/**
 * A poll reading stays current while the account has consumed nothing since
 * it was observed: without use its windows cannot rise, only fall at a reset,
 * which the capacity signal's passed-reset check already treats as unknown.
 *
 * Pollers are registered with a far-off first fetch unless a test needs the
 * poll loop itself; the global fetch is stubbed there.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import {
	getFreshPollCapacity,
	getFreshRoutingCapacity,
	getFreshRoutingUsage,
	USAGE_CACHE_TTL_MS,
	type UsageData,
	usageCache,
} from "../usage-fetcher";
import { openUsageReadGapForEachTest } from "./open-usage-read-gap";

openUsageReadGapForEachTest();

const HOUR = 3_600_000;
const BOUND = 180_000;

let counter = 0;
const cleanups: string[] = [];
function freshId(label: string): string {
	const id = `trust-${label}-${Date.now()}-${counter++}`;
	cleanups.push(id);
	return id;
}

afterEach(() => {
	for (const id of cleanups.splice(0)) {
		usageCache.stopPolling(id);
		usageCache.delete(id);
	}
});

function register(id: string, demandAware = true): void {
	usageCache.startPolling(
		id,
		async () => "token",
		"anthropic",
		90_000,
		null,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ demandAware, initialDelayMs: 10 * HOUR },
	);
}

function reading(
	fiveResetMs: number | null = Date.now() + 2 * HOUR,
): UsageData {
	return {
		five_hour: {
			utilization: 30,
			resets_at:
				fiveResetMs === null ? null : new Date(fiveResetMs).toISOString(),
		},
		seven_day: {
			utilization: 40,
			resets_at: new Date(Date.now() + 90 * HOUR).toISOString(),
		},
	};
}

const routingFresh = (id: string) =>
	getFreshRoutingUsage(usageCache, id, "anthropic", Date.now(), BOUND) !== null;
const pollFresh = (id: string) =>
	getFreshPollCapacity(usageCache, id, "anthropic", Date.now(), BOUND) !== null;

describe("idle trust — the poll's own freshness", () => {
	it("trusts a 5-minute-old poll when the last activity came before it", () => {
		const id = freshId("idle");
		register(id);
		usageCache.noteActivity(id, Date.now() - 10 * 60_000);
		usageCache.setWithAgeForTests(id, reading(), 5 * 60_000);

		expect(routingFresh(id)).toBe(true);
		expect(pollFresh(id)).toBe(true);
	});

	it("does not trust a poll with activity after it", () => {
		const id = freshId("used");
		register(id);
		usageCache.setWithAgeForTests(id, reading(), 5 * 60_000);
		usageCache.noteActivity(id, Date.now() - 60_000);

		expect(routingFresh(id)).toBe(false);
		expect(pollFresh(id)).toBe(false);
	});

	it("does not trust a poll when the account's activity is unknown", () => {
		const id = freshId("unknown");
		register(id);
		usageCache.setWithAgeForTests(id, reading(), 5 * 60_000);

		expect(routingFresh(id)).toBe(false);
		expect(pollFresh(id)).toBe(false);
	});

	it("does not trust a poll past the cache TTL", () => {
		const id = freshId("old");
		register(id);
		usageCache.noteActivity(id, Date.now() - 30 * 60_000);
		usageCache.setWithAgeForTests(id, reading(), USAGE_CACHE_TTL_MS + 1_000);

		expect(routingFresh(id)).toBe(false);
		expect(pollFresh(id)).toBe(false);
	});

	it("does not trust an account without a demand-aware poller", () => {
		const id = freshId("fixed");
		register(id, false);
		usageCache.noteActivity(id, Date.now() - 10 * 60_000);
		usageCache.setWithAgeForTests(id, reading(), 5 * 60_000);

		expect(routingFresh(id)).toBe(false);
	});

	it("still reads a trusted poll whose 5h reset has passed as unknown capacity", () => {
		const id = freshId("rolled");
		register(id);
		usageCache.noteActivity(id, Date.now() - 10 * 60_000);
		usageCache.setWithAgeForTests(id, reading(Date.now() - 1_000), 5 * 60_000);

		expect(routingFresh(id)).toBe(true);
		expect(
			getFreshRoutingCapacity(usageCache, id, "anthropic", Date.now(), BOUND),
		).toBeNull();
	});
});

describe("idle trust — quota use through this process", () => {
	it("an upstream send in flight suspends trust; its end after the poll voids it", () => {
		const id = freshId("in-flight");
		register(id);
		usageCache.noteActivity(id, Date.now() - 10 * 60_000);
		usageCache.setWithAgeForTests(id, reading(), 5 * 60_000);
		expect(routingFresh(id)).toBe(true);

		const end = usageCache.beginQuotaUse(id);
		expect(routingFresh(id)).toBe(false);
		end();
		expect(routingFresh(id)).toBe(false);

		// A poll observed after the send ended is trusted again.
		usageCache.setWithAgeForTests(id, reading(), 0);
		expect(routingFresh(id)).toBe(true);
	});

	it("counts a send as activity that makes the account's activity known", () => {
		const id = freshId("known-by-use");
		register(id);
		usageCache.beginQuotaUse(id)();
		usageCache.setWithAgeForTests(id, reading(), 0);

		expect(routingFresh(id)).toBe(true);
	});
});

describe("idle trust — cold start", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	beforeEach(() => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(
				async () =>
					new Response(JSON.stringify(reading()), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
	});
	afterEach(() => fetchSpy.mockRestore());

	const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

	function startWithResolver(id: string, lastUsed: number | null): void {
		usageCache.startPolling(
			id,
			async () => "token",
			"anthropic",
			90_000,
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ demandAware: true, getLastActivityMs: () => lastUsed },
		);
	}

	it("trusts a poll newer than the account's stored last use", async () => {
		const id = freshId("resolved");
		startWithResolver(id, Date.now() - HOUR);
		await wait(40);
		usageCache.setWithAgeForTests(id, reading(), 5 * 60_000);

		expect(routingFresh(id)).toBe(true);
	});

	it("does not trust a poll when the stored last use is unknown", async () => {
		const id = freshId("resolved-null");
		startWithResolver(id, null);
		await wait(40);
		usageCache.setWithAgeForTests(id, reading(), 5 * 60_000);

		expect(routingFresh(id)).toBe(false);
	});
});
