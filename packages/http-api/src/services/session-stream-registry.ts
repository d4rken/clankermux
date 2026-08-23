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
 * Hard ceiling on one protected stream's connection, independent of the
 * session's own lifetime. Browser `EventSource` reconnects automatically, so a
 * close is a re-handshake rather than a lost stream — and re-handshaking is
 * what re-runs the full auth check.
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
 * The production guard. When no password is configured the deployment is
 * fail-open, so a stream is left alone entirely — no lifetime cap, no
 * revalidation, nothing to revalidate against.
 *
 * Three properties keep revocation from failing OPEN, which is the only way
 * this whole mechanism can be worse than useless:
 *
 *  - The hard lifetime is its OWN timer, not a comparison made after an await.
 *    The store's busy-retry can keep a single read pending for minutes, and a
 *    ceiling that is only checked once that read returns is not a ceiling.
 *  - Ticks are serialized. A revalidation slower than the interval would
 *    otherwise stack callbacks against the store it is already waiting on.
 *  - A revalidation ERROR closes a protected stream. Whether a stream is
 *    protected is captured at the HANDSHAKE, so the answer never comes from the
 *    call that just failed. A SUCCESSFUL `configured: false` is the fail-open
 *    case and is the only reading that leaves a stream running.
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
			let deadline: ReturnType<typeof setTimeout> | null = null;

			const closeOnce = () => {
				if (closed || detached) return;
				closed = true;
				close();
			};

			const armDeadline = () => {
				if (deadline || detached || closed) return;
				deadline = setTimeout(closeOnce, maxLifetimeMs);
				deadline.unref?.();
			};

			// Handshake state. A stream that presented a cookie is protected by
			// definition; one that did not may still have been opened on a gated
			// deployment, and that is read ONCE, here, rather than re-derived on
			// every tick. A handshake read that fails leaves the stream in the
			// fail-open state it was opened under — the first SUCCESSFUL tick that
			// reports a configured deployment closes it anyway.
			let isProtected = tokenHash !== null;
			if (isProtected) {
				armDeadline();
			} else {
				void sessionAuth
					.isConfigured()
					.then((configured) => {
						if (!configured) return;
						isProtected = true;
						armDeadline();
					})
					.catch(() => {
						// Unknown at the handshake; see above.
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
						// Fail-open: nothing is configured, so nothing is revoked and the
						// stream has no session to outlive.
						if (!(await sessionAuth.isConfigured())) return;
						isProtected = true;
						armDeadline();
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
						// longer know whether its session exists; closing costs a browser
						// reconnect, which re-runs the full handshake check.
						if (isProtected) closeOnce();
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
				if (deadline) {
					clearTimeout(deadline);
					deadline = null;
				}
				if (!tokenHash) return;
				const closers = streamsBySession.get(tokenHash);
				if (!closers) return;
				closers.delete(closeOnce);
				if (closers.size === 0) streamsBySession.delete(tokenHash);
			};
		},
	};
}
