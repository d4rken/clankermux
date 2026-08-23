import {
	type ActiveRequestEntry,
	getActiveRequests,
	type RequestStreamEvt,
	requestEvents,
} from "@clankermux/core";
import { registerSseCloser } from "../../sse-registry";
import {
	PUBLIC_SCHEMA,
	type PublicStreamEventDto,
	toPublicRequestDoneDto,
	truncateUtf8,
} from "./dto";

// Periodic SSE comment so the socket never sits idle long enough for
// Bun.serve's idleTimeout (255s) to kill a quiet widget stream overnight.
// EventSource ignores comment lines; they only reset the server idle timer.
const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

function str(value: string | null | undefined): string | null {
	return value == null ? null : truncateUtf8(value);
}

/**
 * Translate one internal bus event into its public form, or null for an event
 * this surface does not carry.
 *
 * Every field is named. The internal `type` is never forwarded: the bus is free
 * to rename or split its events as the proxy changes, and a device in a wall
 * socket must not learn about that as a parse failure.
 */
export function toPublicStreamEvent(
	evt: RequestStreamEvt,
	now: number,
): PublicStreamEventDto | null {
	switch (evt.type) {
		case "snapshot":
			return {
				type: "active.snapshot",
				schema: PUBLIC_SCHEMA,
				now,
				active: evt.active.map((entry) => ({
					id: truncateUtf8(entry.id),
					startedAt: entry.timestamp,
					method: truncateUtf8(entry.method),
					path: truncateUtf8(entry.path),
					project: str(entry.project),
					model: str(entry.model),
					phase: entry.phase,
					accountId: str(entry.accountId),
					statusCode: entry.statusCode,
				})),
			};
		case "ingress":
			return {
				type: "request.opened",
				id: truncateUtf8(evt.id),
				at: evt.timestamp,
				method: truncateUtf8(evt.method),
				path: truncateUtf8(evt.path),
				project: str(evt.project),
				model: str(evt.model),
			};
		case "ingress-end":
			return {
				type: "request.dropped",
				id: truncateUtf8(evt.id),
				statusCode: evt.statusCode,
			};
		case "start":
			return {
				type: "request.upstream",
				id: truncateUtf8(evt.id),
				at: evt.timestamp,
				method: truncateUtf8(evt.method),
				path: truncateUtf8(evt.path),
				accountId: str(evt.accountId),
				statusCode: evt.statusCode,
				project: str(evt.project),
				model: str(evt.model),
			};
		case "summary":
			return toPublicRequestDoneDto(evt.payload, now);
		default:
			// An event this surface does not carry. Dropped rather than forwarded
			// raw: an unmapped shape on a public wire is exactly the leak the DTO
			// layer exists to prevent.
			return null;
	}
}

/**
 * `GET /public/v1/stream` — live request activity, in the public vocabulary.
 *
 * Full DATA parity with the internal dashboard stream (project and model names
 * included) but not wire-schema identity. Three behaviours are preserved
 * exactly from the internal lane because a client depends on each:
 *
 *  - SUBSCRIBE, THEN SNAPSHOT. The reverse order leaves a gap: a request that
 *    settles between building the snapshot and attaching the listener appears
 *    in neither, and the client holds it as pending until its lost-timeout.
 *    This order can only OVERLAP, and the client reducer is idempotent.
 *  - The snapshot is sent UNCONDITIONALLY, empty included. Its arrival is the
 *    only signal that replay finished, and an empty one is what retracts rows a
 *    reconnecting device still holds.
 *  - The `server-shutdown` event name, which marks a clean disconnect so the
 *    device reconnects immediately instead of backing off.
 */
export function createPublicStreamHandler(
	heartbeatIntervalMs = SSE_HEARTBEAT_INTERVAL_MS,
	now: () => number = Date.now,
	/**
	 * Source of the connect-time replay. Injected ONLY so a test can observe
	 * WHEN it is read: the subscribe-then-snapshot ordering is otherwise
	 * invisible from outside — both orders produce a snapshot frame, and only
	 * one of them produces it with the listener already attached.
	 */
	readActive: () => ActiveRequestEntry[] = getActiveRequests,
) {
	return (req: Request): Response => {
		let writeHandler: ((data: RequestStreamEvt) => void) | null = null;
		let heartbeat: ReturnType<typeof setInterval> | null = null;
		let isClosed = false;
		let streamController: ReadableStreamDefaultController<Uint8Array> | null =
			null;
		let unregisterCloser: (() => void) | null = null;

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
		};

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();

				writeHandler = (data: RequestStreamEvt) => {
					if (isClosed) return;
					const mapped = toPublicStreamEvent(data, now());
					if (!mapped) return;
					try {
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify(mapped)}\n\n`),
						);
					} catch {
						cleanup();
					}
				};

				controller.enqueue(encoder.encode("event: connected\ndata: ok\n\n"));

				// Subscribe FIRST. See the handler docstring: the reverse order is a
				// gap, this order is at worst a duplicate.
				requestEvents.on("event", writeHandler);

				// …then replay. Unconditional, empty included.
				writeHandler({ type: "snapshot", active: readActive() });

				heartbeat = setInterval(() => {
					if (isClosed) return;
					try {
						controller.enqueue(encoder.encode(": ping\n\n"));
					} catch {
						cleanup();
					}
				}, heartbeatIntervalMs);

				// Endless streams would otherwise hold Bun's graceful drain at
				// shutdown until the watchdog fires.
				streamController = controller;
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
				cleanup();
			},
		});

		req.signal?.addEventListener("abort", () => {
			if (!isClosed) cleanup();
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
