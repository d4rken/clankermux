/**
 * The shared /oauth/usage rate-limit deadline, as the poll sees it. The
 * banked-reset status read and the usage poll share one upstream bucket, so a
 * deadline recorded by either must hold both: no request while it stands, no
 * writer shortening or erasing it, and only a successful fetch clearing it.
 *
 * Idioms follow usage-cache-fence.test.ts: the real usageCache singleton, a
 * stubbed global fetch, per-test unique account ids.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import { USAGE_RATE_LIMITED_DEFAULT_MS, usageCache } from "../usage-fetcher";

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

interface PollInternals {
	pollSchedule: Map<string, { wakeAt: number }>;
	failureCounts: Map<string, number>;
}
const internals = usageCache as unknown as PollInternals;

let counter = 0;
const cleanups: string[] = [];
function freshId(label: string): string {
	const id = `deadline-${label}-${Date.now()}-${counter++}`;
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

function stubFetch(respond: (call: number) => Promise<Response> | Response) {
	let calls = 0;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		mockFetch(async () => respond(++calls)),
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

describe("the shared usage rate-limit deadline", () => {
	it("refreshNow sends no request while the deadline stands", async () => {
		const id = freshId("refresh");
		const calls = stubFetch(() => usageResponse(10));
		startIdle(id);
		usageCache.noteRateLimited(id, Date.now() + 10 * 60_000);

		expect(await usageCache.refreshNow(id)).toBe(false);
		expect(calls()).toBe(0);
	});

	it("the scheduled poll skips its request and re-arms for the deadline, counting no failure", async () => {
		const id = freshId("poll");
		const calls = stubFetch(() => usageResponse(10));
		const deadline = Date.now() + 20 * 60_000;
		usageCache.noteRateLimited(id, deadline);
		// Immediate first fetch: the poll's own entry point.
		usageCache.startPolling(id, async () => "token", "anthropic", HOUR, null);

		await until(() => (internals.pollSchedule.get(id)?.wakeAt ?? 0) > 0);
		expect(calls()).toBe(0);
		expect(internals.failureCounts.get(id)).toBeUndefined();
		const wakeAt = internals.pollSchedule.get(id)?.wakeAt ?? 0;
		expect(Math.abs(wakeAt - deadline)).toBeLessThan(1_000);
		expect(usageCache.getRateLimitedUntil(id)).toBe(deadline);
	});

	it("a 429 without Retry-After records the bounded default deadline", async () => {
		const id = freshId("headerless");
		stubFetch(() => new Response("{}", { status: 429 }));
		startIdle(id);
		const before = Date.now();
		expect(await usageCache.refreshNow(id)).toBe(false);
		const recorded = usageCache.getRateLimitedUntil(id) ?? 0;
		expect(recorded).toBeGreaterThanOrEqual(
			before + USAGE_RATE_LIMITED_DEFAULT_MS,
		);
		expect(recorded).toBeLessThanOrEqual(
			Date.now() + USAGE_RATE_LIMITED_DEFAULT_MS,
		);
	});

	it("a shorter Retry-After does not replace a longer deadline set meanwhile", async () => {
		const id = freshId("max");
		const parked = deferred<Response>();
		stubFetch(() => parked.promise);
		startIdle(id);
		const pending = usageCache.refreshNow(id);
		await new Promise((r) => setTimeout(r, 5));
		const long = Date.now() + 30 * 60_000;
		usageCache.noteRateLimited(id, long);
		parked.resolve(
			new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
		);
		expect(await pending).toBe(false);
		expect(usageCache.getRateLimitedUntil(id)).toBe(long);
	});

	it("a non-429 failure keeps a deadline set meanwhile", async () => {
		const id = freshId("keep");
		const parked = deferred<Response>();
		stubFetch(() => parked.promise);
		startIdle(id);
		const pending = usageCache.refreshNow(id);
		await new Promise((r) => setTimeout(r, 5));
		const deadline = Date.now() + 10 * 60_000;
		usageCache.noteRateLimited(id, deadline);
		parked.resolve(new Response("oops", { status: 500 }));
		expect(await pending).toBe(false);
		expect(usageCache.getRateLimitedUntil(id)).toBe(deadline);
	});

	it("a successful fetch that left before a newer deadline keeps it", async () => {
		const id = freshId("older-success");
		const parked = deferred<Response>();
		stubFetch(() => parked.promise);
		startIdle(id);
		const pending = usageCache.refreshNow(id);
		await new Promise((r) => setTimeout(r, 5));
		const deadline = Date.now() + 10 * 60_000;
		usageCache.noteRateLimited(id, deadline);
		parked.resolve(usageResponse(10));
		expect(await pending).toBe(true);
		expect(usageCache.getRateLimitedUntil(id)).toBe(deadline);
	});

	it("sends no request when the deadline is recorded while the token is fetched", async () => {
		const id = freshId("token-await");
		const calls = stubFetch(() => usageResponse(10));
		const deadline = Date.now() + 10 * 60_000;
		usageCache.startPolling(
			id,
			async () => {
				usageCache.noteRateLimited(id, deadline);
				return "token";
			},
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
		expect(await usageCache.refreshNow(id)).toBe(false);
		expect(calls()).toBe(0);
		expect(internals.failureCounts.get(id)).toBeUndefined();
		expect(usageCache.getRateLimitedUntil(id)).toBe(deadline);
	});

	it("without a deadline, a failed poll still counts toward backoff as before", async () => {
		const id = freshId("cadence");
		const calls = stubFetch(() => new Response("oops", { status: 500 }));
		usageCache.startPolling(id, async () => "token", "anthropic", HOUR, null);
		await until(() => internals.failureCounts.get(id) === 1);
		expect(calls()).toBe(1);
		expect(usageCache.getRateLimitedUntil(id)).toBeNull();
	});

	it("a 429 with Retry-After still schedules the next poll at the server's delay", async () => {
		const id = freshId("retry-after");
		stubFetch(
			() =>
				new Response("{}", { status: 429, headers: { "retry-after": "1800" } }),
		);
		const before = Date.now();
		usageCache.startPolling(id, async () => "token", "anthropic", HOUR, null);
		await until(() => (internals.pollSchedule.get(id)?.wakeAt ?? 0) > 0);
		expect(internals.failureCounts.get(id)).toBe(1);
		const wakeAt = internals.pollSchedule.get(id)?.wakeAt ?? 0;
		expect(wakeAt - before).toBeGreaterThanOrEqual(1_800_000 - 1_000);
		expect(wakeAt - before).toBeLessThanOrEqual(1_800_000 + 5_000);
	});
});
