/**
 * Headers stripped from a captured client request before it is stored as a warm
 * replay body for the Session Cache Bridge / per-account keepalive path.
 *
 * Shared by both warm-body stores (cache-body-store.ts and session-cache-store.ts)
 * so the strip list has a single source of truth. This is a LEAF module — it
 * imports nothing from either store, so importing it cannot introduce a cycle
 * (cache-body-store.ts already imports session-cache-store.ts).
 *
 * Why these are stripped before storing a replay body:
 *  - Auth headers (authorization, x-api-key, cookie, proxy-auth*) are re-injected
 *    by the provider's prepareHeaders() from account credentials at replay time —
 *    storing the original client credentials would be both stale and a secret leak.
 *  - Internal x-clankermux-* routing/control headers (plus the legacy
 *    x-better-ccflare-account-id alias) are injected fresh by the keepalive
 *    scheduler at replay time, so the stored snapshot must not carry them.
 *  - Transport/framing headers (content-length, transfer-encoding, accept/content-
 *    encoding, connection, keep-alive, upgrade, host) describe the original hop and
 *    must not be replayed verbatim — they are recomputed for the synthetic request.
 *  - Session/trace correlation headers are per-request identifiers that would be
 *    wrong on a replay.
 */
export const CACHE_REPLAY_STRIP_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"cookie",
	"x-claude-code-session-id",
	"thread-id",
	"session-id",
	"x-client-request-id",
	"x-codex-installation-id",
	"x-codex-window-id",
	"x-codex-turn-state",
	"chatgpt-account-id",
	"traceparent",
	"tracestate",
	"x-clankermux-account-id",
	// Legacy alias still accepted on inbound requests (dual-accept), strip it too.
	"x-better-ccflare-account-id",
	"x-clankermux-bypass-session",
	"x-clankermux-skip-cache",
	"x-clankermux-keepalive",
	"content-length",
	"transfer-encoding",
	"accept-encoding",
	"content-encoding",
	"connection",
	"keep-alive",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
	"host",
]);
