/**
 * The Claude Code identity on every request ClankerMux originates to
 * Anthropic, one function per endpoint. Proxied /v1/messages traffic is not
 * covered: it forwards the real client's headers.
 */
import { CLAUDE_CLI_VERSION, getClientVersion } from "./version";

export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
export const ANTHROPIC_API_VERSION = "2023-06-01";

export const CLAUDE_KEEPALIVE_BETAS: readonly string[] = Object.freeze([
	CLAUDE_OAUTH_BETA,
	"fine-grained-tool-streaming-2025-05-14",
]);

/** Pinned by hand, not read from a client. */
export const CLAUDE_STAINLESS_HEADERS: Readonly<Record<string, string>> =
	Object.freeze({
		"x-stainless-arch": "x64",
		"x-stainless-helper-method": "stream",
		"x-stainless-lang": "js",
		"x-stainless-os": "Linux",
		"x-stainless-package-version": "0.60.0",
		"x-stainless-retry-count": "0",
		"x-stainless-runtime": "node",
		"x-stainless-runtime-version": "v24.9.0",
		"x-stainless-timeout": "600",
	});

export function claudeCodeUserAgent(version: string): string {
	return `claude-code/${version}`;
}

export function claudeCliUserAgent(version: string): string {
	return `claude-cli/${version} (external, cli)`;
}

export function pinnedClaudeCliVersion(): string {
	return CLAUDE_CLI_VERSION;
}

/** The last Claude Code version seen on a proxied request, else the pinned one. */
export function lastSeenClaudeCliVersion(): string {
	return getClientVersion();
}

export function newestClaudeCliVersion(
	lastSeen: string = lastSeenClaudeCliVersion(),
	pinned: string = pinnedClaudeCliVersion(),
): string {
	return newerClaudeCliVersion(lastSeen, pinned);
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/;

function compareDigits(a: string, b: string): number {
	const x = a.replace(/^0+(?=\d)/, "");
	const y = b.replace(/^0+(?=\d)/, "");
	if (x.length !== y.length) return x.length < y.length ? -1 : 1;
	return x < y ? -1 : x > y ? 1 : 0;
}

/** Numeric identifiers compare numerically and rank below alphanumeric ones. */
function compareIdentifier(a: string, b: string): number {
	const aNumeric = /^\d+$/.test(a);
	const bNumeric = /^\d+$/.test(b);
	if (aNumeric && bNumeric) return compareDigits(a, b);
	if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(
	a: string | undefined,
	b: string | undefined,
): number {
	if (a === undefined) return b === undefined ? 0 : 1;
	if (b === undefined) return -1;
	const x = a.split(".");
	const y = b.split(".");
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		const order = compareIdentifier(x[i], y[i]);
		if (order !== 0) return order;
	}
	return Math.sign(x.length - y.length);
}

/**
 * Semver precedence of two `x.y.z[-pre][+build]` versions: -1, 0 or 1.
 * `2.1.63` < `2.1.280`, `2.1.280-beta` < `2.1.280`, build metadata is ignored.
 * Throws on anything else.
 */
export function compareClaudeCliVersions(a: string, b: string): number {
	const x = VERSION_PATTERN.exec(a);
	const y = VERSION_PATTERN.exec(b);
	if (!x || !y) throw new Error(`Invalid Claude CLI version: ${x ? b : a}`);
	for (let i = 1; i <= 3; i++) {
		const order = compareDigits(x[i], y[i]);
		if (order !== 0) return order;
	}
	return comparePrerelease(x[4], y[4]);
}

/** The newer of two versions; `a` when they rank equal. */
export function newerClaudeCliVersion(a: string, b: string): string {
	return compareClaudeCliVersions(a, b) >= 0 ? a : b;
}

/** GET /api/oauth/usage */
export function claudeUsageReadHeaders(
	accessToken: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"anthropic-beta": CLAUDE_OAUTH_BETA,
		"User-Agent": claudeCodeUserAgent(pinnedClaudeCliVersion()),
		Accept: "application/json",
		"Content-Type": "application/json",
	};
}

/** GET /api/oauth/profile */
export function claudeProfileReadHeaders(
	accessToken: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"anthropic-beta": CLAUDE_OAUTH_BETA,
		"Content-Type": "application/json",
		"User-Agent": claudeCodeUserAgent(pinnedClaudeCliVersion()),
	};
}

/**
 * The banked-reset status read and claim. The server answers
 * `ineligible_reason: surface` to any other User-Agent, and `cli_version` to a
 * version below its floor, hence the newer of last seen and pinned.
 */
export function claudeBankedResetHeaders(
	accessToken: string,
	lastSeen: string = lastSeenClaudeCliVersion(),
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"anthropic-beta": CLAUDE_OAUTH_BETA,
		"Content-Type": "application/json",
		"User-Agent": claudeCliUserAgent(newestClaudeCliVersion(lastSeen)),
	};
}

/** The auto-refresh keepalive's in-process /v1/messages request. */
export function claudeKeepaliveHeaders(
	lastSeen: string = lastSeenClaudeCliVersion(),
): Record<string, string> {
	return {
		accept: "application/json",
		"accept-language": "*",
		"anthropic-beta": CLAUDE_KEEPALIVE_BETAS.join(","),
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-version": ANTHROPIC_API_VERSION,
		connection: "keep-alive",
		"content-type": "application/json",
		"sec-fetch-mode": "cors",
		"user-agent": claudeCliUserAgent(lastSeen),
		"x-app": "cli",
		...CLAUDE_STAINLESS_HEADERS,
	};
}

/** GET /v1/models for the shared model catalogue. */
export function claudeModelCatalogueHeaders(
	accessToken: string,
): Record<string, string> {
	return {
		authorization: `Bearer ${accessToken}`,
		"anthropic-version": ANTHROPIC_API_VERSION,
		"anthropic-beta": CLAUDE_OAUTH_BETA,
	};
}

export type ClaudeModelPermissionsAuth =
	| { bearer: string; apiKey?: never }
	| { apiKey: string; bearer?: never };

/** GET /v1/models for one account's model permissions. */
export function claudeModelPermissionsHeaders(
	auth: ClaudeModelPermissionsAuth,
): Record<string, string> {
	if (auth.apiKey !== undefined)
		return {
			"anthropic-version": ANTHROPIC_API_VERSION,
			"x-api-key": auth.apiKey,
		};
	return {
		"anthropic-version": ANTHROPIC_API_VERSION,
		authorization: `Bearer ${auth.bearer}`,
		"anthropic-beta": CLAUDE_OAUTH_BETA,
	};
}

/** POST platform.claude.com/v1/oauth/token, grant_type refresh_token. */
export function claudeTokenRefreshHeaders(): Record<string, string> {
	return { "Content-Type": "application/json" };
}

/** POST to the OAuth token URL, grant_type authorization_code. */
export function claudeCodeExchangeHeaders(): Record<string, string> {
	return { "Content-Type": "application/json" };
}

/** POST /api/oauth/claude_cli/create_api_key */
export function claudeCreateApiKeyHeaders(
	accessToken: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json, text/plain, */*",
	};
}
