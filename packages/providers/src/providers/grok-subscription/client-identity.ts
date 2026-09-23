/**
 * The version cli-chat-proxy.grok.com is told we are.
 *
 * It is a GATE, not a label: the proxy compares this against a floor it can
 * raise at any time and answers anything below it with HTTP 426, which is the
 * only notice we get. Bump this constant when that happens — it is the one
 * place the version appears, and {@link GROK_CLI_USER_AGENT} follows it.
 */
export const GROK_CLI_VERSION = "0.2.101";

/** Cosmetic: the proxy does not gate on the platform segment. */
function platformSegment(): string {
	switch (process.platform) {
		case "darwin":
			return "darwin";
		case "win32":
			return "win32";
		default:
			return "linux";
	}
}

export const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (${platformSegment()})`;

/**
 * The Grok CLI chat proxy: inference and the `/v1/user` profile read both go
 * here, and both are gated on the headers below.
 */
export const GROK_CHAT_PROXY_ENDPOINT = "https://cli-chat-proxy.grok.com";

/**
 * Sent on every inference request. A bearer token on its own is refused with
 * 426, so these are load-bearing rather than decorative; all six were verified
 * against the live proxy as a set.
 */
export const GROK_CLI_IDENTITY_HEADERS: Readonly<Record<string, string>> = {
	"x-grok-client-identifier": "grok-shell",
	"x-grok-client-version": GROK_CLI_VERSION,
	"x-grok-client-mode": "interactive",
	"X-XAI-Token-Auth": "xai-grok-cli",
	"x-authenticateresponse": "authenticate-response",
	"User-Agent": GROK_CLI_USER_AGENT,
};

/**
 * Header families that name the inbound client (Claude Code and the Anthropic
 * SDK it is built on). Prefixes, because each family is open-ended: Claude Code
 * adds `x-claude-code-*` headers release by release, Stainless adds
 * `x-stainless-*` suffixes as the SDK evolves, and an enumeration would start
 * leaking on the next release. None of them is part of the chat proxy's
 * protocol surface.
 */
const INBOUND_CLIENT_HEADER_PREFIXES = [
	"x-stainless-",
	"anthropic-",
	"x-claude-code-",
] as const;

/** Single inbound-client headers whose family (`x-*`) is too broad to sweep. */
const INBOUND_CLIENT_HEADERS: ReadonlySet<string> = new Set([
	"x-app",
	"x-client-request-id",
	"user-agent",
]);

/**
 * The Messages wire-protocol version, not a client identity. Every request the
 * chat proxy has answered so far carried it, so it stays.
 */
const PROTOCOL_HEADERS: ReadonlySet<string> = new Set(["anthropic-version"]);

/**
 * Drop the inbound client's identity from an outbound header set, in place, so
 * {@link GROK_CLI_IDENTITY_HEADERS} is the only identity the proxy sees.
 * `x-grok-*`, `content-type` and `accept` are untouched.
 */
export function stripInboundClientIdentity(headers: Headers): void {
	// Collected first: deleting while iterating a Headers skips entries.
	const identifying = [...headers.keys()].filter((raw) => {
		const name = raw.toLowerCase();
		if (PROTOCOL_HEADERS.has(name)) return false;
		return (
			INBOUND_CLIENT_HEADERS.has(name) ||
			INBOUND_CLIENT_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
		);
	});
	for (const name of identifying) headers.delete(name);
}
