/**
 * Sanitizes proxy headers by removing hop-by-hop headers that should not be forwarded
 * after Bun has automatically decompressed the response body.
 *
 * Removes: content-encoding, content-length, transfer-encoding
 */
export function sanitizeProxyHeaders(original: Headers): Headers {
	const sanitized = new Headers(original);

	// Remove headers that are invalidated by automatic decompression
	sanitized.delete("content-encoding");
	sanitized.delete("content-length");
	sanitized.delete("transfer-encoding");

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
