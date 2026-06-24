/**
 * Behavioral test for the onTokenRefreshFailure halt hook on the real
 * UsageCache: when the token provider throws during a poll tick and the hook
 * returns true, polling must STOP (no reschedule); when it returns false (or is
 * absent) polling keeps retrying with backoff.
 *
 * The throw path never reaches the network (tokenProvider throws first), so no
 * fetch mocking is needed. We use a unique account id per test to isolate from
 * the shared singleton's state, and assert on how many times the throwing
 * tokenProvider is invoked.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "../usage-fetcher";

const ids: string[] = [];
function freshId(label: string): string {
	const id = `halt-${label}-${Math.floor(performance.now())}-${ids.length}`;
	ids.push(id);
	return id;
}

afterEach(() => {
	for (const id of ids.splice(0)) usageCache.stopPolling(id);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("UsageCache token-refresh halt hook", () => {
	it("stops polling (no reschedule) when the hook returns true", async () => {
		const id = freshId("stop");
		let calls = 0;
		const tokenProvider = async () => {
			calls++;
			throw new Error('invalid_grant {"error":"invalid_grant"}');
		};
		usageCache.startPolling(
			id,
			tokenProvider,
			"anthropic",
			20, // base interval ms
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			async () => true, // onTokenRefreshFailure → halt
		);
		await wait(150);
		// Only the immediate fetch ran; the loop halted before any reschedule.
		expect(calls).toBe(1);
	});

	it("keeps retrying when the hook returns false", async () => {
		const id = freshId("retry");
		let calls = 0;
		const tokenProvider = async () => {
			calls++;
			throw new Error("network timeout"); // transient, not invalid_grant
		};
		usageCache.startPolling(
			id,
			tokenProvider,
			"anthropic",
			20,
			null,
			undefined,
			undefined,
			undefined,
			undefined,
			async () => false, // do not halt
		);
		await wait(150);
		// Immediate fetch + at least one backoff retry.
		expect(calls).toBeGreaterThanOrEqual(2);
	});
});
