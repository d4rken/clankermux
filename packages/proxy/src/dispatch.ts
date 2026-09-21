import {
	HTTP_STATUS,
	ModelNotServedError,
	ModelSubstitutedError,
	ServiceUnavailableError,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { requestIdFromError } from "./error-request-id";
import { handleProxy, type ProxyContext } from "./proxy";
import { ModelSubstitutionRouteError } from "./resolved-route";
import { CLIENT_REQUEST_ID_HEADER } from "./response-handler";

const log = new Logger("ProxyDispatch");

/**
 * Dispatch a request through the proxy pipeline. Auth-free entry point.
 *
 * This is the single seam through which everything (external HTTP traffic AND
 * in-process schedulers) reaches `handleProxy`. The HTTP server is responsible
 * for running the auth gate before calling this; in-process callers (e.g. the
 * auto-refresh and cache-keepalive schedulers) skip auth entirely because they
 * already run inside the proxy process.
 *
 * Centralizing the error-to-Response mapping here keeps the two call sites
 * consistent and removes the need for schedulers to talk HTTP to themselves.
 */
export async function dispatchProxyRequest(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	isInternal = false,
): Promise<Response> {
	try {
		return await handleProxy(req, url, ctx, apiKeyId, apiKeyName, isInternal);
	} catch (proxyError) {
		const statusCode =
			typeof proxyError === "object" &&
			proxyError !== null &&
			"statusCode" in proxyError &&
			typeof (proxyError as { statusCode: unknown }).statusCode === "number"
				? (proxyError as { statusCode: number }).statusCode
				: HTTP_STATUS.INTERNAL_SERVER_ERROR;

		log.error("Proxy request failed:", proxyError);

		const requestId = requestIdFromError(proxyError);

		const isServiceUnavailable = statusCode === HTTP_STATUS.SERVICE_UNAVAILABLE;
		// The one non-503 terminal whose message is deliberately client-facing.
		// The generic branch below replaces every other message with "Proxy
		// request failed" so an internal string can never leak, and that default
		// is right — but it would also swallow the model name, which is the
		// entire content of this terminal. Gated on the class rather than on the
		// status so a future 400 from anywhere else does not inherit the
		// passthrough by accident.
		const isModelNotServed = proxyError instanceof ModelNotServedError;
		// Also a 503, so it would otherwise be serialized as a generic
		// "Service temporarily unavailable" and lose the two model names that
		// are the whole point of the terminal. Its own type as well: a client
		// that wants to distinguish "the provider swapped my model" from an
		// ordinary outage cannot do it from the status alone.
		// BOTH substitution terminals. The first request of a window raises
		// ModelSubstitutedError from the attempt loop; every request for the rest
		// of the suppression window is stopped earlier, at route construction,
		// and raises ModelSubstitutionRouteError. Same condition, same status, so
		// they must not report different error types depending on timing.
		const isModelSubstituted =
			proxyError instanceof ModelSubstitutedError ||
			proxyError instanceof ModelSubstitutionRouteError;
		const message =
			(isServiceUnavailable || isModelNotServed) && proxyError instanceof Error
				? proxyError.message
				: isServiceUnavailable
					? "Service temporarily unavailable. Please try again later."
					: "Proxy request failed";

		// A retryable 503 with no pacing is re-sent immediately against unchanged
		// pool state. The thrower supplies the interval when it knows one; the
		// flag says the interval is when to look again, not when capacity is back.
		const retryAfterSeconds =
			isServiceUnavailable && proxyError instanceof ServiceUnavailableError
				? proxyError.retryAfterSeconds
				: undefined;

		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: isModelSubstituted
						? "model_substituted_error"
						: isServiceUnavailable
							? "service_unavailable_error"
							: isModelNotServed
								? // Anthropic's vocabulary for a 400 about the request
									// itself, so a client's existing error handling reads it
									// as a request problem rather than a transport one.
									"invalid_request_error"
								: "proxy_error",
					message,
					...(retryAfterSeconds === undefined
						? {}
						: { availability_guaranteed: false }),
				},
			}),
			{
				status: statusCode,
				headers: {
					"Content-Type": "application/json",
					...(retryAfterSeconds === undefined
						? {}
						: { "Retry-After": String(retryAfterSeconds) }),
					// Present when the thrower knew the request: the give-up
					// terminals write their row before throwing, so this is what
					// makes that row reachable by id like every other refusal.
					...(requestId === null
						? {}
						: { [CLIENT_REQUEST_ID_HEADER]: requestId }),
				},
			},
		);
	}
}
