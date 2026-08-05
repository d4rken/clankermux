/**
 * Error-handling logic for the dashboard's SSE (EventSource) connection.
 *
 * Kept out of the React layer so the zombie-connection rules are unit testable
 * without a DOM: when an EventSource errors we ALWAYS close it (disabling the
 * browser's native auto-reconnect, which would otherwise keep an untracked
 * zombie occupying one of the ~6 per-host connection slots), and only release
 * the owner's state / schedule a manual reconnect when the errored instance is
 * the connection the owner is actually tracking.
 *
 * The "is this still the tracked connection?" check matters even though there
 * is now only ever one connection: an error can fire late for an instance that
 * has already been replaced during a reconnect, and acting on it would tear
 * down the healthy replacement.
 */

export const MAX_RETRIES = 10;

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

export interface StreamErrorOpts<C> {
	/** The connection the caller currently owns, or null if it owns none. */
	current: C | null;
	/** Drop the tracked connection: clear its timers and forget it. */
	release: () => void;
	/** Whether the owner is still mounted. */
	mounted: boolean;
	/** Retry attempts so far (reset to 0 by the caller on a successful open). */
	retryCount: number;
	/** Invoked with the next retryCount and the backoff delay to apply. */
	scheduleReconnect: (nextRetryCount: number, delayMs: number) => void;
}

export type StreamErrorOutcome =
	| "stale" // errored instance is not the tracked connection: closed, nothing else
	| "unmounted" // tracked connection died but the owner is gone: no reconnect
	| "reconnect" // tracked connection died: reconnect scheduled
	| "gave-up"; // tracked connection died but MAX_RETRIES exhausted

export function handleStreamError<C extends { close(): void }>(
	es: C,
	opts: StreamErrorOpts<C>,
): StreamErrorOutcome {
	// Always close: frees the browser connection slot and disables native
	// EventSource auto-reconnect. Reconnection is fully manual from here.
	es.close();

	if (opts.current !== es) {
		// Stale zombie event (or already-released connection) — the live
		// connection must not be disturbed and no reconnect is owed.
		return "stale";
	}

	opts.release();

	if (!opts.mounted) return "unmounted";
	if (opts.retryCount >= MAX_RETRIES) return "gave-up";

	opts.scheduleReconnect(
		opts.retryCount + 1,
		reconnectDelayMs(opts.retryCount),
	);
	return "reconnect";
}

/** Exponential backoff, capped so a long outage still retries every 30s. */
export function reconnectDelayMs(retryCount: number): number {
	return Math.min(
		BASE_RECONNECT_DELAY_MS * 2 ** retryCount,
		MAX_RECONNECT_DELAY_MS,
	);
}
