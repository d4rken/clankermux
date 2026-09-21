import { isCodexTransientError } from "../codex-transient-health";
import { extractServedModel, sseFrameData } from "../routing-response-audit";
import {
	type StreamFailurePayload,
	streamFailureCode,
} from "../stream-failure-code";

/**
 * Reads the leading frames of an upstream response to answer two questions
 * before a single byte reaches the client:
 *
 *   1. which model did the provider say it served?
 *   2. (Codex only) did it open with an in-band transient failure?
 *
 * Both answers must be read from the RAW upstream body. After
 * `processResponse`, the adapters seed their model from the
 * `x-clankermux-resolved-model` header — what this proxy SENT — and overwrite it
 * only if a chunk names one, so a later reader can end up comparing the sent
 * model against itself.
 *
 * One reader serves both questions deliberately. Two peeks over one stream tee a
 * branch of a branch, and each would charge its own timeout against the same
 * request clock, so the second could begin already expired and silently stop
 * detecting anything.
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

/**
 * Two frames is enough for the model alone: Anthropic names it in
 * `message_start` and Codex in `response.created`, each the first event of its
 * stream. The spare absorbs a provider that leads with a named but modelless
 * frame.
 */
export const SERVED_MODEL_PEEK_MAX_FRAMES = 2;

/**
 * NOT a latency budget, and not safe to lower. Codex's `response.created`
 * echoes the whole request-side object, `instructions` and full `tools` schemas
 * included, so a tool-laden turn puts tens of KiB in the FIRST frame. Truncating
 * it yields "cannot tell" for every request on the one provider this exists for
 * — a silent, total disablement rather than a visible failure.
 */
export const SERVED_MODEL_PEEK_MAX_BYTES = 256 * 1024;

/**
 * Maximum content-free wait; callers also cap it by the request's elapsed time.
 *
 * This is not added latency. The frame being waited for is the frame that had to
 * arrive before any content could, so time-to-first-TOKEN is unchanged. The
 * ceiling only has to stay under the server's own idle timeout.
 */
export const SERVED_MODEL_PEEK_TIMEOUT_MS = 90_000;

/** A non-stream body above this is not read at all; the verdict is "cannot tell". */
export const SERVED_MODEL_JSON_MAX_BYTES = 1024 * 1024;

/**
 * A non-stream body has to be read to EOF before it can be parsed, so unlike
 * the streaming case the wait is NOT free — a slow or stalled body would hold
 * the response for the whole budget. That is not hypothetical: a 200 carrying
 * `anthropic-ratelimit-unified-status: rate_limited` has to fail over promptly,
 * and it arrives on this path.
 *
 * Armed only once the framing is known to be non-SSE, and never extends the
 * caller's deadline — it can only shorten it.
 */
export const SERVED_MODEL_JSON_TIMEOUT_MS = 3_000;

/**
 * A leading SSE token. Comment frames are included because a stream may open
 * with `: keepalive`, which a narrower `^(event:|data:)` test would classify as
 * non-SSE — and then buffer to the deadline, missing both answers.
 */
