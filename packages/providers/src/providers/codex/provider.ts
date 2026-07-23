import { createHash } from "node:crypto";
import {
	DEFAULT_CODEX_MODEL_BY_FAMILY,
	getModelFamily,
	isDebugEnabled,
	isInvalidGrantMessage,
	mapModelName,
	OAuthRefreshTokenError,
	resolveModelContextWindow,
	ValidationError,
	validateEndpointUrl,
} from "@clankermux/core";
import { sanitizeProxyHeaders } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import { resolveReasoningEffort } from "@clankermux/openai-formats";
import {
	type Account,
	NATIVE_RESPONSES_REQUEST_HEADER,
	NATIVE_RESPONSES_RESPONSE_HEADER,
} from "@clankermux/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";
import { extractCodexIdentity } from "./identity";
import { normalizeCodexInputUsage } from "./usage";

const log = new Logger("CodexProvider");

const INTERNAL_HEADERS = [
	"x-clankermux-request-id",
	"x-clankermux-request-stream",
	"x-clankermux-synthetic-response",
	"x-clankermux-synthetic-status",
	NATIVE_RESPONSES_REQUEST_HEADER,
];

function sanitizeResponseHeaders(headers: Headers): Headers {
	const sanitized = sanitizeProxyHeaders(headers);
	for (const h of INTERNAL_HEADERS) {
		sanitized.delete(h);
	}
	return sanitized;
}

// OAuth error codes that mean the refresh token itself is terminally rejected
// (revoked / expired / rotated-away / deauthorized) and can only be fixed by
// re-authenticating. Detection is by error CODE, not human error_description
// wording, so a genuinely dead token reliably surfaces the reauth prompt.
// Only refresh-token-specific codes belong here. `invalid_client` and
// `unauthorized_client` describe the OAuth CLIENT/application (Codex uses a
// fixed shared CLIENT_ID), NOT an individual account's refresh token — treating
// them as OAuthRefreshTokenError would pause EVERY account with a reauth prompt
// that reauth (through the same client) can't fix, and they'd stay paused after
// the client config is corrected. They deliberately fall through to the generic
// retryable error instead.
const TERMINAL_OAUTH_ERROR_CODES = new Set([
	"refresh_token_reused",
	"invalid_grant",
	"invalid_refresh_token",
]);

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEFAULT_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/responses";
/** Hosts that are OpenAI's own Codex/Responses API, not a custom endpoint. */
const OPENAI_PROMPT_CACHE_HOSTS = new Set(["chatgpt.com", "api.openai.com"]);
/**
 * Hex length of the truncated sha256 digest in a derived prompt_cache_key.
 * OpenAI caps prompt_cache_key at 64 chars; the longest prefix we emit is
 * `clankermux-session-` (19 chars), so 45 hex keeps every key <= 64
 * (session: 19+45=64, convo: 17+45=62) while retaining 180 bits of digest.
 * (Upstream used 48 under the shorter `ccflare-` prefix; our longer fork
 * naming required trimming the digest to preserve the same hard bound.)
 */
const PROMPT_CACHE_KEY_DIGEST_LEN = 45;
// Codex CLI version advertised to the ChatGPT/Codex backend via the `Version`
// header + User-Agent (see prepareHeaders / on-demand-fetch). The backend GATES
// newer models behind a minimum client version: too-old here → 400 "The '<model>'
// model requires a newer version of Codex." We override the real client's header
// with this value, so it must track a version new enough for the models we route
// (e.g. gpt-5.6-sol needs >= 0.144). Bump this when a new Codex model 400s on the
// version gate.
export const CODEX_VERSION = "0.144.0";
export const CODEX_USER_AGENT = `codex-cli/${CODEX_VERSION} (Windows 10.0.26100; x64)`;
// Model used by the on-demand usage probe (on-demand-fetch.ts). This MUST be a
// CURRENTLY-SERVED Codex model: retired slugs get a 400 from the backend, which
// silently breaks usage sampling ("Codex returned no usage headers (status
// 400)"). gpt-5-codex was retired and caused exactly that — keep this pinned to
// the cheapest currently-served model.
export const CODEX_PING_MODEL = "gpt-5.4-mini";

// Structured (non-text) tool_result blocks larger than this are replaced with a
// size marker: replaying megabyte payloads (e.g. base64 documents) into every
// subsequent turn bloats context and destroys prompt-cache reuse.
const CODEX_MAX_STRUCTURED_BLOCK_CHARS = 8_192;

const _normalizeUsage = (value: unknown): Record<string, number> => {
	const usage =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	const getNumber = (field: string) => {
		const candidate = usage[field];
		return typeof candidate === "number" && Number.isFinite(candidate)
			? candidate
			: 0;
	};
	return {
		input_tokens: getNumber("input_tokens"),
		output_tokens: getNumber("output_tokens"),
		cache_read_input_tokens: getNumber("cache_read_input_tokens"),
		cache_creation_input_tokens: getNumber("cache_creation_input_tokens"),
	};
};

// Known Codex failure codes -> Anthropic error types. This drives both the
// error type we surface to the client and (via httpStatusForAnthropicErrorPayload)
// the HTTP status our proxy failover/cooldown logic reacts to:
//   rate_limit_error  -> 429 (account rate-limit cooldown)
//   overloaded_error  -> 529 (transient provider-overload backoff)
//   invalid_request_error -> 400 (permanent; do NOT retry as 5xx)
//   permission_error  -> 403 (subscription/entitlement; do NOT retry)
//   api_error         -> 502 (generic upstream failure)
// Quota exhaustion (insufficient_quota) cools the account like a rate limit;
// slow_down/server_is_overloaded are throttles; context/policy and
// subscription errors are permanent and must not be retried as 5xx. Codes
// mirror the reference client (openai/codex). Unrecognized codes fall through
// to the existing echo-raw-type / 502 fallback.
const CODEX_ERROR_TYPE_BY_CODE: Record<string, string> = {
	rate_limit_exceeded: "rate_limit_error",
	insufficient_quota: "rate_limit_error",
	server_is_overloaded: "overloaded_error",
	slow_down: "overloaded_error",
	server_error: "api_error",
	context_length_exceeded: "invalid_request_error",
	cyber_policy: "invalid_request_error",
	usage_not_included: "permission_error",
};

// The default Anthropic-family → Codex model mapping lives in @clankermux/core
// (DEFAULT_CODEX_MODEL_BY_FAMILY) so the context-window gate and this provider
// resolve the same target model. Do not re-declare it here.

// resolveModelContextWindow (over the shared MODEL_CONTEXT_WINDOWS map in
// @clankermux/core) is the single source of truth for context-window sizes. It
// feeds both routing-side context-window gating and the display-metadata reuse
// in extractContextWindow() below, so both apply the dated-suffix fallback.

// ── Codex Responses API types ─────────────────────────────────────────────────

interface CodexInputTextItem {
	type: "input_text";
	text: string;
}

interface CodexOutputTextItem {
	type: "output_text";
	text: string;
}

interface CodexFunctionCallItem {
	type: "function_call";
	call_id: string;
	name: string;
	arguments: string;
	status?: "in_progress" | "completed" | "incomplete";
}

interface CodexFunctionCallOutputItem {
	type: "function_call_output";
	call_id: string;
	output: string;
	status?: "in_progress" | "completed" | "incomplete";
}

type CodexContentItem =
	| CodexInputTextItem
	| CodexOutputTextItem
	| CodexFunctionCallItem
	| CodexFunctionCallOutputItem;

interface CodexMessage {
	role: "user" | "assistant" | "system";
	content: CodexContentItem[];
}

