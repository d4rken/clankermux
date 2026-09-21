/**
 * Hop-by-hop headers (RFC 9110 §7.6.1): they govern a single transport link
 * and MUST NOT be forwarded by a proxy — `connection: close` forwarded
 * upstream, for example, invites the upstream to close its connection abruptly
 * after the response. `Connection` may additionally NAME further headers as
 * hop-by-hop for its link; those are removed too.
 */
const HOP_BY_HOP_HEADERS = [
	"connection",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"proxy-authenticate",
	"proxy-authorization",
];

/**
 * End-to-end fields a Connection header must not be able to delete: RFC 9110
 * forbids listing end-to-end fields in `Connection`, and at the proxy's
 * outbound chokepoint they may already carry proxy-generated credentials — a
 * hostile client sending `Connection: authorization, cookie` must not strip
 * the proxy's own auth.
 */
const CONNECTION_UNDELETABLE = new Set(["authorization", "cookie", "host"]);

/** RFC 9110 token grammar — `Headers.delete` THROWS on an invalid name, so a
 * malformed Connection value (`Connection: bad name`) must be skipped, not
 * passed through. */
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Deletes every hop-by-hop header (and every valid, deletable header the
 * `Connection` header names) from `headers`, IN PLACE. Apply to outbound
 * upstream requests at the pre-fetch chokepoint and to upstream responses
 * before re-serving them; the runtime re-derives per-link framing
 * (Content-Length, Transfer-Encoding) itself.
 */
export function stripHopByHopHeaders(headers: Headers): void {
	const connection = headers.get("connection");
	if (connection) {
		for (const name of connection.split(",")) {
			const trimmed = name.trim().toLowerCase();
			if (!HTTP_TOKEN_PATTERN.test(trimmed)) continue;
			if (CONNECTION_UNDELETABLE.has(trimmed)) continue;
			headers.delete(trimmed);
		}
	}
	for (const name of HOP_BY_HOP_HEADERS) {
		headers.delete(name);
	}
}

/**
 * Sanitizes proxy response headers: removes the headers invalidated by Bun's
 * automatic response decompression (content-encoding, content-length,
 * transfer-encoding) plus the remaining hop-by-hop set (connection,
 * keep-alive, upgrade, …), which describes the upstream link, not ours.
 */
export function sanitizeProxyHeaders(original: Headers): Headers {
	const sanitized = new Headers(original);

	// Remove headers that are invalidated by automatic decompression
	sanitized.delete("content-encoding");
	sanitized.delete("content-length");
	// Adapter fallback metadata is internal to response conversion.
	sanitized.delete("x-clankermux-resolved-model");
	stripHopByHopHeaders(sanitized);

	return sanitized;
}

/**
 * The Codex CLI's per-turn continuity token. Opaque, and on
 * {@link STORAGE_IDENTITY_HEADERS} — so its VALUE never reaches storage.
 */
export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

/**
 * Character count of the turn-state token, or null when the request carried no
 * such header. 0 means the header was present and empty, which is a different
 * observation from absent.
 *
 * The length is recorded because the token is claimed to vary in size with the
 * account's service tier; whether it actually does is what
 * `requests.codex_turn_state_len` exists to measure.
 */
export function codexTurnStateLength(headers: Headers): number | null {
	const value = headers.get(CODEX_TURN_STATE_HEADER);
	return value === null ? null : value.length;
}

/**
 * Credentials and stable identifiers that must never reach storage, on EITHER
 * side of the exchange. One list for both sanitizers on purpose: they used to
 * carry separate hand-maintained sets, and the request side gained names the
 * response side never did. A stored header set now outlives its payload by
 * months, so a name missing from one list is a credential kept for a quarter.
 *
 * Several of these travel in both directions — a client sends
 * `x-codex-session-id` and upstream echoes it, `authorization` is a request
 * credential while `set-cookie` is its response-side counterpart — so the
 * split was never along the request/response line anyway.
 *
 * `proxy-authorization` is on the RFC 9110 hop-by-hop list above, but neither
 * sanitizer calls {@link stripHopByHopHeaders}; it is named here so it cannot
 * depend on that.
 */
const STORAGE_IDENTITY_HEADERS = [
	// Credentials.
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"cookie",
	"set-cookie",
	"set-cookie2",
	// Stable client/session/turn identifiers.
	"x-claude-code-session-id",
	"thread-id",
	"session-id",
	// Underscore spelling, not a typo: the Codex CLI sends both, and
	// `Headers.delete` matches the exact name.
	"session_id",
	"x-client-request-id",
	"x-codex-installation-id",
	"x-codex-window-id",
	CODEX_TURN_STATE_HEADER,
	"x-codex-session-id",
	"x-codex-conversation-id",
	"chatgpt-account-id",
	"traceparent",
	"tracestate",
] as const;

/**
 * Compression/framing headers invalidated by Bun's automatic decompression:
 * the stored value would describe a body that no longer exists in that form.
 */
const STORAGE_FRAMING_HEADERS = [
	"accept-encoding",
	"content-encoding",
	"content-length",
	"transfer-encoding",
] as const;

/**
 * Removes credentials, stable identity headers, and compression negotiation
 * headers from the ORIGINAL client request before it is persisted for
 * analytics. Storage only — nothing on the forwarding path calls this, so a
 * name added here is dropped from the archive, not from the upstream request.
 */
export function sanitizeRequestHeaders(original: Headers): Headers {
	const h = new Headers(original);
	for (const name of STORAGE_FRAMING_HEADERS) h.delete(name);
	for (const name of STORAGE_IDENTITY_HEADERS) h.delete(name);
	// Internal routing/probe headers: meaningful to this proxy, noise in an archive.
	h.delete("x-clankermux-account-id");
	h.delete("x-clankermux-bypass-session");
	h.delete("x-clankermux-keepalive");
	h.delete("x-clankermux-auto-refresh");
	h.delete("x-clankermux-skip-cache");
	return h;
}

/**
 * Response headers that are pure volume for analytics: a per-response unique
 * value nothing aggregates over. Measured on 300 live payloads, these four
 * cost 562 bytes of the 1882-byte average response header set — a fifth of it,
 * and the reason a stored header set never dedupes against its neighbours.
 */
const STORAGE_NOISE_RESPONSE_HEADERS = [
	"report-to",
	"traceresponse",
	"cf-ray",
	"nel",
] as const;

/**
 * Sanitizes UPSTREAM response headers before they are persisted for analytics.
 * Distinct from {@link sanitizeProxyHeaders}, which prepares headers to send to
 * the client and must keep things a client needs (cookies, trace ids) that a
 * long-lived archive must not hold.
 */
export function sanitizeResponseHeadersForStorage(original: Headers): Headers {
	const h = new Headers(original);
	for (const name of STORAGE_IDENTITY_HEADERS) h.delete(name);
	for (const name of STORAGE_NOISE_RESPONSE_HEADERS) h.delete(name);
	for (const name of STORAGE_FRAMING_HEADERS) h.delete(name);
	return h;
}

/**
 * Return a new Response with hop-by-hop / compression headers stripped.
 * Body & status are preserved.
 */
export function withSanitizedProxyHeaders(res: Response): Response {
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: sanitizeProxyHeaders(res.headers),
	});
}
