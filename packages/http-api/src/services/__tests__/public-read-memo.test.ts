import { describe, expect, it } from "bun:test";
import {
	createPublicReadMemo,
	PUBLIC_READ_FAILURE_TTL_MS,
} from "../public-read-memo";

/**
 * The one memo every `/public/v1/*` reader is built on.
 *
 * Every route on that surface is unauthenticated and polled, so without a memo
 * an anonymous poll loop on the LAN decides how often the work behind it is
 * paid for. The behaviours pinned here are the ones each reader relies on:
 * a served answer reports the instant it was COMPUTED, concurrent cold callers
 * cost one read rather than one each, and — the gap this replaced — a FAILING
 * read is backed off too, so the TTL bounds the error path as well as the
 * success path.
 */

const NOW = 1_700_000_000_000;

interface Answer {
	generatedAtMs: number;
	value: number;
}

function memo(
	read: (nowMs: number) => Promise<Answer>,
	options: {
		now: () => number;
		ttlMs?: number;
		failureTtlMs?: number;
	},
) {
	return createPublicReadMemo(read, {
		computedAtMs: (answer) => answer.generatedAtMs,
		ttlMs: 60_000,
		...options,
	});
}

describe("the shared public read memo", () => {
	it("serves the cached answer inside the TTL without recomputing", async () => {
		let reads = 0;
		let clock = NOW;
		const read = memo(
			async (nowMs) => ({ generatedAtMs: nowMs, value: ++reads }),
			{
				now: () => clock,
			},
		);

		await read();
		clock = NOW + 59_000;
		const second = await read();

		expect(reads).toBe(1);
		// The instant it was COMPUTED, not the instant it was asked for: a client
		// seeing the same `generatedAt` twice is looking at the same measurement
		// twice, which is the truth.
		expect(second.generatedAtMs).toBe(NOW);
	});

	it("recomputes once the TTL has passed", async () => {
		let reads = 0;
		let clock = NOW;
		const read = memo(
			async (nowMs) => ({ generatedAtMs: nowMs, value: ++reads }),
			{
				now: () => clock,
			},
		);

		await read();
		clock = NOW + 60_001;
		const second = await read();

		expect(reads).toBe(2);
		expect(second.generatedAtMs).toBe(NOW + 60_001);
	});

	it("collapses concurrent cold callers onto one read", async () => {
		let reads = 0;
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = memo(
			async (nowMs) => {
				reads++;
				await gate;
				return { generatedAtMs: nowMs, value: reads };
			},
			{ now: () => NOW },
		);

		// Started before the first resolves, so the single-flight check is the
		// only thing that can stop the second and third from starting their own.
		const all = Promise.all([read(), read(), read()]);
		release?.();
		await all;

		expect(reads).toBe(1);
	});

	it("backs a failure off for the negative TTL instead of retrying every poll", async () => {
		// The gap this closes: with no negative TTL the memo bounded the SUCCESS
		// path only, so a reader whose database call was failing re-ran the whole
		// scan for every anonymous poll — the load the memo exists to cap, arriving
		// exactly when the process is least able to absorb it.
		let reads = 0;
		let clock = NOW;
		const read = memo(
			async () => {
				reads++;
				throw new Error("scan failed");
			},
			{ now: () => clock, failureTtlMs: 5_000 },
		);

		await expect(read()).rejects.toThrow("scan failed");
		clock = NOW + 4_999;
		await expect(read()).rejects.toThrow("scan failed");
		expect(reads).toBe(1);
	});

	it("retries once the negative TTL has passed", async () => {
		// Bounded, never pinned: a transient failure must not be replayed to every
		// later caller for the life of the process.
		let reads = 0;
		let clock = NOW;
		const read = memo(
			async (nowMs) => {
				reads++;
				if (reads === 1) throw new Error("scan failed");
				return { generatedAtMs: nowMs, value: reads };
			},
			{ now: () => clock, failureTtlMs: 5_000 },
		);

		await expect(read()).rejects.toThrow("scan failed");
		clock = NOW + 5_000;
		const recovered = await read();

		expect(reads).toBe(2);
		expect(recovered.generatedAtMs).toBe(NOW + 5_000);
	});

	it("keeps serving the last good answer only while it is inside its own TTL", async () => {
		// A failure does not resurrect an expired answer: the memo either has a
		// fresh measurement or it has none, and serving an hour-old snapshot under
		// a fresh-looking `generatedAt` is the one thing this surface must not do.
		let clock = NOW;
		let shouldFail = false;
		const read = memo(
			async (nowMs) => {
				if (shouldFail) throw new Error("scan failed");
				return { generatedAtMs: nowMs, value: 1 };
			},
			{ now: () => clock, failureTtlMs: 5_000 },
		);

		await read();
		shouldFail = true;
		clock = NOW + 59_000;
		// Inside the success TTL, so nothing is recomputed and nothing fails.
		expect((await read()).generatedAtMs).toBe(NOW);

		clock = NOW + 60_001;
		await expect(read()).rejects.toThrow("scan failed");
	});

	it("clears a remembered failure as soon as a read succeeds", async () => {
		let clock = NOW;
		let shouldFail = true;
		const read = memo(
			async (nowMs) => {
				if (shouldFail) throw new Error("scan failed");
				return { generatedAtMs: nowMs, value: 1 };
			},
			{ now: () => clock, failureTtlMs: 5_000 },
		);

		await expect(read()).rejects.toThrow("scan failed");
		clock = NOW + 5_000;
		shouldFail = false;
		await read();
		// The recovery is served from the success cache, not blocked by a failure
		// record left behind.
		expect((await read()).generatedAtMs).toBe(NOW + 5_000);
	});

	it("states a default negative TTL far below its success TTL", () => {
		// The two are not the same decision: a stale ANSWER may be served for a
		// minute because it is a real measurement, while a failure is only a
		// reason to stop asking for a moment.
		expect(PUBLIC_READ_FAILURE_TTL_MS).toBeGreaterThan(0);
		expect(PUBLIC_READ_FAILURE_TTL_MS).toBeLessThan(60_000);
	});
});
