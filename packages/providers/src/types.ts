import type { Account, AccountIdentity } from "@clankermux/types";

export interface TokenRefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken: string; // Always required - either new token or existing one
	/**
	 * When `refreshToken` itself stops being accepted, in epoch ms.
	 *
	 * Distinct from `expiresAt`, which is the short-lived access token. Rotating
	 * the refresh token does not push this out: Anthropic counts it down toward a
	 * fixed date set at the original authorization, so a continuously-refreshed
	 * account still reaches it and needs a human re-auth.
	 *
	 * `null`/absent means the provider does not report a deadline (only Anthropic
	 * sends `refresh_token_expires_in`). Absent is "unknown", never "far away".
	 */
	refreshTokenExpiresAt?: number | null;
	/** Optional account identity resolved during refresh (token claims / profile). */
	identity?: AccountIdentity | null;
}

export interface RateLimitInfo {
	isRateLimited: boolean;
	resetTime?: number;
	statusHeader?: string;
	remaining?: number;
}

export interface Provider {
	name: string;

	/**
	 * Check if this provider can handle the given request path
	 */
	canHandle(path: string): boolean;

	/**
	 * Refresh the access token for an account
	 */
	refreshToken(account: Account, clientId: string): Promise<TokenRefreshResult>;

	/**
	 * Build the target URL for the provider
	 */
	buildUrl(path: string, query: string, account?: Account): string;

	/**
	 * Optional: Pre-process the request before building URL
	 * This allows providers to extract information from the request body
	 * before buildUrl is called (e.g., for including model in URL path)
	 */
	prepareRequest?(
		request: Request,
		requestBodyBuffer: ArrayBuffer | null,
		account: Account,
	): void;

	/**
	 * Prepare headers for the provider request
	 * @param headers - Original request headers
	 * @param accessToken - OAuth access token (for Bearer authentication)
	 * @param apiKey - API key (provider-specific header)
	 */
	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers;

	/**
	 * Parse rate limit information from response
	 */
	parseRateLimit(response: Response): RateLimitInfo;

	/**
	 * Process the response before returning to client
	 */
	processResponse(
		response: Response,
		account: Account | null,
		requestHeaders?: Headers,
	): Promise<Response>;

	/**
	 * Transform the request body before sending to the provider
	 */
	transformRequestBody?(request: Request, account?: Account): Promise<Request>;

	/**
	 * Check if the response is a streaming response
	 */
	isStreamingResponse?(response: Response): boolean;
}

// OAuth-specific types
export interface OAuthProviderConfig {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	redirectUri: string;
	mode?: string;
}

export interface OAuthProvider {
	getOAuthConfig(mode?: string, redirectUri?: string): OAuthProviderConfig;
	exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult>;
	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string;
}

export interface PKCEChallenge {
	verifier: string;
	challenge: string;
}

export interface TokenResult {
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
	/** See {@link TokenRefreshResult.refreshTokenExpiresAt}. */
	refreshTokenExpiresAt?: number | null;
	/** Optional account identity resolved during code exchange (token claims / profile). */
	identity?: AccountIdentity | null;
}
