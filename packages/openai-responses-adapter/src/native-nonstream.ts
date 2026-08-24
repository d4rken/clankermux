import { Buffer } from "node:buffer";

/**
 * Non-streaming leg of the native Responses passthrough.
 *
 * A `/v1/responses` request with `"stream": false` still travels to the Codex
 * backend as SSE — the provider forces `stream: true` upstream, because that is
 * the only transport the backend serves reliably and it is what every usage /
 * analytics path in the proxy is built around. The client asked for one JSON
 * document, so the SSE has to be reduced to the terminal event's `response`
 * envelope somewhere, and that somewhere is here: the adapter, downstream of
 * the proxy's analytics passthrough, is the last place that still knows what
 * the client actually asked for.
 *
 * The extraction is a standalone, line-oriented SSE scanner rather than a reuse
 * of `parseAndProcessChunk` from stream-translator.ts: that parser is welded to
 * the Anthropic→Responses translation state machine and emits events, while
 * this one only has to find one envelope and forget everything else.
 */

/**
 * Terminal event vocabulary, and the OR rule for recognizing it, are the SAME
 * as the proxy's usage collector (packages/proxy/src/usage-collector.ts): an
 * event terminates the stream when EITHER its `event:` field OR its parsed
 * `data.type` is one of these names. Either field is authoritative on its own —
 * backends have been seen naming an event `response.failed` while its payload
 * carries `"type": "error"`, and dropping such a frame would leave the client
 * waiting on a terminal that already went past.
 */
const TERMINAL_EVENT_NAMES: ReadonlySet<string> = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
]);

/**
 * Cap on the bytes RETAINED while scanning: the incomplete trailing line plus
 * the `data:` payload of the event currently being assembled. Processed
 * non-terminal events are discarded the moment they are dispatched, so the
 * whole SSE is never held — peak per-request memory is this cap, transiently
 * ~3x it while one terminal event is parsed and re-serialized. That is
 * affordable because the expected concurrency of NON-streaming native clients
 * is low (the only known client, Codex CLI, always streams); a client that
 * streams never reaches this module at all.
 *
 * (The proxy's own 256 KiB `MAX_NON_STREAM_BODY_BYTES` is an analytics capture
 * bound and never applies here — from the proxy's point of view this response
 * is still a stream.)
 */
export const MAX_NATIVE_NONSTREAM_SSE_BYTES = 32 * 1024 * 1024;

/**
 * Bound on the bytes consumed by the post-terminal drain. Draining to natural
 * EOF is what keeps the analytics passthrough from recording a client
 * disconnect, but a backend that never stops sending must not pin a request
 * forever: past this many bytes the stream is pathological and gets cancelled.
 */
export const MAX_NATIVE_NONSTREAM_DRAIN_BYTES = 256 * 1024 * 1024;

export type NativeTerminalFailureReason =
	| "no-terminal"
	| "malformed-terminal"
	| "oversized"
	| "read-error";

export type NativeTerminalResult =
	| { ok: true; responseJson: string }
	| { ok: false; reason: NativeTerminalFailureReason };

type ScanOutcome =
	| { kind: "none" }
	| { kind: "terminal"; responseJson: string }
	| { kind: "malformed" };

const NONE: ScanOutcome = { kind: "none" };
const MALFORMED: ScanOutcome = { kind: "malformed" };

/** What `reader.read()` resolves to, spelled without a lib-dependent alias. */
type ReaderResult = Awaited<
	ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Cancel without ever awaiting. The stream handed to this module is the proxy's
 * analytics passthrough, whose `cancel()` awaits ITS upstream reader and can
 * hang on a stalled backend (packages/proxy/src/stream-analytics.ts) — awaiting
 * it would hang the client response instead. Rejections are swallowed:
 * cancelling an already-errored stream rejects and there is nothing to do about
 * it.
 */
function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	void reader.cancel().catch(() => {});
}

