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
	IDLE_REFRESH_LEAD_MS,
	USAGE_CACHE_TTL_MS,
	usageCache,
} from "../usage-fetcher";

const ACTIVE = 90_000; // configured active cadence (getUsagePollIntervalMs default)
const RECENCY = 15 * 60_000; // ACTIVITY_RECENCY_MS
const NOW = 1_000_000_000_000;
// The idle cadence is capped so a refresh always lands before the cache entry
// expires: TTL (10 min) minus the fetch-latency lead (1 min) => 9 min.
const IDLE_CAP = USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS;

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
		// The 10-min idle base is capped to 9 min so the refresh lands before the
		// cache entry expires.
		expect(r).toEqual({ intervalMs: IDLE_CAP, isIdle: true });
	});

	it("unknown/never-seen activity (null) → idle interval", () => {
		const r = computeDemandAwareInterval(
			{ demandAware: true },
			null,
			ACTIVE,
			NOW,
		);
		expect(r).toEqual({ intervalMs: IDLE_CAP, isIdle: true });
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

	it("healthy + cold picks the (capped) idle interval", () => {
		const r = computePollDelay({
			demandAware: true,
			activeIntervalMs: ACTIVE,
			lastActivityMs: null,
			failures: 0,
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0,
		});
		expect(r).toEqual({ delayMs: IDLE_CAP, isIdle: true });
	});
});

/**
 * Regression: an idle account's next poll must ALWAYS land before its cache
 * entry expires. Previously the idle cadence (10 min) equalled the cache TTL
 * (10 min) and carried symmetric ±20% jitter, so ~half of all idle cycles left
 * the entry expired for 30s–2min — long enough for the dashboard's evicting
 * read to return null and paint "Live usage unavailable" on a healthy account.
 */
