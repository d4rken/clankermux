/**
 * Registry of active dashboard SSE streams (requests + logs).
 *
 * WHY: these streams are endless (heartbeat forever, never complete), so
 * Bun's graceful drain at shutdown (`server.stop()`) would wait on any open
 * dashboard tab until the shutdown watchdog force-exits (~85s). Shutdown
 * calls `closeAllSseStreams()` right before the drain to proactively end
 * them. Browser EventSource auto-reconnects after a server-side close, and
 * the Caddy front proxy holds the reconnect dial until the new process is
 * up — so closing here is safe and self-healing for dashboard clients.
 */

const closers = new Set<() => void>();

/**
 * Register a closer for an active SSE stream. Returns an unregister
 * function; call it on normal stream teardown (cancel/abort) so the
 * registry doesn't accumulate dead closers. Unregistering is idempotent
 * and safe after `closeAllSseStreams()` has already run.
 */
export function registerSseCloser(close: () => void): () => void {
	closers.add(close);
	return () => {
		closers.delete(close);
	};
}

/**
 * Close every registered SSE stream and empty the registry. Returns the
 * number of closers invoked; a second call returns 0. A throwing closer
 * does not prevent the rest from running.
 */
export function closeAllSseStreams(): number {
	const snapshot = [...closers];
	closers.clear();
	for (const close of snapshot) {
		try {
			close();
		} catch {
			// Best-effort: one failing stream must not block shutdown.
		}
	}
	return snapshot.length;
}
