/**
 * The Claude Code identity on every request ClankerMux originates to
 * Anthropic, one function per endpoint. Proxied /v1/messages traffic is not
 * covered: it forwards the real client's headers.
 */
import {
	CLAUDE_CLI_VERSION,
	extractClaudeVersion,
	getClientVersion,
} from "./version";

export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** Defaults of the axios build Claude Code ships. */
export const AXIOS_USER_AGENT = "axios/1.15.2";
export const AXIOS_ACCEPT = "application/json, text/plain, */*";
export const AXIOS_ACCEPT_ENCODING = "gzip, compress, deflate, br";

/**
 * Claude Code 2.1.280's betas on a Haiku call, then the OAuth beta in the
 * position the proxy appends it to forwarded client traffic.
 */
export const CLAUDE_KEEPALIVE_BETAS: readonly string[] = Object.freeze([
	"interleaved-thinking-2025-05-14",
	"thinking-token-count-2026-05-13",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"claude-code-20250219",
	"advisor-tool-2026-03-01",
	CLAUDE_OAUTH_BETA,
]);

/** The Stainless fields that describe the client's runtime rather than one request. */
const CLAUDE_STAINLESS_RUNTIME_FIELDS = [
	"x-stainless-arch",
	"x-stainless-lang",
	"x-stainless-os",
	"x-stainless-package-version",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
] as const;

/** Claude Code 2.1.280 on Linux x64; used until a client has been seen. */
export const CLAUDE_STAINLESS_HEADERS: Readonly<Record<string, string>> =
	Object.freeze({
		"x-stainless-arch": "x64",
		"x-stainless-lang": "js",
		"x-stainless-os": "Linux",
		"x-stainless-package-version": "0.112.1",
		"x-stainless-retry-count": "0",
		"x-stainless-runtime": "node",
		"x-stainless-runtime-version": "v26.3.0",
		"x-stainless-timeout": "600",
	});

const CLAUDE_CLI_USER_AGENT = /^claude-cli\/\S+ \(external, cli\)$/;

/** Interactive Claude Code, as opposed to the Agent SDK or another client. */
export function isClaudeCliUserAgent(userAgent: string | null): boolean {
	return userAgent !== null && CLAUDE_CLI_USER_AGENT.test(userAgent);
}

const STAINLESS_VALUE = /^[\w.-]{1,40}$/;

let lastSeenCli: {
	version: string;
	stainless: Readonly<Record<string, string>>;
} | null = null;

/**
 * Remembers the version and Stainless runtime block of an interactive Claude
 * Code request, as one pair, so the keepalive describes a single real client
 * on the account. Agent SDK and other clients are ignored, and so is a block
 * with a field missing or malformed.
 */
export function trackClaudeCliStainlessHeaders(headers: Headers): void {
	const userAgent = headers.get("user-agent") ?? "";
	if (!isClaudeCliUserAgent(userAgent)) return;
	const version = extractClaudeVersion(userAgent);
	if (!version) return;
	const runtime: Record<string, string> = {};
	for (const name of CLAUDE_STAINLESS_RUNTIME_FIELDS) {
		const value = headers.get(name);
		if (value === null || !STAINLESS_VALUE.test(value)) return;
		runtime[name] = value;
	}
	lastSeenCli = {
		version,
		stainless: Object.freeze({ ...CLAUDE_STAINLESS_HEADERS, ...runtime }),
	};
}

/** The Stainless block of the last interactive client seen, else the pinned one. */
export function lastSeenClaudeStainlessHeaders(): Readonly<
	Record<string, string>
> {
	return lastSeenCli?.stainless ?? CLAUDE_STAINLESS_HEADERS;
}

export function resetClaudeCliStainlessHeadersForTests(): void {
	lastSeenCli = null;
}

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
	lastSeen: string = lastSeenClaudeCliVersion(),
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"anthropic-beta": CLAUDE_OAUTH_BETA,
		"Content-Type": "application/json",
		"User-Agent": claudeCliUserAgent(newestClaudeCliVersion(lastSeen)),
		Accept: AXIOS_ACCEPT,
		"Accept-Encoding": AXIOS_ACCEPT_ENCODING,
	};
}

/** GET /api/oauth/profile */
export function claudeProfileReadHeaders(
	accessToken: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"Cache-Control": "no-cache",
		"User-Agent": AXIOS_USER_AGENT,
		Accept: AXIOS_ACCEPT,
		"Accept-Encoding": AXIOS_ACCEPT_ENCODING,
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
	return claudeUsageReadHeaders(accessToken, lastSeen);
}

/** The auto-refresh keepalive's in-process /v1/messages request. */
export function claudeKeepaliveHeaders(
	lastSeen: string = lastSeenCli?.version ?? lastSeenClaudeCliVersion(),
	stainless: Readonly<
		Record<string, string>
	> = lastSeenClaudeStainlessHeaders(),
): Record<string, string> {
	return {
		accept: "application/json",
		"anthropic-beta": CLAUDE_KEEPALIVE_BETAS.join(","),
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-version": ANTHROPIC_API_VERSION,
		connection: "keep-alive",
		"content-type": "application/json",
		"user-agent": claudeCliUserAgent(lastSeen),
		"x-app": "cli",
		...stainless,
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

function axiosJsonPostHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"User-Agent": AXIOS_USER_AGENT,
		Accept: AXIOS_ACCEPT,
		"Accept-Encoding": AXIOS_ACCEPT_ENCODING,
	};
}

/** POST platform.claude.com/v1/oauth/token, grant_type refresh_token. */
export function claudeTokenRefreshHeaders(): Record<string, string> {
	return axiosJsonPostHeaders();
}

/** POST to the OAuth token URL, grant_type authorization_code. */
export function claudeCodeExchangeHeaders(): Record<string, string> {
	return axiosJsonPostHeaders();
}

/** POST /api/oauth/claude_cli/create_api_key, with no body. */
export function claudeCreateApiKeyHeaders(
	accessToken: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"User-Agent": claudeCodeUserAgent(newestClaudeCliVersion()),
		Accept: AXIOS_ACCEPT,
		"Accept-Encoding": AXIOS_ACCEPT_ENCODING,
	};
}
