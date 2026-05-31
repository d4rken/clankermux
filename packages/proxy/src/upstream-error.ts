/**
 * Pure, dependency-free parser that extracts a human-readable upstream error
 * message from a captured HTTP response body, so the proxy can surface *why* a
 * request failed instead of a generic "stream error".
 *
 * Handles both JSON error envelopes (e.g. Anthropic's
 * `{"type":"error","error":{"type":...,"message":...}}`) and SSE error frames
 * (`event: error\ndata: {...}`). Returns `null` when no error can be extracted.
 */

const MAX_UPSTREAM_ERROR_LEN = 300;
const SSE_TAIL_SCAN_BYTES = 16 * 1024;

/**
 * Extracts an error string from a parsed JSON object.
 *
 * Mirrors the envelope conventions used elsewhere in the proxy
 * (`json.error?.type`, `json.error?.message ?? json.message`).
 */
function extractErrorFromObject(obj: unknown): string | null {
	if (typeof obj !== "object" || obj === null) return null;

	const record = obj as Record<string, unknown>;
	const err = record.error;

	if (typeof err === "object" && err !== null) {
		const errRecord = err as Record<string, unknown>;
		const type = typeof errRecord.type === "string" ? errRecord.type : null;
		const message =
			typeof errRecord.message === "string" ? errRecord.message : null;
		if (type && message) return `${type}: ${message}`;
		return message ?? type ?? null;
	}

	if (typeof err === "string" && err) return err;

	if (typeof record.message === "string" && record.message) {
		return record.message;
	}

	return null;
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
			const extracted = extractErrorFromObject(parsed);
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
				const extracted = extractErrorFromObject(parsed);
				if (extracted) lastMatch = extracted; // error frames are terminal
			} catch {
				// Ignore unparseable data payloads.
			}
		}

		if (lastMatch) return normalizeAndTruncate(lastMatch);
	}

	return null;
}
