import { Logger } from "@clankermux/logger";
import {
	hashSessionToken,
	readSessionCookie,
	type SessionAuthService,
} from "./session-auth-service";

const log = new Logger("SessionStreams");

/**
 * How often a protected stream re-checks that its session is still live.
 *
 * This interval is also what makes an OUT-OF-PROCESS password rotation take
 * effect on open streams: the CLI deletes every session row, and the next tick
 * of this timer finds the row gone and closes the connection. There is no
 * in-process rotation path to signal from (setting the password over HTTP is
 * deliberately not offered), so the poll is the mechanism, not a fallback.
 */
export const SESSION_STREAM_REVALIDATE_MS = 60_000;

/**
 * Hard ceiling on ONE connection, independent of any session's lifetime and of
 * whether the deployment is gated at all. Browser `EventSource` reconnects
 * automatically, so a close is a re-handshake rather than a lost stream — and
 * re-handshaking is what re-runs the full auth check.
 *
 * For a stream running on an UNGATED deployment this is measured from the last
 * revalidation that actually answered, not from the handshake: see the guard's
 * docstring.
 */
export const SESSION_STREAM_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000;

/** Closers for live streams, indexed by the session that opened them. */
const streamsBySession = new Map<string, Set<() => void>>();

/**
 * Close every stream opened under `tokenHash`. Called on logout, so the tab
 * that just logged out stops receiving management events immediately rather
 * than at the next revalidation tick.
 */
export function closeStreamsForSession(tokenHash: string): number {
	const closers = streamsBySession.get(tokenHash);
	if (!closers) return 0;
	streamsBySession.delete(tokenHash);
	let closed = 0;
	for (const close of closers) {
		try {
			close();
			closed++;
		} catch {
			// Best-effort: one failing stream must not block the rest.
		}
	}
	return closed;
}

/** Test hook: forget every registration without invoking the closers. */
export function resetSessionStreamRegistryForTests(): void {
	streamsBySession.clear();
}

/**
 * Attaches a bounded lifetime and periodic session revalidation to a
 * long-running stream.
 *
 * Both existing SSE lanes authenticate only at the handshake and then run
 * indefinitely on listeners and heartbeats. Without this, a copied cookie keeps
 * receiving management events after its session has expired or been deleted —
 * the handshake check is a moment, and the connection is a day.
 */
export interface StreamSessionGuard {
	/**
	 * Bind `close` to the request's session. Returns a detach function the
	 * stream MUST call on its own teardown, so the registry does not accumulate
	 * closers for connections that are already gone.
	 */
	attach(req: Request, close: () => void): () => void;
}

/**
 * The production guard.
 *
 * Three properties keep revocation from failing OPEN, which is the only way
 * this whole mechanism can be worse than useless:
 *
 *  - EVERY stream gets the hard lifetime, cookie or not, and it is its OWN
 *    timer rather than a comparison made after an await. The store's busy-retry
 *    can keep a single read pending for minutes; a ceiling that is only checked
 *    once that read returns is not a ceiling, and a connection whose
 *    revalidation never answers at all has nothing else left to bound it. What
 *    the timer bounds is the age of the last USABLE answer, not the connection:
 *    a successfully completed `configured: false` re-arms it. So a stream on an
 *    ungated deployment — the default, and the state right after this ships —
 *    runs for as long as the reads keep confirming it, while a stream whose
 *    reads stall or start failing still closes within one lifetime of the last
 *    answer. Without the re-arm every healthy fail-open stream is dropped every
 *    six hours; `/api/requests/stream` backfills on reconnect and survives that,
 *    `/api/logs/stream` has no replay and simply loses the interval. A PROTECTED
 *    stream's deadline is never re-armed: it presented a cookie, so bounding the
 *    connection itself is the point — the re-handshake is what re-runs the auth
 *    check.
 *  - Ticks are serialized. A revalidation slower than the interval would
 *    otherwise stack callbacks against the store it is already waiting on.
 *  - A revalidation that cannot COMPLETE closes the stream, whatever the last
 *    successful read said and whether or not a cookie was presented. An
 *    operator gates a fail-open deployment from the CLI at a moment of their
 *    choosing, so "it was unconfigured when we last managed to look" is not an
 *    answer about now — it is the previous answer to a question we can no
 *    longer ask, and it is the wrong one precisely during the transition this
 *    exists to enforce. Only a SUCCESSFULLY COMPLETED `configured: false`
 *    leaves a stream running.
 */