/**
 * Incremental SSE scanner: fed decoded text, it dispatches complete events and
 * reports the first terminal one. Non-terminal events are dropped as soon as
 * they are dispatched, so nothing accumulates except the current line and the
 * current event's `data:` payload.
 */
class NativeSseScanner {
	/** Trailing bytes that are not yet a complete line. */
	private pending = "";
	private pendingBytes = 0;
	/** `data:` field values of the event being assembled (SSE joins with \n). */
	private dataLines: string[] = [];
	private dataBytes = 0;
	private eventName: string | null = null;

	/** Bytes currently held: incomplete line + assembled event payload. */
	get retainedBytes(): number {
		return this.pendingBytes + this.dataBytes;
	}

	/**
	 * Consume one decoded chunk. `byteLength` is the size of the chunk's raw
	 * bytes; it is tracked incrementally (added here, subtracted per consumed
	 * line) so the retention cap never has to re-measure the whole buffer.
	 */
	push(text: string, byteLength: number): ScanOutcome {
		this.pending += text;
		this.pendingBytes += byteLength;
		let newline = this.pending.indexOf("\n");
		while (newline !== -1) {
			const raw = this.pending.slice(0, newline);
			this.pending = this.pending.slice(newline + 1);
			// The raw line's bytes plus the "\n" itself leave the buffer; a "\r"
			// belonging to a CRLF delimiter is part of `raw` and accounted with it.
			this.pendingBytes -= utf8Length(raw) + 1;
			const outcome = this.handleLine(
				raw.endsWith("\r") ? raw.slice(0, -1) : raw,
			);
			if (outcome.kind !== "none") return outcome;
			newline = this.pending.indexOf("\n");
		}
		return NONE;
	}

	/**
	 * End of stream: take the decoder's remainder, then treat whatever is left
	 * without a trailing newline as a final line and dispatch the pending event.
	 *
	 * Providers really do close right after the last `data:` byte, with no
	 * trailing blank line — the proxy's usage collector flushes the same way
	 * (usage-collector.ts). A truncated envelope goes through the same path and
	 * simply fails to parse, which is what distinguishes it from a complete
	 * event that merely lacked its delimiter.
	 */
	flush(tail: string): ScanOutcome {
		const outcome = this.push(tail, utf8Length(tail));
		if (outcome.kind !== "none") return outcome;
		if (this.pending.length > 0) {
			const raw = this.pending;
			this.pending = "";
			this.pendingBytes = 0;
			const lineOutcome = this.handleLine(
				raw.endsWith("\r") ? raw.slice(0, -1) : raw,
			);
			if (lineOutcome.kind !== "none") return lineOutcome;
		}
		return this.dispatch();
	}

	private handleLine(line: string): ScanOutcome {
		if (line === "") return this.dispatch();
		// Comment / keepalive line.
		if (line.startsWith(":")) return NONE;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			this.dataLines.push(value);
			// +1 for the "\n" the join will insert.
			this.dataBytes += utf8Length(value) + 1;
		} else if (field === "event") {
			this.eventName = value;
		}
		// `id:` / `retry:` / unknown fields carry nothing this scanner needs.
		return NONE;
	}

	/** Evaluate and then FORGET the assembled event. */
	private dispatch(): ScanOutcome {
		const data = this.dataLines.join("\n");
		const name = this.eventName;
		this.dataLines = [];
		this.dataBytes = 0;
		this.eventName = null;

		// Blank line with nothing buffered (stream padding, repeated delimiters).
		if (data === "" && name === null) return NONE;

		const namedTerminal = name !== null && TERMINAL_EVENT_NAMES.has(name);

		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			// An unparseable payload is only an error when the event announced
			// itself as the terminal one. Anything else is noise the scanner has no
			// stake in — sentinel frames, partial vendor extensions, `[DONE]`.
			return namedTerminal ? MALFORMED : NONE;
		}

		const type = isRecord(parsed) ? parsed.type : undefined;
		const typedTerminal =
			typeof type === "string" && TERMINAL_EVENT_NAMES.has(type);
		if (!namedTerminal && !typedTerminal) return NONE;

		const response = isRecord(parsed) ? parsed.response : undefined;
		if (!isRecord(response)) return MALFORMED;
		// Verbatim: no status rewriting, no id substitution. The backend's own
		// envelope is what the client would have received had it streamed.
		return { kind: "terminal", responseJson: JSON.stringify(response) };
	}
}

