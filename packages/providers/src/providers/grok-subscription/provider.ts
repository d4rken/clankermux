import {
	isInvalidGrantMessage,
	OAuthRefreshTokenError,
} from "@clankermux/core";
import { sanitizeProxyHeaders } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
import type { TokenRefreshResult } from "../../types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";
import {
	GROK_CHAT_PROXY_ENDPOINT,
	GROK_CLI_IDENTITY_HEADERS,
} from "./client-identity";
import { XAI_CLIENT_ID, XAI_TOKEN_ENDPOINT } from "./device-oauth";
import { extractGrokSubscriptionIdentity } from "./identity";
import {
	describeGrokUpgradeRequired,
	isGrokUpgradeRequired,
} from "./upgrade-required";

const log = new Logger("GrokSubscriptionProvider");

/**
 * xAI's own response headers (its rate-limit counters, data-retention flags,
 * conversation and request ids) describe the upstream account, not anything a
 * client of this proxy can act on. `retry-after` and the
 * `anthropic-ratelimit-unified-*` family match none of these and pass through.
 */
const GROK_UPSTREAM_HEADER_PATTERNS = [
	/^x-grok-/,
	/^x-xai-/,
	/^x-ratelimit-/,
	/^x-.*-retention$/,
];

function sanitizeGrokResponseHeaders(original: Headers): Headers {
	const headers = sanitizeProxyHeaders(original);
	// Collected first: deleting while iterating a Headers skips entries.
	const upstreamOnly = [...headers.keys()].filter((name) =>
		GROK_UPSTREAM_HEADER_PATTERNS.some((pattern) =>
			pattern.test(name.toLowerCase()),
		),
	);
	for (const name of upstreamOnly) headers.delete(name);
	return headers;
}

/** Bounds one refresh exchange; the caller's retry policy owns the rest. */
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;

/**
 * Error codes that mean THIS account's refresh token is dead and only a human
 * re-authorization can revive it. Detection is by code, so provider wording
 * changes cannot silently reclassify a dead token as transient.
 *
 * `invalid_client` and `unauthorized_client` are deliberately absent. Every
 * grok-subscription account authorizes through one shared Grok CLI client id,
 * so those describe that client, not one account's grant: making them terminal
 * would pause every account at once behind a reauth prompt that reauth — going
 * through the same client — cannot fix, and leave them paused after the client
 * is corrected.
 */
const TERMINAL_OAUTH_ERROR_CODES = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"refresh_token_reused",
]);

/**
 * SuperGrok / X Premium accounts, which reach inference through the Grok CLI
 * chat proxy rather than the metered api.x.ai the `grok` provider uses. The
 * proxy serves a genuine Anthropic Messages API and bills against the
 * subscription's weekly pool.
 */
export class GrokSubscriptionProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "grok-subscription",
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
			defaultModel: "grok-4.6",
		});
	}

	getEndpoint(): string {
		return GROK_CHAT_PROXY_ENDPOINT;
	}

	/**
	 * Exchange the account's refresh token for a fresh access token.
	 *
	 * Replaces the base class's API-key echo, which would hand the refresh token
	 * back as a bearer and never reach xAI at all. Network-free beyond this one
	 * exchange: identity comes from the id_token's claims, so a refresh cannot be
	 * lost to a profile read that fails after the rotation has already happened.
	 */
	override async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		if (!account.refresh_token) {
			throw new Error(
				`No refresh token for grok-subscription account ${account.name}`,
			);
		}

		log.info(`Refreshing grok-subscription token for account ${account.name}`);

		const response = await fetch(XAI_TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: XAI_CLIENT_ID,
				refresh_token: account.refresh_token,
			}).toString(),
			signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
		});

		if (!response.ok) {
			// Read the body once as text, then try to parse it: a non-JSON rejection
			// that still names invalid_grant has to reach the marker fallback rather
			// than be mistaken for a transient failure.
			const raw = await response.text().catch(() => "");
			let errorData: { error?: string; error_description?: string } | null =
				null;
			try {
				errorData = raw ? JSON.parse(raw) : null;
			} catch {
				// ignore — not JSON; classified by the raw-text marker below
			}

			const errorCode = errorData?.error ?? null;
			if (
				(errorCode && TERMINAL_OAUTH_ERROR_CODES.has(errorCode)) ||
				(errorData == null && isInvalidGrantMessage(raw))
			) {
				throw new OAuthRefreshTokenError(
					account.id,
					`xAI rejected the refresh token${
						errorCode ? ` (${errorCode})` : ""
					} for account ${account.name}. Re-authenticate account "${account.name}" from the dashboard (Accounts tab).`,
				);
			}

			throw new Error(
				`Failed to refresh the grok-subscription token for account ${account.name}: ${
					errorData?.error_description ||
					errorCode ||
					raw ||
					response.statusText
				}`,
			);
		}

		const json = (await response.json().catch(() => null)) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			id_token?: string;
		} | null;

		if (!json?.access_token) {
			throw new Error(
				`The xAI token refresh for account ${account.name} carried no access token`,
			);
		}

		return {
			accessToken: json.access_token,
			// xAI rotates, but not on every response: an omitted refresh_token means
			// the stored one is still the live generation and must not be blanked.
			refreshToken: json.refresh_token || account.refresh_token,
			expiresAt: Date.now() + (json.expires_in ?? 0) * 1000,
			// Null when the response omits the id_token — the token write
			// COALESCE-merges identity, so null preserves the stored claims.
			identity: extractGrokSubscriptionIdentity(json.id_token),
		};
	}

	override prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const prepared = super.prepareHeaders(headers, accessToken, apiKey);
		// The proxy refuses a bare bearer with 426; these identify us as the CLI
		// it expects. Set after super so a client-supplied value cannot survive.
		for (const [name, value] of Object.entries(GROK_CLI_IDENTITY_HEADERS)) {
			prepared.set(name, value);
		}
		return prepared;
	}

	/**
	 * True, but no `getOAuthProvider`: like qwen, the device flow lives in the
	 * HTTP handler layer rather than the registry's OAuth map, and the registry
	 * only consults that map when the method exists.
	 */
	override supportsOAuth(): boolean {
		return true;
	}

	override async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		if (!isGrokUpgradeRequired(response)) {
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: sanitizeGrokResponseHeaders(response.headers),
			});
		}
		// Terminal and one sentence long, so read it whole and answer from the
		// text; nothing is left holding the upstream stream.
		const body = await response.text().catch(() => "");
		const message = describeGrokUpgradeRequired(body);
		log.error(message);
		const headers = sanitizeGrokResponseHeaders(response.headers);
		headers.set("content-type", "application/json");
		return new Response(
			JSON.stringify({
				type: "error",
				error: { type: "api_error", message },
			}),
			{
				status: response.status,
				statusText: response.statusText,
				headers,
			},
		);
	}
}
