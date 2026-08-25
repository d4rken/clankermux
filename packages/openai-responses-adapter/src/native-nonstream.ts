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
 * The ChatGPT/Codex backend diverges from the public OpenAI Responses shape in
 * exactly one way that matters here: its terminal envelope carries
 * `"output": []`. The assistant message, reasoning items and tool calls exist
 * only in the `response.output_item.done` events that precede it (verified live
 * on 2026-08-25; the captured stream is the fixture behind
 * __tests__/real-codex-sse.fixture.ts). Handing that envelope to a
 * non-streaming client verbatim gives it a 200 with no content at all.
 *
 * So the scanner retains finalized items as it goes and, ONLY when the terminal
 * envelope's `output` is an empty array, substitutes the assembled list. A
 * public-OpenAI-shaped terminal already carries its full output and keeps
 * passing through verbatim — including its retained items being ignored, since
 * the backend's own array is authoritative whenever it exists.
 *
 * Only `.done` items are used, never the `output_text.delta` fragments: an item
 * the backend never finalized is represented exactly as far as the backend got,
 * rather than being reconstructed from deltas into something the backend never
 * said. Recognition uses the same OR rule as terminals — the `event:` field or
 * the parsed `data.type`.
 */
const OUTPUT_ITEM_DONE_EVENT = "response.output_item.done";

/**
 * Cap on the bytes RETAINED while scanning ONE frame: the incomplete trailing
 * line plus the `data:` payload of the event currently being assembled. Events
 * other than finalized output items are discarded the moment they are
 * dispatched, so the whole SSE is never held. That is affordable because the
 * expected concurrency of NON-streaming native clients is low (the only known
 * client, Codex CLI, always streams); a client that streams never reaches this
 * module at all.
 *
 * (The proxy's own 256 KiB `MAX_NON_STREAM_BODY_BYTES` is an analytics capture
 * bound and never applies here — from the proxy's point of view this response
 * is still a stream.)
 */
export const MAX_NATIVE_NONSTREAM_SSE_BYTES = 32 * 1024 * 1024;

/**
 * Separate cap on the bytes held by RETAINED finalized output items, which live
 * across frames rather than being dropped at dispatch.
 *
 * It is deliberately its own budget rather than a share of the frame cap above.
 * Charging items against the frame cap would let one large finalized item make
 * a later, individually-legal terminal frame oversized — rejecting a stream in
 * which every single document fits, and changing shipped behavior for the
 * non-empty-output terminals that never needed items in the first place.
 *
 * Both numbers bound LOGICAL payload bytes, not JS heap: the parsed objects,
 * the decoder's intermediate strings and the re-serialization of the terminal
 * envelope all cost extra on top, transiently several times the payload size.
 * Peak logical payload for one request is therefore the frame cap plus this
 * one, and the heap figure is a multiple of that.
 */
export const MAX_NATIVE_NONSTREAM_ITEMS_BYTES = 32 * 1024 * 1024;

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
	| { kind: "malformed" }
	| { kind: "oversized" };

const NONE: ScanOutcome = { kind: "none" };
const MALFORMED: ScanOutcome = { kind: "malformed" };
const OVERSIZED: ScanOutcome = { kind: "oversized" };

/** A finalized output item plus the payload bytes it is charged for. */
type RetainedItem = { item: Record<string, unknown>; bytes: number };

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
 * reports the first terminal one. Events are dropped as soon as they are
 * dispatched — except finalized output items, which are retained because a
 * ChatGPT-backend terminal envelope cannot be answered without them (see
 * OUTPUT_ITEM_DONE_EVENT above).
 */
class NativeSseScanner {
	/** Trailing bytes that are not yet a complete line. */
	private pending = "";
	private pendingBytes = 0;
	/** `data:` field values of the event being assembled (SSE joins with \n). */
	private dataLines: string[] = [];
	private dataBytes = 0;
	private eventName: string | null = null;
	private eventNameBytes = 0;

