import { HTTP_STATUS, ModelNotServedError } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { handleProxy, type ProxyContext } from "./proxy";

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

		const isServiceUnavailable = statusCode === HTTP_STATUS.SERVICE_UNAVAILABLE;
		// The one non-503 terminal whose message is deliberately client-facing.
		// The generic branch below replaces every other message with "Proxy
		// request failed" so an internal string can never leak, and that default
		// is right — but it would also swallow the model name, which is the
		// entire content of this terminal. Gated on the class rather than on the
		// status so a future 400 from anywhere else does not inherit the
		// passthrough by accident.
		const isModelNotServed = proxyError instanceof ModelNotServedError;
		const message =
			(isServiceUnavailable || isModelNotServed) && proxyError instanceof Error
				? proxyError.message
				: isServiceUnavailable
					? "Service temporarily unavailable. Please try again later."
					: "Proxy request failed";

		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: isServiceUnavailable
						? "service_unavailable_error"
						: isModelNotServed
							? // Anthropic's vocabulary for a 400 about the request
								// itself, so a client's existing error handling reads it
								// as a request problem rather than a transport one.
								"invalid_request_error"
							: "proxy_error",
					message,
				},
			}),
			{
				status: statusCode,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}
