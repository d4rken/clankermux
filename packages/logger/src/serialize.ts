// Serialization guards shared by the Logger (index.ts) and LogFileWriter
// (file-writer.ts). Logging happens synchronously on the caller's stack, so an
// unguarded JSON.stringify on caller-supplied data (circular refs, BigInt, a
// throwing toJSON) would throw an uncaught TypeError INTO the business logic
// that was merely trying to log. These helpers make serialization never throw:
// the offending payload is replaced with a `[unserializable: <reason>]` marker
// while the surrounding log envelope (ts/level/msg) is preserved.
//
// Kept dependency-free (like file-writer.ts's local constants) so it can be
// imported from either logger module without risking a circular import.

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
