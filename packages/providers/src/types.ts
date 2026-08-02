import type { Account, AccountIdentity } from "@clankermux/types";

export interface TokenRefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken: string; // Always required - either new token or existing one
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
	 * Extract tier information from response if available.
	 *
	 * DISPOSABLE-RESPONSE CONTRACT — see {@link Provider.extractUsageInfo}.
	 */
	extractTierInfo?(response: Response): Promise<number | null>;

	/**
	 * Extract usage information from response if available.
	 *
	 * DISPOSABLE-RESPONSE CONTRACT (applies to `extractUsageInfo`,
	 * {@link Provider.extractTierInfo} and {@link Provider.parseUsage} alike):
	 *
	 *   The `Response` handed to this method is DISPOSABLE. The callee MAY
	 *   consume its body, and the CALLER MUST NOT use it afterwards.
	 *
	 * Callers pass a dedicated `clone()` and treat it as spent. Implementations
	 * must therefore read the supplied response DIRECTLY and must NOT clone it
	 * again: a second clone tees the caller's branch in two, and cancelling the
	 * outer branch cannot release the inner one — that inner branch is the leak
	 * this contract removes.
	 *
	 * Because the caller can no longer dispose a body this method has locked, an
	 * implementation that acquires a reader MUST release it on EVERY path,
	 * including `throw` — i.e. `reader.cancel()` in a `finally`, not only on the
	 * happy path.
	 *
	 * Reading `response.headers` remains valid after the body is consumed.
	 */
	extractUsageInfo?(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null>;

	/**
	 * Parse usage information from streaming SSE response if available
	 * This is called for streaming responses to extract usage from final SSE events
	 * Falls back to extractUsageInfo for non-streaming responses
	 *
	 * DISPOSABLE-RESPONSE CONTRACT — see {@link Provider.extractUsageInfo}.
	 */
	parseUsage?(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null>;

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
	/** Optional account identity resolved during code exchange (token claims / profile). */
	identity?: AccountIdentity | null;
}