export function createSessionStreamGuard(
	sessionAuth: SessionAuthService,
	revalidateMs = SESSION_STREAM_REVALIDATE_MS,
	maxLifetimeMs = SESSION_STREAM_MAX_LIFETIME_MS,
): StreamSessionGuard {
	return {
		attach(req, close) {
			const token = readSessionCookie(req);
			const tokenHash = token ? hashSessionToken(token) : null;

			let detached = false;
			let closed = false;

			const closeOnce = () => {
				if (closed || detached) return;
				closed = true;
				close();
			};

			// Armed for every connection at the handshake, and re-armed by every
			// revalidation that completes with `configured: false`: see the
			// docstring.
			let deadline: ReturnType<typeof setTimeout> | undefined;
			const armDeadline = () => {
				clearTimeout(deadline);
				// A tick resolving after teardown must not leave a live timer behind:
				// detach has already cleared the one it knew about.
				if (closed || detached) return;
				deadline = setTimeout(closeOnce, maxLifetimeMs);
				deadline.unref?.();
			};
			armDeadline();

			// Handshake probe for a cookie-less stream. Nothing it reports keeps the
			// connection alive — a gated deployment is caught by the first tick
			// anyway — but a read that FAILS here means the gate state was never
			// known for this connection, and unknown is not fail-open.
			if (!tokenHash) {
				void sessionAuth.isConfigured().catch(() => {
					closeOnce();
				});
			}

			if (tokenHash) {
				let closers = streamsBySession.get(tokenHash);
				if (!closers) {
					closers = new Set();
					streamsBySession.set(tokenHash, closers);
				}
				// The registry holds `closeOnce`, not `close`: a logout-driven close
				// must also mark the stream closed here, or a tick still in flight
				// would call the stream's closer a second time.
				closers.add(closeOnce);
			}

			let revalidating = false;
			const timer = setInterval(() => {
				// One tick at a time: a store that takes longer than the interval
				// must not accumulate overlapping reads against itself.
				if (revalidating || closed || detached) return;
				revalidating = true;
				void (async () => {
					try {
						// Fail-open, and the only reading that leaves a stream running:
						// nothing is configured, so nothing is revoked and the stream has
						// no session to outlive. It is also the only reading that re-arms
						// the watchdog — the gate state is known AGAIN, as of now, which
						// is exactly what the watchdog exists to notice the absence of.
						if (!(await sessionAuth.isConfigured())) {
							armDeadline();
							return;
						}
						// A password exists but this stream never presented a cookie: it
						// was opened while the deployment was still fail-open. It must not
						// keep running now that it is not.
						if (!tokenHash || !(await sessionAuth.isSessionLive(tokenHash))) {
							closeOnce();
						}
					} catch (error) {
						log.debug(
							`Session revalidation for an open stream failed: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
						// Fail CLOSED. The stream carries management events and we no
						// longer know whether the deployment is gated, let alone whether
						// this session exists; closing costs a browser reconnect, which
						// re-runs the full handshake check.
						closeOnce();
					} finally {
						revalidating = false;
					}
				})();
			}, revalidateMs);
			// Never hold the process open for a revalidation tick.
			timer.unref?.();

			return () => {
				detached = true;
				clearInterval(timer);
				clearTimeout(deadline);
				if (!tokenHash) return;
				const closers = streamsBySession.get(tokenHash);
				if (!closers) return;
				closers.delete(closeOnce);
				if (closers.size === 0) streamsBySession.delete(tokenHash);
			};
		},
	};
}
