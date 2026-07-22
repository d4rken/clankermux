/**
 * Task 2 — Anthropic demand-aware usage polling.
 *
 * The cadence decision is a pure function (`computeDemandAwareInterval` /
 * `computePollDelay`) so most behavior is exercised deterministically with an
 * injected `now`, injected `jitterFraction: 0`, and a fake last-activity value —
 * no timers, no network (DI, never mock.module). The one timing-dependent
 * behavior (`noteActivity` re-arming a sleeping idle poller to the active
 * cadence) is exercised against the real `usageCache` singleton with a stubbed
 * global `fetch`, so no Anthropic endpoint is ever contacted.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	computeDemandAwareInterval,
	computePollDelay,
	usageCache,
} from "../usage-fetcher";

const ACTIVE = 90_000; // configured active cadence (getUsagePollIntervalMs default)
const IDLE = 10 * 60_000; // IDLE_POLL_INTERVAL_MS
const RECENCY = 15 * 60_000; // ACTIVITY_RECENCY_MS
const NOW = 1_000_000_000_000;

describe("demand-aware cadence — computeDemandAwareInterval", () => {
	it("recently-active account → active interval", () => {
		const r = computeDemandAwareInterval(
			{ demandAware: true },
			NOW - 60_000, // used 1 min ago
			ACTIVE,
			NOW,
		);
		expect(r).toEqual({ intervalMs: ACTIVE, isIdle: false });
	});

	it("cold account (activity older than recency) → idle interval", () => {
		const r = computeDemandAwareInterval(
			{ demandAware: true },
			NOW - (RECENCY + 1), // just past the recency window
			ACTIVE,
			NOW,
		);
		expect(r).toEqual({ intervalMs: IDLE, isIdle: true });
	});

	it("unknown/never-seen activity (null) → idle interval", () => {
		const r = computeDemandAwareInterval(
			{ demandAware: true },
			null,
			ACTIVE,
			NOW,
		);
		expect(r).toEqual({ intervalMs: IDLE, isIdle: true });
	});

	it("exactly at the recency boundary → idle (strict <)", () => {
		const r = computeDemandAwareInterval(
			{ demandAware: true },
			NOW - RECENCY, // now - last === recency, not < recency
			ACTIVE,
			NOW,
		);
		expect(r.isIdle).toBe(true);
	});

	it("idle interval respects max(active, 10min) when configured active > 10min", () => {
		const bigActive = 15 * 60_000; // 15-min configured cadence exceeds the idle floor
		const r = computeDemandAwareInterval(
			{ demandAware: true },
			null, // cold
			bigActive,
			NOW,
		);
		// Idle must never be *shorter* than the configured active interval.
		expect(r).toEqual({ intervalMs: bigActive, isIdle: true });
	});

	it("non-demand-aware (policy omitted) → fixed active interval regardless of activity", () => {
		const stale = computeDemandAwareInterval(
			{},
			NOW - 10 * RECENCY, // very old
			ACTIVE,
			NOW,
		);
		expect(stale).toEqual({ intervalMs: ACTIVE, isIdle: false });
		const fresh = computeDemandAwareInterval({}, NOW, ACTIVE, NOW);
		expect(fresh).toEqual({ intervalMs: ACTIVE, isIdle: false });
	});

	it("honors idleIntervalMs / activityRecencyMs overrides", () => {
		const r = computeDemandAwareInterval(
			{ demandAware: true, idleIntervalMs: 300_000, activityRecencyMs: 60_000 },
			NOW - 120_000, // 2 min ago: past the 1-min override recency → idle
			ACTIVE,
			NOW,
		);
		expect(r).toEqual({ intervalMs: 300_000, isIdle: true });
	});
});

describe("demand-aware cadence — computePollDelay priority", () => {
	it("server retry-after wins outright over everything else", () => {
		const r = computePollDelay({
			demandAware: true,
			activeIntervalMs: ACTIVE,
			lastActivityMs: NOW, // active
			failures: 3, // would otherwise back off
			retryAfterMs: 12_345,
			now: NOW,
			jitterFraction: 0,
		});
		expect(r).toEqual({ delayMs: 12_345, isIdle: false });
	});

	it("failure backoff overrides the base cadence (active OR idle)", () => {
		// Recent activity would normally pick the active cadence, but a failure
		// streak must keep backing off: active * 2^failures.
		const r = computePollDelay({
			demandAware: true,
			activeIntervalMs: ACTIVE,
			lastActivityMs: NOW, // recently active
			failures: 2,
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0,
		});
		expect(r).toEqual({ delayMs: ACTIVE * 4, isIdle: false });
	});

	it("backoff is capped at 30 minutes", () => {
		const r = computePollDelay({
			demandAware: true,
			activeIntervalMs: ACTIVE,
			lastActivityMs: null,
			failures: 20, // huge → would blow past the cap
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0,
		});
		expect(r.delayMs).toBe(30 * 60 * 1000);
	});

	it("healthy + active applies jitter to the active interval", () => {
		const r = computePollDelay({
			demandAware: true,
			activeIntervalMs: ACTIVE,
			lastActivityMs: NOW, // active
			failures: 0,
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0.2, // +20%
		});
		expect(r).toEqual({ delayMs: ACTIVE * 1.2, isIdle: false });
	});

	it("healthy + cold picks the idle interval", () => {
		const r = computePollDelay({
			demandAware: true,
			activeIntervalMs: ACTIVE,
			lastActivityMs: null,
			failures: 0,
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0,
		});
		expect(r).toEqual({ delayMs: IDLE, isIdle: true });
	});
});

// Real singleton + stubbed fetch: proves noteActivity re-arms a sleeping idle
// poller to the active cadence. Uses tiny intervals so the active tick fires
// within the test but the idle sleep (100s) never would.
describe("demand-aware cadence — noteActivity re-arm (integration)", () => {
	const ids: string[] = [];
	function freshId(): string {
		const id = `demand-${Math.floor(performance.now())}-${ids.length}`;
		ids.push(id);
		return id;
	}
	let fetchSpy: ReturnType<typeof spyOn>;
	let fetchCalls = 0;

	beforeEach(() => {
		fetchCalls = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			fetchCalls++;
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 10, resets_at: null },
					seven_day: { utilization: 20, resets_at: null },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
	});
	afterEach(() => {
		for (const id of ids.splice(0)) usageCache.stopPolling(id);
		fetchSpy.mockRestore();
	});

	const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it("noteActivity on a sleeping idle account re-arms to the active cadence", async () => {
		const id = freshId();
		const ACTIVE_MS = 40;
		// demandAware + huge idle so a cold account sleeps far past the test window.
		usageCache.startPolling(
			id,
			async () => "fake-token",
			"anthropic",
			ACTIVE_MS,
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ demandAware: true, idleIntervalMs: 100_000 },
		);
		// Let the immediate fetch complete and the idle timer arm.
		await wait(30);
		const afterImmediate = fetchCalls; // === 1 (immediate fetch only)
		expect(afterImmediate).toBe(1);

		// Control: without activity it stays asleep on the 100s idle timer.
		await wait(120);
		expect(fetchCalls).toBe(afterImmediate);

		// Now signal activity → should re-arm to the ~40ms active cadence and poll.
		usageCache.noteActivity(id);
		await wait(200);
		expect(fetchCalls).toBeGreaterThan(afterImmediate);
	});

	it("noteActivity is a no-op for a non-demand-aware poller", async () => {
		const id = freshId();
		usageCache.startPolling(
			id,
			async () => "fake-token",
			"anthropic",
			100_000, // huge fixed interval, no policy → not demand-aware
			null,
		);
		await wait(30);
		const afterImmediate = fetchCalls;
		usageCache.noteActivity(id); // records activity but must NOT re-arm
		await wait(120);
		expect(fetchCalls).toBe(afterImmediate);
	});
});
