import {
	ACCOUNT_WIDE_HARD_STATUSES,
	mapModelName,
	TIME_CONSTANTS,
} from "@clankermux/core";
import { sanitizeProxyHeaders } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
import { BaseProvider } from "../base";
import type { RateLimitInfo, TokenRefreshResult } from "../types";
import { transformRequestBodyModel } from "../utils/model-mapping";

// Configuration interface for Anthropic-compatible providers
export interface AnthropicCompatibleConfig {
	name?: string;
	baseUrl?: string;
	authHeader?: string; // "x-api-key", "authorization", etc.
	authType?: "bearer" | "direct"; // Whether to add "Bearer " prefix for authorization header
	modelMappings?: Record<string, string>; // Model name mappings
	supportsStreaming?: boolean; // Whether this provider supports streaming
	defaultModel?: string; // Default model to use
}

// Default configuration
const DEFAULT_CONFIG: AnthropicCompatibleConfig = {
	name: "anthropic-compatible",
	baseUrl: "https://api.anthropic.com",
	authHeader: "x-api-key",
	authType: "direct",
	supportsStreaming: true,
};

// Hard rate limit statuses (similar to Anthropic) — the shared vocabulary.
const HARD_LIMIT_STATUSES = ACCOUNT_WIDE_HARD_STATUSES;

const log = new Logger("BaseAnthropicCompatibleProvider");

export abstract class BaseAnthropicCompatibleProvider extends BaseProvider {
	protected config: AnthropicCompatibleConfig;
	name: string; // Make name concrete instead of abstract

	constructor(config: Partial<AnthropicCompatibleConfig> = {}) {
		super();
		this.config = { ...DEFAULT_CONFIG, ...config };
		// Set name from config, ensuring we always have a valid name
		const providerName =
			this.config.name || DEFAULT_CONFIG.name || "base-anthropic-compatible";
		this.name = providerName;
		if (!this.config.name) {
			this.config.name = providerName;
		}
	}

	/**
	 * Get the endpoint URL for this provider
	 * Must be implemented by each provider
	 */
	abstract getEndpoint(): string;

	/**
	 * Get the authentication header name for this provider
	 * Defaults to config.authHeader but can be overridden
	 */
	getAuthHeader(): string {
		return this.config.authHeader || "x-api-key";
	}

	/**
	 * Get the authentication type for this provider
	 * Defaults to config.authType but can be overridden
	 */
	getAuthType(): "bearer" | "direct" {
		const authType = this.config.authType;
		if (authType !== "bearer" && authType !== "direct") {
			return "direct"; // sensible default
		}
		return authType;
	}

	canHandle(_path: string): boolean {
		return true;
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		// Anthropic-compatible providers use API keys
		// Prioritize api_key field, but maintain fallback to refresh_token for backward compatibility
		let apiKey: string | undefined;
		if (account.api_key) {
			apiKey = account.api_key;
		} else if (account.refresh_token) {
			apiKey = account.refresh_token;
		}

		if (!apiKey) {
			throw new Error(`No API key available for account ${account.name}`);
		}

		log.info(`Using API key for ${this.name} account ${account.name}`);

		return {
			accessToken: apiKey,
			expiresAt: Date.now() + TIME_CONSTANTS.API_KEY_TOKEN_EXPIRY_MS,
			refreshToken: "", // Empty string prevents DB update for API key accounts
		};
	}

	buildUrl(path: string, query: string, _account?: Account): string {
		const baseUrl = this.getEndpoint().replace(/\/$/, ""); // Remove trailing slash
		return `${baseUrl}${path}${query}`;
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);

		// SECURITY: Remove client's authorization headers when we have provider credentials
		// to prevent credential leakage. If no credentials provided (passthrough mode),
		// preserve client's authorization for direct API access.
		// Use explicit undefined checks to handle empty strings correctly.
		if (accessToken !== undefined || apiKey !== undefined) {
			newHeaders.delete("authorization");
			newHeaders.delete("x-api-key");

			// Set authentication header for API key
			const token = accessToken || apiKey;
			if (token) {
				const headerName = this.getAuthHeader();
				const authType = this.getAuthType();

				if (headerName === "authorization" && authType === "bearer") {
					newHeaders.set(headerName, `Bearer ${token}`);
				} else {
					newHeaders.set(headerName, token);
				}
			}
		}

		// Remove host header
		newHeaders.delete("host");

		// Remove compression headers to avoid decompression issues
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");

		return newHeaders;
	}

	/**
	 * Transform request body to handle model mapping
	 */
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		if (!this.config.supportsStreaming) {
			return request;
		}

		// Use the shared utility for model mapping
		return transformRequestBodyModel(request, account, (model, acc) => {
			if (acc) {
				// Use core mapModelName which handles arrays, fallbacks, env overrides, and defaults
				return mapModelName(model, acc);
			}

			// Fall back to static config mappings for backward compatibility
			if (this.config.modelMappings?.[model]) {
				return this.config.modelMappings[model];
			}

			return model;
		});
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// Check for unified rate limit headers (Anthropic-style)
		const statusHeader = response.headers.get(
			"anthropic-ratelimit-unified-status",
		);
		const resetHeader = response.headers.get(
			"anthropic-ratelimit-unified-reset",
		);
		const remainingHeader = response.headers.get(
			"anthropic-ratelimit-unified-remaining",
		);

		if (statusHeader || resetHeader) {
			const resetTime = resetHeader ? Number(resetHeader) * 1000 : undefined;
			const remaining = remainingHeader ? Number(remainingHeader) : undefined;

			const isRateLimited =
				HARD_LIMIT_STATUSES.has(statusHeader || "") || response.status === 429;

			return {
				isRateLimited,
				resetTime,
				statusHeader: statusHeader || undefined,
				remaining,
			};
		}

		// Fall back to traditional 429 check
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		const retryAfter = response.headers.get("retry-after");
		let resetTime: number | undefined;

		if (retryAfter) {
			const seconds = Number(retryAfter);
			if (!Number.isNaN(seconds)) {
				resetTime = Date.now() + seconds * 1000;
			} else {
				resetTime = new Date(retryAfter).getTime();
			}
		}

		return { isRateLimited: true, resetTime };
	}

	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		// Sanitize headers by removing hop-by-hop headers
		const headers = sanitizeProxyHeaders(response.headers);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	/**
	 * Check if a response is a streaming response
	 */
	isStreamingResponse(response: Response): boolean {
		if (!this.config.supportsStreaming) return false;

		const contentType = response.headers.get("content-type") ?? "";
		return (
			contentType.includes("text/event-stream") ||
			contentType.includes("stream")
		);
	}

	/**
	 * Check if this provider supports OAuth
	 */
	supportsOAuth(): boolean {
		return false;
	}
}
