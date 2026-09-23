/**
 * The Codex CLI identity on every request ClankerMux sends to OpenAI, one
 * function per endpoint profile. Golden record of the output:
 * `__tests__/client-identity.golden.test.ts`.
 */
import { NATIVE_RESPONSES_REQUEST_HEADER } from "@clankermux/types";
import { readChatgptAccountId } from "./identity";

/**
 * Codex CLI version advertised via the `Version` header, the User-Agent and the
 * model catalogue's `client_version`. The backend GATES newer models behind a
 * minimum client version: too-old here → 400 "The '<model>' model requires a
 * newer version of Codex." We override the real client's header with this
 * value, so it must track a version new enough for the models we route
 * (gpt-5.6-sol needs >= 0.144; gpt-6-astra carries `minimal_client_version:
 * 0.153.0` in the Codex catalog, gpt-6-sol and gpt-6-luna carry 0.155.0).
 * Bump this when a new Codex model 400s on the version gate.
 */
export const CODEX_VERSION = "0.155.1";

/** The OS/arch segment of the User-Agent. Pinned, not read from the host. */
export const CODEX_PLATFORM = "Debian 13.0.0; x86_64";

/** The terminal segment of the User-Agent. */
export const CODEX_TERMINAL = "xterm-256color";

/** `codex exec`, the persona of all traffic ClankerMux originates itself. */
export const CODEX_EXEC_ORIGINATOR = "codex_exec";

/** The CLI before any client names itself: `codex login`. */
export const CODEX_LOGIN_ORIGINATOR = "codex_cli_rs";

/** OpenAI's OAuth client id for the Codex CLI, shared by every account. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CODEX_OAUTH_SCOPES: readonly string[] = Object.freeze([
	"openid",
	"profile",
	"email",
	"offline_access",
	"api.connectors.read",
	"api.connectors.invoke",
]);

function userAgentPrefix(originator: string): string {
	return `${originator}/${CODEX_VERSION} (${CODEX_PLATFORM}) ${CODEX_TERMINAL}`;
}

/**
 * `codex_exec/0.155.1 (Debian 13.0.0; x86_64) xterm-256color (codex_exec; 0.155.1)`.
 * The trailing group names the client that initialized the session.
 */
export const CODEX_USER_AGENT = `${userAgentPrefix(CODEX_EXEC_ORIGINATOR)} (${CODEX_EXEC_ORIGINATOR}; ${CODEX_VERSION})`;

/** `codex_cli_rs/0.155.1 (Debian 13.0.0; x86_64) xterm-256color`: no client yet. */
export const CODEX_LOGIN_USER_AGENT = userAgentPrefix(CODEX_LOGIN_ORIGINATOR);

/**
 * Where prepareHeaders parks a Codex client's own User-Agent (already
 * version-aligned) until the body transform knows whether the attempt is a
 * native passthrough. Swept with every other `x-clankermux-*` header before
 * the upstream fetch.
 */
export const CODEX_CLIENT_USER_AGENT_HEADER =
	"x-clankermux-codex-client-user-agent";

/** Originators of the first-party Codex clients whose persona we may keep. */
const CODEX_CLIENT_ORIGINATORS: ReadonlySet<string> = new Set([
	"codex_cli_rs",
	"codex-tui",
	"codex_exec",
	"codex_vscode",
]);

/** The desktop app's originator is `Codex <surface>`. */
const CODEX_DESKTOP_ORIGINATOR_PREFIX = "Codex ";

/**
 * Per-turn and per-thread state a Codex client sends on a Responses request,
 * by exact name. The native passthrough forwards these; the translated path
 * replaces the session ones with its own and drops the rest.
 */
const CODEX_CONTINUITY_HEADERS: readonly string[] = [
	"session-id",
	"thread-id",
	"x-client-request-id",
	"x-codex-beta-features",
	"x-codex-parent-thread-id",
	"x-codex-routing-hint",
	"x-codex-turn-metadata",
	"x-codex-turn-state",
	"x-codex-window-id",
	"x-oai-attestation",
	"x-openai-internal-codex-responses-lite",
	"x-openai-memgen-request",
	"x-openai-subagent",
];

