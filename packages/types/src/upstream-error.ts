/**
 * Pure, dependency-free parser that extracts a human-readable upstream error
 * message from a captured HTTP response body, so callers can surface *why* a
 * request failed instead of a generic "stream error" / "Unknown error".
 *
 * Three JSON envelope conventions are understood:
 *   - Anthropic/OpenAI — `{"type":"error","error":{"type":...,"message":...}}`
 *   - FastAPI — `{"detail": ...}`, what the ChatGPT/Codex backend raises
 *     (e.g. `{"detail":"Unsupported parameter: max_output_tokens"}`)
 *   - a bare top-level `{"message": ...}`
 * plus SSE error frames (`event: error\ndata: {...}`).
 *
 * Returns `null` when no error can be extracted — callers fall back to their
 * own generic label rather than to raw body bytes. That is deliberate: the
 * result is both persisted (`requests.error_message`) and, via the OpenAI
 * Responses adapter, returned to the client, so this parser only ever emits
 * values the upstream put in a recognized *error* field. It never echoes
 * arbitrary body content.
 *
 * Lives in `@clankermux/types` rather than in the proxy because two packages
 * consume it (the proxy's request recorder and the OpenAI Responses adapter)
 * and this is the only package low enough in the graph for both.
 */

const MAX_UPSTREAM_ERROR_LEN = 300;
const SSE_TAIL_SCAN_BYTES = 16 * 1024;

/**
 * How many entries of a structured `detail` list are rendered before the rest
 * are elided. This bounds the work and keeps the common case readable; it is
 * NOT the authoritative limit — `normalizeAndTruncate` still caps the joined
 * string and can cut inside an entry when the messages are long.
 */
const MAX_DETAIL_ENTRIES = 5;

/**
 * Where a parsed JSON object came from. The SSE branch feeds EVERY `data:`
 * payload through the extractor, so the weaker envelope conventions have to be
 * gated on the source — see `extractErrorFromObject`.
 */
type EnvelopeSource = "body" | "sse-frame";

/** Trimmed string, or null when the value is not a string or is blank. */
function nonBlankString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Renders the value of an `error` key: the standard `{type, message}` object
 * (either half may be missing) or a flat string.
 */
function extractFromErrorValue(err: unknown): string | null {
	if (typeof err === "object" && err !== null) {
		const errRecord = err as Record<string, unknown>;
		const type = nonBlankString(errRecord.type);
		const message = nonBlankString(errRecord.message);
		if (type && message) return `${type}: ${message}`;
		return message ?? type ?? null;
	}
	return nonBlankString(err);
}

/**
 * Joins a FastAPI `loc` tuple (`["body","max_output_tokens"]`, where numeric
 * segments are list indices) into a dotted path. Without it a validation entry
 * reads "Field required" and names nothing.
 */
function renderDetailLocation(loc: unknown): string | null {
	if (!Array.isArray(loc)) return null;
	const segments: string[] = [];
	for (const segment of loc) {
		if (typeof segment === "number" && Number.isFinite(segment)) {
			segments.push(String(segment));
			continue;
		}
		const text = nonBlankString(segment);
		if (text) segments.push(text);
	}
	return segments.length > 0 ? segments.join(".") : null;
}

/**
 * Renders one entry of a structured `detail`: a bare string, or an object
 * carrying its human message under `msg` (FastAPI validation), `message`, or a
 * nested standard error envelope.
 *
 * Only the field path and the message are read. A validation entry also
 * carries `input`, which echoes the *rejected request value* straight back —
 * potentially a credential or prompt text — and this string is persisted and
 * shown to clients, so nothing outside the known message keys is rendered.
 */
function renderDetailEntry(entry: unknown): string | null {
	const direct = nonBlankString(entry);
	if (direct) return direct;
	if (typeof entry !== "object" || entry === null) return null;

	const record = entry as Record<string, unknown>;
	const message =
		nonBlankString(record.msg) ??
		nonBlankString(record.message) ??
		extractFromErrorValue(record.error);
	if (!message) return null;

	const location = renderDetailLocation(record.loc);
	return location ? `${location}: ${message}` : message;
}