const SSE_LEADING = /^\uFEFF?[\r\n]*(?::|event:|data:|id:|retry:)/;
const JSON_LEADING = /^\uFEFF?\s*[{[]/;

type SsePayload = StreamFailurePayload & {
	item?: { type?: unknown; content?: unknown; summary?: unknown };
	type?: unknown;
};

export type FrameVerdict =
	/** Comment/keepalive: no event name and no payload. Keep reading. */
	| { kind: "skip" }
	/** A prelude event. Keep reading. */
	| { kind: "prelude" }
	/** Content, or anything unrecognised: commit the response as-is. */
	| { kind: "commit" }
	/** An in-band failure, transient or not. */
	| { kind: "failure"; code: string };

export function classifyFrame(frame: string): FrameVerdict {
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

/** Payload/event names that exist only to hold a connection open. */
const KEEPALIVE_NAMES: ReadonlySet<string> = new Set(["ping", "keepalive"]);

/**
 * Whether a frame is a heartbeat rather than a frame that could name a model.
 *
 * Checks the payload's `type` and the frame's `event:` name independently: a
 * provider may set either, and `usage-collector` applies the same OR rule to
 * the same shape.
 */
function isKeepaliveFrame(parsed: unknown, frame: string): boolean {
	const type = (parsed as { type?: unknown } | null)?.type;
	if (typeof type === "string" && KEEPALIVE_NAMES.has(type)) return true;
	for (const line of frame.split(/\r?\n/))
		if (line.startsWith("event:"))
			return KEEPALIVE_NAMES.has(line.slice(6).trim());
	return false;
}

export interface ServedModelPeekOptions {
	/** Substantive frames to read while still looking for the model. */
	maxFrames?: number;
	maxBytes?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Also classify Codex prelude frames and report a transient failure code. */
	codexFailure?: boolean;
	/** Prelude events to walk before giving up on the Codex failure question. */
	maxCodexEvents?: number;
	/** Skip the model question entirely; used by the Codex-failure-only caller. */
	skipModel?: boolean;
}

export interface ServedModelPeek {
	/** null means "could not tell". Never guessed, never defaulted. */
	servedModel: string | null;
	/** Only ever non-null when `codexFailure` was requested. */
	codexFailureCode: string | null;
}

const UNKNOWN: ServedModelPeek = { servedModel: null, codexFailureCode: null };

/**
 * Every ambiguity — a missing body, an unrecognised framing, an unparseable
 * frame, a bound expiring, a transport error — answers `servedModel: null` and
 * the caller forwards unchanged. Failing open matters more here than anywhere
 * else in the rung: a wrong "substituted" verdict turns a working response into
 * a client-visible error.
 *
 * The clone's reader is cancelled in the `finally` and NEVER awaited: with the
 * twin (the response the caller may still forward) unread, a tee's cancel
 * promise does not settle at all. The cancel still marks the branch cancelled
 * synchronously, so the tee stops feeding it immediately.
 */
export async function peekServedModel(
	response: Response,
	opts: ServedModelPeekOptions = {},
): Promise<ServedModelPeek> {
	const maxFrames = opts.maxFrames ?? SERVED_MODEL_PEEK_MAX_FRAMES;
	const maxCodexEvents = opts.maxCodexEvents ?? CODEX_PEEK_MAX_EVENTS;
	const maxBytes = opts.maxBytes ?? SERVED_MODEL_PEEK_MAX_BYTES;
	const timeoutMs = opts.timeoutMs ?? SERVED_MODEL_PEEK_TIMEOUT_MS;
	const signal = opts.signal;
	const wantModel = !opts.skipModel;
	const wantFailure = opts.codexFailure === true;
	if (timeoutMs <= 0 || response.status !== 200 || !response.body)
		return UNKNOWN;
	if (!wantModel && !wantFailure) return UNKNOWN;

	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	const declaredSse = contentType.includes("text/event-stream");
	const declaredJson = contentType.includes("application/json");
	// A JSON body is read whole, so an oversized one is rejected before the
	// clone: cloning to abandon the read would tee a body nobody drains.
	if (!declaredSse) {
		const declaredLength = Number(response.headers.get("content-length"));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > SERVED_MODEL_JSON_MAX_BYTES
		)
			return UNKNOWN;
	}

	signal?.throwIfAborted();
	const reader = response.clone().body?.getReader();
	if (!reader) return UNKNOWN;
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	/** Frames carrying a payload, counted for the model question only. */
	let modelFrames = 0;
	/** Prelude events, counted for the Codex failure question only. */
	let codexEvents = 0;
	let servedModel: string | null = null;
	let codexFailureCode: string | null = null;
	let modelDone = !wantModel;
	let failureDone = !wantFailure;
	// Unknown until the first chunk when the provider omits the header, which the
	// Codex backend routinely does.
	let sse: boolean | null = declaredSse ? true : declaredJson ? false : null;
	// A declared JSON body needs the short deadline from the first read, not
	// from the sniff it will never reach.
	const jsonFromTheStart = sse === false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	let expire: () => void = () => {};
	const startedAt = Date.now();
	const stop = new Promise<null>((resolve, reject) => {
		expire = () => resolve(null);
		timer = setTimeout(expire, timeoutMs);
		if (signal) {
			onAbort = () =>
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	/** Shorten, never extend, once the body is known to need reading whole. */
	const armJsonDeadline = () => {
		const remaining = timeoutMs - (Date.now() - startedAt);
		if (remaining <= SERVED_MODEL_JSON_TIMEOUT_MS) return;
		clearTimeout(timer);
		timer = setTimeout(expire, SERVED_MODEL_JSON_TIMEOUT_MS);
	};
	const result = (): ServedModelPeek => ({ servedModel, codexFailureCode });
	if (jsonFromTheStart) armJsonDeadline();
	try {
		while (bytes < maxBytes) {
			const next = await Promise.race([reader.read(), stop]);
			if (!next) return result();
			if (next.done) {
				// A non-stream body is only trustworthy once it is whole: the
				// Responses shape echoes `instructions` and `input` ahead of
				// `model`, so a truncated head can carry a user-supplied string
				// where the served model belongs.
				if (sse === false && wantModel && servedModel === null) {
					try {
						servedModel = extractServedModel(JSON.parse(text));
					} catch {
						/* Not JSON after all: "cannot tell". */
					}
				}
				return result();
			}
			const prefix = next.value.subarray(0, maxBytes - bytes);
			bytes += prefix.byteLength;
			text += decoder.decode(prefix, { stream: true });
			if (sse === null) {
				if (SSE_LEADING.test(text)) sse = true;
				else if (JSON_LEADING.test(text)) {
					sse = false;
					armJsonDeadline();
				} else if (text.trim().length > 0) return UNKNOWN;
			}
			if (sse !== true) continue;
			while (true) {
				const boundary = /\r?\n\r?\n/.exec(text);
				if (!boundary) break;
				const frame = text.slice(0, boundary.index);
				text = text.slice(boundary.index + boundary[0].length);

				if (!modelDone) {
					const payload = sseFrameData(frame);
					// A frame with no `data:` line is a comment or a bare event
					// name; it carries no model and does not spend the budget.
					if (payload) {
						try {
							const parsed: unknown = JSON.parse(payload);
							const found = extractServedModel(parsed);
							if (found !== null) servedModel = found;
							// A keepalive carries a payload but can never carry a
							// model, so counting it would let two of them exhaust the
							// budget before the opening frame ever arrived. Judged on
							// the payload alone, NOT via `classifyFrame`: that answers
							// the Codex prelude/content question, under which a bare
							// `{"model":"…"}` chat frame is unnamed and would be
							// skipped — dropping the very frame being looked for.
							else if (!isKeepaliveFrame(parsed, frame)) modelFrames++;
						} catch {
							// An unparseable frame is the end of what can be read
							// reliably, matching the Codex classifier's stop rule.
							modelDone = true;
						}
						if (servedModel !== null || modelFrames >= maxFrames)
							modelDone = true;
					}
				}
				if (!failureDone) {
					const verdict = classifyFrame(frame);
					if (verdict.kind === "commit") failureDone = true;
					else if (verdict.kind === "failure") {
						codexFailureCode = isCodexTransientError(verdict.code)
							? verdict.code
							: null;
						failureDone = true;
					} else if (verdict.kind === "prelude") {
						if (++codexEvents >= maxCodexEvents) failureDone = true;
					}
				}
				// Finding the model must NOT end the read while the Codex failure
				// question is still open: that failure arrives in a LATER frame than
				// `response.created`, so stopping early would regress the in-band
				// failover this reader also serves.
				if (modelDone && failureDone) return result();
			}
		}
		return result();
	} catch (_error) {
		signal?.throwIfAborted();
		// The forwarded branch still owns any transport error for normal handling.
		return result();
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
