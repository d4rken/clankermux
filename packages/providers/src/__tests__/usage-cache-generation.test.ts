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
});
