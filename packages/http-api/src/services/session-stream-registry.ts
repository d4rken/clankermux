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
			const openedAt = Date.now();

			if (tokenHash) {
				let closers = streamsBySession.get(tokenHash);
				if (!closers) {
					closers = new Set();
					streamsBySession.set(tokenHash, closers);
				}
				closers.add(close);
			}

			const timer = setInterval(() => {
				void (async () => {
					try {
						// Fail-open: nothing is configured, so nothing is revoked and the
						// stream has no session to outlive.
						if (!(await sessionAuth.isConfigured())) return;
						if (Date.now() - openedAt >= maxLifetimeMs) {
							close();
							return;
						}
						// A password exists but this stream never presented a cookie: it
						// was opened while the deployment was still fail-open. It must not
						// keep running now that it is not.
						if (!tokenHash || !(await sessionAuth.isSessionLive(tokenHash))) {
							close();
						}
					} catch (error) {
						log.debug(
							`Session revalidation for an open stream failed: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				})();
			}, revalidateMs);
			// Never hold the process open for a revalidation tick.
			timer.unref?.();

			return () => {
				clearInterval(timer);
				if (!tokenHash) return;
				const closers = streamsBySession.get(tokenHash);
				if (!closers) return;
				closers.delete(close);
				if (closers.size === 0) streamsBySession.delete(tokenHash);
			};
		},
	};
}