interface CodexTool {
	type: "function";
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

interface CodexRequest {
	model: string;
	input: (CodexMessage | CodexFunctionCallItem | CodexFunctionCallOutputItem)[];
	stream: boolean;
	store: false;
	reasoning?: { effort: string };
	instructions?: string;
	tools?: CodexTool[];
	prompt_cache_key?: string;
	tool_choice?:
		| "auto"
		| "required"
		| "none"
		| { type: "function"; name: string };
	parallel_tool_calls?: boolean;
}

// ── Anthropic request types ───────────────────────────────────────────────────

interface AnthropicTextContent {
	type: "text";
	text: string;
}

interface AnthropicToolUse {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface AnthropicToolResult {
	type: "tool_result";
	tool_use_id: string;
	is_error?: boolean;
	content:
		| string
		| Array<{
				type: string;
				text?: string;
				[key: string]: unknown;
		  }>;
}

type AnthropicContentBlock =
	| AnthropicTextContent
	| AnthropicToolUse
	| AnthropicToolResult;

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
	name: string;
	description?: string;
	input_schema?: Record<string, unknown>;
}

interface AnthropicToolChoice {
	type: "auto" | "any" | "none" | "tool";
	name?: string;
	disable_parallel_tool_use?: boolean;
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	system?: string | { type: string; text: string }[];
	stream?: boolean;
	tools?: AnthropicTool[];
	tool_choice?: AnthropicToolChoice;
	reasoning?: { effort?: string };
	/** Claude Code sends a JSON-encoded object with a session_id here. */
	metadata?: { user_id?: string };
	[key: string]: unknown;
}

// ── SSE streaming state ───────────────────────────────────────────────────────

interface FunctionCallBuffer {
	contentBlockIndex: number;
	name: string;
	arguments: string[];
}

interface ContextWindowUsage {
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

interface ContextWindow {
	current_usage: ContextWindowUsage;
	context_window_size: number;
}

interface StreamState {
	buffer: string;
	messageId: string;
	model: string;
	contentBlockIndex: number;
	hasSentMessageStart: boolean;
	hasSentContentBlockStart: boolean;
	hasSentTerminalEvents: boolean;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	// Anthropic clients expect stop_reason=tool_use when the assistant emitted a tool call.
	sawToolUse: boolean;
	contextWindow: ContextWindow | null;
	// Track function_call items: output_index → buffered arguments and block index
	functionCallBlocks: Map<number, FunctionCallBuffer>;
	upstreamError?: {
		type: string;
		message: string;
		code?: string;
		status?: string;
	};
}

/**
 * Resolves the endpoint a Codex request would be sent to, mirroring
 * CodexProvider.buildUrl's fallback (invalid/missing custom_endpoint falls
 * back to CODEX_DEFAULT_ENDPOINT). Read-only: unlike buildUrl it never logs,
 * since it may be called on every request just to decide prompt_cache_key
 * eligibility.
 */
function resolveCodexPromptCacheEndpoint(account?: Account): string {
	if (account?.custom_endpoint) {
		try {
			return validateEndpointUrl(account.custom_endpoint, "custom_endpoint");
		} catch {
			return CODEX_DEFAULT_ENDPOINT;
		}
	}
	return CODEX_DEFAULT_ENDPOINT;
}

/**
 * prompt_cache_key is an OpenAI-specific Responses API field. Custom or
 * self-hosted OpenAI-compatible endpoints may reject the unknown field, so
 * only attach it when the account resolves to OpenAI's own hosts.
 */
function isOpenAiPromptCacheEndpoint(account?: Account): boolean {
	try {
		const { hostname } = new URL(resolveCodexPromptCacheEndpoint(account));
		return OPENAI_PROMPT_CACHE_HOSTS.has(hostname);
	} catch {
		return false;
	}
}

export class CodexProvider extends BaseProvider {
	name = "codex";
	// Fallback map: proxy-operations.ts injects x-clankermux-request-id and
	// x-clankermux-request-stream into the upstream response before calling
	// processResponse, so headerRequestedStream is normally set. This map covers
	// the race where a response arrives after the 30s TTL sweep evicts the entry.
	// `native` marks a native-Responses passthrough attempt (Stage A): the
	// response is returned untransformed. It inherits the same ts-based cleanup;
	// eviction degrades gracefully to today's translated behaviour.
	private requestStreamById = new Map<
		string,
		{ stream: boolean; native?: boolean; ts: number }
	>();

	private sweepRequestStreamById(): void {
		const cutoff = Date.now() - 30_000;
		for (const [id, entry] of this.requestStreamById) {
			if (entry.ts < cutoff) {
				this.requestStreamById.delete(id);
			}
		}
	}

	canHandle(path: string): boolean {
		return path === "/v1/messages" || path === "/v1/messages/count_tokens";
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		if (!account.refresh_token) {
			throw new Error(`No refresh token for account ${account.name}`);
		}

		log.info(`Refreshing Codex token for account ${account.name}`);

		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: account.refresh_token,
			client_id: CLIENT_ID,
			scope:
				"openid profile email offline_access api.connectors.read api.connectors.invoke",
		});

		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (!response.ok) {
			// Read the raw body once, then attempt JSON parse. Reading text first
			// (rather than response.json() in a try/catch) means a non-JSON body —
			// e.g. a 400 text/plain payload literally containing "invalid_grant" —
			// is still classifiable via the marker fallback below, instead of being
			// silently treated as a generic retryable error.
			const raw = await response.text();
			let errorData: { error?: string; error_description?: string } | null =
				null;
			try {
				errorData = raw ? JSON.parse(raw) : null;
			} catch {
				// ignore — body was not JSON; fall back to raw-text marker matching
			}

			const errorCode = errorData?.error ?? null;
			const errorMessage =
				errorData?.error_description ||
				errorData?.error ||
				raw ||
				response.statusText;

			// Terminal auth rejections (revoked / expired / reused / deauthorized)
			// must re-auth. Throw the typed error so the refresh chokepoint pauses
			// the account for reauth — detection is by error CODE when JSON parses,
			// or by a raw-body marker when it doesn't, so a genuinely dead token
			// reliably surfaces the reauth prompt instead of being mistaken for a
			// transient failure.
			if (
				(errorCode && TERMINAL_OAUTH_ERROR_CODES.has(errorCode)) ||
				(errorData == null && isInvalidGrantMessage(raw))
			) {
				throw new OAuthRefreshTokenError(
					account.id,
					`Codex refresh token rejected${
						errorCode ? ` (${errorCode})` : ""
					} for account ${account.name}. Re-authenticate account "${account.name}" from the dashboard (Accounts tab).`,
				);
			}

			throw new Error(
				`Failed to refresh Codex token for account ${account.name}: ${errorMessage}`,
			);
		}

		const json = (await response.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
			id_token?: string;
		};

		log.debug(`[CodexProvider] token refresh response for ${account.name}:`, {
			expiresIn: json.expires_in,
			responseKeys: Object.keys(json),
		});

		const identity = extractCodexIdentity(
			json.access_token,
			json.id_token ?? null,
		);

		return {
			accessToken: json.access_token,
			// OpenAI issues a new refresh token on each refresh (rotating)
			refreshToken: json.refresh_token,
			expiresAt: Date.now() + json.expires_in * 1000,
			identity,
		};
	}

	buildUrl(_path: string, _query: string, account?: Account): string {
		if (_path === "/v1/messages/count_tokens") {
			return "https://clankermux.local/codex/count_tokens";
		}
		if (account?.custom_endpoint) {
			try {
				return validateEndpointUrl(account.custom_endpoint, "custom_endpoint");
			} catch (error) {
				log.warn(
					`Invalid custom endpoint for ${account.name}: ${account.custom_endpoint}. Using default.`,
					error,
				);
			}
		}
		return CODEX_DEFAULT_ENDPOINT;
	}

	prepareHeaders(headers: Headers, accessToken?: string): Headers {
		const newHeaders = new Headers(headers);

		// Remove client auth and Anthropic-specific headers
		newHeaders.delete("authorization");
		newHeaders.delete("anthropic-version");
		newHeaders.delete("anthropic-dangerous-direct-browser-access");
		newHeaders.delete("anthropic-beta");
		newHeaders.delete("x-api-key");
		newHeaders.delete("host");

		// Set Codex-required headers
		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
		}
		newHeaders.set("Version", CODEX_VERSION);
		newHeaders.set("Openai-Beta", "responses=experimental");
		newHeaders.set("User-Agent", CODEX_USER_AGENT);
		newHeaders.set("originator", "codex_cli_rs");

