/**
 * pi's verdict on whether a failed turn is retried, copied from pi-ai 1.2.0
 * (`dist/utils/retry.js`, `isRetryableAssistantError`) together with how its
 * openai-responses provider composes the text that verdict reads. pi retries
 * a turn up to three times by default.
 *
 * Before the head (`api/openai-responses.js`, `utils/error-body.js`):
 *   clankermux API error (400): {"message":"…","type":"…","code":"…"}
 * After it (`api/openai-responses-shared.js`, `response.failed`):
 *   server_error: The upstream model call failed
 */

const NON_RETRYABLE = new RegExp(
	[
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
		"insufficient_quota",
		"out of budget",
		"quota exceeded",
		"billing",
		"subscription_sharing_usage_limit_exceeded",
	].join("|"),
	"i",
);

const RETRYABLE = new RegExp(
	[
		"overloaded",
		"server_busy",
		"servers are currently busy",
		"currently experiencing high demand",
		"model is at capacity",
		"rate.?limit",
		"too many requests",
		"429",
		"500",
		"502",
		"503",
		"504",
		"520",
		"524",
		"service.?unavailable",
		"server.?error",
		"internal.?error",
		"provider.?returned.?(?:an.?)?error",
		"exceeded request buffer limit while retrying upstream",
		"network.?error",
		"connection.?error",
		"connection.?refused",
		"connection.?lost",
		"other side closed",
		"fetch failed",
		"getaddrinfo",
		"ENOTFOUND",
		"EAI_AGAIN",
		"upstream.?connect",
		"reset before headers",
		"socket hang up",
		"socket connection was closed",
		"timed? out",
		"timeout",
		"terminated",
		"websocket.?closed",
		"websocket.?error",
		"ended without",
		"stream ended before message_stop",
		"stream ended before a terminal response event",
		"http2 request did not get a response",
		"pending stream has been canceled",
		"retry delay",
		"you can retry your request",
		"try your request again",
		"please retry your request",
		"ResourceExhausted",
		"subscription_sharing_usage_unavailable",
		"subscription_sharing_user_unavailable",
	].join("|"),
	"i",
);

export function piRetries(errorMessage: string): boolean {
	if (NON_RETRYABLE.test(errorMessage)) return false;
	return RETRYABLE.test(errorMessage);
}

/** A JSON error answered before the head; `error` is the body's `error` object. */
export function piHttpErrorMessage(status: number, error: unknown): string {
	return `clankermux API error (${status}): ${JSON.stringify(error)}`;
}

/** A Responses stream that ended in `response.failed`. */
export function piFailedErrorMessage(error: {
	code?: unknown;
	message?: unknown;
}): string {
	return `${error.code || "unknown"}: ${error.message || "no message"}`;
}
