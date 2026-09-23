/**
 * The Codex CLI identity on every request ClankerMux sends to OpenAI, one
 * function per endpoint profile. Golden record of the output:
 * `__tests__/client-identity.golden.test.ts`.
 */

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
export const CODEX_PLATFORM = "Windows 10.0.26100; x64";

export const CODEX_ORIGINATOR = "codex_cli_rs";

export const CODEX_OPENAI_BETA = "responses=experimental";

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

export function codexUserAgent(
	version: string = CODEX_VERSION,
	platform: string = CODEX_PLATFORM,
): string {
	return `codex-cli/${version} (${platform})`;
}

export const CODEX_USER_AGENT = codexUserAgent();

/** Headers that belong to the inbound Anthropic client and never go upstream. */
const INBOUND_ANTHROPIC_HEADERS: readonly string[] = [
	"authorization",
	"anthropic-version",
	"anthropic-dangerous-direct-browser-access",
	"anthropic-beta",
	"x-api-key",
	"host",
];

/**
 * Exact SDK identity headers to drop before forwarding to the Codex backend.
 *
 * Deliberately an exact list rather than an `x-openai-client-` prefix sweep:
 * only this family identifies the calling SDK. Other `x-openai-*` headers
 * (`x-openai-internal-codex-responses-lite`, `x-openai-subagent`) are Codex
 * protocol surface and have to survive.
 */
const SDK_FINGERPRINT_HEADERS: readonly string[] = [
	"x-openai-client-arch",
	"x-openai-client-id",
	"x-openai-client-os",
	"x-openai-client-user-agent",
	"x-openai-client-version",
];

/**
 * Prefix for the Stainless generator's header family. A prefix rather than a
 * list because the suffixes are open-ended — the generator adds new ones
 * (`-retry-count`, `-timeout`, `-helper-method` …) as the SDK evolves, and an
 * enumeration would silently start leaking on the next SDK release.
 */
const SDK_FINGERPRINT_HEADER_PREFIX = "x-stainless-";

/**
 * Drop the calling SDK's identity headers from an outbound header set, in
 * place. `x-codex-*` continuity headers are untouched: the native Responses
 * passthrough forwards the Codex CLI's own turn/session state and the backend
 * needs it.
 */
function stripSdkFingerprintHeaders(headers: Headers): void {
	for (const name of SDK_FINGERPRINT_HEADERS) {
		headers.delete(name);
	}
	// Collect before deleting — mutating a Headers object mid-iteration is not
	// specified to be safe.
	const stainless: string[] = [];
	for (const [name] of headers) {
		if (name.toLowerCase().startsWith(SDK_FINGERPRINT_HEADER_PREFIX)) {
			stainless.push(name);
		}
	}
	for (const name of stainless) {
		headers.delete(name);
	}
}

/**
 * POST /backend-api/codex/responses: the inbound client's headers with its
 * credentials and SDK fingerprint removed and the Codex identity stamped on.
 * Everything else the client sent is forwarded.
 */
export function codexInferenceHeaders(
	inbound: Headers,
	accessToken?: string,
): Headers {
	const headers = new Headers(inbound);
	for (const name of INBOUND_ANTHROPIC_HEADERS) {
		headers.delete(name);
	}

	// The client that got here is usually Claude Code on the Stainless-generated
	// Anthropic SDK, which attaches the whole `x-stainless-*` family. Forwarding
	// it hands the backend two contradictory identities for one request: an
	// `x-stainless-*` set is an SDK signal in its own right, so leaving it on is
	// what makes the persona incoherent rather than merely redundant. Same
	// applies to opencode and anything else on the ai-sdk.
	stripSdkFingerprintHeaders(headers);

	if (accessToken) {
		headers.set("Authorization", `Bearer ${accessToken}`);
	}
	headers.set("Version", CODEX_VERSION);
	headers.set("Openai-Beta", CODEX_OPENAI_BETA);
	headers.set("User-Agent", CODEX_USER_AGENT);
	headers.set("originator", CODEX_ORIGINATOR);
	return headers;
}

/**
 * The ChatGPT Codex backend keys prompt caching on the `session-id` REQUEST
 * HEADER and ignores the body's `prompt_cache_key`, so the documented body
 * field is translated into the header the backend reads.
 *
 * Usable means: a string that is non-empty and printable ASCII after trim().
 * The upper bound is U+007E rather than "no control characters" because
 * `Headers.set` throws on code points above U+00FF, and a throw on this path
 * would drop the request onto the passthrough fallback.
 */
const USABLE_SESSION_ID = /^[\x20-\x7E]+$/;

function usableSessionId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || !USABLE_SESSION_ID.test(trimmed))
		return undefined;
	return trimmed;
}

/**
 * Derives `session-id` from `promptCacheKey` unless the client already supplied
 * a usable one of its own, which is never overwritten. An inbound value that is
 * present but unusable is DELETED, not forwarded: `headers` is a copy of the
 * inbound set, so skipping it would relay the very value that was rejected.
 * Only call this for accounts that reach the ChatGPT backend.
 */
export function applyCodexSessionIdHeader(
	headers: Headers,
	promptCacheKey: unknown,
): void {
	if (usableSessionId(headers.get("session-id"))) return;
	const derived = usableSessionId(promptCacheKey);
	if (derived) {
		headers.set("session-id", derived);
	} else {
		headers.delete("session-id");
	}
}

/**
 * The zero-cost ChatGPT backend reads and the reset-credit consume: model
 * catalogue, subscription, `wham/usage`, rate-limit-reset-credits.
 * `ChatGPT-Account-ID` is sent only when `chatgptAccountId` is non-empty; the
 * caller decides whether to trim it.
 */
export function codexSideCallHeaders(
	accessToken: string,
	chatgptAccountId?: string | null,
): Headers {
	const headers = new Headers({
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		Version: CODEX_VERSION,
		"User-Agent": CODEX_USER_AGENT,
		originator: CODEX_ORIGINATOR,
	});
	if (chatgptAccountId) headers.set("ChatGPT-Account-ID", chatgptAccountId);
	return headers;
}

/** The window-priming POST /backend-api/codex/responses. */
export function codexNativePingHeaders(
	accessToken: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		Version: CODEX_VERSION,
		"Openai-Beta": CODEX_OPENAI_BETA,
		"User-Agent": CODEX_USER_AGENT,
		originator: CODEX_ORIGINATOR,
		Accept: "text/event-stream",
	};
}

/** POST auth.openai.com/oauth/token, every grant type. */
export function codexTokenEndpointHeaders(): Record<string, string> {
	return { "Content-Type": "application/x-www-form-urlencoded" };
}

/** POST auth.openai.com/api/accounts/deviceauth/{usercode,token}. */
export function codexDeviceAuthHeaders(): Record<string, string> {
	return { "Content-Type": "application/json" };
}

/**
 * The Codex-specific tail of the authorize URL's query string, already
 * encoded, in the order the URL carries them.
 */
export function codexAuthorizeUrlParams(): string[] {
	return [
		"id_token_add_organizations=true",
		"codex_cli_simplified_flow=true",
		`originator=${encodeURIComponent(CODEX_ORIGINATOR)}`,
	];
}
