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

	// SF2 regression: replacing an ACTIVE demand-aware poller via startPolling
	// (WITHOUT a prior stopPolling) must leave it scheduled. The old code cleared
	// the existing timer but left its stale `pollTimeouts` entry, so the fresh
	// generation's async cold-start resolver bailed on the `pollTimeouts.has`
	// guard and the poller silently died. The fix deletes the entry on replacement
	// (and gates arming on a per-account generation token).
	it("replacing an active demand-aware poller (no stopPolling) keeps it scheduled", async () => {
		const id = freshId();
		const ACTIVE_MS = 40;
		// Async cold-start resolver reporting recent activity → active cadence. This
		// forces the armAfterResolve path that the SF2 bug broke.
		const policy = {
			demandAware: true,
			idleIntervalMs: 100_000,
			getLastActivityMs: async () => Date.now(),
		};
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
			policy,
		);
		// Let gen-1 arm its active timer and poll a couple of times.
		await wait(80);
		expect(fetchCalls).toBeGreaterThanOrEqual(1);

		// Replace WITHOUT stopPolling — this is the path the reauth flow does NOT
		// take (it stops first), so it exercises the direct-replacement bug.
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
			policy,
		);
		// Let the replacement's immediate fetch settle, then snapshot.
		await wait(40);
		const afterReplaceImmediate = fetchCalls;
		// The replaced generation must keep polling at the active cadence. With the
		// SF2 bug the poller would be permanently unscheduled here and the count
		// would stall at `afterReplaceImmediate`.
		await wait(250);
		expect(fetchCalls).toBeGreaterThan(afterReplaceImmediate);
	});

	// Also verify the reauth-shaped path (explicit stopPolling then startPolling)
	// ends with a single live, actively-polling timer.
	it("stopPolling() then startPolling() leaves one live active timer", async () => {
		const id = freshId();
		const ACTIVE_MS = 40;
		const policy = {
			demandAware: true,
			idleIntervalMs: 100_000,
			getLastActivityMs: async () => Date.now(),
		};
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
			policy,
		);
		await wait(80);
		usageCache.stopPolling(id);
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
			policy,
		);
		await wait(40);
		const afterRestartImmediate = fetchCalls;
		await wait(250);
		expect(fetchCalls).toBeGreaterThan(afterRestartImmediate);
	});

	// FIX 3: noteActivity must not grow `lastActivityAt` unbounded. It records
	// activity ONLY when a demand-aware poller is actually active for the account,
	// and stopPolling prunes the entry — so late responses after polling stops, or
	// traffic on non-demand-aware accounts, never leak an entry.
	it("noteActivity never leaves a lingering lastActivityAt entry", async () => {
		const id = freshId();
		const activityMap = (
			usageCache as unknown as { lastActivityAt: Map<string, number> }
		).lastActivityAt;

		// (a) No poller configured at all → pure no-op, no entry recorded.
		usageCache.noteActivity(id);
		expect(activityMap.has(id)).toBe(false);

		// (b) A NON-demand-aware poller → still a no-op (no entry recorded).
		usageCache.startPolling(
			id,
			async () => "fake-token",
			"anthropic",
			100_000,
			null,
		);
		await wait(20);
		usageCache.noteActivity(id);
		expect(activityMap.has(id)).toBe(false);
		usageCache.stopPolling(id);

		// (c) A demand-aware poller → records; stopPolling prunes; post-stop no-op.
		usageCache.startPolling(
			id,
			async () => "fake-token",
			"anthropic",
			100_000,
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ demandAware: true, idleIntervalMs: 100_000 },
		);
		await wait(20);
		usageCache.noteActivity(id);
		expect(activityMap.has(id)).toBe(true); // active demand-aware poller → recorded
		usageCache.stopPolling(id);
		expect(activityMap.has(id)).toBe(false); // pruned on stop
		usageCache.noteActivity(id); // stopped poller → no-op, stays absent
		expect(activityMap.has(id)).toBe(false);
	});
});
