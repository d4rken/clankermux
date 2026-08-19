import {
	ACCOUNT_WIDE_HARD_STATUSES,
	isInvalidGrantMessage,
	isReauthDueSoon,
	mapModelName,
	OAuthRefreshTokenError,
	SOFT_WARNING_STATUSES as SHARED_SOFT_WARNING_STATUSES,
	validateEndpointUrl,
} from "@clankermux/core";
import { sanitizeProxyHeaders } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";
import { transformRequestBodyModel } from "../../utils/model-mapping";
import { extractAnthropicIdentity } from "./identity";
import { resolveRefreshTokenExpiresAt } from "./refresh-token-expiry";

/**
 * Hard rate limit statuses that should block account usage.
 *
 * These are the values Anthropic emits in the
 * `anthropic-ratelimit-unified-status` header that indicate a HARD,
 * account-level limit (as opposed to a soft/warning status — see
 * {@link SOFT_WARNING_STATUSES} — or the normal `"allowed"`).
 *
 * Note on `"rate_limited"`: NEVER observed in production (0 of 1,145 measured
 * 429s — see the rate-limiting skill's 429-signals reference). What Anthropic
 * actually sends: a hard 429 carries `"rejected"` WITH a unified reset; a
 * per-IP burst carries no unified headers at all. The hard-status vocabulary
 * is kept for completeness, but `"rejected"` is deliberately NOT in it —
 * a `"rejected"` summary can describe a CLAIM-SCOPED rejection (e.g. `7d_oi`)
 * on an account whose account-wide windows still have headroom, so it must
 * never be read as an account-wide verdict by itself (see
 * `@clankermux/core` `unified-claim-headers.ts` for the per-claim parsing).
 *
 * Alias of `ACCOUNT_WIDE_HARD_STATUSES` in `@clankermux/core`, which is the
 * single source of truth for the whole repo; the name is kept here because both
 * {@link AnthropicProvider.parseRateLimit} and the exported
 * {@link isAnthropicHardLimitStatus} predicate read from it. Comparison is
 * exact and case-sensitive, matching the raw header value.
 */
export const HARD_LIMIT_STATUSES: ReadonlySet<string> =
	ACCOUNT_WIDE_HARD_STATUSES;

/**
 * Soft / warning statuses that must NOT block account usage and must NOT be
 * treated as hard limits. Exposed for symmetry with {@link HARD_LIMIT_STATUSES};
 * the normal non-limited value `"allowed"` is not listed here.
 */
export const SOFT_WARNING_STATUSES: ReadonlySet<string> =
	SHARED_SOFT_WARNING_STATUSES;

/**
 * Returns `true` iff the response's `anthropic-ratelimit-unified-status` header
 * value indicates a HARD, account-level rate limit (see
 * {@link HARD_LIMIT_STATUSES}).
 *
 * Returns `false` when the header is absent, empty, a soft/warning status, the
 * normal `"allowed"` value, or any other unrecognized value. Comparison is
 * exact and case-sensitive, matching how `parseRateLimit` compares the header.
 *
 * This is the shared predicate the 429 classifier uses to tell a transient
 * per-IP burst 429 (no hard status) apart from a real hard account limit.
 */
export function isAnthropicHardLimitStatus(response: Response): boolean {
	const statusHeader = response.headers.get(
		"anthropic-ratelimit-unified-status",
	);
	return statusHeader !== null && HARD_LIMIT_STATUSES.has(statusHeader);
}

/**
 * The value Anthropic sets on `anthropic-ratelimit-unified-overage-disabled-reason`
 * when an account's credits / overage allowance are exhausted.
 */
export const OUT_OF_CREDITS_REASON = "out_of_credits";

/**
 * Returns `true` iff the response is an out-of-credits depletion signal:
 * `anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits`.
 *
 * Such a 429 carries `x-should-retry: true` and NO reset header, so without
 * special handling it falls into the short no-reset probe-cooldown loop and
 * storms the depleted account (issue #261). Comparison is exact and
 * case-sensitive, matching {@link isAnthropicHardLimitStatus}.
 */
export function isAnthropicOutOfCredits(response: Response): boolean {
	return (
		response.headers.get(
			"anthropic-ratelimit-unified-overage-disabled-reason",
		) === OUT_OF_CREDITS_REASON
	);
}

