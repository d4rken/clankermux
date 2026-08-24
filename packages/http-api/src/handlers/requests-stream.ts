import {
	getActiveRequests,
	type RequestStreamEvt,
	requestEvents,
} from "@clankermux/core";
import type { StreamSessionGuard } from "../services/session-stream-registry";
import { registerSseCloser } from "../sse-registry";

// Periodic SSE comment so the socket never sits idle long enough for
// Bun.serve's idleTimeout (255s) to kill quiet dashboard streams overnight.
// EventSource ignores comment lines; they only reset the server idle timer.
const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

export function createRequestsStreamHandler(
	heartbeatIntervalMs = SSE_HEARTBEAT_INTERVAL_MS,
	/**
	 * Binds the connection to the session that opened it: periodic
	 * revalidation plus a bounded lifetime. Without it this stream
	 * authenticates once at the handshake and then runs forever, so a copied
	 * cookie keeps receiving management events after its session is gone.
	 */
	sessionGuard?: StreamSessionGuard,
) {
	return (req: Request): Response => {
		// Store the write handler outside to access it in cancel
		let writeHandler: ((data: RequestStreamEvt) => void) | null = null;
		let heartbeat: ReturnType<typeof setInterval> | null = null;
		let isClosed = false;
		// Set inside start() — the controller is only available there.
		let streamController: ReadableStreamDefaultController<Uint8Array> | null =
			null;
		let unregisterCloser: (() => void) | null = null;
		let detachSessionGuard: (() => void) | null = null;

		const cleanup = () => {
			isClosed = true;
			if (writeHandler) {
				requestEvents.off("event", writeHandler);
				writeHandler = null;
			}
			if (heartbeat) {
				clearInterval(heartbeat);
				heartbeat = null;
			}
			if (unregisterCloser) {
				unregisterCloser();
				unregisterCloser = null;
			}
			if (detachSessionGuard) {
				detachSessionGuard();
				detachSessionGuard = null;
			}
		};

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();

				// Helper to send SSE formatted data with error handling
				writeHandler = (data: RequestStreamEvt) => {
					if (isClosed) return;

					try {
						const message = `data: ${JSON.stringify(data)}\n\n`;
						controller.enqueue(encoder.encode(message));
					} catch (_error) {
						// Stream is closed or errored
						cleanup();
					}
				};

				// Send initial connection message
				const connectMsg = `event: connected\ndata: ok\n\n`;
				controller.enqueue(encoder.encode(connectMsg));

				// Listen for events
				requestEvents.on("event", writeHandler);

				// Replay whatever is in flight RIGHT NOW.
				//
				// This stream only carries future events, and an in-flight
				// request has no database row yet — the recorder writes on
				// completion — so a client that connects (or reconnects after a
				// dropped connection) mid-request can learn about it from
				// nowhere else. Sent unconditionally, empty included: its
				// arrival is how the client knows the replay is complete.
				//
				// Subscribe-THEN-snapshot, in that order. The reverse leaves a
				// gap: a request that settles between the snapshot and the
				// subscription is in neither, so the client would hold it as
				// pending until its lost-timeout. This order can only overlap —
				// a request may appear in both the live stream and the snapshot
				// — and the client reducer is idempotent, so an overlap costs
				// nothing while a gap shows a phantom in-flight mark.
				writeHandler({ type: "snapshot", active: getActiveRequests() });

				// Periodic heartbeat comment to keep the connection alive
				heartbeat = setInterval(() => {
					if (isClosed) return;

					try {
						controller.enqueue(encoder.encode(": ping\n\n"));
					} catch (_error) {
						// Stream is closed or errored
						cleanup();
					}
				}, heartbeatIntervalMs);

				// Register for proactive close at shutdown: this endless stream
				// would otherwise hold Bun's graceful drain until the watchdog.
				streamController = controller;

				// Revocation. Closing is safe and self-healing: browser EventSource
				// reconnects, and the reconnect re-runs the full auth check at the
				// handshake — which is exactly what a revoked session must fail.
				const closeForRevocation = () => {
					if (isClosed) return;
					cleanup();
					try {
						controller.close();
					} catch {
						// Already closed/errored.
					}
				};
				detachSessionGuard =
					sessionGuard?.attach(req, closeForRevocation) ?? null;

				unregisterCloser = registerSseCloser(() => {
					if (isClosed) return;
					try {
						streamController?.enqueue(
							encoder.encode("event: server-shutdown\ndata: bye\n\n"),
						);
					} catch {
						// Best-effort farewell only.
					}
					cleanup();
					try {
						streamController?.close();
					} catch {
						// Already closed/errored.
					}
				});
			},
			cancel() {
				// Cleanup only this specific listener
				cleanup();
			},
		});

		// Clean up on abort signal
		req.signal?.addEventListener("abort", () => {
			if (!isClosed) {
				cleanup();
			}
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				Connection: "keep-alive",
				"Cache-Control": "no-cache",
			},
		});
	};
}
