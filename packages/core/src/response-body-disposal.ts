/**
 * Response-body disposal primitives.
 *
 * Two DIFFERENT kinds of abandoned body need two DIFFERENT treatments, and
 * using the wrong one costs memory (or hangs):
 *
 *   - A NATIVE `fetch()` body must be DRAINED. At Bun 1.3.x a fetch Response
 *     body that is neither read to EOF nor cancelled keeps its socket and its
 *     ~512 KB native read buffer committed indefinitely; cancelling alone does
 *     not reliably return the native allocation, whereas reading to EOF does.
 *     Use {@link discardUpstreamBody}.
 *
 *   - A `clone()` / tee BRANCH must be CANCELLED, never drained. Draining a
 *     branch forces the tee to keep pulling bytes FOR that branch and buffer
 *     them for the twin — measured on Bun 1.3.14, draining a tee branch retains
 *     ~2.7x what cancelling it does. Use {@link discardTeeBranch}.
 *
 * Both functions return `void` and run their work as an internally-guarded
 * fire-and-forget task. That is deliberate: disposal happens on failover /
 * retry / error paths where the caller must move on to the next candidate
 * IMMEDIATELY, and awaiting the disposal would serialise the very failover this
 * exists to keep fast. A `void` return also makes an accidental `await` at a
 * call site harmless (it resolves instantly) rather than silently blocking.
 *
 * This module is a dependency-free leaf on purpose:
 *   - It lives in `@clankermux/core` because BOTH `@clankermux/proxy` and
 *     `@clankermux/providers` need it and `core` is the only runtime package
 *     both depend on (proxy depends on providers, so a proxy-local home would
 *     be a package cycle).
 *   - It is published as the `@clankermux/core/response-body-disposal` subpath
 *     and is deliberately NOT re-exported from `packages/core/src/index.ts`.
 *     That barrel is curated and `@clankermux/core` is a dependency of
 *     `dashboard-web`, whose bundle is a systemd `ExecStartPre` — anything
 *     added to the barrel reaches the browser bundle. `./renewal` is the
 *     precedent.
 *   - It therefore uses UNIVERSAL Web APIs only (`Response`, `ReadableStream`,
 *     `getReader`, `cancel`). No `node:` imports, no Bun-specific globals.
 */

/**
 * Wall-clock ceiling for a single drain. A stalled or infinite upstream stream
 * must never pin its reader and network connection while later candidates are
 * being tried: `makeProxyRequest` clears its own request timeout as soon as the
 * response HEADERS arrive, so nothing else bounds the body. On expiry the drain
 * gives up and falls back to a best-effort `cancel()`.
 */
const DRAIN_TIME_BUDGET_MS = 5_000;

/**
 * Byte ceiling for a single drain. Everything we discard is an error body or an
 * abandoned attempt, which is kilobytes in practice; this only exists so a
 * pathological (or hostile) multi-gigabyte body cannot be read to EOF just to
 * release it. On expiry the drain gives up and falls back to `cancel()`.
 */
const DRAIN_BYTE_BUDGET = 8 * 1024 * 1024;

/**
 * Size of EACH of the two windows the marker scan looks at — a prefix window
 * over the first bytes of the body and a rolling suffix window over the last
 * ones. Two windows are needed because the signatures live at both ends: the
 * opening frame (`message_start`, a short non-streaming completion) is at the
 * head, while the terminal ones (`message_delta`, `response.completed`, and the
 * root `"usage"` of a long non-streaming completion) are at the TAIL. Scanning
 * only the head would miss a completed answer in exactly the case this guard
 * exists for. Both windows are fixed, so the scan stays O(1) in memory for a
 * multi-megabyte body.
 */
const MARKER_SCAN_BYTES = 64 * 1024;

/**
 * Characters of the previous chunk carried into the next one so a signature
 * split across a chunk boundary is still seen. Comfortably longer than the
 * longest literal we match.
 */
