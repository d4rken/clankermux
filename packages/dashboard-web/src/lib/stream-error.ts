/**
 * Error-handling logic for pooled SSE (EventSource) connections.
 *
 * Extracted from useRequestStream so the zombie-connection rules are unit
 * testable without a DOM: when an EventSource errors we ALWAYS close it
 * (disabling the browser's native auto-reconnect, which would otherwise keep
 * an untracked zombie occupying one of the ~6 per-host connection slots), and
 * only mutate the pool / schedule a manual reconnect when the errored instance
 * is the connection the pool is actually tracking.
 */

export const MAX_RETRIES = 10;

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

interface PoolEntryLike<C> {
	connection: C;
	heartbeat: ReturnType<typeof setInterval>;
}

export interface StreamErrorOpts {
	/** Whether the owning hook is still mounted. */
	mounted: boolean;
	/** Retry attempts so far (reset to 0 by the caller on a successful open). */
	retryCount: number;
	/** Invoked with the next retryCount and the backoff delay to apply. */
	scheduleReconnect: (nextRetryCount: number, delayMs: number) => void;
}

export type StreamErrorOutcome =
	| "stale" // errored instance is not the tracked connection: closed, nothing else
	| "unmounted" // tracked connection died but the hook is gone: no reconnect
	| "reconnect" // tracked connection died: reconnect scheduled
	| "gave-up"; // tracked connection died but MAX_RETRIES exhausted

export function handleStreamError<C extends { close(): void }>(
	es: C,
	pool: Map<string, PoolEntryLike<C>>,
	key: string,
	opts: StreamErrorOpts,
): StreamErrorOutcome {
	// Always close: frees the browser connection slot and disables native
	// EventSource auto-reconnect. Reconnection is fully manual from here.
	es.close();

	const pooled = pool.get(key);
	if (pooled?.connection !== es) {
		// Stale zombie event (or already-evicted entry) — the live connection
		// in the pool must not be disturbed and no reconnect is owed.
		return "stale";
	}

	clearInterval(pooled.heartbeat);
	pool.delete(key);

	if (!opts.mounted) return "unmounted";
	if (opts.retryCount >= MAX_RETRIES) return "gave-up";

	const delay = Math.min(
		BASE_RECONNECT_DELAY_MS * 2 ** opts.retryCount,
		MAX_RECONNECT_DELAY_MS,
	);
	opts.scheduleReconnect(opts.retryCount + 1, delay);
	return "reconnect";
}
