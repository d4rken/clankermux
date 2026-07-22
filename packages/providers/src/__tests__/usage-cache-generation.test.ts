/**
 * Regression test for the poll-loop generation race: when polling is restarted
 * (stopPolling + startPolling, e.g. on reauth) WHILE an old fetch is in flight,
 * the old fetch's completion must not reschedule a zombie loop with the stale
 * provider. The reschedule sites guard on provider IDENTITY, not mere presence.
 *
 * To exercise the race the old provider must be slow enough to still be in
 * flight across the restart. Providers throw (no network) and count invocations.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "../usage-fetcher";

const ids: string[] = [];
function freshId(label: string): string {
	const id = `gen-${label}-${Math.floor(performance.now())}-${ids.length}`;
	ids.push(id);
	return id;
}
afterEach(() => {
	for (const id of ids.splice(0)) usageCache.stopPolling(id);
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("UsageCache poll-loop generation guard", () => {
	it("a slow in-flight old fetch does not reschedule a zombie loop after restart", async () => {
		const id = freshId("swap");
		let callsA = 0;
		let callsB = 0;
		// Slow provider: counts on invocation, stays "in flight" ~50ms, then fails.
		const providerA = async () => {
			callsA++;
			await wait(50);
			throw new Error("provider A");
		};
		const providerB = async () => {
			callsB++;
			throw new Error("provider B");
		};

		// Start generation A; its immediate fetch invokes A and is in flight.
		usageCache.startPolling(id, providerA, "anthropic", 10, null);
		await wait(25); // A still in flight (50ms)
		const callsAAtSwap = callsA; // === 1

		// Restart (reauth path): stop, then start with a new provider, while A's
		// fetch is still in flight.
		usageCache.stopPolling(id);
		usageCache.startPolling(id, providerB, "anthropic", 10, null);

		await wait(280);

		// New generation B's loop is running.
		expect(callsB).toBeGreaterThanOrEqual(2);
		// The stale generation A did NOT spin up a zombie loop: A's in-flight
		// completion bails on the identity guard instead of rescheduling.
		expect(callsA - callsAAtSwap).toBe(0);
	});

	// The generation token is the AUTHORITATIVE replacement guard — it holds even
	// when the caller reuses the same tokenProvider reference (which defeats the
	// tokenProviders identity guard). These are whitebox checks against the two
	// arm entry points, gating deterministically on the generation value.
	type WhiteboxCache = {
		pollGenerations: Map<string, number>;
		pollTimeouts: Map<string, NodeJS.Timeout>;
		pollSchedule: Map<string, unknown>;
		armNextPoll: (
			accountId: string,
			tokenProvider: () => Promise<string>,
			generation: number,
			activeBaseMs: number,
			provider: string | undefined,
			customEndpoint: string | null | undefined,
			retryAfterMs: number | null,
			lastActivityMs: number | null,
		) => void;
		armAfterResolve: (
			accountId: string,
			tokenProvider: () => Promise<string>,
			generation: number,
			baseIntervalMs: number,
			provider: string | undefined,
			customEndpoint: string | null | undefined,
			resolved: number | null,
		) => void;
	};

	function cleanupWhitebox(cache: WhiteboxCache, id: string): void {
		const t = cache.pollTimeouts.get(id);
		if (t) clearTimeout(t);
		cache.pollTimeouts.delete(id);
		cache.pollSchedule.delete(id);
		cache.pollGenerations.delete(id);
	}

	it("a superseded generation cannot arm a timer via armNextPoll", () => {
		const id = freshId("arm-gen");
		const cache = usageCache as unknown as WhiteboxCache;
		const tp = async () => "";
		cache.pollGenerations.set(id, 2); // current generation is 2

		// Stale generation-1 arm attempt → NO-OP (no timer created).
		cache.armNextPoll(id, tp, 1, 90_000, "anthropic", null, null, Date.now());
		expect(cache.pollTimeouts.has(id)).toBe(false);

		// Current generation-2 arm → arms exactly one timer.
		cache.armNextPoll(id, tp, 2, 90_000, "anthropic", null, null, Date.now());
		expect(cache.pollTimeouts.has(id)).toBe(true);

		cleanupWhitebox(cache, id);
	});

	it("a superseded generation's async cold-start resolver cannot arm (armAfterResolve)", () => {
		const id = freshId("resolve-gen");
		const cache = usageCache as unknown as WhiteboxCache;
		cache.pollGenerations.set(id, 5); // current generation is 5

		// A stale generation-4 resolver settling AFTER replacement must not arm,
		// even though it would have passed the old `pollTimeouts.has` guard.
		cache.armAfterResolve(
			id,
			async () => "",
			4,
			90_000,
			"anthropic",
			null,
			Date.now(),
		);
		expect(cache.pollTimeouts.has(id)).toBe(false);

		cleanupWhitebox(cache, id);
	});
});
