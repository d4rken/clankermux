/**
 * The per-account /oauth/usage read gap, as the usage cache enforces it.
 * Idioms follow usage-rate-limit-deadline.test.ts: the real usageCache
 * singleton, a stubbed global fetch, per-test unique account ids.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import { type UsageData, usageCache } from "../usage-fetcher";
import { ANTHROPIC_USAGE_READ_MIN_GAP_MS } from "../usage-read-budget";

const HOUR = 60 * 60 * 1000;
const GAP = ANTHROPIC_USAGE_READ_MIN_GAP_MS;

function reading(utilization: number): UsageData {
	const future = new Date(Date.now() + HOUR).toISOString();
	return {
		five_hour: { utilization, resets_at: future },
		seven_day: { utilization, resets_at: future },
	} as UsageData;
}

function usageResponse(utilization: number): Response {
	return new Response(JSON.stringify(reading(utilization)), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

interface PollInternals {
	pollSchedule: Map<string, { wakeAt: number }>;
	failureCounts: Map<string, number>;
}
const internals = usageCache as unknown as PollInternals;

let counter = 0;
const cleanups: string[] = [];
function freshId(label: string): string {
	const id = `read-gap-${label}-${Date.now()}-${counter++}`;
	cleanups.push(id);
	return id;
}

let fetchSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = null;
	usageCache.setAnthropicUsageReadStore(null);
	for (const id of cleanups.splice(0)) {
		usageCache.stopPolling(id);
		usageCache.delete(id);
	}
});

function stubFetch(respond: () => Response) {
	let calls = 0;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		mockFetch(async () => {
			calls++;
			return respond();
		}),
	);
	return () => calls;
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) {
		await new Promise((r) => setTimeout(r, 1));
	}
	expect(check()).toBe(true);
}

/** Polling registered, first fetch deferred an hour so only the test drives it. */
function startIdle(id: string): void {
	usageCache.startPolling(
		id,
		async () => "token",
		"anthropic",
		HOUR,
		null,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ initialDelayMs: HOUR },
	);
}

describe("the per-account usage read gap", () => {
	it("refreshNow inside the gap sends no request", async () => {
		const id = freshId("refresh");
		const calls = stubFetch(() => usageResponse(10));
		startIdle(id);

		expect(await usageCache.refreshNow(id)).toBe(true);
		expect(await usageCache.refreshNow(id)).toBe(false);
		expect(calls()).toBe(1);
	});

	it("the scheduled poll re-arms for the end of the gap, counting no failure", async () => {
		const id = freshId("poll");
		const calls = stubFetch(() => usageResponse(10));
		startIdle(id);
		expect(await usageCache.refreshNow(id)).toBe(true);
		const sentAt = Date.now();

		// Immediate first fetch from a replacement poller: the gap outlives it.
		usageCache.startPolling(id, async () => "token", "anthropic", HOUR, null);

		await until(() => (internals.pollSchedule.get(id)?.wakeAt ?? 0) > 0);
		expect(calls()).toBe(1);
		expect(internals.failureCounts.get(id)).toBeUndefined();
		const wakeAt = internals.pollSchedule.get(id)?.wakeAt ?? 0;
		expect(Math.abs(wakeAt - (sentAt + GAP))).toBeLessThan(1_000);
	});

	it("keeps the gap across stopPolling", async () => {
		const id = freshId("stop");
		const calls = stubFetch(() => usageResponse(10));
		startIdle(id);
		expect(await usageCache.refreshNow(id)).toBe(true);
		usageCache.stopPolling(id);
		startIdle(id);
		expect(await usageCache.refreshNow(id)).toBe(false);
		expect(calls()).toBe(1);
	});

	it("a slot taken outside the poll holds refreshNow off until it is released", async () => {
		const id = freshId("held");
		const calls = stubFetch(() => usageResponse(10));
		startIdle(id);
		const grant = usageCache.tryAcquireAnthropicUsageRead(id);
		if (!("slot" in grant)) throw new Error("expected a slot");

		expect(await usageCache.refreshNow(id)).toBe(false);
		grant.slot.cancel();
		expect(await usageCache.refreshNow(id)).toBe(true);
		expect(calls()).toBe(1);
	});

	it("a read noted outside the poll pushes refreshNow a full gap back", async () => {
		const id = freshId("noted");
		const readAt: string[] = [];
		const calls = stubFetch(() => usageResponse(10));
		usageCache.setAnthropicUsageReadStore({
			recordReadAt: (accountId) => readAt.push(accountId),
			recordReading: () => {},
		});
		startIdle(id);

		usageCache.noteAnthropicUsageRead(id);
		expect(readAt).toEqual([id]);
		expect(await usageCache.refreshNow(id)).toBe(false);
		expect(calls()).toBe(0);
	});

	it("persists each read when it is sent and each reading when it lands", async () => {
		const id = freshId("store");
		stubFetch(() => usageResponse(42));
		const readAt: Array<[string, number]> = [];
		const readings: Array<[string, UsageData, number]> = [];
		usageCache.setAnthropicUsageReadStore({
			recordReadAt: (accountId, at) => readAt.push([accountId, at]),
			recordReading: (accountId, data, observedAt) =>
				readings.push([accountId, data, observedAt]),
		});
		startIdle(id);
		const before = Date.now();

		expect(await usageCache.refreshNow(id)).toBe(true);
		expect(readAt).toHaveLength(1);
		expect(readAt[0]?.[0]).toBe(id);
		expect(readAt[0]?.[1]).toBeGreaterThanOrEqual(before);
		expect(readings).toHaveLength(1);
		expect(readings[0]?.[1].five_hour?.utilization).toBe(42);
		expect(readings[0]?.[2]).toBe(usageCache.peekWrittenAt(id) ?? -1);
	});
});