// Maximum allowed reset time: 24 hours from now.
// Prevents a pathological Retry-After value from keeping an account
// cooled down for days (or effectively forever with "Infinity").
const MAX_RESET_MS = 24 * 60 * 60 * 1000;

/**
 * Clamp a candidate reset-time epoch-ms value.
 *
 * Returns:
 *   - `undefined` if the input is NaN, not finite, or <= now (already in the past).
 *   - `Math.min(input, now + MAX_RESET_MS)` otherwise — capped at 24 h from now.
 */
function clampResetTime(candidateMs: number, now: number): number | undefined {
	if (!Number.isFinite(candidateMs) || candidateMs <= now) {
		return undefined;
	}
	return Math.min(candidateMs, now + MAX_RESET_MS);
}

const log = new Logger("AnthropicProvider");

export class AnthropicProvider extends BaseProvider {
	name = "anthropic";

	canHandle(_path: string): boolean {
		// Handle all paths for now since this is Anthropic-specific
		return true;
	}

	async refreshToken(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult> {
		// Debug: Log account classification
		log.debug(`Account classification for ${account.name}:`, {
			hasApiKey: !!account.api_key,
			hasAccessToken: !!account.access_token,
			hasRefreshToken: !!account.refresh_token,
			provider: account.provider,
		});

		// Determine account type based on token presence (same logic as re-authentication)
		const isConsoleMode = !!account.api_key;
		const accountType = isConsoleMode ? "Console (API key)" : "CLI (OAuth)";
		log.debug(`Account type: ${accountType}`);

		if (isConsoleMode) {
			// For console API key accounts, return the API key directly
			if (!account.api_key) {
				throw new Error(
					`No API key available for console account ${account.name}`,
				);
			}

			log.info(`Using API key for console account ${account.name}`);

			return {
				accessToken: account.api_key,
				expiresAt: Date.now() + 24 * 60 * 60 * 1000, // API keys don't expire, but set a reasonable time
				refreshToken: "", // Empty string prevents DB update for console mode
			};
		}

		// For OAuth accounts (claude-oauth), use the OAuth refresh flow
		if (!account.refresh_token) {
			throw new Error(`No refresh token available for account ${account.name}`);
		}

		log.info(
			`Refreshing OAuth token for account ${account.name} with client ID: ${clientId}`,
		);

		// Debug: Log the refresh attempt details
		log.debug(`Token refresh attempt for ${account.name}:`, {
			refreshTokenPreview: account.refresh_token
				? `${account.refresh_token.substring(0, 30)}...`
				: "null/undefined",
			clientId,
			refreshTokenLength: account.refresh_token?.length || 0,
		});

		const requestBody = {
			grant_type: "refresh_token",
			refresh_token: account.refresh_token,
			client_id: clientId,
		};

		// NOTE: do NOT log `requestBody` — it contains the full plaintext
		// refresh_token, which would leak a live credential into the logs
		// (journald is persistent and group-readable). The truncated
		// `refreshTokenPreview` logged above is the only debug detail we keep.

		const response = await fetch("https://platform.claude.com/v1/oauth/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
		});

		log.debug(`Response status: ${response.status} ${response.statusText}`, {
			headers: Object.fromEntries(response.headers.entries()),
		});

		if (!response.ok) {
			let errorMessage = response.statusText;
			let errorData: unknown = null;
			let responseText = "";
			try {
				responseText = await response.text();
				log.debug("Error response body:", responseText);
				errorData = JSON.parse(responseText);
				const errorObj = errorData as {
					error?: string;
					error_description?: string;
					message?: string;
				};
				errorMessage =
					errorObj.error_description ||
					errorObj.error ||
					errorObj.message ||
					errorMessage;

				// Log specific OAuth authentication errors
				if (response.status === 401 && typeof errorMessage === "string") {
					if (
						errorMessage.includes(
							"OAuth authentication is currently not supported",
						)
					) {
						log.error(
							`OAuth authentication not supported for ${account.name} - the refresh token may be revoked or invalid. Account may need re-authentication.`,
						);
					} else if (
						errorMessage.includes("invalid_grant") ||
						errorMessage.includes("invalid_refresh_token")
					) {
						log.error(
							`Refresh token invalid or expired for ${account.name} - account needs re-authentication`,
						);
					}
				}
			} catch {
				// If we can't parse the error response, use the status text
				log.error(
					`Failed to parse token refresh error response for ${account.name}: ${response.statusText}`,
				);
			}
			log.error(
				`Token refresh failed for ${account.name}: Status ${response.status}, Error: ${errorMessage}`,
				errorData,
			);
			const failureMessage = `Failed to refresh token for account ${account.name}: ${errorMessage}`;
			// A revoked/invalid refresh token is terminal (not retryable) and is
			// reported with varying status codes (Anthropic returned HTTP 400 for
			// `invalid_grant`, not 401). Detect it from the parsed message *or* the
			// raw body (non-JSON bodies never reach `errorMessage`) and throw a typed
			// error so callers can pause the account for re-authentication instead of
			// treating it as a transient refresh failure.
			if (
				isInvalidGrantMessage(errorMessage) ||
				isInvalidGrantMessage(responseText)
			) {
				throw new OAuthRefreshTokenError(account.id, failureMessage);
			}
			throw new Error(failureMessage);
		}

		const json = (await response.json()) as {
			access_token: string;
			expires_in: number;
			refresh_token?: string;
			refresh_token_expires_in?: unknown;
			account?: unknown;
			organization?: unknown;
		};

		const identity = extractAnthropicIdentity(json);

		// Only meaningful alongside a rotated token: the deadline describes the
		// refresh token this response issued, and a response that reused the old
		// one says nothing about how long that older token still has.
		const refreshTokenExpiresAt = json.refresh_token
			? resolveRefreshTokenExpiresAt(json)
			: null;

		log.debug(`token response for ${account.name}:`, {
			expiresIn: json.expires_in,
			hasRefreshToken: !!json.refresh_token,
			refreshTokenExpiresAt,
			responseKeys: Object.keys(json),
		});
		// Ensure we always return a refresh token
		const refreshToken = json.refresh_token || account.refresh_token;

		if (!json.refresh_token) {
			log.warn(
				`Anthropic refresh endpoint did not return a refresh_token for ${account.name} - continuing with previous one`,
			);
		} else {
			log.info(
				`Token refresh successful for ${account.name}, new refresh token provided`,
			);
		}

		if (isReauthDueSoon(refreshTokenExpiresAt)) {
			// Rotation does not push this deadline out, so continuing to refresh
			// will not save the account — only a human re-auth will. Warn on every
			// refresh through the final week rather than once, because a single
			// line in a busy journal is a line nobody reads.
			log.warn(
				`Account ${account.name} needs re-authentication by ${new Date(
					refreshTokenExpiresAt as number,
				).toISOString()} — its OAuth refresh token expires then and token rotation does not extend it. The account will auto-pause mid-rotation if the deadline passes.`,
			);
		}

		return {
			accessToken: json.access_token,
			expiresAt: Date.now() + json.expires_in * 1000,
			refreshToken: refreshToken,
			refreshTokenExpiresAt,
			identity,
		};
	}

	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		return transformRequestBodyModel(request, account, (model, acc) => {
			if (acc) {
				return mapModelName(model, acc);
			}
			return model;
		});
	}

	buildUrl(path: string, query: string, account?: Account): string {
		const defaultEndpoint = "https://api.anthropic.com";

		if (account?.custom_endpoint) {
			try {
				// Validate and sanitize the custom endpoint
				const validatedEndpoint = validateEndpointUrl(
					account.custom_endpoint,
					"custom_endpoint",
				);
				return `${validatedEndpoint}${path}${query}`;
			} catch (error) {
				log.warn(
					`Invalid custom endpoint for account ${account.name}: ${account.custom_endpoint}. Using default.`,
					error,
				);
				return `${defaultEndpoint}${path}${query}`;
			}
		}

		return `${defaultEndpoint}${path}${query}`;
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
		}

		// Set authentication header
		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
			// Add required OAuth beta header for OAuth accounts
			// This is needed when clients (like Claude Code with API key auth) don't include it
			const betaHeader = newHeaders.get("anthropic-beta");
			if (betaHeader) {
				// Header exists, check if oauth value is already present
				if (!betaHeader.includes("oauth-2025-04-20")) {
					newHeaders.set("anthropic-beta", `${betaHeader},oauth-2025-04-20`);
				}
			} else {
				// Header doesn't exist, create it
				newHeaders.set("anthropic-beta", "oauth-2025-04-20");
			}
		} else if (apiKey) {
			newHeaders.set("x-api-key", apiKey);
		}

		// Remove host header
		newHeaders.delete("host");

		return newHeaders;
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// Check for unified rate limit headers
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
			const now = Date.now();
			const remaining = remainingHeader ? Number(remainingHeader) : undefined;

			// Only mark as rate limited for hard limit statuses, 429, or 529 (overloaded).
			// A 529 is an overload even when the unified-status header says "allowed" —
			// the overload condition takes precedence over the header value.
			const isRateLimited =
				HARD_LIMIT_STATUSES.has(statusHeader || "") ||
				response.status === 429 ||
				response.status === 529;

			// For 529 with a unified-reset header: clamp the reset time.
			// If clamping rejects the value (past/NaN/infinite), fall through
			// to the 529 block below to try Retry-After and x-ratelimit-reset.
			if (response.status === 529 && resetHeader) {
				const clamped = clampResetTime(Number(resetHeader) * 1000, now);
				if (clamped === undefined) {
					// Fall through to the 529 block for better header candidates.
					// (handled below)
				} else {
					return {
						isRateLimited,
						resetTime: clamped,
						statusHeader: statusHeader || undefined,
						remaining,
					};
				}
			} else if (response.status !== 529) {
				// 200s keep the raw header value (window-anchor semantics — the
				// auto-refresh scheduler reads the persisted reset as the account's
				// 5h window boundary). 429 resets are clamped like the 529 branch:
				// on a claim-scoped rejection (`7d_oi`) the summary reset is the
				// SCOPED claim's — observed 4.5 days out — and unclamped it became
				// an account-wide deadline/anchor.
				const rawResetMs = resetHeader ? Number(resetHeader) * 1000 : undefined;
				const resetTime =
					rawResetMs !== undefined && response.status === 429
						? clampResetTime(rawResetMs, now)
						: rawResetMs;
				return {
					isRateLimited,
					resetTime,
					statusHeader: statusHeader || undefined,
					remaining,
				};
			}
			// 529 with no usable resetHeader — fall through to 529 block below.
		}

		// Handle 529 (overloaded_error) — try Retry-After, then x-ratelimit-reset
		if (response.status === 529) {
			const now = Date.now();
			const retryAfterHeader = response.headers.get("retry-after");
			if (retryAfterHeader) {
				const parsed = Number(retryAfterHeader);
				if (Number.isFinite(parsed) && parsed > 0) {
					// Positive finite number → treat as delta-seconds
					const clamped = clampResetTime(now + parsed * 1000, now);
					if (clamped !== undefined) {
						return {
							isRateLimited: true,
							resetTime: clamped,
							statusHeader: undefined,
							remaining: undefined,
						};
					}
				}
				// Try HTTP-date format
				const dateMs = new Date(retryAfterHeader).getTime();
				const clampedDate = clampResetTime(dateMs, now);
				if (clampedDate !== undefined) {
					return {
						isRateLimited: true,
						resetTime: clampedDate,
						statusHeader: undefined,
						remaining: undefined,
					};
				}
			}

			// Fall back to x-ratelimit-reset (unix epoch seconds → ms)
			const rateLimitReset = response.headers.get("x-ratelimit-reset");
			if (rateLimitReset) {
				const resetMs = parseInt(rateLimitReset, 10) * 1000;
				const clamped = clampResetTime(resetMs, now);
				if (clamped !== undefined) {
					return {
						isRateLimited: true,
						resetTime: clamped,
						statusHeader: undefined,
						remaining: undefined,
					};
				}
			}

			// No usable reset time — return without resetTime so the no-reset cooldown path fires
			return {
				isRateLimited: true,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			};
		}

		// Fall back to 429 status with x-ratelimit-reset header
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		const now429 = Date.now();
		const rateLimitReset = response.headers.get("x-ratelimit-reset");
		// Apply clampResetTime to both the upstream-provided reset header and the
		// no-header default, matching the 529 path. Header values that are invalid,
		// in the past, or beyond the 24h cap fall back to the 60s default.
		const DEFAULT_429_COOLDOWN_MS = 60_000;
		const parsedReset = rateLimitReset
			? clampResetTime(parseInt(rateLimitReset, 10) * 1000, now429)
			: undefined;
		const resetTime = parsedReset ?? now429 + DEFAULT_429_COOLDOWN_MS;

		return {
			isRateLimited: true,
			resetTime,
		};
	}

	/**
	 * Transform Anthropic SSE stream to add OpenAI-compatible finish_reason.
	 * Anthropic uses stop_reason on message_delta events; OpenAI clients expect
	 * finish_reason. This maps between them without breaking native Anthropic clients
	 * since both fields are present in the transformed output.
	 */
	private async transformStreamToOpenAIFormat(
		response: Response,
		requestHeaders?: Headers,
	): Promise<Response> {
		// Native Anthropic SDK clients always send anthropic-version; skip transform for them
		if (requestHeaders?.has("anthropic-version")) {
			return response;
		}

		const contentType = response.headers.get("content-type");

		// Only transform streaming responses
		if (!contentType?.includes("text/event-stream")) {
			return response;
		}

		const reader = response.body?.getReader();
		if (!reader) return response;

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		// stopReasonMap defined once outside the loop for performance
		const stopReasonMap: Record<string, string> = {
			end_turn: "stop",
			max_tokens: "length",
			stop_sequence: "stop",
			tool_use: "tool_calls",
		};

		const stream = new ReadableStream({
			async start(controller) {
				// lineBuffer carries incomplete lines across chunk boundaries
				let lineBuffer = "";
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							// Flush any remaining buffered content
							if (lineBuffer) {
								controller.enqueue(encoder.encode(lineBuffer));
							}
							break;
						}

						// Accumulate decoded bytes into lineBuffer, split on newlines
						lineBuffer += decoder.decode(value, { stream: true });
						const lines = lineBuffer.split("\n");
						// Last element may be an incomplete line — keep it in the buffer
						lineBuffer = lines.pop() ?? "";

						for (const line of lines) {
							// Pass through non-data lines (empty lines, event:, id:, comment:)
							// SSE allows both "data:" and "data: " prefixes
							if (!line.startsWith("data:")) {
								controller.enqueue(encoder.encode(`${line}\n`));
								continue;
							}

							const data = line.replace(/^data:\s?/, "");

							// Pass through [DONE] marker
							if (data === "[DONE]") {
								controller.enqueue(encoder.encode(`${line}\n`));
								continue;
							}

							try {
								const event = JSON.parse(data);

								// Map Anthropic stop_reason -> OpenAI finish_reason on message_delta
								if (
									event.type === "message_delta" &&
									event.delta?.stop_reason
								) {
									event.finish_reason =
										stopReasonMap[event.delta.stop_reason] ?? "stop";
								}

								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify(event)}\n`),
								);
							} catch {
								// Non-JSON data line — pass through unchanged
								controller.enqueue(encoder.encode(`${line}\n`));
							}
						}
					}
				} catch (error) {
					controller.error(error);
				} finally {
					// Guard close() — stream may already be errored
					try {
						controller.close();
					} catch {
						// ignore: stream is already in errored state
					}
				}
			},
			cancel(reason) {
				reader.cancel(reason);
			},
		});

		return new Response(stream, {
			headers: response.headers,
			status: response.status,
			statusText: response.statusText,
		});
	}

	async processResponse(
		response: Response,
		_account: Account | null,
		requestHeaders?: Headers,
	): Promise<Response> {
		// Sanitize headers by removing hop-by-hop headers
		const headers = sanitizeProxyHeaders(response.headers);

		const sanitizedResponse = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});

		// Add OpenAI-compatible finish_reason alongside Anthropic's stop_reason
		return this.transformStreamToOpenAIFormat(
			sanitizedResponse,
			requestHeaders,
		);
	}

	/**
	 * Check if this provider supports OAuth
	 */
	supportsOAuth(): boolean {
		return true;
	}

	/**
	 * Get the OAuth provider for this provider
	 */
	getOAuthProvider() {
		// Lazy load to avoid circular dependencies
		const { AnthropicOAuthProvider } = require("./oauth.js");
		return new AnthropicOAuthProvider();
	}
}
