import { requestEvents, TIME_CONSTANTS } from "@clankermux/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@clankermux/http-common";
import type { Account, RateLimitReason } from "@clankermux/types";
import type { ProxyContext } from "./handlers";
import { applyRateLimitCooldown } from "./handlers/rate-limit-cooldown";
import { createSseRateLimitSniffer } from "./handlers/sse-rate-limit-sniffer";
import { createStreamAnalyticsPassthrough } from "./stream-analytics";
import type { UsageWorkerController } from "./usage-worker-controller";
import type { ChunkMessage, EndMessage, StartMessage } from "./worker-messages";

// Default cooldown for rate-limit errors detected mid-stream. SSE error
// frames don't carry reset headers (HTTP headers were sent before the
// error occurred), so we fall back to the same probe-friendly default
// that response-processor.ts uses for headerless 429 responses.
//
// Read on every call (not module load) so a runtime change to the env
// var is picked up without a server restart. Use `||` (not `??`) so an
// empty-string env value (Number("") === 0) falls through to the default
// instead of silently disabling the cooldown.
function getMidStreamRateLimitCooldownMs(): number {
	return (
		Number(process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) ||
		TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS
	);
}

// Must match MAX_REQUEST_BODY_BYTES in post-processor.worker.ts.
// Bounds the fresh ArrayBuffer copy we transfer to the worker (the source
// body is never transferred — see the start-message construction below).
// 4MB so afterburn can see full conversation history for friction analysis.
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

function safePostMessage(
	worker: UsageWorkerController,
	message: StartMessage | ChunkMessage | EndMessage,
	transfer?: Transferable[],
): void {
	try {
		worker.postMessage(message, transfer);
	} catch (_error) {
		// Worker not ready or terminated — silently ignore
	}
}

/**
 * Check if a response should be considered successful/expected
 * Treats certain well-known paths that return 404 as expected
 */
function isExpectedResponse(path: string, response: Response): boolean {
	// Any .well-known path returning 404 is expected
	if (path.startsWith("/.well-known/") && response.status === 404) {
		return true;
	}

	// Otherwise use standard HTTP success logic
	return response.ok;
}

export interface ResponseHandlerOptions {
	requestId: string;
	method: string;
	path: string;
	account: Account | null;
	requestHeaders: Headers;
	requestBody: ArrayBuffer | null;
	project?: string | null;
	response: Response;
	timestamp: number;
	retryAttempt: number;
	failoverAttempts: number;
	agentUsed?: string | null;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	comboName?: string | null;
}

/**
 * Unified response handler that immediately streams responses
 * while forwarding data to worker for async processing
 */
