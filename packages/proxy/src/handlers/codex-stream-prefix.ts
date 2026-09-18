import { isCodexTransientError } from "../codex-transient-health";
import {
	type StreamFailurePayload,
	streamFailureCode,
} from "../stream-failure-code";

/**
 * Codex signals some backend failures as HTTP 200 followed by an in-band SSE
 * `error` event (or a `response.failed` terminal). When that happens before any
 * content has been generated, the response is worthless to the client, so the
 * attempt can still be handed to a sibling account — but only if the failure is
 * seen BEFORE the response is committed to the client.
 *
 * This peek reads a CLONE of the response's leading events and reports the
 * transient failure code it found, or null. Null is the "forward unchanged"
 * answer for every other case: content already streamed, a non-transient code,
 * an unparseable frame, or any bound expiring.
 *
 * Content safety is the stop rule: the peek walks only the prelude events, which
 * carry no generated text, and ends at the first event that is not one. A
 * response that has produced even one delta is never discarded here.
 */

/** Events a Codex Responses stream emits before it has produced any content. */
const PRELUDE_EVENTS: ReadonlySet<string> = new Set([
	"response.created",
	"response.in_progress",
]);

/** Event names that carry an in-band failure. */
const FAILURE_EVENTS: ReadonlySet<string> = new Set([
	"error",
	"response.failed",
]);

/** Provider keepalives carry no generated content and must not commit a stream. */
const KEEPALIVE_EVENTS: ReadonlySet<string> = new Set(["keepalive"]);

/**
 * Prelude events observed in practice are `response.created` +
 * `response.in_progress`; the budget leaves room for one or two more rather than
 * reading an unbounded prefix.
 */
export const CODEX_PEEK_MAX_EVENTS = 4;
export const CODEX_PEEK_MAX_BYTES = 256 * 1024;
/** Maximum content-free wait; callers also cap it by the request's elapsed time. */
export const CODEX_PEEK_TIMEOUT_MS = 90_000;

export interface CodexStreamPeekOptions {
	maxEvents?: number;
	maxBytes?: number;
	timeoutMs?: number;
}

type SsePayload = StreamFailurePayload & {
	item?: { type?: unknown; content?: unknown; summary?: unknown };
	type?: unknown;
};

type FrameVerdict =
	/** Comment/keepalive: no event name and no payload. Keep reading. */
	| { kind: "skip" }
	/** A prelude event. Keep reading. */
	| { kind: "prelude" }
	/** Content, or anything unrecognised: commit the response as-is. */
	| { kind: "commit" }
	/** An in-band failure, transient or not. */
	| { kind: "failure"; code: string };

function classifyFrame(frame: string): FrameVerdict {
	let eventName = "";
	const data: string[] = [];
	for (const line of frame.split(/\r?\n/)) {
		if (line.startsWith("event:")) eventName = line.slice(6).trim();
		else if (line.startsWith("data:"))
			data.push(line.slice(5).replace(/^ /, ""));
	}
	const payload = data.join("\n");
	let parsed: SsePayload | null = null;
	if (payload) {
		try {
			parsed = JSON.parse(payload) as SsePayload;
		} catch {
			return { kind: "commit" };
		}
	}
	const payloadType = typeof parsed?.type === "string" ? parsed.type : "";
	// The event NAME and the payload `type` are each independently authoritative,
	// never `type ?? name`: a backend has been seen naming an event
	// `response.failed` while its payload carries `"type":"error"`, so a
	// nullish-coalesce would let the payload mask the terminal event name.
	// usage-collector's applySseData applies the same OR rule to the same shape.
	const names = [eventName, payloadType].filter((name) => name.length > 0);
	if (names.length === 0) return { kind: "skip" };
	if (names.some((name) => FAILURE_EVENTS.has(name)))
		return { kind: "failure", code: streamFailureCode(parsed ?? {}) };
	if (names.every((name) => KEEPALIVE_EVENTS.has(name)))
		return { kind: "skip" };
	if (
		names.every((name) => name === "response.output_item.added") &&
		parsed?.item?.type === "reasoning" &&
		[parsed.item.content, parsed.item.summary].every(
			(value) =>
				value === undefined || (Array.isArray(value) && value.length === 0),
		)
	)
		return { kind: "prelude" };
	if (names.every((name) => PRELUDE_EVENTS.has(name)))
		return { kind: "prelude" };
	return { kind: "commit" };
}

/**
 * @returns the transient failure code found in the stream's prefix, or null when
 *   the response should be forwarded unchanged.
 *
 * Only an HTTP 200 `text/event-stream` is inspected. That guard is safe ONLY
 * downstream of the Codex provider's native fix-up, which sets the content-type
 * the backend routinely omits; call this before that fix-up and the traffic this
 * exists for is rejected by the guard.
 *
 * The clone's reader is cancelled in the `finally` and NEVER awaited: with the
 * twin (the response the caller may still forward) unread, a tee's cancel
 * promise does not settle at all. The cancel still marks the branch cancelled
 * synchronously, so the tee stops feeding it immediately and a later
 * `discardUpstreamBody` on the twin has no live twin of its own.
 */
export async function peekCodexStreamPrefix(
	response: Response,
	signal?: AbortSignal,
	opts: CodexStreamPeekOptions = {},
): Promise<string | null> {
	const maxEvents = opts.maxEvents ?? CODEX_PEEK_MAX_EVENTS;
	const maxBytes = opts.maxBytes ?? CODEX_PEEK_MAX_BYTES;
	const timeoutMs = opts.timeoutMs ?? CODEX_PEEK_TIMEOUT_MS;
	if (
		timeoutMs <= 0 ||
		response.status !== 200 ||
		!response.body ||
		!response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream")
	)
		return null;
	signal?.throwIfAborted();
	const reader = response.clone().body?.getReader();
	if (!reader) return null;
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let events = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const stop = new Promise<null>((resolve, reject) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		if (signal) {
			onAbort = () =>
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	try {
		while (bytes < maxBytes) {
			const next = await Promise.race([reader.read(), stop]);
			if (!next || next.done) return null;
			const prefix = next.value.subarray(0, maxBytes - bytes);
			bytes += prefix.byteLength;
			text += decoder.decode(prefix, { stream: true });
			while (true) {
				const boundary = /\r?\n\r?\n/.exec(text);
				if (!boundary) break;
				const frame = text.slice(0, boundary.index);
				text = text.slice(boundary.index + boundary[0].length);
				const verdict = classifyFrame(frame);
				if (verdict.kind === "skip") continue;
				if (verdict.kind === "commit") return null;
				if (verdict.kind === "failure")
					return isCodexTransientError(verdict.code) ? verdict.code : null;
				if (++events >= maxEvents) return null;
			}
		}
		return null;
	} catch (_error) {
		signal?.throwIfAborted();
		// The forwarded branch still owns any transport error for normal handling.
		return null;
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
