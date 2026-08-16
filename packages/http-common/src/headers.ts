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
 * Deletes every hop-by-hop header (and every header the `Connection` header
 * names) from `headers`, IN PLACE. Apply to outbound upstream requests at the
 * pre-fetch chokepoint and to upstream responses before re-serving them; the
 * runtime re-derives per-link framing (Content-Length, Transfer-Encoding)
 * itself.
 */
export function stripHopByHopHeaders(headers: Headers): void {
	const connection = headers.get("connection");
	if (connection) {
		for (const name of connection.split(",")) {
			const trimmed = name.trim();
			if (trimmed) headers.delete(trimmed);
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
	stripHopByHopHeaders(sanitized);

	return sanitized;
}

/**
 * Removes hop-by-hop + compression negotiation headers and sensitive auth
 * headers from the ORIGINAL client request before it is persisted for
 * analytics.
 *
 * Removes: accept-encoding, content-encoding, transfer-encoding, content-length,
 * authorization, x-api-key, cookie, and stable client identity headers.
 */
export function sanitizeRequestHeaders(original: Headers): Headers {
	const h = new Headers(original);
	h.delete("accept-encoding");
	h.delete("content-encoding");
	h.delete("content-length");
	h.delete("transfer-encoding");
	// Strip sensitive auth headers from persisted payloads
	h.delete("authorization");
	h.delete("x-api-key");
	h.delete("cookie");
	// Strip stable client/session identifiers from persisted request payloads.
	h.delete("x-claude-code-session-id");
	h.delete("thread-id");
	h.delete("session-id");
	h.delete("x-client-request-id");
	h.delete("x-codex-installation-id");
	h.delete("x-codex-window-id");
	h.delete("x-codex-turn-state");
	h.delete("chatgpt-account-id");
	h.delete("traceparent");
	h.delete("tracestate");
	// Strip internal routing/probe headers from persisted request payloads.
	h.delete("x-clankermux-account-id");
	h.delete("x-better-ccflare-account-id");
	h.delete("x-clankermux-bypass-session");
	h.delete("x-clankermux-keepalive");
	h.delete("x-clankermux-auto-refresh");
	h.delete("x-clankermux-skip-cache");
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