/**
 * Renders a FastAPI `detail` value. It is a string for a hand-raised
 * HTTPException and a list of `{loc, msg, type, input}` entries for a
 * request-validation failure.
 *
 * An unrecognized shape yields null so the caller falls through to the next
 * convention. It is deliberately NOT `JSON.stringify`d: a serialized blob
 * would leak whatever the upstream put in unknown fields, inflate the
 * cardinality of the dashboard's error grouping (which groups on the message
 * verbatim), and truncate mid-token into invalid JSON that reads worse than
 * the generic label it replaced.
 */
function extractFromDetailValue(detail: unknown): string | null {
	const direct = nonBlankString(detail);
	if (direct) return direct;

	if (Array.isArray(detail)) {
		const parts: string[] = [];
		for (const entry of detail) {
			const rendered = renderDetailEntry(entry);
			if (rendered) parts.push(rendered);
			if (parts.length === MAX_DETAIL_ENTRIES) break;
		}
		if (parts.length === 0) return null;
		// Counted against the rendered parts rather than against how far the loop
		// walked, so the suffix means exactly "entries not represented above"
		// whether they were elided by the cap or skipped as unrecognizable.
		const omitted = detail.length - parts.length;
		if (omitted > 0) parts.push(`(+${omitted} more)`);
		return parts.join("; ");
	}

	if (typeof detail === "object" && detail !== null) {
		return renderDetailEntry(detail);
	}

	return null;
}

/**
 * Extracts an error string from a parsed JSON object.
 *
 * Precedence is `error` → `detail` → top-level `message`, and a branch that
 * yields nothing falls through to the next (an `{"error":{}}` wrapper must not
 * suppress a usable sibling). The order is deliberate rather than incidental:
 * `error` is the richest and most specific convention and the one every
 * first-party provider uses; `detail` is FastAPI's and unambiguous when
 * present; bare `message` comes last because it is the most collision-prone
 * key — an ordinary Anthropic `message_start` SSE frame has a top-level
 * `message`, which is why it is only ever accepted as a string.
 */
function extractErrorFromObject(
	obj: unknown,
	source: EnvelopeSource,
): string | null {
	if (typeof obj !== "object" || obj === null) return null;

	const record = obj as Record<string, unknown>;

	const fromError = extractFromErrorValue(record.error);
	if (fromError) return fromError;

	// `detail` is a whole-body convention: FastAPI raises it on a plain JSON
	// response, never as a frame inside an SSE stream. Since the SSE branch
	// feeds every `data:` payload through here, admitting a generic key there
	// would let an ordinary event invent error text for a request that failed
	// for an unrelated reason.
	if (source === "body") {
		const fromDetail = extractFromDetailValue(record.detail);
		if (fromDetail) return fromDetail;
	}

	return nonBlankString(record.message);
}

/**
 * Collapses internal whitespace to single spaces, trims, then truncates to
 * `MAX_UPSTREAM_ERROR_LEN` (replacing the final char with `…` when over cap).
 * Normalization is applied before the length check.
 */
function normalizeAndTruncate(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length > MAX_UPSTREAM_ERROR_LEN) {
		return `${normalized.slice(0, MAX_UPSTREAM_ERROR_LEN - 1)}…`;
	}
	return normalized;
}

export function parseUpstreamError(body: string): string | null {
	if (!body) return null;

	const trimmed = body.trimStart();

	// JSON envelope first.
	if (trimmed.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const extracted = extractErrorFromObject(parsed, "body");
			if (extracted) return normalizeAndTruncate(extracted);
		} catch {
			return null;
		}
		return null;
	}

	// SSE fallback: only scan the tail for an error frame.
	if (trimmed.includes("data:")) {
		const tail =
			trimmed.length > SSE_TAIL_SCAN_BYTES
				? trimmed.slice(-SSE_TAIL_SCAN_BYTES)
				: trimmed;

		let lastMatch: string | null = null;
		for (const rawLine of tail.split("\n")) {
			const line = rawLine.trim();
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload.startsWith("{")) continue; // covers `[DONE]`
			try {
				const parsed: unknown = JSON.parse(payload);
				const extracted = extractErrorFromObject(parsed, "sse-frame");
				if (extracted) lastMatch = extracted; // error frames are terminal
			} catch {
				// Ignore unparseable data payloads.
			}
		}

		if (lastMatch) return normalizeAndTruncate(lastMatch);
	}

	return null;
}