	/**
	 * Finalized items that carried a usable `output_index`, keyed by it. A Map
	 * rather than a sparse array: the backend's indices are its own, and nothing
	 * here should depend on them being dense or starting at zero.
	 */
	private indexedItems = new Map<number, RetainedItem>();
	/**
	 * Finalized items whose `output_index` was absent or unusable, in arrival
	 * order. They get their OWN list instead of a synthesized key: "largest index
	 * so far + 1" would collide with a later real index and silently overwrite
	 * output the backend did send.
	 */
	private unindexedItems: RetainedItem[] = [];
	private itemsBytes = 0;
	/**
	 * Set when a recognized done event could not be retained (unparseable data, a
	 * missing or non-record `item`, an unserializable one). Consulted ONLY where
	 * it changes an answer: a terminal that needs reconstruction. Reporting a
	 * 502 there is the honest outcome, because the alternative is a 200 whose
	 * `output` silently omits whatever that event was carrying.
	 */
	private itemsCorrupt = false;

	/**
	 * Bytes currently held: incomplete line + assembled event payload + the
	 * current event's name. The name is small in every real stream, but it is
	 * retained across lines exactly like the payload is, so it belongs in the
	 * number the cap is measured against.
	 */
	get retainedBytes(): number {
		return this.pendingBytes + this.dataBytes + this.eventNameBytes;
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
			// Assignment, not accumulation: a repeated `event:` line replaces the
			// name it retains rather than adding to it.
			this.eventNameBytes = utf8Length(value);
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
		this.eventNameBytes = 0;

		// Blank line with nothing buffered (stream padding, repeated delimiters).
		if (data === "" && name === null) return NONE;

		const namedTerminal = name !== null && TERMINAL_EVENT_NAMES.has(name);
		const namedDoneItem = name === OUTPUT_ITEM_DONE_EVENT;

		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			// An unparseable payload is only an error when the event announced
			// itself as the terminal one. Anything else is noise the scanner has no
			// stake in — sentinel frames, partial vendor extensions, `[DONE]`.
			if (namedTerminal) return MALFORMED;
			// A done event that cannot be read is different from noise: it was
			// carrying output this scanner may have to reconstruct from.
			if (namedDoneItem) this.itemsCorrupt = true;
			return NONE;
		}