const CODEX_CONTINUITY_HEADER_SET: ReadonlySet<string> = new Set(
	CODEX_CONTINUITY_HEADERS,
);

/** Internal control headers only ClankerMux itself may set on this leg. */
const PROVIDER_OWNED_INTERNAL_HEADERS: ReadonlySet<string> = new Set([
	NATIVE_RESPONSES_REQUEST_HEADER,
	CODEX_CLIENT_USER_AGENT_HEADER,
]);

const INTERNAL_HEADER_PREFIX = "x-clankermux-";

function isCodexClientOriginator(originator: string): boolean {
	return (
		CODEX_CLIENT_ORIGINATORS.has(originator) ||
		originator.startsWith(CODEX_DESKTOP_ORIGINATOR_PREFIX)
	);
}

/**
 * A Codex client's User-Agent with its build version replaced by
 * CODEX_VERSION, or null when the request is not from a Codex client. It has
 * to name a first-party originator and begin with that same originator.
 *
 *   originator "codex-tui",
 *   "codex-tui/0.160.0 (Mac OS 15.5.0; arm64) iTerm.app/3.5.14 (codex-tui; 0.160.0)"
 *   → "codex-tui/0.155.1 (Mac OS 15.5.0; arm64) iTerm.app/3.5.14 (codex-tui; 0.155.1)"
 *
 * The trailing group is only rewritten when it repeats the build version: a
 * client like the VS Code extension reports its own version there.
 */
export function alignCodexClientUserAgent(
	userAgent: string | null,
	originator: string | null,
): string | null {
	if (!userAgent || !originator || !isCodexClientOriginator(originator)) {
		return null;
	}
	const prefix = `${originator}/`;
	if (!userAgent.startsWith(prefix)) return null;
	const versionEnd = userAgent.indexOf(" ", prefix.length);
	if (versionEnd <= prefix.length) return null;
	const version = userAgent.slice(prefix.length, versionEnd);
	let rest = userAgent.slice(versionEnd);
	const suffix = ` (${originator}; ${version})`;
	if (rest.endsWith(suffix)) {
		rest = `${rest.slice(0, -suffix.length)} (${originator}; ${CODEX_VERSION})`;
	}
	return `${prefix}${CODEX_VERSION}${rest}`;
}

/**
 * The fixed part of every Responses request in the `codex_exec` persona:
 * credentials and the client identity. `ChatGPT-Account-ID` depends on the
 * endpoint, so {@link applyChatGptAccountId} adds it.
 */
function codexExecInferenceHeaders(accessToken?: string): Headers {
	const headers = new Headers({
		Accept: "text/event-stream",
		"Content-Type": "application/json",
		Version: CODEX_VERSION,
		"User-Agent": CODEX_USER_AGENT,
		originator: CODEX_EXEC_ORIGINATOR,
	});
	if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
	return headers;
}

const BEARER_PREFIX = "Bearer ";

/**
 * `ChatGPT-Account-ID` from the bearer token's own claims, and only for the
 * ChatGPT backend: a custom endpoint has no use for the workspace id. Any
 * other value is removed.
 */
function applyChatGptAccountId(
	headers: Headers,
	chatGptBackend: boolean,
): void {
	headers.delete("ChatGPT-Account-ID");
	if (!chatGptBackend) return;
	const authorization = headers.get("authorization");
	if (!authorization?.startsWith(BEARER_PREFIX)) return;
	const accountId = readChatgptAccountId(
		authorization.slice(BEARER_PREFIX.length),
	);
	if (accountId) headers.set("ChatGPT-Account-ID", accountId);
}