describe("reads the gap defers", () => {
	/** The account's gap ends `ms` from now. */
	function gapEndsIn(id: string, ms: number): void {
		usageCache.restoreAnthropicUsageRead(id, {
			lastReadAt: Date.now() - GAP + ms,
			reading: null,
			readingObservedAt: null,
		});
	}

	it("fenceAndRefetch inside the gap sends nothing, and the first read after it lands under the fence", async () => {
		const id = freshId("fence");
		let utilization = 10;
		const calls = stubFetch(() => usageResponse(utilization));
		gapEndsIn(id, 40);
		startIdle(id);

		expect(await usageCache.fenceAndRefetch(id)).toBe(false);
		expect(calls()).toBe(0);

		await new Promise((r) => setTimeout(r, 60));
		utilization = 3;
		expect(await usageCache.refreshNow(id)).toBe(true);
		expect(
			(usageCache.get(id) as UsageData | null)?.five_hour?.utilization,
		).toBe(3);
	});

	it("an on-demand read during the boot stagger defers the first scheduled fetch without a failure", async () => {
		const id = freshId("stagger");
		const calls = stubFetch(() => usageResponse(10));
		usageCache.startPolling(
			id,
			async () => "token",
			"anthropic",
			HOUR,
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: 20 },
		);
		expect(await usageCache.refreshNow(id)).toBe(true);
		const sentAt = Date.now();

		await until(
			() => (internals.pollSchedule.get(id)?.wakeAt ?? 0) > sentAt + 1_000,
		);
		expect(calls()).toBe(1);
		expect(internals.failureCounts.get(id)).toBeUndefined();
		const wakeAt = internals.pollSchedule.get(id)?.wakeAt ?? 0;
		expect(Math.abs(wakeAt - (sentAt + GAP))).toBeLessThan(1_000);
	});

	it("a deferred read reports nothing to the usage observer or the capacity-restored listener", async () => {
		const id = freshId("silent");
		stubFetch(() => usageResponse(10));
		const observed: string[] = [];
		const restored: string[] = [];
		gapEndsIn(id, GAP);
		usageCache.startPolling(
			id,
			async () => "token",
			"anthropic",
			HOUR,
			null,
			undefined,
			(evidence) => restored.push(evidence.accountId),
			undefined,
			undefined,
			undefined,
			{
				initialDelayMs: HOUR,
				onAnthropicUsageObservation: async (observation) => {
					observed.push(observation.outcome);
				},
			},
		);

		expect(await usageCache.refreshNow(id)).toBe(false);
		await usageCache.waitForAnthropicUsageObservation(id);
		expect(observed).toEqual([]);
		expect(restored).toEqual([]);
	});
});

describe("restoreAnthropicUsageRead", () => {
	it("starts the gap from the last process's read", async () => {
		const id = freshId("seed-gap");
		const calls = stubFetch(() => usageResponse(10));
		usageCache.restoreAnthropicUsageRead(id, {
			lastReadAt: Date.now() - 10_000,
			reading: null,
			readingObservedAt: null,
		});
		startIdle(id);

		expect(await usageCache.refreshNow(id)).toBe(false);
		expect(calls()).toBe(0);
	});

	it("caches the last reading at its observation age, not as fresh", () => {
		const id = freshId("seed-reading");
		const observedAt = Date.now() - 60_000;
		usageCache.restoreAnthropicUsageRead(id, {
			lastReadAt: observedAt,
			reading: reading(33),
			readingObservedAt: observedAt,
		});

		expect(
			(usageCache.get(id) as UsageData | null)?.five_hour?.utilization,
		).toBe(33);
		expect(usageCache.peekWrittenAt(id)).toBe(observedAt);
		expect(usageCache.peekWithAge(id)?.observedAtMs).toBe(observedAt);
	});

	it("starts the gap from the reading when the read time was never written", async () => {
		const id = freshId("seed-from-reading");
		const calls = stubFetch(() => usageResponse(10));
		usageCache.restoreAnthropicUsageRead(id, {
			lastReadAt: null,
			reading: reading(20),
			readingObservedAt: Date.now() - 10_000,
		});
		startIdle(id);

		expect(await usageCache.refreshNow(id)).toBe(false);
		expect(calls()).toBe(0);
	});

	it("drops a reading stamped in the future, and does not start the gap from it", () => {
		const id = freshId("seed-future");
		usageCache.restoreAnthropicUsageRead(id, {
			lastReadAt: null,
			reading: reading(20),
			readingObservedAt: Date.now() + HOUR,
		});
		expect(usageCache.get(id)).toBeNull();
		expect(usageCache.anthropicUsageReadWaitMs(id)).toBe(0);
	});

	it("starts the gap no later than now from a read time stamped in the future", () => {
		const id = freshId("seed-future-read");
		usageCache.restoreAnthropicUsageRead(id, {
			lastReadAt: Date.now() + HOUR,
			reading: null,
			readingObservedAt: null,
		});
		expect(usageCache.anthropicUsageReadWaitMs(id)).toBeLessThanOrEqual(GAP);
	});

	it("never replaces a reading this process already holds", () => {
		const id = freshId("seed-keep");
		usageCache.set(id, reading(70));
		usageCache.restoreAnthropicUsageRead(id, {
			lastReadAt: null,
			reading: reading(5),
			readingObservedAt: Date.now() - 1_000,
		});
		expect(
			(usageCache.get(id) as UsageData | null)?.five_hour?.utilization,
		).toBe(70);
	});
});