describe("demand-aware cadence — idle refresh lands before the cache TTL", () => {
	// Sweep the full symmetric jitter range the scheduler can produce.
	const JITTER_SAMPLES = Array.from(
		{ length: 41 },
		(_, i) => -0.2 + i * 0.01, // -0.20 … +0.20
	);

	const idleDelay = (jitterFraction: number, activeIntervalMs = ACTIVE) =>
		computePollDelay({
			demandAware: true,
			activeIntervalMs,
			lastActivityMs: null, // cold → idle cadence
			failures: 0,
			retryAfterMs: null,
			now: NOW,
			jitterFraction,
		});

	it("idle delay is strictly under the cache TTL across the full jitter range", () => {
		for (const jitterFraction of JITTER_SAMPLES) {
			const { delayMs, isIdle } = idleDelay(jitterFraction);
			expect(isIdle).toBe(true);
			expect(delayMs).toBeLessThan(USAGE_CACHE_TTL_MS);
			// And by at least the fetch-latency lead, so the replacement lands first.
			expect(delayMs).toBeLessThanOrEqual(
				USAGE_CACHE_TTL_MS - IDLE_REFRESH_LEAD_MS,
			);
		}
	});

	it("idle jitter is negative-only: delay stays in [0.9, 1.0] x the capped interval", () => {
		for (const jitterFraction of JITTER_SAMPLES) {
			const { delayMs } = idleDelay(jitterFraction);
			expect(delayMs).toBeGreaterThanOrEqual(IDLE_CAP * 0.9);
			expect(delayMs).toBeLessThanOrEqual(IDLE_CAP);
		}
		// The extremes still de-synchronize accounts (not a constant delay).
		expect(idleDelay(0.2).delayMs).toBe(IDLE_CAP * 0.9);
		expect(idleDelay(-0.2).delayMs).toBe(IDLE_CAP * 0.9);
		expect(idleDelay(0).delayMs).toBe(IDLE_CAP);
	});

	it("caps an idleIntervalMs override that exceeds the TTL lead", () => {
		const r = computeDemandAwareInterval(
			{ demandAware: true, idleIntervalMs: 20 * 60_000 },
			null,
			ACTIVE,
			NOW,
		);
		expect(r).toEqual({ intervalMs: IDLE_CAP, isIdle: true });
	});

	it("leaves an idleIntervalMs override below the cap untouched", () => {
		const r = computeDemandAwareInterval(
			{ demandAware: true, idleIntervalMs: 5 * 60_000 },
			null,
			ACTIVE,
			NOW,
		);
		expect(r).toEqual({ intervalMs: 5 * 60_000, isIdle: true });
	});

	it("never polls an idle account faster than the configured active cadence", () => {
		// A configured active cadence above the cap wins: speeding an idle account
		// up to 9 min would spend MORE of the shared usage-endpoint quota than the
		// active cadence does, inverting the whole point of the idle cadence.
		const bigActive = 15 * 60_000;
		const r = computeDemandAwareInterval(
			{ demandAware: true },
			null,
			bigActive,
			NOW,
		);
		expect(r).toEqual({ intervalMs: bigActive, isIdle: true });
	});

	it("active cadence keeps its symmetric ±20% jitter (uncapped)", () => {
		const active = (jitterFraction: number) =>
			computePollDelay({
				demandAware: true,
				activeIntervalMs: ACTIVE,
				lastActivityMs: NOW, // recent → active cadence
				failures: 0,
				retryAfterMs: null,
				now: NOW,
				jitterFraction,
			});
		expect(active(0.2)).toEqual({ delayMs: ACTIVE * 1.2, isIdle: false });
		expect(active(-0.2)).toEqual({ delayMs: ACTIVE * 0.8, isIdle: false });
		expect(active(0)).toEqual({ delayMs: ACTIVE, isIdle: false });
	});

	it("does NOT cap a non-demand-aware provider's fixed cadence", () => {
		// Zai/Kilo/Alibaba pass no policy → isIdle is always false and their
		// configured cadence is used verbatim, even beyond the cache TTL.
		const fixed = 20 * 60_000;
		expect(computeDemandAwareInterval({}, null, fixed, NOW)).toEqual({
			intervalMs: fixed,
			isIdle: false,
		});
		const r = computePollDelay({
			activeIntervalMs: fixed,
			lastActivityMs: null,
			failures: 0,
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0.2,
		});
		expect(r).toEqual({ delayMs: fixed * 1.2, isIdle: false });
		expect(r.delayMs).toBeGreaterThan(USAGE_CACHE_TTL_MS);
	});

	it("leaves retry-after and failure backoff free to exceed the cache TTL", () => {
		// A failing account must keep backing off; letting its entry lapse is
		// correct (there is no fresh reading to protect).
		const retry = computePollDelay({
			demandAware: true,
			activeIntervalMs: ACTIVE,
			lastActivityMs: null,
			failures: 0,
			retryAfterMs: 25 * 60_000,
			now: NOW,
			jitterFraction: 0,
		});
		expect(retry).toEqual({ delayMs: 25 * 60_000, isIdle: false });

		const backoff = computePollDelay({
			demandAware: true,
			activeIntervalMs: ACTIVE,
			lastActivityMs: null,
			failures: 10,
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0,
		});
		expect(backoff.delayMs).toBeGreaterThan(USAGE_CACHE_TTL_MS);
		expect(backoff.isIdle).toBe(false);
	});

	// The cap must hold for EVERY demand-aware healthy delay, not just the idle
	// branch: `activeIntervalMs` is a caller-supplied parameter that may exceed
	// the cap, and noteActivity() re-arms a woken account to the ACTIVE cadence
	// with symmetric jitter. Clamping the post-jitter delay for both branches is
	// what makes the invariant configuration-independent — and at the ceiling the
	// idle delay simply equals the active one, so idle still never polls faster.
	it("clamps the post-jitter ACTIVE delay of a demand-aware account", () => {
		const nearCap = 9.5 * 60_000; // already above the 9-min cap
		const r = computePollDelay({
			demandAware: true,
			activeIntervalMs: nearCap,
			lastActivityMs: NOW, // recent → active cadence
			failures: 0,
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0.2, // would push it to 11.4 min
		});
		expect(r).toEqual({ delayMs: IDLE_CAP, isIdle: false });
	});

	it("holds the invariant for every configured cadence x jitter combination", () => {
		const configuredCadences = [
			90_000, // production default (apps/server/src/server.ts)
			5 * 60_000,
			9 * 60_000,
			15 * 60_000, // above the cap
			45 * 60_000, // far above the cap
		];
		for (const activeIntervalMs of configuredCadences) {
			for (const jitterFraction of JITTER_SAMPLES) {
				for (const lastActivityMs of [NOW, null]) {
					// active and idle
					const { delayMs } = computePollDelay({
						demandAware: true,
						activeIntervalMs,
						lastActivityMs,
						failures: 0,
						retryAfterMs: null,
						now: NOW,
						jitterFraction,
					});
					expect(delayMs).toBeLessThanOrEqual(IDLE_CAP);
				}
			}
		}
	});

	it("never schedules an idle poll sooner than the active one at the ceiling", () => {
		const bigActive = 15 * 60_000;
		const active = computePollDelay({
			demandAware: true,
			activeIntervalMs: bigActive,
			lastActivityMs: NOW,
			failures: 0,
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0,
		});
		const idle = computePollDelay({
			demandAware: true,
			activeIntervalMs: bigActive,
			lastActivityMs: null,
			failures: 0,
			retryAfterMs: null,
			now: NOW,
			jitterFraction: 0,
		});
		expect(idle.delayMs).toBeGreaterThanOrEqual(active.delayMs);
		expect(idle.delayMs).toBe(IDLE_CAP);
		expect(active.delayMs).toBe(IDLE_CAP);
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
	// Flipped by the refreshNow tests to drive the poll loop into failure backoff
	// and then let an on-demand refresh succeed.
	let fetchFails = false;

	beforeEach(() => {
		fetchCalls = 0;
		fetchFails = false;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			fetchCalls++;
			if (fetchFails) return new Response("nope", { status: 500 });
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

	// refreshNow() writes a fresh entry but used to leave the poll loop sitting in
	// whatever backoff earlier failures had earned. A 30-minute backoff outlives
	// the 10-minute cache TTL, so the proven-healthy reading expired long before
	// the next scheduled poll — exactly the gap this branch is closing.
	describe("refreshNow re-arms the poll schedule", () => {
		const failureCounts = () =>
			(usageCache as unknown as { failureCounts: Map<string, number> })
				.failureCounts;
		const pollSchedule = () =>
			(
				usageCache as unknown as {
					pollSchedule: Map<string, { wakeAt: number; isIdle: boolean }>;
				}
			).pollSchedule;

		const startDemandAware = (
			id: string,
			activeMs: number,
			idleIntervalMs = 100_000,
		) =>
			usageCache.startPolling(
				id,
				async () => "fake-token",
				"anthropic",
				activeMs,
				null,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ demandAware: true, idleIntervalMs },
			);

		// Wait until the loop is asleep on a backoff timer of at least `minFailures`
		// consecutive failures (rather than racing a fixed sleep against a tick).
		async function waitForBackoff(id: string, minFailures: number) {
			for (let i = 0; i < 200; i++) {
				if (
					(failureCounts().get(id) ?? 0) >= minFailures &&
					pollSchedule().has(id)
				)
					return;
				await wait(20);
			}
			throw new Error(`account ${id} never reached ${minFailures} failures`);
		}

		it("clears the failure streak and pulls the next poll in", async () => {
			const id = freshId();
			const ACTIVE_MS = 100;
			const IDLE_MS = 250; // the healthy cadence for this cold account
			fetchFails = true;
			startDemandAware(id, ACTIVE_MS, IDLE_MS);

			// Let the streak grow until the backoff (ACTIVE_MS * 2^failures) is
			// genuinely longer than the healthy cadence — the shape of the real bug,
			// where a 30-minute backoff outlives a 10-minute cache entry.
			await waitForBackoff(id, 3);
			const backoffRemaining =
				(pollSchedule().get(id)?.wakeAt ?? 0) - Date.now();
			expect(backoffRemaining).toBeGreaterThan(IDLE_MS);

			fetchFails = false;
			expect(await usageCache.refreshNow(id)).toBe(true);

			// The streak is disproven and the schedule is back on the healthy cadence.
			expect(failureCounts().has(id)).toBe(false);
			const rearmedRemaining =
				(pollSchedule().get(id)?.wakeAt ?? 0) - Date.now();
			expect(rearmedRemaining).toBeGreaterThan(0);
			expect(rearmedRemaining).toBeLessThanOrEqual(IDLE_MS);
			expect(rearmedRemaining).toBeLessThan(backoffRemaining);
		});

		it("does not push out the next poll when the account was already healthy", async () => {
			// Guard against the opposite failure: a dashboard that refreshes on a
			// timer must not be able to postpone scheduled polling indefinitely.
			const id = freshId();
			startDemandAware(id, 100_000);
			await wait(40);
			const before = pollSchedule().get(id)?.wakeAt;
			expect(before).toBeDefined();

			expect(await usageCache.refreshNow(id)).toBe(true);
			expect(pollSchedule().get(id)?.wakeAt).toBe(before as number);
		});

		it("never resurrects a stopped poller", async () => {
			const id = freshId();
			startDemandAware(id, 100_000);
			await wait(40);
			usageCache.stopPolling(id);

			expect(await usageCache.refreshNow(id)).toBe(false);
			expect(pollSchedule().has(id)).toBe(false);
			expect(failureCounts().has(id)).toBe(false);
		});
	});
});
