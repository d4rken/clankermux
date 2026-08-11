import {
	getEndpointUrl,
	ValidationError,
	validateEndpointUrl,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import {
	convertAnthropicPathToOpenAI,
	convertAnthropicRequestToOpenAI,
	convertOpenAIResponseToAnthropic,
	type OpenAIRequest,
	sanitizeHeaders,
	transformStreamingResponse,
} from "@clankermux/openai-formats";
import type { Account } from "@clankermux/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";

const log = new Logger("OpenAICompatibleProvider");

export class OpenAICompatibleProvider extends BaseProvider {
	name = "openai-compatible";

	canHandle(_path: string): boolean {
		return true;
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		// OpenAI-compatible providers use API keys, not OAuth tokens
		// Store the API key in refresh_token field for consistency
		if (!account.refresh_token) {
			throw new Error(`No API key available for account ${account.name}`);
		}

		// For API key based providers, we don't need to refresh tokens
		// Just return the existing API key as both access and refresh token
		return {
			accessToken: account.refresh_token,
			expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year from now
			refreshToken: "", // Empty string prevents DB update for API key accounts
		};
	}

	buildUrl(path: string, query: string, account?: Account): string {
		// Get endpoint URL with validation
		let endpoint: string;
		try {
			endpoint = account ? getEndpointUrl(account) : "https://api.openai.com";
			// Validate the endpoint
			endpoint = validateEndpointUrl(endpoint, "endpoint");
		} catch (error) {
			log.error(
				`Invalid endpoint for account ${account?.name || "unknown"}, using default: ${error instanceof Error ? error.message : String(error)}`,
			);
			endpoint = "https://api.openai.com";
		}

		// Store endpoint for provider-specific transformations (e.g., Alibaba caching)
		this.currentEndpoint = endpoint;

		// Convert Anthropic paths to OpenAI-compatible paths
		// Anthropic: /v1/messages → OpenAI: /v1/chat/completions
		let openaiPath = convertAnthropicPathToOpenAI(path);
		if (endpoint.endsWith("/v1") && openaiPath.startsWith("/v1/")) {
			openaiPath = openaiPath.replace(/^\/v1/, "");
		}

		return `${endpoint}${openaiPath}${query}`;
	}

	prepareHeaders(
		headers: Headers,
		_accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);

		// SECURITY: Remove client's authorization header when we have provider credentials
		// to prevent credential leakage. If no credentials provided (passthrough mode),
		// preserve client's authorization for direct API access.
		// Use explicit undefined checks to handle empty strings correctly.
		if (_accessToken !== undefined || apiKey !== undefined) {
			newHeaders.delete("authorization");
		}

		// OpenAI uses Bearer token authentication with API key
		if (apiKey) {
			newHeaders.set("Authorization", `Bearer ${apiKey}`);
		} else if (_accessToken) {
			newHeaders.set("Authorization", `Bearer ${_accessToken}`);
		}

		// Remove host header
		newHeaders.delete("host");

		// Remove Anthropic-specific headers
		newHeaders.delete("anthropic-version");
		newHeaders.delete("anthropic-dangerous-direct-browser-access");

		return newHeaders;
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// OpenAI-compatible providers (OpenRouter, etc.) should never be marked as rate-limited
		// by our load balancer. They handle their own rate limiting and return errors inline.
		// We always return isRateLimited: false to prevent the account from being marked unavailable.

		// Extract rate limit info headers if present (for informational purposes only)
		const resetHeader = response.headers.get("x-ratelimit-reset-requests");
		const remainingHeader = response.headers.get(
			"x-ratelimit-remaining-requests",
		);

		const resetTime = resetHeader ? Number(resetHeader) * 1000 : undefined;
		const remaining = remainingHeader ? Number(remainingHeader) : undefined;

		// Always return isRateLimited: false - do not block OpenAI-compatible accounts
		return {
			isRateLimited: false,
			resetTime,
			statusHeader: "allowed",
			remaining,
		};
	}

	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		// Convert OpenAI response format back to Anthropic format
		const contentType = response.headers.get("content-type");

		if (contentType?.includes("application/json")) {
			// Consume the ORIGINAL body rather than a clone. This is NOT an
			// extractor: it builds an INDEPENDENT Response from the parsed JSON and
			// never forwards `response` itself, so a clone teed the body and then
			// abandoned the original branch with nobody able to release it.
			//
			// The body is read ONCE as bytes so the conversion-failure path can
			// still forward the upstream payload verbatim (the "surface the real
			// upstream error" contract) — falling through to `response.body` would
			// forward an empty body once the original has been consumed, and
			// re-encoding decoded text would not be byte-identical (BOM, invalid
			// UTF-8) under a preserved Content-Length. An empty capture falls back
			// to a null body: `new Response("", ...)` throws for null-body statuses
			// like a 204, while null is valid for every status.
			let rawBytes: ArrayBuffer | null = null;
			try {
				rawBytes = await response.arrayBuffer();
				const anthropicData = convertOpenAIResponseToAnthropic(
					JSON.parse(new TextDecoder().decode(rawBytes)),
				);

				return new Response(JSON.stringify(anthropicData), {
					status: response.status,
					statusText: response.statusText,
					headers: sanitizeHeaders(response.headers),
				});
			} catch (error) {
				log.error(
					"Failed to convert OpenAI response to Anthropic format:",
					error,
				);
				// If conversion fails, return the original bytes unchanged.
				if (rawBytes !== null) {
					return new Response(rawBytes.byteLength > 0 ? rawBytes : null, {
						status: response.status,
						statusText: response.statusText,
						headers: sanitizeHeaders(response.headers),
					});
				}
				// The body itself could not be read — nothing left to forward.
			}
		}

		// For streaming responses, we need to transform the SSE stream
		if (contentType?.includes("text/event-stream")) {
			return transformStreamingResponse(response);
		}

		// For non-JSON responses, return as-is with sanitized headers
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: sanitizeHeaders(response.headers),
		});
	}

	/**
	 * Transform request body from Anthropic format to OpenAI format
	 */
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		const contentType = request.headers.get("content-type");

		if (!contentType?.includes("application/json")) {
			return request; // Not a JSON request, return as-is
		}

		try {
			const body = await request.json();
			const effectiveAccount = this.beforeConvert(body, account);
			const openaiBody = convertAnthropicRequestToOpenAI(
				body,
				effectiveAccount,
			);
			this.afterConvert(openaiBody);

			// Inject enable_thinking for reasoning models on DashScope
			this.injectDashScopeReasoning(openaiBody, body);

			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.delete("content-length");

			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: JSON.stringify(openaiBody),
			});
		} catch (error) {
			if (error instanceof ValidationError) {
				throw error;
			}
			log.error(
				"Failed to transform Anthropic request to OpenAI format:",
				error,
			);
			return request; // Return original request if transformation fails
		}
	}

	/**
	 * Check if this provider supports OAuth
	 */
	supportsOAuth(): boolean {
		return false; // OpenAI-compatible providers use API keys
	}

	/**
	 * Check if this provider supports usage tracking
	 */
	supportsUsageTracking(): boolean {
		return true; // OpenAI-compatible providers support usage tracking via response body
	}

	/**
	 * Hook called after converting Anthropic request to OpenAI format.
	 * Override to inject provider-specific fields (e.g., cache_control, vision flags).
	 */
	protected afterConvert(body: OpenAIRequest): void {
		// Inject cache_control for Alibaba/DashScope endpoints
		if (this.shouldInjectAlibabaCaching()) {
			this.injectAlibabaCaching(body);
		}
	}

	/**
	 * Hook called before converting Anthropic request to OpenAI format.
	 * Override to adjust the account (e.g., inject default model mappings).
	 * Returns the account to use for model mapping.
	 */
	protected beforeConvert(
		_body: Record<string, unknown>,
		account?: Account,
	): Account | undefined {
		// Store model for provider-specific transformations (e.g., Alibaba caching for Qwen)
		if (_body.model && typeof _body.model === "string") {
			this.currentModel = _body.model;
		}
		return account;
	}

	/**
	 * Check if we should inject Alibaba-style prompt caching.
	 * Only triggered for Qwen models on DashScope or OpenCode Go endpoints.
	 * These endpoints support Alibaba's cacheControl format for Qwen models only.
	 */
	private shouldInjectAlibabaCaching(): boolean {
		// Check if current request is for a DashScope or OpenCode Go endpoint
		const endpoint = this.currentEndpoint?.toLowerCase() || "";
		const isDashScopeEndpoint =
			endpoint.includes("dashscope.aliyuncs.com") ||
			endpoint.includes("opencode.ai/zen/go");

		if (!isDashScopeEndpoint) return false;

		// Only apply caching for Qwen models (qwen3.5-plus, qwen3.6-plus, etc.)
		// Other models on these endpoints use different SDKs (openai-compatible, anthropic)
		const model = this.currentModel?.toLowerCase() || "";
		return model.includes("qwen");
	}

	/**
	 * Inject Alibaba-style cache_control on system and final messages.
	 * Uses OpenAI-compatible format (snake_case) since DashScope endpoint is /compatible-mode/v1.
	 * Mirrors opencode's applyCaching logic for prompt caching.
	 */
	private injectAlibabaCaching(body: OpenAIRequest): void {
		if (!body.messages || body.messages.length === 0) return;

		// Find system messages (first 2) and final messages (last 2)
		const systemMessages = body.messages
			.filter((msg) => msg.role === "system")
			.slice(0, 2);

		const nonSystemMessages = body.messages.filter(
			(msg) => msg.role !== "system",
		);
		const finalMessages = nonSystemMessages.slice(-2);

		// Apply caching to these messages
		const messagesToCache = [...systemMessages, ...finalMessages];

		for (const msg of messagesToCache) {
			// DashScope OpenAI-compatible endpoint expects snake_case cache_control
			if (Array.isArray(msg.content)) {
				// Find last valid content part
				const lastPart = msg.content[msg.content.length - 1];
				if (
					lastPart &&
					typeof lastPart === "object" &&
					lastPart.type === "text"
				) {
					// Inject cache_control (snake_case for OpenAI-compatible API)
					lastPart.cache_control = { type: "ephemeral" };
				}
			} else if (typeof msg.content === "string" && msg.content.length > 0) {
				// Convert string content to array with cache_control
				msg.content = [
					{
						type: "text",
						text: msg.content,
						cache_control: { type: "ephemeral" },
					},
				];
			}
		}

		log.debug(
			`Injected cache_control for ${messagesToCache.length} messages on DashScope endpoint`,
		);
	}

	/**
	 * Inject enable_thinking for reasoning models on DashScope.
	 * DashScope's OpenAI-compatible API requires this flag to return reasoning_content.
	 * Without it, reasoning models like Qwen-Plus, Qwen3, qwq, etc. never output thinking tokens.
	 */
	private injectDashScopeReasoning(
		openaiBody: OpenAIRequest,
		anthropicBody: Record<string, unknown>,
	): void {
		// Only apply for DashScope endpoints
		const endpoint = this.currentEndpoint?.toLowerCase() || "";
		if (
			!endpoint.includes("dashscope.aliyuncs.com") &&
			!endpoint.includes("opencode.ai/zen/go")
		)
			return;

		// Check if model is a reasoning model (has thinking/reasoning capabilities)
		const modelId = this.currentModel?.toLowerCase() || "";
		const thinking = anthropicBody.thinking as { type?: string } | undefined;
		const isReasoningModel =
			modelId.includes("qwen") ||
			modelId.includes("qwq") ||
			modelId.includes("deepseek-r1") ||
			// Also check if anthropic request indicates thinking
			thinking?.type === "enabled";

		// Skip if it's kimi-k2-thinking (returns reasoning_content by default)
		if (modelId.includes("kimi-k2-thinking")) return;

		// Inject enable_thinking flag
		if (isReasoningModel) {
			(
				openaiBody as OpenAIRequest & { enable_thinking?: boolean }
			).enable_thinking = true;
			log.debug(
				`Injected enable_thinking for DashScope reasoning model: ${modelId}`,
			);
		}
	}

	/**
	 * Store current endpoint for provider-specific transformations
	 */
	private currentEndpoint?: string;

	/**
	 * Store current model for provider-specific transformations (e.g., Qwen caching)
	 */
	private currentModel?: string;
}