/**
 * POST /backend-api/codex/responses, before the body transform. An allowlist:
 * the `codex_exec` persona, the inbound Codex continuity headers and
 * ClankerMux's own `x-clankermux-*` control headers. Nothing else the client
 * sent survives. A Codex client's own User-Agent is parked under
 * CODEX_CLIENT_USER_AGENT_HEADER for {@link applyCodexNativeProfile}.
 */
export function codexInferenceHeaders(
	inbound: Headers,
	accessToken?: string,
): Headers {
	const headers = codexExecInferenceHeaders(accessToken);
	for (const [name, value] of inbound) {
		const lower = name.toLowerCase();
		if (
			CODEX_CONTINUITY_HEADER_SET.has(lower) ||
			(lower.startsWith(INTERNAL_HEADER_PREFIX) &&
				!PROVIDER_OWNED_INTERNAL_HEADERS.has(lower))
		) {
			headers.set(lower, value);
		}
	}
	const clientUserAgent = alignCodexClientUserAgent(
		inbound.get("user-agent"),
		inbound.get("originator"),
	);
	if (clientUserAgent) {
		headers.set(CODEX_CLIENT_USER_AGENT_HEADER, clientUserAgent);
	}
	return headers;
}

/**
 * Usable means: a string that is non-empty and printable ASCII after trim().
 * The upper bound is U+007E rather than "no control characters" because
 * `Headers.set` throws on code points above U+00FF, and a throw on this path
 * would drop the request onto the passthrough fallback.
 */
const USABLE_HEADER_VALUE = /^[\x20-\x7E]+$/;

function usableHeaderValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || !USABLE_HEADER_VALUE.test(trimmed))
		return undefined;
	return trimmed;
}

/**
 * `thread-id` and `x-client-request-id` set to the `session-id`, or removed
 * when there is none: `codex_exec` sends its thread id in all three.
 */
function alignThreadHeadersToSession(headers: Headers): void {
	const id = headers.get("session-id");
	if (id) {
		headers.set("thread-id", id);
		headers.set("x-client-request-id", id);
	} else {
		headers.delete("thread-id");
		headers.delete("x-client-request-id");
	}
}

/**
 * A request ClankerMux translated into Codex format: always the `codex_exec`
 * persona, never the client's. On the ChatGPT backend `session-id`,
 * `thread-id` and `x-client-request-id` all carry `sessionId` (the body's
 * `prompt_cache_key`); without a usable id, or off that backend, none of them
 * is sent. Every other continuity header is dropped.
 */
export function applyCodexTranslatedProfile(
	headers: Headers,
	sessionId: unknown,
	chatGptBackend: boolean,
): void {
	headers.delete(CODEX_CLIENT_USER_AGENT_HEADER);
	for (const name of CODEX_CONTINUITY_HEADERS) headers.delete(name);
	headers.set("User-Agent", CODEX_USER_AGENT);
	headers.set("originator", CODEX_EXEC_ORIGINATOR);
	applyChatGptAccountId(headers, chatGptBackend);
	const id = chatGptBackend ? usableHeaderValue(sessionId) : undefined;
	if (id) headers.set("session-id", id);
	alignThreadHeadersToSession(headers);
}

/**
 * The native Responses passthrough. A Codex client keeps its own persona (the
 * parked, version-aligned User-Agent and the originator it names) and its
 * continuity headers as sent, when usable. Anything else is `codex_exec`, so
 * its `thread-id` and `x-client-request-id` follow its `session-id`. On the
 * ChatGPT backend a missing or unusable `session-id` is derived from
 * `promptCacheKey`: that backend keys prompt caching on the header and
 * ignores the body's `prompt_cache_key`.
 */