const MARKER_CARRY_CHARS = 64;

/** Why {@link discardUpstreamBody} stopped reading. */
export type DrainStopReason =
	/** The body ended — everything was released. */
	| "eof"
	/** {@link DRAIN_TIME_BUDGET_MS} expired; the rest was cancelled. */
	| "time-budget"
	/** {@link DRAIN_BYTE_BUDGET} was hit; the rest was cancelled. */
	| "byte-budget"
	/** The stream errored or was cancelled from elsewhere mid-drain. */
	| "stream-error"
	/** Another reader already owned the body, so no drain ran at all. */
	| "locked";

/**
 * A completion/usage signature spotted in an abandoned body. Its presence means
 * the upstream had already produced (part of) a real answer that is being
 * thrown away — the case worth an operator's attention, and one a size
 * threshold alone cannot catch (a valid short completion is ~70 bytes).
 */
export type DrainMarker =
	/** Non-streaming Anthropic completion: `"type":"message"` plus a `"usage"`. */
	| "anthropic-message-usage"
	/** Anthropic SSE opening frame. */
	| "sse-message-start"
	/** Anthropic SSE frame carrying the final usage. */
	| "sse-message-delta"
	/** Codex Responses API terminal event. */
	| "codex-response-completed";

/** What a drain observed, handed to the optional completion callback. */
export interface DrainReport {
	/** Bytes actually pulled off the wire (0 when `stopReason` is "locked"). */
	bytesRead: number;
	/** True only when the body ended on its own. */
	reachedEof: boolean;
	stopReason: DrainStopReason;
	/** The first completion/usage signature seen, or null if none matched. */
	marker: DrainMarker | null;
}

const ANTHROPIC_MESSAGE_TYPE_RE = /"type"\s*:\s*"message"/;
const USAGE_PROPERTY_RE = /"usage"\s*:/;

/**
 * Bounded, allocation-light scan for completion/usage signatures over bytes the
 * drain is already reading. Deliberately NOT a JSON/SSE parser: it never
 * materialises the body and stops dead once something matches.
 *
 * Two fixed windows, each {@link MARKER_SCAN_BYTES} (see that constant for why
 * one end is not enough):
 *
 *   - PREFIX: `feed` decodes only the part of a chunk that still fits in the
 *     window — never the whole chunk — so a single huge first chunk costs the
 *     failover path one 64 KiB decode, not a multi-megabyte one.
 *   - SUFFIX: every chunk is copied into a fixed-size ring buffer, so the last
 *     64 KiB of the body are always available. Nothing is decoded until
 *     {@link finish}, which runs once, after the last chunk.
 */
