import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { usageCache } from "../usage-fetcher";

/**
 * A poll generation that has been replaced (reauth → stopPolling + startPolling)
 * may still have work in flight. That work must not touch ANY state belonging to
 * the live generation: not the failure streak that drives exponential backoff,
 * and certainly not the poller itself.
 */

const ACCOUNT = "test-generation-isolation";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function healthyResponse(): Response {
	const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	return new Response(
		JSON.stringify({
			five_hour: { utilization: 10, resets_at: future },
			seven_day: { utilization: 20, resets_at: future },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Whitebox view of the private backoff bookkeeping. */
function failureCount(accountId: string): number | undefined {
	return (
		usageCache as unknown as { failureCounts: Map<string, number> }
	).failureCounts.get(accountId);
}

describe("UsageCache — superseded fetches cannot corrupt the live generation", () => {
	let fetchSpy: ReturnType<typeof spyOn> | null = null;

	afterEach(() => {
		usageCache.stopPolling(ACCOUNT);
		usageCache.delete(ACCOUNT);
		fetchSpy?.mockRestore();
		fetchSpy = null;
	});

	it("a stale FAILED fetch does not seed the replacement poller's failure streak", async () => {
		// Without the superseded result, the stale failure was counted against the
		// live generation, pushing a perfectly healthy poller into exponential
		// backoff (up to a 30-minute wake) and letting its usage data go stale.
		let release: (() => void) | null = null;
		let served = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
			served++;
			if (served === 1) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return new Response("boom", { status: 500 });
			}
			return healthyResponse();
		});

		// Generation 1: its immediate fetch parks in flight.
		usageCache.startPolling(ACCOUNT, "token-1", "anthropic", 60 * 60 * 1000);
		await wait(10);

		// Reauth: generation 2 replaces it and polls healthily.
		usageCache.stopPolling(ACCOUNT);
		usageCache.startPolling(ACCOUNT, "token-2", "anthropic", 60 * 60 * 1000);
		await wait(20);
		expect(failureCount(ACCOUNT)).toBeUndefined();

		// Generation 1's fetch now fails — for a generation that no longer exists.
		release?.();
		await wait(20);

		expect(failureCount(ACCOUNT)).toBeUndefined();
		// And the live generation is still healthy (its cache entry stands).
		expect(usageCache.get(ACCOUNT)).not.toBeNull();
	});

	it("a stale token-refresh failure handler cannot stop the replacement poller", async () => {
		// onTokenRefreshFailure awaits a DB read. A reauth during that read used to
		// let the OLD generation's verdict call stopPolling() on the LIVE one,
		// deleting its token provider, callbacks and cache — polling stayed dead
		// until an explicit restart.
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
			healthyResponse(),
		);

		let handlerEntered = false;
		let releaseHandler: (() => void) | null = null;
		const handlerGate = new Promise<void>((resolve) => {
			releaseHandler = resolve;
		});

		usageCache.startPolling(
			ACCOUNT,
			async () => {
				throw new Error("dead refresh token");
			},
			"anthropic",
			60 * 60 * 1000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			async () => {
				handlerEntered = true;
				await handlerGate; // the DB lookup is still in flight…
				return true; // …and its verdict is "halt polling"
			},
		);
		while (!handlerEntered) await wait(5);

		// Reauth installs generation 2 with a working token.
		usageCache.stopPolling(ACCOUNT);
		usageCache.startPolling(ACCOUNT, "token-2", "anthropic", 60 * 60 * 1000);
		await wait(20);

		// The stale handler's verdict lands AFTER the replacement.
		releaseHandler?.();
		await wait(20);

		// Generation 2 is untouched: still polling, still cached.
		expect(await usageCache.refreshNow(ACCOUNT)).toBe(true);
		expect(usageCache.get(ACCOUNT)).not.toBeNull();
		expect(failureCount(ACCOUNT)).toBeUndefined();
	});
});
