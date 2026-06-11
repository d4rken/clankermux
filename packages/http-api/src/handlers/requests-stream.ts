import { type RequestEvt, requestEvents } from "@clankermux/core";

// Periodic SSE comment so the socket never sits idle long enough for
// Bun.serve's idleTimeout (255s) to kill quiet dashboard streams overnight.
// EventSource ignores comment lines; they only reset the server idle timer.
const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

export function createRequestsStreamHandler(
	heartbeatIntervalMs = SSE_HEARTBEAT_INTERVAL_MS,
) {
	return (req: Request): Response => {
		// Store the write handler outside to access it in cancel
		let writeHandler: ((data: RequestEvt) => void) | null = null;
		let heartbeat: ReturnType<typeof setInterval> | null = null;
		let isClosed = false;

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
		};

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();

				// Helper to send SSE formatted data with error handling
				writeHandler = (data: RequestEvt) => {
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
