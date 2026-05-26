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
}

export function createStreamAnalyticsPassthrough(
	upstream: ReadableStream<Uint8Array>,
	options: StreamAnalyticsOptions,
): ReadableStream<Uint8Array> {
	const { onChunk, onEnd, onError, totalTimeoutMs, chunkTimeoutMs } = options;
	const reader = upstream.getReader();
	const startTime = Date.now();
	let finalized = false; // guard so onEnd/onError fire at most once total

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			// Overall stream timeout
			if (Date.now() - startTime > totalTimeoutMs) {
				const err = new Error(
					`Stream timeout: exceeded ${totalTimeoutMs}ms total duration`,
				);
				try {
					await reader.cancel();
				} catch {
					// reader may already be released/cancelled
				}
				if (!finalized) {
					finalized = true;
					onError?.(err);
				}
				controller.error(err);
				return;
			}

			let timeoutId: ReturnType<typeof setTimeout> | null = null;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(
					() =>
						reject(
							new Error(
								`Stream timeout: no data received for ${chunkTimeoutMs}ms`,
							),
						),
					chunkTimeoutMs,
				);
			});

			try {
				const { value, done } = await Promise.race([
					reader.read(),
					timeoutPromise,
				]);
				if (timeoutId) {
					clearTimeout(timeoutId);
					timeoutId = null;
				}

				if (done) {
					if (!finalized) {
						finalized = true;
						onEnd?.();
					}
					controller.close();
					return;
				}
				if (value) {
					controller.enqueue(value); // deliver to client first (latency)
					try {
						onChunk?.(value);
					} catch {
						// analytics must never break the client stream
					}
				}
			} catch (err) {
				if (timeoutId) {
					clearTimeout(timeoutId);
					timeoutId = null;
				}
				try {
					await reader.cancel();
				} catch {
					// reader may already be released/cancelled
				}
				if (!finalized) {
					finalized = true;
					onError?.(err as Error);
				}
				controller.error(err);
			}
		},
		async cancel(reason) {
			// Client disconnected. Cancel upstream and finalize analytics so the
			// worker doesn't leak per-request state waiting for an end that never comes.
			try {
				await reader.cancel(reason);
			} catch {
				// reader may already be released/cancelled
			}
			if (!finalized) {
				finalized = true;
				onError?.(new Error("client disconnected"));
			}
		},
	});
}
