/**
 * `fenceAndRefetch` and `noteRateLimited`, the two UsageCache entry points a
 * banked-reset claim needs.
 *
 * After a claim clears a window, a usage fetch that left BEFORE the claim can
 * still land afterwards carrying the pre-claim (exhausted) reading. The fence
 * makes such a fetch unable to write the cache or fire its callbacks, and the
 * refetch behind it must be a fresh request rather than a join onto that
 * in-flight one.
 *
 * Idioms follow usage-polling-initial-delay.test.ts: the real usageCache
 * singleton, a stubbed global fetch, per-test unique account ids.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import {
	type CapacityRestoredEvidence,
	parseRetryAfterMs,
	USAGE_RATE_LIMITED_DEFAULT_MS,
	usageCache,
} from "../usage-fetcher";
import { openUsageReadGapForEachTest } from "./open-usage-read-gap";

openUsageReadGapForEachTest();

const HOUR = 60 * 60 * 1000;

function usageResponse(utilization: number): Response {
	const future = new Date(Date.now() + HOUR).toISOString();
	return new Response(
		JSON.stringify({
			five_hour: { utilization, resets_at: future },
			seven_day: { utilization, resets_at: future },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function fiveHourUtilization(accountId: string): number | undefined {
	const data = usageCache.peek(accountId) as {
		five_hour?: { utilization: number };
	} | null;
	return data?.five_hour?.utilization;
}

function hasArmedTimer(accountId: string): boolean {
	return (
		usageCache as unknown as { pollTimeouts: Map<string, unknown> }
	).pollTimeouts.has(accountId);
}

let counter = 0;
const cleanups: string[] = [];
function freshId(label: string): string {
	const id = `fence-${label}-${Date.now()}-${counter++}`;
	cleanups.push(id);
	return id;
}

let fetchSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = null;
	for (const id of cleanups.splice(0)) {
		usageCache.stopPolling(id);
		usageCache.delete(id);
	}
});

/**
 * First fetch parks on a deferred response; every later one answers at once
 * with `laterUtilization`.
 */
function stubFetch(laterUtilization: number) {
	const first = deferred<Response>();
	let calls = 0;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		mockFetch(async () => {
			calls++;
			return calls === 1 ? first.promise : usageResponse(laterUtilization);
		}),
	);
	return { releaseFirst: first.resolve, calls: () => calls };
}

async function untilCalls(calls: () => number, n: number): Promise<void> {
	for (let i = 0; i < 100 && calls() < n; i++) {
		await new Promise((r) => setTimeout(r, 1));
	}
	expect(calls()).toBe(n);
}

describe("UsageCache.fenceAndRefetch", () => {
	it("drops a pre-fence fetch that resolves after the fence and stores a fresh one", async () => {
		const id = freshId("drop");
		const { releaseFirst, calls } = stubFetch(10);
		const evidence: CapacityRestoredEvidence[] = [];
		usageCache.startPolling(
			id,
			async () => "token",
			"anthropic",
			HOUR,
			null,
			undefined,
			(e) => evidence.push(e),
			undefined,
			undefined,
			undefined,
			{ initialDelayMs: HOUR },
		);

		const preFence = usageCache.refreshNow(id);
		await untilCalls(calls, 1);

		// The fresh fetch is a second request, not a join onto the parked one.
		expect(await usageCache.fenceAndRefetch(id)).toBe(true);
		expect(calls()).toBe(2);
		expect(fiveHourUtilization(id)).toBe(10);
		expect(evidence.map((e) => e.utilization)).toEqual([10]);

		// The pre-fence response lands late with its own (older) reading.
		releaseFirst(usageResponse(60));
		expect(await preFence).toBe(false);
		expect(fiveHourUtilization(id)).toBe(10);
		expect(evidence.map((e) => e.utilization)).toEqual([10]);
	});

	it("keeps the poll loop armed when the fence drops its first fetch", async () => {
		const id = freshId("loop");
		const { releaseFirst, calls } = stubFetch(10);
		usageCache.startPolling(id, async () => "token", "anthropic", HOUR, null);
		await untilCalls(calls, 1);

		expect(await usageCache.fenceAndRefetch(id)).toBe(true);
		releaseFirst(usageResponse(60));
		for (let i = 0; i < 50 && !hasArmedTimer(id); i++) {
			await new Promise((r) => setTimeout(r, 1));
		}
		expect(hasArmedTimer(id)).toBe(true);
		expect(fiveHourUtilization(id)).toBe(10);
	});

	it("reports false for an account with no poller", async () => {
		expect(await usageCache.fenceAndRefetch(freshId("none"))).toBe(false);
	});
});

describe("UsageCache.noteRateLimited", () => {
	it("records a deadline read back by getRateLimitedUntil", () => {
		const id = freshId("note");
		const until = Date.now() + 60_000;
		usageCache.noteRateLimited(id, until);
		expect(usageCache.getRateLimitedUntil(id)).toBe(until);
	});

	it("keeps the later of the existing and the new deadline", () => {
		const id = freshId("later");
		const long = Date.now() + 10 * 60_000;
		usageCache.noteRateLimited(id, long);
		usageCache.noteRateLimited(id, Date.now() + 60_000);
		expect(usageCache.getRateLimitedUntil(id)).toBe(long);

		const longer = long + 60_000;
		usageCache.noteRateLimited(id, longer);
		expect(usageCache.getRateLimitedUntil(id)).toBe(longer);
	});

	it("exports a bounded five-minute default for a 429 without Retry-After", () => {
		expect(USAGE_RATE_LIMITED_DEFAULT_MS).toBe(5 * 60 * 1000);
	});
});

describe("parseRetryAfterMs", () => {
	const NOW = Date.parse("2026-09-22T12:00:00Z");

	it("reads delta-seconds", () => {
		expect(parseRetryAfterMs("120", NOW)).toBe(120_000);
		expect(parseRetryAfterMs("1.5", NOW)).toBe(1_500);
	});

	it("reads an HTTP-date as the delay until it", () => {
		expect(parseRetryAfterMs("Tue, 22 Sep 2026 12:05:00 GMT", NOW)).toBe(
			5 * 60_000,
		);
	});

	it("returns null for missing, malformed, zero and past values", () => {
		for (const value of [
			null,
			"",
			"soon",
			"-5",
			"0",
			"Tue, 22 Sep 2026 11:00:00 GMT",
		]) {
			expect(parseRetryAfterMs(value, NOW)).toBeNull();
		}
	});
});
