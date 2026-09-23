import { OAuthError } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type {
	OAuthProvider,
	OAuthProviderConfig,
	PKCEChallenge,
	TokenResult,
} from "../../types";
import {
	CODEX_CLIENT_ID,
	CODEX_OAUTH_SCOPES,
	codexAuthorizeUrlParams,
	codexLoginTokenHeaders,
} from "./client-identity";
import { extractCodexIdentity } from "./identity";

const oauthLog = new Logger("CodexOAuthProvider");

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";

export class CodexOAuthProvider implements OAuthProvider {
	getOAuthConfig(): OAuthProviderConfig {
		return {
			authorizeUrl: AUTHORIZE_URL,
			tokenUrl: TOKEN_URL,
			clientId: CODEX_CLIENT_ID,
			scopes: [...CODEX_OAUTH_SCOPES],
			redirectUri: REDIRECT_URI,
		};
	}

	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string {
		const params = codexAuthorizeUrlParams({
			clientId: config.clientId,
			redirectUri: config.redirectUri,
			scopes: config.scopes,
			codeChallenge: pkce.challenge,
			state: this.generateSecureRandomState(),
		}).join("&");

		return `${config.authorizeUrl}?${params}`;
	}

	async exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult> {
		oauthLog.debug("Exchanging authorization code for tokens");

		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: config.redirectUri,
			client_id: config.clientId,
			code_verifier: verifier,
		});

		const response = await fetch(config.tokenUrl, {
			method: "POST",
			headers: codexLoginTokenHeaders(),
			body: body.toString(),
		});

		oauthLog.debug(
			`Token exchange response: ${response.status} ${response.statusText}`,
		);

		if (!response.ok) {
			let errorDetails: {
				error?: string;
				error_description?: string;
			} | null = null;
			try {
				errorDetails = await response.json();
			} catch {
				// ignore parse failure
			}

			const errorMessage =
				errorDetails?.error_description ||
				errorDetails?.error ||
				response.statusText ||
				"OAuth token exchange failed";

			throw new OAuthError(errorMessage, "codex", errorDetails?.error);
		}

		const json = (await response.json()) as {
			refresh_token: string;
			access_token: string;
			expires_in: number;
			id_token?: string;
		};

		const identity = extractCodexIdentity(
			json.access_token,
			json.id_token ?? null,
		);

		return {
			refreshToken: json.refresh_token,
			accessToken: json.access_token,
			expiresAt: Date.now() + json.expires_in * 1000,
			identity,
		};
	}

	private generateSecureRandomState(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
	}
}