		const type = isRecord(parsed) ? parsed.type : undefined;
		const typedTerminal =
			typeof type === "string" && TERMINAL_EVENT_NAMES.has(type);
		// Terminal recognition is checked first: an event claiming both names is
		// pathological, and answering the client is what this module is for.
		if (namedTerminal || typedTerminal) return this.finishTerminal(parsed);
		if (namedDoneItem || type === OUTPUT_ITEM_DONE_EVENT) {
			return this.retainItem(parsed);
		}
		return NONE;
	}

	/** Retain one `response.output_item.done` payload's `item`. */
	private retainItem(parsed: unknown): ScanOutcome {
		const item = isRecord(parsed) ? parsed.item : undefined;
		if (!isRecord(item)) {
			this.itemsCorrupt = true;
			return NONE;
		}

		let bytes: number;
		try {
			bytes = utf8Length(JSON.stringify(item));
		} catch {
			// Only reachable for values JSON.parse cannot produce (a getter, a
			// BigInt); fail the same way as a missing item rather than trust it.
			this.itemsCorrupt = true;
			return NONE;
		}

		// `null` means "no usable index": absent, non-numeric, negative,
		// fractional, or past the safe-integer range.
		const rawIndex = isRecord(parsed) ? parsed.output_index : undefined;
		const index =
			typeof rawIndex === "number" &&
			Number.isSafeInteger(rawIndex) &&
			rawIndex >= 0
				? rawIndex
				: null;

		// A re-emitted index supersedes what it replaces, so the entry it evicts
		// stops being charged — otherwise a backend that re-sends one item could
		// exhaust the budget with bytes nothing is holding.
		const superseded =
			index === null ? undefined : this.indexedItems.get(index);
		const nextBytes = this.itemsBytes + bytes - (superseded?.bytes ?? 0);
		if (nextBytes > MAX_NATIVE_NONSTREAM_ITEMS_BYTES) return OVERSIZED;

		this.itemsBytes = nextBytes;
		if (index === null) this.unindexedItems.push({ item, bytes });
		else this.indexedItems.set(index, { item, bytes });
		return NONE;
	}

	/**
	 * Produce the client's JSON body from a terminal envelope, repairing an empty
	 * `output` from the retained items.
	 */
	private finishTerminal(parsed: unknown): ScanOutcome {
		const response = isRecord(parsed) ? parsed.response : undefined;
		if (!isRecord(response)) return MALFORMED;

		if (Array.isArray(response.output) && response.output.length === 0) {
			// Only here does a dropped item change the answer.
			if (this.itemsCorrupt) return MALFORMED;
			const items = this.assembleItems();
			if (items.length > 0) response.output = items;
		}

		// Otherwise verbatim: no status rewriting, no id substitution. The
		// backend's own envelope is what the client would have received had it
		// streamed.
		try {
			return { kind: "terminal", responseJson: JSON.stringify(response) };
		} catch {
			return MALFORMED;
		}
	}

	/** Indexed items in ascending index order, then unindexed ones as they came. */
	private assembleItems(): Array<Record<string, unknown>> {
		const indexed = [...this.indexedItems.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, retained]) => retained.item);
		return [
			...indexed,
			...this.unindexedItems.map((retained) => retained.item),
		];
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
	// Structurally non-rejecting: the caller (handler.ts) awaits this on the
	// request's hot path and does not catch, so a rejection here would surface as
	// an unhandled failure instead of the 502 this module is supposed to produce.
	// Every known path already returns a result; this is the guarantee, not a
	// replacement for them.
	try {
		return await scanNativeTerminalResponse(body, opts);
	} catch {
		return { ok: false, reason: "read-error" };
	}
}

async function scanNativeTerminalResponse(
	body: ReadableStream<Uint8Array>,
	opts: { signal?: AbortSignal },
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
			if (outcome.kind === "malformed") {
				return { ok: false, reason: "malformed-terminal" };
			}
			if (outcome.kind === "oversized") {
				return { ok: false, reason: "oversized" };
			}
			return { ok: false, reason: "no-terminal" };
		}

		const value = chunk.value;
		if (!value || value.byteLength === 0) continue;

		if (
			scanner.retainedBytes + value.byteLength >
			MAX_NATIVE_NONSTREAM_SSE_BYTES
		) {
			// Checked BEFORE the chunk is decoded and scanned, because scanning it
			// is what would allocate past the cap: a terminal event completing
			// inside an over-cap chunk would otherwise be parsed, re-serialized and
			// returned as a 200, and the cap would never be consulted. The bound has
			// to hold for the bytes this module is about to touch, not only for what
			// it still holds afterwards.
			//
			// The price is that a chunk larger than the remaining budget is refused
			// even when it would have reduced into small, discardable events. That
			// is the correct trade: a single chunk that big is already outside the
			// shape of any real Codex-Responses stream.
			cancelQuietly(reader);
			return { ok: false, reason: "oversized" };
		}

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
		if (outcome.kind === "oversized") {
			// The retained-items budget is exhausted: this stream cannot produce a
			// complete answer no matter how much more of it is read. Cancel rather
			// than drain, exactly as the frame cap does.
			cancelQuietly(reader);
			return { ok: false, reason: "oversized" };
		}

		if (scanner.retainedBytes > MAX_NATIVE_NONSTREAM_SSE_BYTES) {
			// Defensive backstop. The pre-check above already refuses any chunk that
			// could carry retention past the cap, so reaching here means the
			// scanner's incremental byte accounting drifted upward from the raw
			// chunk sizes. Fail closed rather than trust the discrepancy.
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
