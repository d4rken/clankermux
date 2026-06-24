/**
 * Custom error classes for standardized error handling across the application
 */

/**
 * Base error class for all application errors
 */
export abstract class AppError extends Error {
	public readonly timestamp: Date;
	public readonly context?: Record<string, unknown>;

	constructor(
		message: string,
		public readonly code: string,
		public readonly statusCode: number,
		context?: Record<string, unknown>,
	) {
		super(message);
		this.name = this.constructor.name;
		this.timestamp = new Date();
		this.context = context;
		Error.captureStackTrace(this, this.constructor);
	}

	toJSON() {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			statusCode: this.statusCode,
			timestamp: this.timestamp,
			context: this.context,
		};
	}
}

/**
 * Authentication and authorization errors
 */
export class AuthError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, "AUTH_ERROR", 401, context);
	}
}

export class TokenRefreshError extends AuthError {
	/**
	 * True when the underlying failure was a terminal `invalid_grant` (the
	 * refresh token was revoked/expired/invalid) rather than a transient error.
	 * Set by the refresh chokepoint from the RAW provider error before it is
	 * wrapped here, so downstream consumers (e.g. usage polling) can reliably
	 * distinguish "needs reauth" from "retry later" without re-parsing messages.
	 */
	public readonly isInvalidGrant: boolean;

	constructor(
		accountId: string,
		originalError?: Error,
		isInvalidGrant = false,
	) {
		super("Failed to refresh access token", {
			accountId,
			originalError: originalError?.message,
			isInvalidGrant,
		});
		this.isInvalidGrant = isInvalidGrant;
	}
}

/**
 * Canonical `pause_reason` value for an account whose OAuth refresh token was
 * rejected by the provider (terminal — needs re-authentication, will not
 * self-heal). Surfaced on the dashboard as "Needs re-authentication" and
 * auto-cleared by a successful reauth. Kept here so producers (token refresh)
 * and consumers (oauth-flow resume, dashboard) agree on the exact string.
 */
export const PAUSE_REASON_NEEDS_REAUTH = "oauth_invalid_grant";

/**
 * Terminal OAuth markers returned by a token endpoint when a refresh token has
 * been revoked/rotated/invalidated. These are NOT retryable network conditions
 * — the only fix is re-authentication.
 */
const INVALID_GRANT_MARKERS = [
	"invalid_grant",
	"invalid_refresh_token",
	// Codex uses rotating refresh tokens; a reused/rotated token is terminal and
	// equally requires re-authentication.
	"refresh_token_reused",
	"refresh token not found or invalid",
	"oauth authentication is currently not supported",
] as const;

/**
 * True when an OAuth token-refresh error message/body indicates the refresh
 * token itself was rejected (terminal — needs reauth). Case-insensitive; pass
 * either the parsed error description or the raw response body, since some
 * providers return a non-JSON body that never reaches the parsed message.
 */
export function isInvalidGrantMessage(
	message: string | null | undefined,
): boolean {
	if (!message) return false;
	const lower = message.toLowerCase();
	return INVALID_GRANT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Thrown by a provider's `refreshToken` when the OAuth token endpoint rejects
 * the refresh token (e.g. HTTP 400/401 `invalid_grant`). Distinct, typed error
 * so callers can pause the account for re-auth instead of treating it as a
 * generic/transient refresh failure. Extends `AppError` directly (not
 * `AuthError`, which hardcodes the `AUTH_ERROR` code) to carry its own code.
 */
export class OAuthRefreshTokenError extends AppError {
	constructor(
		public readonly accountId: string,
		message = "OAuth refresh token rejected — re-authentication required",
	) {
		super(message, "OAUTH_INVALID_GRANT", 401, { accountId });
	}
}

/**
 * Rate limiting errors
 */
export class RateLimitError extends AppError {
	constructor(
		public readonly accountId: string,
		public readonly resetTime: number,
		public readonly remaining?: number,
	) {
		super("Rate limit exceeded", "RATE_LIMIT_ERROR", 429, {
			accountId,
			resetTime,
			remaining,
		});
	}
}

/**
 * Validation errors
 */
export class ValidationError extends AppError {
	constructor(
		message: string,
		public readonly field?: string,
		public readonly value?: unknown,
	) {
		super(message, "VALIDATION_ERROR", 400, { field, value });
	}
}

/**
 * Provider errors
 */
export class ProviderError extends AppError {
	constructor(
		message: string,
		public readonly provider: string,
		statusCode = 502,
		context?: Record<string, unknown>,
	) {
		super(message, "PROVIDER_ERROR", statusCode, { provider, ...context });
	}
}

export class OAuthError extends ProviderError {
	constructor(
		message: string,
		provider: string,
		public readonly oauthCode?: string,
	) {
		super(message, provider, 400, { oauthCode });
	}
}

/**
 * Service unavailable errors
 */
export class ServiceUnavailableError extends AppError {
	constructor(
		message: string,
		public readonly service?: string,
	) {
		super(message, "SERVICE_UNAVAILABLE", 503, { service });
	}
}

/**
 * Type guards
 */
export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError;
}

/**
 * Error logger that sanitizes sensitive data
 */
export function logError(
	error: unknown,
	logger: { error: (msg: string, ...args: unknown[]) => void },
): void {
	if (isAppError(error)) {
		// Sanitize sensitive context data
		const sanitizedContext = error.context
			? sanitizeErrorContext(error.context)
			: undefined;
		logger.error(`${error.name}: ${error.message}`, {
			code: error.code,
			statusCode: error.statusCode,
			context: sanitizedContext,
		});
	} else if (error instanceof Error) {
		logger.error(`Error: ${error.message}`, {
			name: error.name,
			stack: error.stack,
		});
	} else {
		logger.error("Unknown error", error);
	}
}

/**
 * Sanitize error context to remove sensitive data
 */
function sanitizeErrorContext(
	context: Record<string, unknown>,
): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	const sensitiveKeys = ["token", "password", "secret", "key", "authorization"];

	for (const [key, value] of Object.entries(context)) {
		const lowerKey = key.toLowerCase();
		if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
			sanitized[key] = "[REDACTED]";
		} else if (typeof value === "object" && value !== null) {
			sanitized[key] = sanitizeErrorContext(value as Record<string, unknown>);
		} else {
			sanitized[key] = value;
		}
	}

	return sanitized;
}
