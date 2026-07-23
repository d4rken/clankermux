import { sseResponse } from "@clankermux/http-common";
import { Logger, logBus, safeStringifyLogEvent } from "@clankermux/logger";
import type { LogEvent } from "@clankermux/types";
import { registerSseCloser } from "../sse-registry";

const log = new Logger("LogsHandler");

// Periodic SSE comment so the socket never sits idle long enough for
// Bun.serve's idleTimeout (255s) to kill quiet dashboard streams overnight.
// EventSource ignores comment lines; they only reset the server idle timer.
const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Create a logs stream handler using Server-Sent Events
 */
export function createLogsStreamHandler(
	heartbeatIntervalMs = SSE_HEARTBEAT_INTERVAL_MS,
) {
	return (req: Request): Response => {
		// Use TransformStream for better Bun compatibility
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		let closed = false;
		let handleLogEvent: ((event: LogEvent) => Promise<void>) | null = null;
		let heartbeat: ReturnType<typeof setInterval> | null = null;
		let unregisterCloser: (() => void) | null = null;

		const cleanup = () => {
			closed = true;
			if (handleLogEvent) {
				logBus.off("log", handleLogEvent);
				handleLogEvent = null;
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

		// Send initial connection message
		(async () => {
			try {
				const initialData = `data: ${JSON.stringify({ connected: true })}\n\n`;
				await writer.write(encoder.encode(initialData));
			} catch (e) {
				log.error("Error sending initial message:", e);
			}
		})();

		// Listen for log events
		handleLogEvent = async (event: LogEvent) => {
			if (closed) return;

			try {
				// safeStringifyLogEvent never throws on an unserializable event, so a
				// serialization failure can't masquerade as a closed socket here and
				// tear down a healthy stream — this catch now only fires on a genuine
				// write failure.
				const data = `data: ${safeStringifyLogEvent(event)}\n\n`;
				await writer.write(encoder.encode(data));
			} catch (_error) {
				// Stream closed
				cleanup();
				try {
					await writer.close();
				} catch {}
			}
		};

		// Subscribe to log events
		logBus.on("log", handleLogEvent);

		// Periodic heartbeat comment to keep the connection alive
		heartbeat = setInterval(async () => {
			if (closed) return;

			try {
				await writer.write(encoder.encode(": ping\n\n"));
			} catch (_error) {
				// Stream closed
				cleanup();
				try {
					await writer.close();
				} catch {}
			}
		}, heartbeatIntervalMs);

		// Register for proactive close at shutdown: this endless stream would
		// otherwise hold Bun's graceful drain until the watchdog.
		unregisterCloser = registerSseCloser(() => {
			if (closed) return;
			try {
				// Best-effort farewell only; ignore write failures.
				writer
					.write(encoder.encode("event: server-shutdown\ndata: bye\n\n"))
					.catch(() => {});
			} catch {}
			cleanup();
			try {
				writer.close().catch(() => {});
			} catch {}
		});

		// Clean up on abort signal
		req.signal?.addEventListener("abort", () => {
			if (!closed) {
				cleanup();
				try {
					writer.close();
				} catch {}
			}
		});

		return sseResponse(readable);
	};
}
