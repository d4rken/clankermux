/**
 * Tests for createStreamAnalyticsPassthrough — the single-reader pass-through
 * that replaced native ReadableStream.tee() in the streaming analytics path.
 *
 * The key regression guard is the backpressure test: native tee() let the fast
 * (analytics) branch race ahead and buffer the whole body in the slow (client)
 * branch's queue. The single-reader design pulls upstream at client pace, so
 * upstream must never be read more than ~1 chunk ahead of the client.
 */
import { describe, expect, it, mock } from "bun:test";
import { NETWORK } from "@clankermux/core";
import { createStreamAnalyticsPassthrough } from "../stream-analytics";

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (u: Uint8Array) => new TextDecoder().decode(u);

/** A controllable upstream that records how many times pull() was invoked. */
function makeUpstream(chunks: Uint8Array[]): {
	stream: ReadableStream<Uint8Array>;
	pullCount: () => number;
} {
	let i = 0;
	let pulls = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls++;
			if (i < chunks.length) {
				controller.enqueue(chunks[i++]);
			} else {
				controller.close();
			}
		},
	});
	return { stream, pullCount: () => pulls };
}

describe("createStreamAnalyticsPassthrough", () => {
	it("fires onChunk for each chunk, in order, with the chunk bytes", async () => {
		const chunks = ["a", "bb", "ccc"].map(encode);
		const { stream } = makeUpstream(chunks);
		const seen: string[] = [];

		const out = createStreamAnalyticsPassthrough(stream, {
			totalTimeoutMs: 5000,
			chunkTimeoutMs: 1000,
			onChunk: (c) => seen.push(decode(c)),
		});

		// Drain the client fully.
		const reader = out.getReader();
		const received: string[] = [];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) received.push(decode(value));
		}

		expect(seen).toEqual(["a", "bb", "ccc"]);
		expect(received).toEqual(["a", "bb", "ccc"]);
	});

	it("backpressure: upstream is not read more than ~1 chunk ahead of the client", async () => {
		const chunks = Array.from({ length: 20 }, (_, n) => encode(`chunk-${n}`));
		const { stream, pullCount } = makeUpstream(chunks);

		let clientReads = 0;
		const out = createStreamAnalyticsPassthrough(stream, {
			totalTimeoutMs: 5000,
			chunkTimeoutMs: 1000,
		});

		const reader = out.getReader();
		// Read slowly, asserting the gap between upstream pulls and client reads
		// stays bounded at every step (the leak was an unbounded gap).
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) {
				clientReads++;
				// Give the microtask/timer queue a chance to run, so if the impl
				// were greedily prefetching it would show up here.
				await new Promise((r) => setTimeout(r, 0));
				const gap = pullCount() - clientReads;
				expect(gap).toBeLessThanOrEqual(2);
			}
		}
		expect(clientReads).toBe(20);
	});

	it("onEnd fires exactly once on normal completion; client receives all chunks then closes", async () => {
		const chunks = ["x", "y"].map(encode);
		const { stream } = makeUpstream(chunks);
		let endCount = 0;
		let errCount = 0;

		const out = createStreamAnalyticsPassthrough(stream, {
			totalTimeoutMs: 5000,
			chunkTimeoutMs: 1000,
			onEnd: () => endCount++,
			onError: () => errCount++,
		});

		const reader = out.getReader();
		const received: string[] = [];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) received.push(decode(value));
		}

		expect(received).toEqual(["x", "y"]);
		expect(endCount).toBe(1);
		expect(errCount).toBe(0);
	});

	it("per-chunk timeout: an upstream that never produces a chunk → onError fires and client errors within ~chunkTimeoutMs", async () => {
		// Upstream that never enqueues and never closes.
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				// hang forever
				return new Promise<void>(() => {});
			},
		});

		let errCount = 0;
		let endCount = 0;
		const out = createStreamAnalyticsPassthrough(stream, {
			totalTimeoutMs: 5000,
			chunkTimeoutMs: 50,
			onEnd: () => endCount++,
			onError: () => errCount++,
		});

		const start = Date.now();
		const reader = out.getReader();
		let threw = false;
		try {
			await reader.read();
		} catch {
			threw = true;
		}
		const elapsed = Date.now() - start;

		expect(threw).toBe(true);
		expect(errCount).toBe(1);
		expect(endCount).toBe(0);
		// Allow generous slack for CI scheduling, but it must be timeout-driven.
		expect(elapsed).toBeLessThan(1000);
	});

	// ── Idle-timer re-arm (bumpIdleTimeout) ─────────────────────────────────
	//
	// The re-arm interval fires on the IDLE_REARM_INTERVAL_MS cadence (150s), too
	// long to wait for in a test, so we spy on global setInterval/clearInterval to
	// assert (a) an interval is armed with bumpIdleTimeout at the right cadence,
	// (b) invoking it calls bumpIdleTimeout, and (c) it is cleared on every
	// stream-end path. An interval that is set up and torn down correctly is the
	// whole contract; the cadence value is asserted directly.

	/**
	 * Run `body` while capturing the setInterval armed with IDLE_REARM_INTERVAL_MS
	 * (the re-arm timer). Returns the captured callback + cleared flag. Restores
	 * the globals afterwards. The real interval is suppressed (never scheduled) so
	 * it can't fire during the test.
	 */
	async function withRearmSpy(
		body: () => Promise<void>,
	): Promise<{ armed: boolean; fired: () => void; cleared: () => boolean }> {
		const realSet = globalThis.setInterval;
		const realClear = globalThis.clearInterval;
		const token = Symbol("rearm") as unknown as ReturnType<typeof setInterval>;
		let cb: (() => void) | null = null;
		let clearedToken = false;
		globalThis.setInterval = ((fn: () => void, ms?: number) => {
			if (ms === NETWORK.IDLE_REARM_INTERVAL_MS) {
				cb = fn;
				return token; // suppress the real timer; hand back our sentinel
			}
			return realSet(fn, ms);
		}) as typeof setInterval;
		globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
			if (id === token) {
				clearedToken = true;
				return;
			}
			return realClear(id);
		}) as typeof clearInterval;
		try {
			await body();
		} finally {
			globalThis.setInterval = realSet;
			globalThis.clearInterval = realClear;
		}
		return {
			armed: cb !== null,
			fired: () => cb?.(),
			cleared: () => clearedToken,
		};
	}

	it("arms a re-arm interval that calls bumpIdleTimeout, and clears it on normal end", async () => {
		const bump = mock(() => {});
		const spy = await withRearmSpy(async () => {
			const { stream } = makeUpstream(["a", "b"].map(encode));
			const out = createStreamAnalyticsPassthrough(stream, {
				totalTimeoutMs: 5000,
				chunkTimeoutMs: 1000,
				bumpIdleTimeout: bump,
			});
			const reader = out.getReader();
			while (true) {
				const { done } = await reader.read();
				if (done) break;
			}
		});

		expect(spy.armed).toBe(true);
		// Simulate the interval firing during a quiet gap → bumps the idle timer.
		spy.fired();
		expect(bump).toHaveBeenCalledTimes(1);
		// Interval is cleared when the stream completes (no leaked re-arm).
		expect(spy.cleared()).toBe(true);
	});

	it("clears the re-arm interval on the per-chunk timeout error path", async () => {
		const bump = mock(() => {});
		const spy = await withRearmSpy(async () => {
			const stream = new ReadableStream<Uint8Array>({
				pull() {
					return new Promise<void>(() => {}); // hang forever
				},
			});
			const out = createStreamAnalyticsPassthrough(stream, {
				totalTimeoutMs: 5000,
				chunkTimeoutMs: 50,
				bumpIdleTimeout: bump,
			});
			const reader = out.getReader();
			try {
				await reader.read();
			} catch {
				// expected: per-chunk timeout
			}
		});

		expect(spy.armed).toBe(true);
		expect(spy.cleared()).toBe(true);
	});

	it("clears the re-arm interval on client cancel()", async () => {
		const bump = mock(() => {});
		const spy = await withRearmSpy(async () => {
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(encode("first"));
				},
			});
			const out = createStreamAnalyticsPassthrough(stream, {
				totalTimeoutMs: 5000,
				chunkTimeoutMs: 1000,
				bumpIdleTimeout: bump,
			});
			const reader = out.getReader();
			await reader.read();
			await reader.cancel("client gone");
			await new Promise((r) => setTimeout(r, 10));
		});

		expect(spy.armed).toBe(true);
		expect(spy.cleared()).toBe(true);
	});

	it("does not arm a re-arm interval when bumpIdleTimeout is omitted", async () => {
		const spy = await withRearmSpy(async () => {
			const { stream } = makeUpstream(["a"].map(encode));
			const out = createStreamAnalyticsPassthrough(stream, {
				totalTimeoutMs: 5000,
				chunkTimeoutMs: 1000,
			});
			const reader = out.getReader();
			while (true) {
				const { done } = await reader.read();
				if (done) break;
			}
		});

		expect(spy.armed).toBe(false);
	});

	it("cancel() on the client reader cancels upstream and fires onError exactly once", async () => {
		let upstreamCancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(encode("first"));
			},
			cancel() {
				upstreamCancelled = true;
			},
		});

		let errCount = 0;
		let endCount = 0;
		const out = createStreamAnalyticsPassthrough(stream, {
			totalTimeoutMs: 5000,
			chunkTimeoutMs: 1000,
			onEnd: () => endCount++,
			onError: () => errCount++,
		});

		const reader = out.getReader();
		// Pull one chunk so the stream is live, then cancel.
		const first = await reader.read();
		expect(first.done).toBe(false);
		await reader.cancel("client gone");

		// Let the cancel() handler's awaited reader.cancel() settle.
		await new Promise((r) => setTimeout(r, 10));

		expect(upstreamCancelled).toBe(true);
		expect(errCount).toBe(1);
		expect(endCount).toBe(0);
	});
});
