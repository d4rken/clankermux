// Serialization guards shared by the Logger (index.ts), LogFileWriter
// (file-writer.ts), and the dashboard live-log SSE feed (http-api logs handler).
// Logging happens synchronously on the caller's stack, so an unguarded
// JSON.stringify on caller-supplied data (circular refs, BigInt, a throwing
// toJSON) would throw an uncaught TypeError INTO the business logic that was
// merely trying to log — and, on the SSE path, would masquerade as a closed
// socket and tear down a healthy log stream. These helpers make serialization
// never throw: the offending payload is replaced with a `[unserializable:
// <reason>]` marker while the surrounding log envelope (ts/level/msg) is
// preserved.
//
// Runtime-dependency-free (the LogEvent import is type-only, erased at compile
// time) so it can be imported from any logger consumer without a circular import.

import type { LogEvent } from "@clankermux/types";

/**
 * Extract a human-readable reason from a thrown value without ever throwing.
 * `String(value)` and an Error's `.message` getter can both throw for hostile
 * objects (e.g. a `Symbol.toPrimitive`/`toString` that raises), so even the
 * reason extraction is wrapped.
 */
export function safeReason(value: unknown): string {
	try {
		return value instanceof Error ? value.message : String(value);
	} catch {
		return "unknown serialization error";
	}
}

/**
 * Serialize a LogEvent to JSON without ever throwing. On the happy path the
 * result is byte-identical to `JSON.stringify(event)`. If the event's `data`
 * is unserializable, the envelope (ts/level/msg) is preserved and only `data`
 * is replaced with a `[unserializable: <reason>]` marker; if even that fails
 * (e.g. a hostile `msg` getter), a fixed, always-valid JSON line is returned so
 * a caller can never crash and no log entry is silently dropped.
 */
export function safeStringifyLogEvent(event: LogEvent): string {
	try {
		return JSON.stringify(event);
	} catch (e: unknown) {
		const reason = safeReason(e);
		try {
			const fallback: LogEvent = {
				ts: event.ts,
				level: event.level,
				msg: event.msg,
				data: `[unserializable: ${reason}]`,
			};
			return JSON.stringify(fallback);
		} catch {
			return JSON.stringify({
				ts: Date.now(),
				level: "ERROR",
				msg: "[unserializable log event]",
			});
		}
	}
}