export function applyCodexNativeProfile(
	headers: Headers,
	promptCacheKey: unknown,
	chatGptBackend: boolean,
): void {
	const clientUserAgent = headers.get(CODEX_CLIENT_USER_AGENT_HEADER);
	headers.delete(CODEX_CLIENT_USER_AGENT_HEADER);
	if (clientUserAgent) {
		headers.set("User-Agent", clientUserAgent);
		headers.set(
			"originator",
			clientUserAgent.slice(0, clientUserAgent.indexOf("/")),
		);
	} else {
		headers.set("User-Agent", CODEX_USER_AGENT);
		headers.set("originator", CODEX_EXEC_ORIGINATOR);
	}
	for (const name of CODEX_CONTINUITY_HEADERS) {
		const value = headers.get(name);
		if (value === null) continue;
		const usable = usableHeaderValue(value);
		if (usable) headers.set(name, usable);
		else headers.delete(name);
	}
	applyChatGptAccountId(headers, chatGptBackend);
	if (chatGptBackend && !headers.has("session-id")) {
		const derived = usableHeaderValue(promptCacheKey);
		if (derived) headers.set("session-id", derived);
	}
	if (!clientUserAgent) alignThreadHeadersToSession(headers);
}

/**
 * The ChatGPT backend client: `wham/usage`, the reset-credit list and consume,
 * and the subscription record. No originator and no `Version`: this client
 * sets its own headers instead of the default ones. `ChatGPT-Account-ID` is
 * sent only when `chatgptAccountId` is non-empty; the caller decides whether
 * to trim it.
 */
export function codexBackendClientHeaders(
	accessToken: string,
	chatgptAccountId?: string | null,
): Headers {
	const headers = new Headers({
		"User-Agent": CODEX_USER_AGENT,
		Authorization: `Bearer ${accessToken}`,
		Accept: "*/*",
	});
	if (chatgptAccountId) headers.set("ChatGPT-Account-ID", chatgptAccountId);
	return headers;
}

/** GET /backend-api/codex/models: the default client plus `Version`. */
export function codexModelsHeaders(
	accessToken: string,
	chatgptAccountId?: string | null,
): Headers {
	const headers = codexBackendClientHeaders(accessToken, chatgptAccountId);
	headers.set("originator", CODEX_EXEC_ORIGINATOR);
	headers.set("Version", CODEX_VERSION);
	return headers;
}

/** The window-priming POST /backend-api/codex/responses. */
export function codexNativePingHeaders(
	accessToken: string,
	chatGptBackend: boolean,
): Headers {
	const headers = codexExecInferenceHeaders(accessToken);
	applyChatGptAccountId(headers, chatGptBackend);
	return headers;
}

/** POST auth.openai.com/oauth/token, authorization-code grant. */
export function codexLoginTokenHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/x-www-form-urlencoded",
		"User-Agent": CODEX_LOGIN_USER_AGENT,
	};
}

/** POST auth.openai.com/oauth/token, refresh grant, with a JSON body. */
export function codexRefreshHeaders(): Record<string, string> {
	return {
		Accept: "*/*",
		"Content-Type": "application/json",
		"User-Agent": CODEX_USER_AGENT,
		originator: CODEX_EXEC_ORIGINATOR,
	};
}

/** POST auth.openai.com/api/accounts/deviceauth/{usercode,token}. */
export function codexDeviceAuthHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"User-Agent": CODEX_LOGIN_USER_AGENT,
	};
}

export interface CodexAuthorizeUrlInput {
	clientId: string;
	redirectUri: string;
	scopes: readonly string[];
	codeChallenge: string;
	state: string;
}

/** The authorize URL's query parameters, encoded, in the real client's order. */
export function codexAuthorizeUrlParams(
	input: CodexAuthorizeUrlInput,
): string[] {
	return [
		"response_type=code",
		`client_id=${encodeURIComponent(input.clientId)}`,
		`redirect_uri=${encodeURIComponent(input.redirectUri)}`,
		`scope=${encodeURIComponent(input.scopes.join(" "))}`,
		`code_challenge=${encodeURIComponent(input.codeChallenge)}`,
		"code_challenge_method=S256",
		"id_token_add_organizations=true",
		"codex_cli_simplified_flow=true",
		`state=${encodeURIComponent(input.state)}`,
		`originator=${encodeURIComponent(CODEX_LOGIN_ORIGINATOR)}`,
	];
}
