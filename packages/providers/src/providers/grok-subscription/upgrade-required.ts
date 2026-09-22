import { GROK_CLI_VERSION } from "./client-identity";

/**
 * cli-chat-proxy.grok.com answers a client below its version floor with HTTP
 * 426 and a body naming the floor. No other status carries that meaning here,
 * and nothing else on this upstream uses 426, so the status alone identifies it.
 */
export function isGrokUpgradeRequired(response: Response): boolean {
	return response.status === 426;
}

/** The floor the upstream named, e.g. `0.1.202`, or null when it named none. */
export function parseRequiredGrokCliVersion(body: string): string | null {
	return /\bversion\s+(\d+(?:\.\d+)+)\s+or\s+later\b/i.exec(body)?.[1] ?? null;
}

/** How long of the upstream body to quote back; the real one is one sentence. */
const MAX_QUOTED_BODY = 400;

/**
 * An operator-actionable message for a 426. The upstream copy tells a human to
 * run `grok update`, which is not the fix here: the version is a constant in
 * this provider, so the message has to name that instead.
 */
export function describeGrokUpgradeRequired(body: string): string {
	const required = parseRequiredGrokCliVersion(body);
	const demand = required
		? `now requires ${required} or later`
		: "now requires a newer version";
	const quoted = body.trim().slice(0, MAX_QUOTED_BODY);
	return (
		`Grok CLI version gate rejected ${GROK_CLI_VERSION}: cli-chat-proxy.grok.com ${demand}. ` +
		`Bump GROK_CLI_VERSION in the grok-subscription provider.` +
		(quoted ? ` Upstream said: ${quoted}` : "")
	);
}