function createMarkerScanner(): {
	feed(chunk: Uint8Array): void;
	finish(): void;
	marker(): DrainMarker | null;
} {
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let carry = "";
	let prefixScanned = 0;
	let marker: DrainMarker | null = null;
	// The two halves of the non-streaming signature can be far apart in a long
	// body — `"type":"message"` at the head, `"usage"` at the tail — so they
	// latch independently, across chunks AND across the two windows.
	let sawMessageType = false;
	let sawUsage = false;

	// Fixed-size ring holding the most recent MARKER_SCAN_BYTES bytes.
	const suffix = new Uint8Array(MARKER_SCAN_BYTES);
	let suffixWrite = 0;
	let suffixFilled = 0;

	function appendSuffix(chunk: Uint8Array): void {
		// Only the tail of an oversized chunk can survive in the window.
		const src =
			chunk.byteLength > MARKER_SCAN_BYTES
				? chunk.subarray(chunk.byteLength - MARKER_SCAN_BYTES)
				: chunk;
		if (src.byteLength === 0) return;
		const head = Math.min(src.byteLength, MARKER_SCAN_BYTES - suffixWrite);
		suffix.set(src.subarray(0, head), suffixWrite);
		if (head < src.byteLength) suffix.set(src.subarray(head), 0);
		suffixWrite = (suffixWrite + src.byteLength) % MARKER_SCAN_BYTES;
		suffixFilled = Math.min(MARKER_SCAN_BYTES, suffixFilled + src.byteLength);
	}

	/** The ring's contents in stream order. */
	function suffixBytes(): Uint8Array {
		if (suffixFilled < MARKER_SCAN_BYTES)
			return suffix.subarray(0, suffixWrite);
		const ordered = new Uint8Array(MARKER_SCAN_BYTES);
		ordered.set(suffix.subarray(suffixWrite));
		ordered.set(
			suffix.subarray(0, suffixWrite),
			MARKER_SCAN_BYTES - suffixWrite,
		);
		return ordered;
	}

	return {
		feed(chunk: Uint8Array): void {
			if (marker !== null) return;
			appendSuffix(chunk);

			const room = MARKER_SCAN_BYTES - prefixScanned;
			if (room <= 0) return;
			// Decode ONLY what still fits in the prefix window.
			const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
			prefixScanned += slice.byteLength;
			const text = carry + decoder.decode(slice, { stream: true });

			if (text.includes("message_start")) {
				marker = "sse-message-start";
				return;
			}
			if (text.includes("message_delta")) {
				marker = "sse-message-delta";
				return;
			}
			if (text.includes("response.completed")) {
				marker = "codex-response-completed";
				return;
			}
			if (!sawMessageType)
				sawMessageType = ANTHROPIC_MESSAGE_TYPE_RE.test(text);
			if (!sawUsage) sawUsage = USAGE_PROPERTY_RE.test(text);
			if (sawMessageType && sawUsage) {
				marker = "anthropic-message-usage";
				return;
			}

			carry = text.slice(-MARKER_CARRY_CHARS);
		},
		finish(): void {
			if (marker !== null) return;
			const bytes = suffixBytes();
			if (bytes.byteLength === 0) return;
			// A ring window can start mid-codepoint; a non-fatal decode turns that
			// into a replacement character rather than throwing, and no signature we
			// match is affected.
			const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

			if (text.includes("message_delta")) {
				marker = "sse-message-delta";
				return;
			}
			if (text.includes("response.completed")) {
				marker = "codex-response-completed";
				return;
			}
			if (!sawUsage) sawUsage = USAGE_PROPERTY_RE.test(text);
			// The head half may have latched in the prefix window many megabytes ago.
			if (sawMessageType && sawUsage) marker = "anthropic-message-usage";
		},
		marker(): DrainMarker | null {
			return marker;
		},
	};
}

/**
 * Release a NATIVE `fetch()` response body that will never be forwarded.
 *
 * Drains the body to EOF (bounded by {@link DRAIN_TIME_BUDGET_MS} and
 * {@link DRAIN_BYTE_BUDGET}) so Bun returns the socket and the ~512 KB native
 * read buffer, then cancels whatever is left. Never uses `arrayBuffer()`: that
 * would materialise the whole body on the heap to throw it away.
 *
 * Fire-and-forget by design (see the module comment). Safe to call with any
 * `Response`/`null`/`undefined` and safe to call twice: a `null` or already
 * locked body is skipped (locked means some other reader already owns it — it
 * will be drained or was cloned), and every error is swallowed because a body
 * that is already cancelled or errored has nothing left to release.
 *
 * @param onDrained - Optional OBSERVER, invoked at most once when the drain
 *   finishes, with what it saw ({@link DrainReport}). It exists so callers can
 *   report on abandoned bodies (e.g. "this failover threw away a completed
 *   answer") WITHOUT changing control flow: the return type stays `void`, so
 *   failover never waits on a dead account's body, and the callback therefore
 *   runs long after the caller has moved on. Anything it throws is swallowed.
 *   Not invoked when there is no body at all (nothing was disposed); invoked
 *   with `stopReason: "locked"` when a body existed but someone else owned it.
 */