/**
 * Read `body` (raw Codex-Responses SSE) until the first terminal event and
 * return that event's `response` object serialized as JSON.
 *
 * On success the stream is NEVER cancelled: it is the proxy's analytics
 * passthrough, and cancelling it records a client disconnect and — for
 * `response.incomplete` / `response.failed` — inflates the request's output
 * tokens through the bytes/4 fallback. The remainder is read and discarded
 * instead, so analytics sees an ordinary end of stream. The malformed-terminal
 * path drains for the same reason: a 502 out of this module is a server-side
 * fault, not a client that walked away.
 */
export async function extractNativeTerminalResponse(
	body: ReadableStream<Uint8Array>,
	opts: { signal?: AbortSignal } = {},
): Promise<NativeTerminalResult> {
	const signal = opts.signal;
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	const scanner = new NativeSseScanner();

	for (;;) {
		if (signal?.aborted) {
			cancelQuietly(reader);
			return { ok: false, reason: "read-error" };
		}

		let chunk: ReaderResult;
		try {
			chunk = await reader.read();
		} catch {
			// The stream is already dead; nothing left to drain.
			cancelQuietly(reader);
			return { ok: false, reason: "read-error" };
		}

		if (chunk.done) {
			const outcome = scanner.flush(decoder.decode());
			if (outcome.kind === "terminal") {
				return { ok: true, responseJson: outcome.responseJson };
			}
			return {
				ok: false,
				reason:
					outcome.kind === "malformed" ? "malformed-terminal" : "no-terminal",
			};
		}

		const value = chunk.value;
		if (!value || value.byteLength === 0) continue;

		const outcome = scanner.push(
			decoder.decode(value, { stream: true }),
			value.byteLength,
		);
		if (outcome.kind === "terminal") {
			await drainToEnd(reader, signal);
			return { ok: true, responseJson: outcome.responseJson };
		}
		if (outcome.kind === "malformed") {
			await drainToEnd(reader, signal);
			return { ok: false, reason: "malformed-terminal" };
		}

		if (scanner.retainedBytes > MAX_NATIVE_NONSTREAM_SSE_BYTES) {
			// Checked AFTER processing so a chunk that happens to be large but
			// splits into complete, discardable events is not punished for its
			// framing. What trips the cap is retention — an event (or a line) that
			// genuinely cannot be reduced, whether it grew across chunks or arrived
			// as one oversized chunk.
			cancelQuietly(reader);
			return { ok: false, reason: "oversized" };
		}
	}
}

/**
 * Read and discard the rest of the stream so it ends naturally. Read errors are
 * swallowed: the result is already decided, and a backend that dies after its
 * terminal event has nothing left to tell us.
 */
async function drainToEnd(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal | undefined,
): Promise<void> {
	let drained = 0;
	for (;;) {
		if (signal?.aborted) {
			// The client is gone — a disconnect record is honest now, and there is
			// nobody left to be kept waiting on the drain.
			cancelQuietly(reader);
			return;
		}
		let chunk: ReaderResult;
		try {
			chunk = await reader.read();
		} catch {
			return;
		}
		if (chunk.done) return;
		drained += chunk.value?.byteLength ?? 0;
		if (drained > MAX_NATIVE_NONSTREAM_DRAIN_BYTES) {
			cancelQuietly(reader);
			return;
		}
	}
}