// Forward response to client while streaming analytics to worker
export async function forwardToClient(
	options: ResponseHandlerOptions,
	ctx: ProxyContext,
): Promise<Response> {
	const {
		requestId,
		method,
		path,
		account,
		requestHeaders,
		requestBody,
		project,
		response: responseRaw,
		timestamp,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		agentUsed,
		apiKeyId,
		apiKeyName,
		comboName,
	} = options;

	// Always strip compression headers *before* we do anything else
	const response = withSanitizedProxyHeaders(responseRaw);

	// Prepare objects once for serialisation - sanitize headers before storing
	const sanitizedReq = sanitizeRequestHeaders(requestHeaders);
	const requestHeadersObj = Object.fromEntries(sanitizedReq.entries());

	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;
	const shouldStorePayloads = ctx.config.getStorePayloads?.() ?? true;

	// Filter out:
	//   - count_tokens requests on OpenAI-compatible providers (existing
	//     filter — these aren't billable user traffic).
	//   - synthetic auto-refresh probes (issue #199, bug 2). Logging these
	//     pollutes the user-visible 503/200 metrics on the dashboard with
	//     internal scheduler activity. Header set by AutoRefreshScheduler
	//     mirrors the existing keepalive pattern.
	const isAutoRefreshProbe =
		requestHeaders.get("x-clankermux-auto-refresh") === "true";
	const shouldProcessRequest =
		!(
			ctx.provider.name === "openai-compatible" &&
			path === "/v1/messages/count_tokens"
		) && !isAutoRefreshProbe;

	// Send START message immediately if not filtered
	if (shouldProcessRequest) {
		const startMessage: StartMessage = {
			type: "start",
			messageId: crypto.randomUUID(),
			requestId,
			accountId: account?.id || null,
			method,
			path,
			timestamp,
			requestHeaders: requestHeadersObj,
			// Fresh capped copy: .slice() returns a NEW ArrayBuffer, safe to
			// transfer to the worker. Never transfer the caller's `requestBody`
			// — it may be shared with the failover/replay RequestBodyContext, and
			// transfer detaches the source buffer.
			requestBody:
				shouldStorePayloads && requestBody
					? requestBody.slice(
							0,
							Math.min(requestBody.byteLength, MAX_REQUEST_BODY_BYTES),
						)
					: null,
			project: project ?? null,
			responseStatus: response.status,
			responseHeaders: responseHeadersObj,
			isStream,
			providerName: ctx.provider.name,
			accountBillingType: account?.billing_type ?? null,
			accountAutoPauseOnOverageEnabled: account?.auto_pause_on_overage_enabled
				? 1
				: 0,
			accountName: account?.name ?? null,
			agentUsed: agentUsed || null,
			comboName: comboName || null,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			retryAttempt,
			failoverAttempts,
		};
		// The transferable IS the requestBody field — move ownership to the
		// worker (no structured-clone copy) instead of cloning the bytes.
		const transfer = startMessage.requestBody
			? [startMessage.requestBody]
			: undefined;
		safePostMessage(ctx.usageWorker, startMessage, transfer);
	}

	// Emit request start event for real-time dashboard
	if (shouldProcessRequest) {
		requestEvents.emit("event", {
			type: "start",
			id: requestId,
			timestamp,
			method,
			path,
			accountId: account?.id || null,
			statusCode: response.status,
			agentUsed: agentUsed || null,
		});
	}

	/*********************************************************************
	 *  STREAMING RESPONSES — single-reader pass-through with inline analytics
	 *
	 *  Replaces the old `response.body.tee()` split. Native tee() buffered the
	 *  whole body in the slow (client) branch's queue while the fast analytics
	 *  branch raced ahead — an unbounded off-heap leak. Here the client reads
	 *  the wrapper stream directly; analytics side-effects run inline per chunk
	 *  at client pace, so there is no second buffer.
	 *********************************************************************/
	if (isStream && response.body) {
		// Mid-stream rate-limit detection for issue #114 Fix 1.2. Only
		// create a sniffer when we know which account to mark — anonymous
		// or unauthenticated requests can't be failed over.
		const rateLimitSniffer = account
			? createSseRateLimitSniffer({ provider: account.provider })
			: null;

		// Configurable via env vars to support long agentic workloads where
		// nested sub-calls (e.g. recursive claude-code-sdk sessions) can leave
		// the outer stream silent for extended periods (issue #84).
		const STREAM_TIMEOUT_MS = Number(
			process.env.CF_STREAM_TOTAL_TIMEOUT_MS ??
				TIME_CONSTANTS.STREAM_FORWARD_TOTAL_TIMEOUT_MS,
		);
		const CHUNK_TIMEOUT_MS = Number(
			process.env.CF_STREAM_CHUNK_TIMEOUT_MS ??
				TIME_CONSTANTS.STREAM_FORWARD_CHUNK_TIMEOUT_MS,
		);

		// Computed once upfront from path + status only (isExpectedResponse does
		// NOT read the body), matching the old analyticsResponse status.
		const success = isExpectedResponse(path, response);

		const clientStream = createStreamAnalyticsPassthrough(response.body, {
			totalTimeoutMs: STREAM_TIMEOUT_MS,
			chunkTimeoutMs: CHUNK_TIMEOUT_MS,
			onChunk: (value) => {
				if (shouldProcessRequest) {
					const chunkMsg: ChunkMessage = {
						type: "chunk",
						requestId,
						data: value,
					};
					safePostMessage(ctx.usageWorker, chunkMsg);
				}

				// Mid-stream rate-limit detection. The sniffer
				// fires exactly once; after that feed() is a no-op.
				if (account && rateLimitSniffer?.feed(value)) {
					// Map firedReason to the correct RateLimitReason override:
					//   "overloaded_error" → upstream_529_overloaded_with_reset
					//   "rate_limit_error" → let applyRateLimitCooldown auto-derive (429)
					const reason: RateLimitReason | undefined =
						rateLimitSniffer.firedReason === "overloaded_error"
							? "upstream_529_overloaded_with_reset"
							: undefined;
					applyRateLimitCooldown(
						account,
						{
							resetTime: Date.now() + getMidStreamRateLimitCooldownMs(),
							reason,
						},
						ctx,
					);
				}
			},
			onEnd: () => {
				if (shouldProcessRequest) {
					const endMsg: EndMessage = {
						type: "end",
						requestId,
						success,
					};
					safePostMessage(ctx.usageWorker, endMsg);
				}
			},
			onError: (err) => {
				if (shouldProcessRequest) {
					const endMsg: EndMessage = {
						type: "end",
						requestId,
						success: false,
						error: err.message,
					};
					safePostMessage(ctx.usageWorker, endMsg);
				}
			},
		});

		// Return the sanitized response backed by the single-reader stream.
		return new Response(clientStream, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	if (!response.body) {
		if (shouldProcessRequest) {
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				responseBody: null,
				success: isExpectedResponse(path, response),
			};
			safePostMessage(ctx.usageWorker, endMsg);
		}

		return response;
	}

	const [clientStream, analyticsStream] = response.body.tee();
	const clientResponse = new Response(clientStream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
	const analyticsResponse = new Response(analyticsStream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});

	(async () => {
		const MAX_NON_STREAM_BODY_BYTES = 256 * 1024; // 256KB cap for stored body
		try {
			// Read body via stream, stopping once the cap is reached to avoid
			// loading an unbounded response into memory before truncation.
			const reader = analyticsResponse.body?.getReader();
			let cappedBuf: Buffer;
			if (!reader) {
				cappedBuf = Buffer.alloc(0);
			} else {
				const chunks: Uint8Array[] = [];
				let bytesRead = 0;
				while (bytesRead < MAX_NON_STREAM_BODY_BYTES) {
					const { value, done } = await reader.read();
					if (done) break;
					const remaining = MAX_NON_STREAM_BODY_BYTES - bytesRead;
					if (value.length <= remaining) {
						chunks.push(value);
						bytesRead += value.length;
					} else {
						chunks.push(value.slice(0, remaining));
						bytesRead += remaining;
						await reader.cancel();
						break;
					}
				}
				cappedBuf = Buffer.concat(chunks);
			}
			if (shouldProcessRequest) {
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					responseBody:
						cappedBuf.byteLength > 0 ? cappedBuf.toString("base64") : null,
					success: isExpectedResponse(path, analyticsResponse),
				};
				safePostMessage(ctx.usageWorker, endMsg);
			}
		} catch (err) {
			if (shouldProcessRequest) {
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					success: false,
					error: (err as Error).message,
				};
				safePostMessage(ctx.usageWorker, endMsg);
			}
		}
	})();

	// Return the sanitized response
	return clientResponse;
}