		return newHeaders;
	}

	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		// count_tokens is handled synthetically regardless of content-type.
		// Match both the client path (/v1/messages/count_tokens) and the internal
		// URL that buildUrl() produces (https://clankermux.local/codex/count_tokens).
		const pathname = new URL(request.url).pathname;
		if (
			pathname === "/v1/messages/count_tokens" ||
			pathname === "/codex/count_tokens"
		) {
			return this.buildSyntheticCountTokensRequest(request);
		}

		const contentType = request.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return request;
		}

		// Native Responses passthrough (Stage A): the proxy forwards the client's
		// ORIGINAL OpenAI-Responses body — do NOT run the Anthropic→Codex
		// translator; only patch the transport invariants the backend requires.
		if (request.headers.get(NATIVE_RESPONSES_REQUEST_HEADER) === "1") {
			return this.transformNativeResponsesBody(request);
		}

		try {
			this.sweepRequestStreamById();
			const body = (await request.json()) as AnthropicRequest;
			const requestId = request.headers.get("x-clankermux-request-id");
			if (requestId) {
				this.requestStreamById.set(requestId, {
					stream: body.stream === true,
					ts: Date.now(),
				});
			}
			const codexBody = this.convertToCodexFormat(
				body,
				account,
				requestId ?? undefined,
			);

			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.set(
				"x-clankermux-request-stream",
				body.stream === true ? "true" : "false",
			);
			newHeaders.delete("content-length");

			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: JSON.stringify(codexBody),
			});
		} catch (error) {
			if (error instanceof ValidationError) {
				throw error;
			}
			log.error("Failed to transform request body to Codex format:", error);
			return request;
		}
	}

	/**
	 * Native Responses passthrough (Stage A): forward the original Responses
	 * body verbatim, patching only what the Codex backend requires:
	 * - `stream: true` — the backend always streams,
	 * - `store: false` — stateless HTTP path,
	 * - drop `previous_response_id` — the HTTP path always sends full history
	 *   (mirrors the translator's handling; see the adapter's note).
	 * Everything else — tools of ALL types (web_search etc.), reasoning,
	 * instructions — is forwarded untouched.
	 */
	private async transformNativeResponsesBody(
		request: Request,
	): Promise<Request> {
		let bodyText = "";
		try {
			this.sweepRequestStreamById();
			bodyText = await request.text();
			const body = JSON.parse(bodyText) as Record<string, unknown>;
			body.stream = true;
			body.store = false;
			delete body.previous_response_id;

			const requestId = request.headers.get("x-clankermux-request-id");
			if (requestId) {
				// Client stream intent is always true in native mode (guarded
				// upstream in proxy-operations before choosing the native body).
				this.requestStreamById.set(requestId, {
					stream: true,
					native: true,
					ts: Date.now(),
				});
			}

			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.set("x-clankermux-request-stream", "true");
			newHeaders.delete("content-length");

			// The native flag stays on the returned Request: the proxy reads it
			// off the transformed request to tag the response, then strips it
			// before the upstream fetch.
			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: JSON.stringify(body),
			});
		} catch (error) {
			log.error("Failed to prepare native Responses passthrough body:", error);
			// Defensive fallback (the proxy validates the native body before
			// setting the flag, so this should not fire): forward the body
			// unchanged but STRIP the native flag so the proxy can never relay a
			// native marker for a request that wasn't natively prepared.
			const fallbackHeaders = new Headers(request.headers);
			fallbackHeaders.delete(NATIVE_RESPONSES_REQUEST_HEADER);
			fallbackHeaders.delete("content-length");
			return new Request(request.url, {
				method: request.method,
				headers: fallbackHeaders,
				body: bodyText,
			});
		}
	}

	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		const contentType = response.headers.get("content-type");
		const requestId = response.headers.get("x-clankermux-request-id");
		const headerRequestedStream = response.headers.get(
			"x-clankermux-request-stream",
		);
		const streamEntry = requestId
			? this.requestStreamById.get(requestId)
			: undefined;
		const requestedStream =
			headerRequestedStream === "true"
				? true
				: headerRequestedStream === "false"
					? false
					: (streamEntry?.stream ?? true);
		if (requestId) {
			this.requestStreamById.delete(requestId);
		}

		// Native Responses passthrough (Stage A): return the raw Codex-Responses
		// stream untransformed, marked for the adapter (Stage B consumes it).
		// SUCCESS only — non-200s keep today's error handling path below (error
		// translation downstream expects the existing shape). Primary signal is
		// the request-side flag the proxy copies onto the response (same channel
		// as x-clankermux-request-stream); the map entry is the fallback.
		const nativeMode =
			response.headers.get(NATIVE_RESPONSES_REQUEST_HEADER) === "1" ||
			streamEntry?.native === true;
		if (nativeMode && response.status === 200) {
			const headers = sanitizeResponseHeaders(response.headers);
			headers.set(NATIVE_RESPONSES_RESPONSE_HEADER, "1");
			// The Codex backend frequently returns SSE WITHOUT a content-type
			// header (the translated path's sniffing fix-up below exists for
			// exactly this). Native mode is always a stream, so apply the same
			// fix-up here — without it isStreamingResponse() is false downstream,
			// the response takes the non-stream path, and SSE usage collection
			// never runs (request recorded with no model/tokens).
			if (!headers.get("content-type")?.includes("text/event-stream")) {
				headers.set("content-type", "text/event-stream");
			}
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		const isEventStream = contentType?.includes("text/event-stream") ?? false;
		if (isEventStream) {
			if (requestedStream) {
				return this.transformStreamingResponse(response);
			}
			return this.transformSseResponseToJson(response);
		}

		if (response.ok && response.body !== null) {
			const probeText = await response.text();
			const trimmed = probeText.trimStart();
			const isSseLike = trimmed.startsWith("event:");

			if (isSseLike) {
				log.debug(
					`Codex returned successful response without SSE content-type (${contentType ?? "<missing>"}); transforming as ${requestedStream ? "SSE" : "JSON"}`,
				);
				const headers = sanitizeResponseHeaders(response.headers);
				headers.set("content-type", "text/event-stream");
				const sseResponse = new Response(probeText, {
					status: response.status,
					statusText: response.statusText,
					headers,
				});
				if (requestedStream) {
					return this.transformStreamingResponse(sseResponse);
				}
				return this.transformSseResponseToJson(sseResponse);
			}

			const headers = sanitizeResponseHeaders(response.headers);
			return new Response(probeText, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		const headers = sanitizeResponseHeaders(response.headers);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// Parse reset time from Codex usage headers (present on all responses)
		const parseReset = (v: string | null) =>
			v ? Number.parseInt(v, 10) * 1000 : undefined;

		// Try primary/secondary headers first, then legacy x-codex-5h/7d headers
		const resets = [
			parseReset(response.headers.get("x-codex-primary-reset-at")),
			parseReset(response.headers.get("x-codex-secondary-reset-at")),
			parseReset(response.headers.get("x-codex-5h-reset-at")),
			parseReset(response.headers.get("x-codex-7d-reset-at")),
		].filter((v): v is number => v !== undefined);

		// Use the sooner (smallest) reset time
		const resetTime = resets.length > 0 ? Math.min(...resets) : undefined;

		if (response.status !== 429) {
			// Return reset time for DB tracking even on successful responses
			return { isRateLimited: false, resetTime };
		}

		return {
			isRateLimited: true,
			resetTime: resetTime ?? Date.now() + 60 * 60 * 1000,
		};
	}

	supportsOAuth(): boolean {
		return true;
	}

	getOAuthProvider() {
		const { CodexOAuthProvider } = require("./oauth.js");
		return new CodexOAuthProvider();
	}

	private async buildSyntheticCountTokensRequest(
		request: Request,
	): Promise<Request> {
		const contentType = request.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			// Non-JSON content-type → 400 error
			const errorBody = JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "Content-Type must be application/json for count_tokens",
				},
			});
			const errorHeaders = new Headers(request.headers);
			errorHeaders.set("content-type", "application/json");
			errorHeaders.set("x-clankermux-synthetic-response", "true");
			errorHeaders.set("x-clankermux-synthetic-status", "400");
			return new Request(request.url, {
				method: request.method,
				headers: errorHeaders,
				body: errorBody,
			});
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			// Malformed JSON → 400 error
			const errorBody = JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "Request body must be valid JSON",
				},
			});
			const errorHeaders = new Headers(request.headers);
			errorHeaders.set("content-type", "application/json");
			errorHeaders.set("x-clankermux-synthetic-response", "true");
			errorHeaders.set("x-clankermux-synthetic-status", "400");
			return new Request(request.url, {
				method: request.method,
				headers: errorHeaders,
				body: errorBody,
			});
		}

		// Conservative token estimate: same heuristic used elsewhere in ClankerMux
		const inputTokens = Math.max(1, Math.ceil(JSON.stringify(body).length / 3));
		const responseBody = JSON.stringify({ input_tokens: inputTokens });
		const successHeaders = new Headers(request.headers);
		successHeaders.set("content-type", "application/json");
		successHeaders.set("x-clankermux-synthetic-response", "true");
		successHeaders.set("x-clankermux-synthetic-status", "200");
		return new Request(request.url, {
			method: request.method,
			headers: successHeaders,
			body: responseBody,
		});
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	private mapModel(anthropicModel: string, account?: Account): string {
		if (account) {
			const mapped = mapModelName(anthropicModel, account);
			if (mapped !== anthropicModel) {
				return mapped;
			}
		}

		// Family default (opus/sonnet/haiku/fable; mythos resolves to fable).
		const family = getModelFamily(anthropicModel);
		if (family) return DEFAULT_CODEX_MODEL_BY_FAMILY[family];
		return anthropicModel;
	}

	private extractSystemPrompt(
		system: AnthropicRequest["system"],
	): string | undefined {
		if (!system) return undefined;
		if (typeof system === "string") return system;
		// Array of content blocks
		return system
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n\n");
	}

	/**
	 * True when the final content block of the final message is a `tool_result`
	 * for a `Skill` tool call earlier in the same history. Reads the original
	 * Anthropic blocks so the result is independent of convertMessage's item
	 * ordering. Returns false for string-content messages, non-Skill terminal
	 * tool results, mid-history Skill results, and orphaned tool results whose
	 * matching `Skill` tool_use is absent.
	 */
	private endsWithSkillToolResult(messages: AnthropicMessage[]): boolean {
		const lastMsg = messages[messages.length - 1];
		if (!lastMsg || !Array.isArray(lastMsg.content)) return false;
		const lastBlock = lastMsg.content[lastMsg.content.length - 1];
		if (!lastBlock || lastBlock.type !== "tool_result") return false;

		// Collect the call IDs of every `Skill` tool_use across the history.
		const skillCallIds = new Set<string>();
		for (const msg of messages) {
			if (!Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (block.type === "tool_use" && block.name === "Skill") {
					skillCallIds.add(block.id);
				}
			}
		}
		return skillCallIds.has(lastBlock.tool_use_id);
	}

	/**
	 * Map an Anthropic `tool_choice` to the Responses API `tool_choice`.
	 * `auto`→auto, `any`→required, `none`→none, `tool`→a forced function (validated
	 * against the declared tools). Unknown types and named choices that reference a
	 * tool the request did not declare throw ValidationError so the bad request is
	 * surfaced to the client rather than silently dropped. `disable_parallel_tool_use`
	 * is handled separately at the request-build site (it maps to
	 * `parallel_tool_calls`, not to `tool_choice`).
	 */
	private convertToolChoice(
		choice: AnthropicToolChoice | undefined,
		tools: readonly CodexTool[],
	): CodexRequest["tool_choice"] | undefined {
		if (!choice) return undefined;
		if (typeof choice !== "object") {
			throw new ValidationError("tool_choice must be an object");
		}
		if (choice.type === "auto") return "auto";
		if (choice.type === "any") return "required";
		if (choice.type === "none") return "none";
		if (choice.type === "tool") {
			if (
				typeof choice.name !== "string" ||
				!tools.some((tool) => tool.name === choice.name)
			) {
				throw new ValidationError(
					`tool_choice references unknown tool: ${choice.name}`,
				);
			}
			return { type: "function", name: choice.name };
		}
		throw new ValidationError(
			`tool_choice has unsupported type: ${String(
				(choice as { type?: unknown }).type,
			)}`,
		);
	}

	/**
	 * Serialize an Anthropic tool_result `content` into the single output string
	 * the Codex `function_call_output` item requires. Degrades non-text blocks
	 * safely: image blocks become a marker, other structured blocks are JSON'd
	 * (with an 8 KiB cap replacing oversized payloads), and malformed input
	 * (missing/null/non-array content, null blocks) yields empty output instead of
	 * throwing — a throw here is swallowed by transformRequestBody, which then
	 * forwards the UNtranslated Anthropic body upstream.
	 */
	private serializeToolResultContent(
		content: AnthropicToolResult["content"],
	): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const parts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
				continue;
			}
			if (block.type === "image") {
				parts.push("[image content not supported in Codex tool results]");
				continue;
			}
			let serialized: string;
			try {
				serialized = JSON.stringify(block);
			} catch {
				continue;
			}
			if (serialized.length > CODEX_MAX_STRUCTURED_BLOCK_CHARS) {
				parts.push(
					`[${String(block.type ?? "unknown")} content omitted: ${serialized.length} chars]`,
				);
				continue;
			}
			parts.push(serialized);
		}
		return parts.join("\n");
	}

	private convertMessage(
		msg: AnthropicMessage,
	): (CodexMessage | CodexFunctionCallItem | CodexFunctionCallOutputItem)[] {
		const items: (
			| CodexMessage
			| CodexFunctionCallItem
			| CodexFunctionCallOutputItem
		)[] = [];

		// Codex API only accepts user/assistant/system roles.
		// Map developer (Codex CLI system instructions sent as a message role) to system.
		const role = (msg.role as string) === "developer" ? "system" : msg.role;
		const textType = role === "assistant" ? "output_text" : "input_text";

		if (typeof msg.content === "string") {
			items.push({
				role,
				content: [{ type: textType, text: msg.content } as CodexContentItem],
			} as CodexMessage);
			return items;
		}

		// Complex content array: may contain tool_use, tool_result, text.
		// Preserve source order so Codex sees the same block chronology the client
		// sent — outputs stay adjacent to their calls, and follow-up text stays
		// after the results it refers to. Consecutive text blocks batch into one
		// message wrapper; function_call* items are top-level.
		let pendingText: CodexContentItem[] = [];
		const flushText = () => {
			if (pendingText.length === 0) return;
			items.push({ role, content: pendingText } as CodexMessage);
			pendingText = [];
		};

		for (const block of msg.content) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text") {
				pendingText.push({
					type: textType,
					text: block.text,
				} as CodexContentItem);
			} else if (block.type === "tool_use") {
				flushText();
				items.push({
					type: "function_call",
					call_id: block.id,
					name: block.name,
					arguments: JSON.stringify(
						this.sanitizeToolUseInput(block.name, block.input),
					),
					status: "completed",
				});
			} else if (block.type === "tool_result") {
				flushText();
				const serialized = this.serializeToolResultContent(block.content);
				items.push({
					type: "function_call_output",
					call_id: block.tool_use_id,
					output:
						block.is_error === true ? `[tool error] ${serialized}` : serialized,
					status: "completed",
				});
			}
		}
		flushText();

		return items;
	}

	/**
	 * Normalize Anthropic tool_use inputs that Codex (GPT) tends to emit in
	 * shapes the Anthropic client's local tool schemas reject. Generic/non-object
	 * arguments (`""`, `null`, arrays, numbers) are passed through untouched so
	 * unrelated tools are never corrupted.
	 */
	private sanitizeToolUseInput(name: string, input: unknown): unknown {
		if (input === undefined) return {};
		if (input === null || typeof input !== "object" || Array.isArray(input)) {
			return input;
		}

		const sanitized: Record<string, unknown> = {
			...(input as Record<string, unknown>),
		};

		if (name === "Read") {
			// An empty `pages` value fails Read's page-range schema; drop it.
			const pages = sanitized.pages;
			if (
				pages === "" ||
				pages === null ||
				pages === undefined ||
				(Array.isArray(pages) && pages.length === 0)
			) {
				delete sanitized.pages;
			}
		}

		if (name === "WebSearch") {
			const allowedDomains = this.cleanWebSearchDomains(
				sanitized.allowed_domains,
			);
			if (allowedDomains.length > 0) {
				sanitized.allowed_domains = allowedDomains;
			} else {
				delete sanitized.allowed_domains;
			}
			// Intentionally stripped: the WebSearch surface here does not accept
			// blocked_domains, so any value GPT emits would fail client validation.
			delete sanitized.blocked_domains;
		}

		return sanitized;
	}

	private cleanWebSearchDomains(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value
			.filter((domain): domain is string => typeof domain === "string")
			.map((domain) => domain.trim())
			.filter((domain) => domain.length > 0);
	}

	private sanitizeToolUsePartialJson(
		name: string,
		partialJson: string,
	): string {
		try {
			const input = JSON.parse(partialJson) as unknown;
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				return partialJson;
			}
			return JSON.stringify(this.sanitizeToolUseInput(name, input));
		} catch {
			return partialJson;
		}
	}

	private extractContextWindow(
		response: Record<string, unknown> | undefined,
		usage: { input_tokens?: number } | undefined,
	): ContextWindow | null {
		const model = response?.model;
		if (typeof model !== "string") return null;
		// resolveModelContextWindow (not a direct MODEL_CONTEXT_WINDOWS lookup) so
		// a dated backend model (e.g. gpt-5.6-sol-2026-05-13) still resolves to its
		// family window — matching the routing gate — instead of dropping the
		// client gauge / compaction signal.
		const contextWindowSize = resolveModelContextWindow(model);
		if (!contextWindowSize) return null;

		const inputTokens = usage?.input_tokens;
		if (
			typeof inputTokens !== "number" ||
			!Number.isFinite(inputTokens) ||
			inputTokens < 0
		)
			return null;

		const usageRecord = usage as Record<string, unknown> | undefined;
		const inputTokenDetails = usageRecord?.input_tokens_details as
			| Record<string, unknown>
			| undefined;
		// Codex's input_tokens is cache-inclusive; normalize to Anthropic's
		// additive semantics so the context-window gauge's input_tokens excludes
		// cache reads instead of double-counting them.
		const normalizedInput = normalizeCodexInputUsage(
			inputTokens,
			inputTokenDetails?.cached_tokens,
		);

		return {
			current_usage: {
				input_tokens: normalizedInput.inputTokens,
				cache_read_input_tokens: normalizedInput.cacheReadInputTokens,
				cache_creation_input_tokens:
					typeof inputTokenDetails?.cache_creation_input_tokens === "number" &&
					Number.isFinite(inputTokenDetails.cache_creation_input_tokens) &&
					inputTokenDetails.cache_creation_input_tokens >= 0
						? inputTokenDetails.cache_creation_input_tokens
						: 0,
			},
			context_window_size: contextWindowSize,
		};
	}

	private extractSessionId(body: AnthropicRequest): string | undefined {
		const rawUserId = body.metadata?.user_id;
		if (typeof rawUserId !== "string") return undefined;
		try {
			const metadata = JSON.parse(rawUserId) as unknown;
			if (!metadata || typeof metadata !== "object") return undefined;
			const sessionId = (metadata as Record<string, unknown>).session_id;
			if (
				typeof sessionId !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					sessionId,
				)
			) {
				return undefined;
			}
			return sessionId.toLowerCase();
		} catch {
			return undefined;
		}
	}

	/**
	 * Attaches an OpenAI prompt_cache_key to converted Codex requests. OpenAI
	 * documents that on GPT-5.6-family models this key is required for reliable
	 * prompt-cache matching, routes each request to a cache machine by hashing
	 * the prompt prefix together with the key, and warns that one key should
	 * stay under ~15 requests/minute or "some requests may miss the cache".
	 *
	 * A Claude Code session multiplexes the main loop plus every subagent
	 * conversation over one session id, so keying on the session alone funnels
	 * an entire fan-out burst onto one cache machine and thrashes it (measured
	 * in production traces: turns 1-8 of subagent conversations cached no better
	 * than cold starts while one session key carried 170+ conversations in five
	 * minutes). We therefore partition the key by conversation identity: session
	 * id + first input item, stable across the turns of one conversation and
	 * distinct across concurrent subagents. Each conversation is sequential, so
	 * per-key traffic stays far below the documented bound.
	 *
	 * Instructions (the system prompt) are deliberately NOT hashed into the key:
	 * Claude Code's system prompt embeds volatile content (current date, cwd,
	 * git-status snapshot), so including it would re-shard the key mid-
	 * conversation (a midnight rollover or a new commit), splitting the cache.
	 * The key only picks the routing bucket — OpenAI still matches the real
	 * prompt prefix inside that bucket, so dropping instructions cannot cause an
	 * incorrect cache HIT; it only makes the bucket stable across turns.
	 *
	 * Always-on, but gated on the resolved account endpoint
	 * (isOpenAiPromptCacheEndpoint): only sent when the account targets OpenAI's
	 * own chatgpt.com / api.openai.com hosts, never a custom_endpoint pointing
	 * elsewhere (which may reject the unknown field). This is the TRANSLATED
	 * (Claude Code → Codex) path only; the native /v1/responses passthrough
	 * carries the Codex CLI's own key.
	 *
	 * Digests are truncated to PROMPT_CACHE_KEY_DIGEST_LEN hex chars so the full
	 * key (including the longer `clankermux-session-` prefix) stays within the
	 * API's 64-char key bound. Session ids and prompt content never appear in
	 * the key.
	 */
	private derivePromptCacheKey(
		body: AnthropicRequest,
		input: readonly unknown[],
		account?: Account,
	): string | undefined {
		if (!isOpenAiPromptCacheEndpoint(account)) return undefined;
		const sessionId = this.extractSessionId(body);
		if (!sessionId) return undefined;
		const sessionKey = () =>
			`clankermux-session-${createHash("sha256")
				.update(sessionId)
				.digest("hex")
				.slice(0, PROMPT_CACHE_KEY_DIGEST_LEN)}`;
		// Empty input: no conversation-identity anchor → coarse per-session key.
		if (input.length === 0) return sessionKey();
		let firstItem: string | undefined;
		try {
			firstItem = JSON.stringify(input[0]);
		} catch {
			firstItem = undefined;
		}
		// Non-serializable first item (e.g. a circular structure): fall back to
		// the coarse per-session key rather than a partial-identity convo key.
		if (firstItem === undefined) return sessionKey();
		return `clankermux-convo-${createHash("sha256")
			.update(sessionId)
			.update("\0")
			.update(firstItem)
			.digest("hex")
			.slice(0, PROMPT_CACHE_KEY_DIGEST_LEN)}`;
	}

	private convertToCodexFormat(
		body: AnthropicRequest,
		account?: Account,
		requestId?: string,
	): CodexRequest {
		const model = this.mapModel(body.model, account);
		if (isDebugEnabled("model")) {
			log.info(
				`[codex:model-debug] request_id=${requestId ?? "unknown"} request_model=${body.model} mapped_model=${model} account=${account?.name ?? "unknown"}`,
			);
		}
		const instructions = this.extractSystemPrompt(body.system);

		// Convert messages
		const input: CodexRequest["input"] = [];
		for (const msg of body.messages) {
			const items = this.convertMessage(msg);
			for (const item of items) {
				input.push(item);
			}
		}

		// Continuation nudge for the `Skill` tool. `Skill` is local to the
		// Anthropic-compatible client/harness (Claude Code): after it returns, the
		// useful behavior is for the model to continue the user's original request
		// using the freshly-loaded instructions, not to stall waiting for another
		// user message. A Codex backend handed a history ending in a bare
		// function_call_output often treats the turn as complete and stalls. So
		// when the final content block of the final message is a `Skill`
		// tool_result, append exactly one continuation nudge.
		//
		// The terminality check reads the original Anthropic content blocks (not
		// the converted Codex items) so it is unaffected by how convertMessage
		// groups/reorders items. A mid-history Skill result, a non-Skill terminal
		// tool result, or any block after the Skill result (text or another tool
		// result) all correctly skip the nudge.
		if (this.endsWithSkillToolResult(body.messages)) {
			input.push({
				role: "user",
				content: [
					{
						type: "input_text",
						text: "The requested Skill tool has loaded additional instructions. Continue the user's original request now, applying those instructions. Do not wait for another user message.",
					},
				],
			});
		}

		// Convert tools
		let tools: CodexTool[] | undefined;
		if (body.tools && body.tools.length > 0) {
			tools = body.tools.map((t) => ({
				type: "function" as const,
				name: t.name,
				description: t.description,
				parameters: t.input_schema,
			}));
		}

		const reasoningResolution = resolveReasoningEffort(body.reasoning?.effort, {
			sourceModel: body.model,
			targetModel: model,
		});
		if (reasoningResolution.downgrades.length > 0) {
			for (const downgrade of reasoningResolution.downgrades) {
				log.warn(
					`Downgraded reasoning effort for model ${downgrade.model}: ${downgrade.from} -> ${downgrade.to}`,
				);
			}
		}

		// Codex always requires streaming upstream; non-streaming clients are handled
		// on the response side via transformSseResponseToJson.
		const codexRequest: CodexRequest = {
			model,
			input,
			stream: true,
			store: false,
			reasoning: { effort: reasoningResolution.effort ?? "medium" },
		};

		codexRequest.instructions = instructions || "You are a helpful assistant.";
		const promptCacheKey = this.derivePromptCacheKey(body, input, account);
		if (promptCacheKey) {
			codexRequest.prompt_cache_key = promptCacheKey;
		}
		// Honor an explicit Anthropic tool_choice; validate named choices even when
		// no tools are declared (so a bad request is rejected, not silently sent).
		const explicitToolChoice = this.convertToolChoice(
			body.tool_choice,
			tools ?? [],
		);
		if (explicitToolChoice) {
			codexRequest.tool_choice = explicitToolChoice;
		} else if (tools?.some((t) => t.name === "StructuredOutput")) {
			// Claude Code schema agents provide a StructuredOutput tool but do not set
			// Anthropic tool_choice. Native Claude reliably follows the hidden schema
			// instruction; Codex models often end_turn with text instead. Force the
			// function when this sentinel tool is present to preserve workflow semantics.
			codexRequest.tool_choice = {
				type: "function",
				name: "StructuredOutput",
			};
		}
		if (body.tool_choice?.disable_parallel_tool_use === true) {
			codexRequest.parallel_tool_calls = false;
		}
		if (tools) {
			codexRequest.tools = tools;
		}

		return codexRequest;
	}

	private async transformSseResponseToJson(
		response: Response,
	): Promise<Response> {
		const requestId =
			response.headers.get("x-clankermux-request-id") ?? "unknown";
		const transformed = this.transformStreamingResponse(response);
		const reader = transformed.body
			?.pipeThrough(new TextDecoderStream())
			.getReader();
		let messageStartPayload: Record<string, unknown> | null = null;
		let messageDeltaPayload: Record<string, unknown> | null = null;
		let errorPayload: Record<string, unknown> | null = null;
		const content: Array<Record<string, unknown>> = [];
		const textByIndex = new Map<number, string>();
		const toolByIndex = new Map<
			number,
			{ id: string; name: string; partialJson: string }
		>();

		// Parse SSE line-pairs incrementally without buffering full body
		let pending = "";
		let lastEventName: string | null = null;
		const processLine = (line: string) => {
			if (line.startsWith("event:")) {
				lastEventName = line.slice("event:".length).trim();
			} else if (line.startsWith("data:") && lastEventName !== null) {
				const eventName = lastEventName;
				lastEventName = null;
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(line.slice("data:".length).trim());
				} catch {
					return;
				}
				if (eventName === "error") {
					errorPayload = data;
					return;
				}
				if (eventName === "message_start") {
					messageStartPayload = data;
					return;
				}
				if (eventName === "message_delta") {
					messageDeltaPayload = data;
					return;
				}
				if (eventName === "content_block_delta") {
					const index = typeof data.index === "number" ? data.index : -1;
					const delta = data.delta as Record<string, unknown> | undefined;
					if (index < 0 || !delta) return;
					if (delta.type === "text_delta" && typeof delta.text === "string") {
						textByIndex.set(index, (textByIndex.get(index) ?? "") + delta.text);
					} else if (
						delta.type === "input_json_delta" &&
						typeof delta.partial_json === "string"
					) {
						const existing = toolByIndex.get(index);
						if (existing) {
							existing.partialJson += delta.partial_json;
						} else {
							toolByIndex.set(index, {
								id: "",
								name: "",
								partialJson: delta.partial_json,
							});
						}
					}
					return;
				}
				if (eventName === "content_block_start") {
					const index = typeof data.index === "number" ? data.index : -1;
					const block = data.content_block as
						| Record<string, unknown>
						| undefined;
					if (index < 0 || !block) return;
					if (block.type === "tool_use") {
						toolByIndex.set(index, {
							id: typeof block.id === "string" ? block.id : "",
							name: typeof block.name === "string" ? block.name : "",
							partialJson: toolByIndex.get(index)?.partialJson ?? "",
						});
					}
				}
			}
		};

		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					pending += value;
					const parts = pending.split("\n");
					pending = parts.pop() ?? "";
					for (const line of parts) {
						processLine(line);
					}
				}
				if (pending) processLine(pending);
			} finally {
				reader.releaseLock();
			}
		}

		if (errorPayload) {
			const headers = sanitizeResponseHeaders(response.headers);
			headers.set("content-type", "application/json");
			const { status, statusText } =
				this.httpStatusForAnthropicErrorPayload(errorPayload);
			return new Response(JSON.stringify(errorPayload), {
				status,
				statusText,
				headers,
			});
		}

		const allIndices = new Set([...textByIndex.keys(), ...toolByIndex.keys()]);
		for (const index of [...allIndices].sort((a, b) => a - b)) {
			const text = textByIndex.get(index);
			if (text !== undefined) {
				content.push({ type: "text", text });
			}
			const tool = toolByIndex.get(index);
			if (tool !== undefined) {
				let input: Record<string, unknown> = {};
				if (tool.partialJson.trim().length > 0) {
					try {
						input = JSON.parse(tool.partialJson) as Record<string, unknown>;
					} catch {
						input = {};
					}
				}
				content.push({
					type: "tool_use",
					id: tool.id || `call_${index}`,
					name: tool.name,
					// Already sanitized upstream: this JSON came from the
					// transformStreamingResponse pass, which ran
					// sanitizeToolUsePartialJson on every tool call. No second pass.
					input,
				});
			}
		}
		const startMessage =
			((messageStartPayload as Record<string, unknown> | null)?.message as
				| Record<string, unknown>
				| undefined) ?? {};
		const hasDeltaUsage = messageDeltaPayload !== null;
		const deltaUsage = _normalizeUsage(
			(messageDeltaPayload as Record<string, unknown> | null)?.usage,
		);
		const startUsage = _normalizeUsage(startMessage.usage);
		const usage = {
			input_tokens: hasDeltaUsage
				? deltaUsage.input_tokens
				: startUsage.input_tokens,
			output_tokens: hasDeltaUsage
				? deltaUsage.output_tokens
				: startUsage.output_tokens,
			cache_read_input_tokens: hasDeltaUsage
				? deltaUsage.cache_read_input_tokens
				: startUsage.cache_read_input_tokens,
			cache_creation_input_tokens: hasDeltaUsage
				? deltaUsage.cache_creation_input_tokens
				: startUsage.cache_creation_input_tokens,
		};
		const resolvedModel =
			typeof startMessage.model === "string" ? startMessage.model : "gpt-5.4";
		if (resolvedModel === "gpt-5.4" && isDebugEnabled("model")) {
			log.info(
				`[codex:model-debug] request_id=${requestId} transformSseResponseToJson used fallback model=gpt-5.4 (startMessage.model missing)`,
			);
		}
		const stopReason = content.some((block) => block.type === "tool_use")
			? "tool_use"
			: "end_turn";
		const jsonPayload = {
			id:
				typeof startMessage.id === "string"
					? startMessage.id
					: `msg_${crypto.randomUUID().replace(/-/g, "").substring(0, 24)}`,
			type: "message",
			role: "assistant",
			model: resolvedModel,
			content: content.length > 0 ? content : [{ type: "text", text: "" }],
			stop_reason: stopReason,
			stop_sequence: null,
			usage,
		};
		const headers = sanitizeResponseHeaders(response.headers);
		headers.set("content-type", "application/json");
		return new Response(JSON.stringify(jsonPayload), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	private transformStreamingResponse(response: Response): Response {
		const requestId =
			response.headers.get("x-clankermux-request-id") ?? "unknown";
		if (isDebugEnabled("model")) {
			log.info(
				`[codex:model-debug] request_id=${requestId} transformStreamingResponse initial fallback model=gpt-5.4 until response.created arrives`,
			);
		}
		const state: StreamState = {
			buffer: "",
			messageId: `msg_${crypto.randomUUID().replace(/-/g, "").substring(0, 24)}`,
			model: "gpt-5.4",
			contentBlockIndex: 0,
			hasSentMessageStart: false,
			hasSentContentBlockStart: false,
			hasSentTerminalEvents: false,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			contextWindow: null,
			functionCallBlocks: new Map(),
			sawToolUse: false,
		};

		const headers = sanitizeResponseHeaders(response.headers);
		headers.set("content-type", "text/event-stream");

		const { readable, writable } = new TransformStream<
			Uint8Array,
			Uint8Array
		>();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const writeSSE = async (event: string, data: unknown) => {
			const payload =
				typeof data === "object" && data !== null
					? (data as Record<string, unknown>)
					: null;
			if ((event === "message_start" || event === "message_delta") && payload) {
				const normalizedUsage = _normalizeUsage(payload.usage);
				payload.usage = normalizedUsage;
				if (event === "message_start") {
					const message =
						typeof payload.message === "object" && payload.message !== null
							? (payload.message as Record<string, unknown>)
							: {};
					message.usage = _normalizeUsage(message.usage ?? normalizedUsage);
					payload.message = message;
				} else {
					const message = payload.message as
						| Record<string, unknown>
						| undefined;
					if (message) {
						message.usage = _normalizeUsage(message.usage ?? normalizedUsage);
					}
				}
			}
			if (event === "message_delta" && payload) {
				const delta =
					typeof payload.delta === "object" && payload.delta !== null
						? (payload.delta as Record<string, unknown>)
						: {};
				if (!("stop_reason" in delta)) {
					delta.stop_reason = "end_turn";
				}
				if (!("stop_sequence" in delta)) {
					delta.stop_sequence = null;
				}
				if (!("usage" in delta)) {
					delta.usage = payload.usage;
				}
				payload.delta = delta;
			}
			const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
			await writer.write(encoder.encode(line));
		};
		const ensureMessageStart = async () => {
			if (state.hasSentMessageStart) return;
			state.hasSentMessageStart = true;
			await writeSSE("message_start", {
				type: "message_start",
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
				message: {
					id: state.messageId,
					type: "message",
					role: "assistant",
					content: [],
					model: state.model,
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			});
		};

		const processEvents = async () => {
			try {
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Response body is not readable");

				while (true) {
					const { value, done } = await reader.read();
					if (done) break;

					state.buffer += decoder.decode(value, { stream: true });

					// Process complete SSE events in buffer
					while (true) {
						const newlineIdx = state.buffer.indexOf("\n\n");
						if (newlineIdx === -1) break;

						const eventText = state.buffer.slice(0, newlineIdx);
						state.buffer = state.buffer.slice(newlineIdx + 2);

						const eventLine = eventText
							.split("\n")
							.find((l) => l.startsWith("event:"));
						const dataLine = eventText
							.split("\n")
							.find((l) => l.startsWith("data:"));

						if (!eventLine || !dataLine) continue;

						const eventName = eventLine.slice("event:".length).trim();
						const dataStr = dataLine.slice("data:".length).trim();

						if (dataStr === "[DONE]") continue;

						let data: Record<string, unknown>;
						try {
							data = JSON.parse(dataStr);
						} catch {
							continue;
						}

						await this.handleCodexEvent(
							eventName,
							data,
							state,
							writeSSE,
							ensureMessageStart,
						);
					}
				}

				if (state.upstreamError) {
					return;
				}

				// Flush any remaining
				await ensureMessageStart();

				// Close any open content block
				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
				}

				// Final message_delta + message_stop if upstream never sent response.completed
				if (!state.hasSentTerminalEvents) {
					await writeSSE("message_delta", {
						type: "message_delta",
						delta: {
							stop_reason: state.sawToolUse ? "tool_use" : "end_turn",
							stop_sequence: null,
						},
						usage: { output_tokens: state.outputTokens },
					});
					await writeSSE("message_stop", { type: "message_stop" });
				}
			} catch (error) {
				log.error("Error processing Codex SSE stream:", error);
			} finally {
				await writer.close();
			}
		};

		processEvents();

		return new Response(readable, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	private normalizeCodexStreamError(
		eventName: string,
		data: Record<string, unknown>,
	): StreamState["upstreamError"] {
		const response =
			data.response && typeof data.response === "object"
				? (data.response as Record<string, unknown>)
				: undefined;
		const responseError =
			response?.error && typeof response.error === "object"
				? (response.error as Record<string, unknown>)
				: undefined;
		const directError =
			data.error && typeof data.error === "object"
				? (data.error as Record<string, unknown>)
				: undefined;
		const error = responseError ?? directError ?? data;
		const messageCandidate = error.message ?? data.message ?? response?.status;
		const typeCandidate = error.type ?? error.code ?? eventName;
		const codeCandidate = error.code ?? data.code;
		const statusCandidate = response?.status ?? data.status;

		return {
			type:
				typeof typeCandidate === "string" && typeCandidate.length > 0
					? typeCandidate
					: "api_error",
			message:
				typeof messageCandidate === "string" && messageCandidate.length > 0
					? messageCandidate
					: "Codex upstream failed while generating a response.",
			...(typeof codeCandidate === "string" ? { code: codeCandidate } : {}),
			...(typeof statusCandidate === "string"
				? { status: statusCandidate }
				: {}),
		};
	}

	private toAnthropicErrorPayload(error: StreamState["upstreamError"]): {
		type: "error";
		error: { type: string; message: string; code?: string };
	} {
		const code = error?.code;
		const message = error?.message || "Codex upstream failed.";
		// Recognized Codex codes map to the correct Anthropic error type so our
		// failover/cooldown logic reacts to the right HTTP status. Unrecognized
		// codes keep the existing behavior (echo the raw upstream type, else
		// api_error -> 502).
		const mappedFromCode = code
			? CODEX_ERROR_TYPE_BY_CODE[code.toLowerCase()]
			: undefined;
		let type = mappedFromCode || error?.type || "api_error";
		// Some Codex endpoints report context overflow without the
		// context_length_exceeded code, only an "your input exceeds the context
		// window..." message. Treat that message shape as a permanent 400-class
		// error too, forcing invalid_request_error even when the code/type is
		// generic (otherwise it would fall through to api_error -> 502).
		const isContextOverflow =
			code?.toLowerCase() === "context_length_exceeded" ||
			/^your input exceeds the context window\b/i.test(message);
		if (isContextOverflow) {
			type = "invalid_request_error";
		}
		return {
			type: "error",
			error: {
				type,
				message,
				...(code ? { code } : {}),
			},
		};
	}

	private httpStatusForAnthropicErrorPayload(
		payload: Record<string, unknown>,
	): {
		status: number;
		statusText: string;
	} {
		const error =
			payload.error && typeof payload.error === "object"
				? (payload.error as Record<string, unknown>)
				: {};
		const type = typeof error.type === "string" ? error.type : "";
		const code = typeof error.code === "string" ? error.code : "";
		const status = typeof error.status === "string" ? error.status : "";

		if (code === "context_length_exceeded") {
			return { status: 400, statusText: "Bad Request" };
		}
		if (type === "invalid_request_error") {
			return { status: 400, statusText: "Bad Request" };
		}
		if (type === "authentication_error") {
			return { status: 401, statusText: "Unauthorized" };
		}
		if (type === "permission_error") {
			return { status: 403, statusText: "Forbidden" };
		}
		if (
			type === "rate_limit_error" ||
			code === "rate_limit_exceeded" ||
			status === "rate_limited"
		) {
			return { status: 429, statusText: "Too Many Requests" };
		}
		if (type === "overloaded_error") {
			return { status: 529, statusText: "Overloaded" };
		}
		return { status: 502, statusText: "Bad Gateway" };
	}

	private async handleCodexEvent(
		eventName: string,
		data: Record<string, unknown>,
		state: StreamState,
		writeSSE: (event: string, data: unknown) => Promise<void>,
		ensureMessageStart: () => Promise<void>,
	): Promise<void> {
		switch (eventName) {
			case "response.created": {
				const resp = data.response as Record<string, unknown> | undefined;
				const respId = (resp?.id as string) || state.messageId;
				state.messageId = respId;
				state.model = (resp?.model as string) || state.model;
				if (state.hasSentMessageStart) {
					break;
				}

				await ensureMessageStart();
				break;
			}

			case "response.output_item.added": {
				const item = data.item as Record<string, unknown> | undefined;
				const outputIndex = data.output_index as number | undefined;
				const itemType = item?.type as string | undefined;

				if (itemType === "message") {
					// Text content block will start on content_part.added
					// Nothing to emit yet
				} else if (itemType === "function_call") {
					const callId = item?.call_id as string;
					const name = item?.name as string;
					state.sawToolUse = true;

					if (state.hasSentContentBlockStart) {
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: state.contentBlockIndex,
						});
						state.contentBlockIndex++;
						state.hasSentContentBlockStart = false;
					}

					const blockIdx = state.contentBlockIndex;
					await ensureMessageStart();
					await writeSSE("content_block_start", {
						type: "content_block_start",
						index: blockIdx,
						content_block: { type: "tool_use", id: callId, name, input: {} },
					});
					state.hasSentContentBlockStart = true;
					if (outputIndex !== undefined) {
						state.functionCallBlocks.set(outputIndex, {
							contentBlockIndex: blockIdx,
							name,
							arguments: [],
						});
					}
				}
				break;
			}

			case "response.content_part.added": {
				const part = data.part as Record<string, unknown> | undefined;
				const partType = part?.type as string | undefined;

				if (partType === "output_text") {
					await ensureMessageStart();
					// Start a text content block
					if (state.hasSentContentBlockStart) {
						// Only close the current block if it's not a still-open function-call
						// block awaiting output_item.done — closing it here would produce a
						// premature content_block_stop that output_item.done will duplicate.
						const isOpenFunctionCallBlock = [
							...state.functionCallBlocks.values(),
						].some((b) => b.contentBlockIndex === state.contentBlockIndex);
						if (!isOpenFunctionCallBlock) {
							await writeSSE("content_block_stop", {
								type: "content_block_stop",
								index: state.contentBlockIndex,
							});
						}
						state.contentBlockIndex++;
					}

					await writeSSE("content_block_start", {
						type: "content_block_start",
						index: state.contentBlockIndex,
						content_block: { type: "text", text: "" },
					});
					state.hasSentContentBlockStart = true;
				}
				break;
			}

			case "response.output_text.delta": {
				const delta = data.delta as string | undefined;
				if (delta) {
					await ensureMessageStart();
					await writeSSE("content_block_delta", {
						type: "content_block_delta",
						index: state.contentBlockIndex,
						delta: { type: "text_delta", text: delta },
					});
				}
				break;
			}

			case "response.function_call_arguments.delta": {
				const delta = data.delta as string | undefined;
				const outputIndex = data.output_index as number | undefined;
				if (delta && outputIndex !== undefined) {
					const buffer = state.functionCallBlocks.get(outputIndex);
					if (buffer) {
						buffer.arguments.push(delta);
					}
				}
				break;
			}

			case "response.output_item.done": {
				const item = data.item as Record<string, unknown> | undefined;
				const itemType = item?.type as string | undefined;

				if (itemType === "function_call") {
					const outputIndex = data.output_index as number | undefined;
					const buffer =
						outputIndex !== undefined
							? state.functionCallBlocks.get(outputIndex)
							: undefined;
					if (buffer) {
						await writeSSE("content_block_delta", {
							type: "content_block_delta",
							index: buffer.contentBlockIndex,
							delta: {
								type: "input_json_delta",
								partial_json: this.sanitizeToolUsePartialJson(
									buffer.name,
									buffer.arguments.join(""),
								),
							},
						});
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: buffer.contentBlockIndex,
						});
						if (outputIndex !== undefined) {
							state.functionCallBlocks.delete(outputIndex);
						}
						if (
							state.hasSentContentBlockStart &&
							state.contentBlockIndex === buffer.contentBlockIndex
						) {
							state.contentBlockIndex++;
							state.hasSentContentBlockStart = false;
						}
					}
					break;
				}

				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
					state.contentBlockIndex++;
					state.hasSentContentBlockStart = false;
				}
				break;
			}

			case "error":
			case "response.failed": {
				state.upstreamError = this.normalizeCodexStreamError(eventName, data);
				if (!state.hasSentTerminalEvents) {
					await writeSSE(
						"error",
						this.toAnthropicErrorPayload(state.upstreamError),
					);
					state.hasSentTerminalEvents = true;
				}
				break;
			}

			case "response.incomplete":
			case "response.completed": {
				// Guard against a stray response.completed/response.incomplete that
				// arrives AFTER a terminal/error event (e.g. response.failed set
				// upstreamError + hasSentTerminalEvents and wrote an `error` SSE).
				// Emitting message_delta/message_stop here would produce an invalid
				// SSE sequence (terminal events after an error), so bail out.
				if (state.upstreamError || state.hasSentTerminalEvents) break;
				const resp = data.response as Record<string, unknown> | undefined;
				const usage = resp?.usage as
					| {
							input_tokens?: number;
							output_tokens?: number;
							input_tokens_details?: {
								cached_tokens?: number;
								cache_creation_input_tokens?: number;
							};
					  }
					| undefined;

				// Extract cache fields from input_tokens_details (Codex format).
				// Codex's input_tokens is cache-inclusive; normalize to Anthropic's
				// additive semantics so input_tokens excludes cache reads instead of
				// double-counting them (our estimateCostUSD charges input_tokens and
				// cache_read_input_tokens additively).
				const inputTokenDetails = usage?.input_tokens_details;
				const normalizedInput = normalizeCodexInputUsage(
					usage?.input_tokens,
					inputTokenDetails?.cached_tokens,
				);
				const cacheCreation =
					typeof inputTokenDetails?.cache_creation_input_tokens === "number" &&
					inputTokenDetails.cache_creation_input_tokens >= 0
						? inputTokenDetails.cache_creation_input_tokens
						: 0;

				state.inputTokens =
					usage?.input_tokens !== undefined
						? normalizedInput.inputTokens
						: state.inputTokens;
				state.outputTokens = usage?.output_tokens || state.outputTokens;
				state.cacheReadInputTokens = normalizedInput.cacheReadInputTokens;
				state.cacheCreationInputTokens = cacheCreation;
				state.contextWindow = this.extractContextWindow(resp, usage);
				// Close any lingering content block
				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
					state.hasSentContentBlockStart = false;
				}

				const incompleteDetails = resp?.incomplete_details as
					| { reason?: string }
					| undefined;
				const isIncomplete =
					eventName === "response.incomplete" || resp?.status === "incomplete";
				// An incomplete response never resolves to a success stop_reason,
				// even mid tool call: content_filter -> refusal (client discards the
				// partial output); every other reason, including unknown future ones
				// (e.g. max_output_tokens), -> max_tokens (generic truncation). This
				// stops a content-filtered or truncated Codex turn from being
				// reported as a successful end_turn.
				const stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" =
					isIncomplete
						? incompleteDetails?.reason === "content_filter"
							? "refusal"
							: "max_tokens"
						: state.sawToolUse
							? "tool_use"
							: "end_turn";

				const messageDelta: {
					type: "message_delta";
					delta: {
						stop_reason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
						stop_sequence: null;
					};
					usage: {
						input_tokens: number;
						output_tokens: number;
						cache_read_input_tokens: number;
						cache_creation_input_tokens: number;
					};
					context_window?: ContextWindow;
				} = {
					type: "message_delta",
					delta: {
						stop_reason: stopReason,
						stop_sequence: null,
					},
					usage: {
						input_tokens: state.inputTokens,
						output_tokens: state.outputTokens,
						cache_read_input_tokens: state.cacheReadInputTokens,
						cache_creation_input_tokens: state.cacheCreationInputTokens,
					},
				};
				if (state.contextWindow) {
					messageDelta.context_window = state.contextWindow;
				}

				await writeSSE("message_delta", messageDelta);
				await writeSSE("message_stop", { type: "message_stop" });
				state.hasSentTerminalEvents = true;
				break;
			}
			default:
				// Ignore unknown events
				break;
		}
	}
}
