/**
 * Single-reader pass-through stream for analytics side-effects.
 *
 * Replaces the old native `ReadableStream.prototype.tee()` split (client branch
 * + analytics branch). Native tee() buffers every chunk the fast (analytics)
 * branch has read until the slow (client) branch catches up, so the entire
 * response body accumulated in the slow branch's internal queue — an unbounded
 * off-heap (anonymous RSS) leak.
 *
 * Here the client consumes the wrapper stream directly. In `pull` we read
 * upstream, enqueue the chunk to the client, then run analytics side-effects
 * (`onChunk`) inline. ONE reader means chunks are pulled at client pace →
 * natural backpressure (default queuing strategy, highWaterMark 1), no second
 * buffer, and the per-chunk worker postMessage is rate-limited to client pace.
 */

import { NETWORK } from "@clankermux/core";

const { IDLE_REARM_INTERVAL_MS } = NETWORK;

export interface StreamAnalyticsOptions {
	/** Called for each chunk AFTER it is enqueued to the client. Forward to worker + sniff here. */
	onChunk?: (chunk: Uint8Array) => void;
	/** Called once when upstream completes normally (before the client stream closes). */
	onEnd?: () => void;
	/** Called once on timeout / read error / client cancel. */
	onError?: (err: Error) => void;
	/** Overall stream duration cap. */
	totalTimeoutMs: number;
	/** Per-read inactivity cap (no data received). */
	chunkTimeoutMs: number;
	/**
	 * Best-effort re-arm of the client connection's Bun idle timer. When
	 * provided, an interval fires it on the IDLE_REARM_INTERVAL_MS cadence for the
	 * lifetime of the stream so a single silent gap longer than the 180s base
	 * idleTimeout (agentic sub-call pauses can exceed it) doesn't reap the
	 * connection. An interval — not a post-chunk re-arm — is required precisely
	 * because the gap can be longer than the timeout. Cleared on every stream-end
	 * path (normal completion, total-timeout, per-chunk-timeout, error, cancel).
	 */
	bumpIdleTimeout?: () => void;
}

export function createStreamAnalyticsPassthrough(
	upstream: ReadableStream<Uint8Array>,
	options: StreamAnalyticsOptions,
): ReadableStream<Uint8Array> {
	const {
		onChunk,
		onEnd,
		onError,
		totalTimeoutMs,
		chunkTimeoutMs,
		bumpIdleTimeout,
	} = options;
	const reader = upstream.getReader();
	let finalized = false;
	let totalTimer: ReturnType<typeof setTimeout> | undefined;
	let readTimer: ReturnType<typeof setTimeout> | undefined;
	const rearmInterval = bumpIdleTimeout
		? setInterval(bumpIdleTimeout, IDLE_REARM_INTERVAL_MS)
		: undefined;

	const finalize = (err?: Error): boolean => {
		if (finalized) return false;
		finalized = true;
		clearTimeout(totalTimer);
		clearTimeout(readTimer);
		clearInterval(rearmInterval);
		// Cleanup and the terminal verdict must not depend on upstream cancel
		// settling. Cancellation resolves pending reads with done:true.
		try {
			if (err) onError?.(err);
			else onEnd?.();
		} catch {
			/* analytics only */
		}
		return true;
	};
	const release = () => {
		try {
			reader.releaseLock();
		} catch {
			/* pending read */
		}
	};
	const cancelUpstream = (reason?: unknown) => {
		void reader
			.cancel(reason)
			.catch(() => {})
			.finally(release);
	};
	const fail = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		err: Error,
	) => {
		if (!finalize(err)) return;
		controller.error(err);
		cancelUpstream(err);
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			// Independent of pull/backpressure: a silent or unread stream still
			// has the same absolute lifetime cap.
			totalTimer = setTimeout(
				() =>
					fail(
						controller,
						new Error(
							`Stream timeout: exceeded ${totalTimeoutMs}ms total duration`,
						),
					),
				totalTimeoutMs,
			);
		},
		async pull(controller) {
			if (finalized) return;
			readTimer = setTimeout(
				() =>
					fail(
						controller,
						new Error(
							`Stream timeout: no data received for ${chunkTimeoutMs}ms`,
						),
					),
				chunkTimeoutMs,
			);
			try {
				const { value, done } = await reader.read();
				clearTimeout(readTimer);
				if (finalized) return;
				if (done) {
					finalize();
					release();
					controller.close();
					return;
				}
				if (value) {
					controller.enqueue(value);
					try {
						onChunk?.(value);
					} catch {
						/* analytics only */
					}
				}
			} catch (err) {
				fail(controller, err instanceof Error ? err : new Error(String(err)));
			}
		},
		cancel(reason) {
			if (finalize(new Error("client disconnected"))) cancelUpstream(reason);
		},
	});
}