export function discardUpstreamBody(
	response: Response | null | undefined,
	onDrained?: (report: DrainReport) => void,
): void {
	const body = response?.body;
	if (!body) return;
	if (body.locked) {
		report(onDrained, {
			bytesRead: 0,
			reachedEof: false,
			stopReason: "locked",
			marker: null,
		});
		return;
	}
	void drainToRelease(body, onDrained);
}

function report(
	onDrained: ((report: DrainReport) => void) | undefined,
	value: DrainReport,
): void {
	if (!onDrained) return;
	try {
		onDrained(value);
	} catch {
		// An observer must never be able to break disposal.
	}
}

async function drainToRelease(
	body: ReadableStream<Uint8Array>,
	onDrained?: (report: DrainReport) => void,
): Promise<void> {
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = body.getReader();
	} catch {
		// Locked between the guard above and here — someone else owns it now.
		report(onDrained, {
			bytesRead: 0,
			reachedEof: false,
			stopReason: "locked",
			marker: null,
		});
		return;
	}

	// `expired` is flipped by the deadline timer, which ALSO cancels the reader
	// so a hung `read()` resolves instead of hanging the drain forever. The
	// timer is always cleared in the `finally`, so it can never outlive the
	// drain (no unref needed, and nothing Node-specific is required).
	let expired = false;
	const deadline = setTimeout(() => {
		expired = true;
		reader.cancel().catch(() => {});
	}, DRAIN_TIME_BUDGET_MS);

	// Only built when someone is listening — an unobserved drain stays exactly as
	// cheap as it was.
	const scanner = onDrained ? createMarkerScanner() : null;
	let drained = 0;
	let reachedEof = false;
	let stopReason: DrainStopReason = "byte-budget";

	try {
		while (!expired && drained < DRAIN_BYTE_BUDGET) {
			const { value, done } = await reader.read();
			// `expired` is checked BEFORE `done`: the deadline timer cancels the
			// reader, and that cancellation is what resolves this very `read()` with
			// `done: true`. Trusting `done` first would report a forcibly timed-out
			// drain as a clean EOF — and the guard's value rests on these fields
			// being trustworthy.
			if (expired) {
				stopReason = "time-budget";
				return;
			}
			if (done) {
				reachedEof = true;
				stopReason = "eof";
				return;
			}
			drained += value?.byteLength ?? 0;
			if (scanner && value) scanner.feed(value);
		}
		stopReason = expired ? "time-budget" : "byte-budget";
	} catch {
		// Stream errored or was cancelled mid-drain — nothing left to release.
		stopReason = expired ? "time-budget" : "stream-error";
	} finally {
		clearTimeout(deadline);
		// No-op after a clean EOF; the real release when a budget expired.
		reader.cancel().catch(() => {});
		// Scan the tail window before the report is built — the terminal
		// signatures only ever appear there.
		scanner?.finish();
		report(onDrained, {
			bytesRead: drained,
			reachedEof,
			stopReason,
			marker: scanner?.marker() ?? null,
		});
	}
}

/**
 * Release a `clone()` / tee BRANCH that will never be read.
 *
 * Cancels — deliberately does NOT drain (see the module comment: draining a
 * branch makes the tee buffer for the twin).
 *
 * Never awaited, and callers must not await it either. `await
 * branch.body.cancel()` with the twin still unread does not settle (measured:
 * >3 s, no resolution) and that is spec-correct: WHATWG `ReadableStreamTee`
 * settles its `cancelPromise` only once BOTH branches have cancelled, and the
 * twin here is the live response someone else is actively reading.
 *
 * Safe with any `Response`/`null`/`undefined`; skips a null/locked body and
 * swallows the harmless error from an already-cancelled one.
 */
export function discardTeeBranch(response: Response | null | undefined): void {
	const body = response?.body;
	if (!body || body.locked) return;
	try {
		body.cancel().catch(() => {});
	} catch {
		// Body became locked/disturbed between the guard and the call.
	}
}
