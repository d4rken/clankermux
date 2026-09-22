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
