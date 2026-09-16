/**
 * The payload fields a failure code can hide in. Deliberately structural: the
 * usage collector passes its full `SseParsed`, the prefix peek passes a freshly
 * parsed frame.
 */
export interface StreamFailurePayload {
	code?: unknown;
	error?: { type?: unknown; code?: unknown };
	response?: { error?: { type?: unknown; code?: unknown } };
}

/**
 * Resolve the failure code of an SSE `error` / `response.failed` payload.
 *
 * ONE implementation, two readers: the usage collector reads it off the
 * committed stream, and the Codex stream-prefix peek reads it off a clone
 * before the response is committed. Both feed `isCodexTransientError`, so a
 * second copy drifting from this one would make the two disagree about the same
 * bytes.
 *
 * `response.error` is consulted BEFORE a top-level `error` because that is
 * where a `response.failed` payload nests its error:
 *
 *   {"type":"response.failed","response":{"error":{"code":"server_error"}}}
 *   {"type":"error","error":{"type":"service_unavailable_error",
 *                            "code":"server_is_overloaded"}}
 *
 * Anything that is not a lowercase identifier is reported as the generic
 * `upstream_stream_error` rather than passed through.
 */
export function streamFailureCode(parsed: StreamFailurePayload): string {
	const error = parsed.response?.error ?? parsed.error;
	const code = error?.code ?? parsed.code ?? error?.type;
	return typeof code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(code)
		? code
		: "upstream_stream_error";
}
