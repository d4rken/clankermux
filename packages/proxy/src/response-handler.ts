import { BUFFER_SIZES, requestEvents, TIME_CONSTANTS } from "@clankermux/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	Account,
	RateLimitReason,
	RequestRoutingMeta,
} from "@clankermux/types";
import { cacheBodyStore } from "./cache-body-store";
import type { ProxyContext } from "./handlers";
import { applyRateLimitCooldown } from "./handlers/rate-limit-cooldown";
import { createSseRateLimitSniffer } from "./handlers/sse-rate-limit-sniffer";
import {
	NO_ACCOUNT_ID,
	type RecordMeta,
	type TransportOutcome,
} from "./request-recorder";
import { hashRoutingAffinityKey } from "./routing-telemetry";
import { shouldRecordRequest } from "./should-record-request";
import { createStreamAnalyticsPassthrough } from "./stream-analytics";
import type { UsageWorkerController } from "./usage-worker-controller";
import type { ChunkMessage, EndMessage, StartMessage } from "./worker-messages";

/**
 * Map a stream-analytics error to a transport outcome for the recorder. The
 * passthrough stream surfaces three distinct error shapes (see
 * stream-analytics.ts): a total/chunk timeout ("Stream timeout: ..."), a client
 * cancel ("client disconnected"), or any other read error.
 */
function streamErrorToOutcome(err: Error): TransportOutcome {
	const message = err.message || "";
	if (message.includes("client disconnected")) return "disconnect";
	if (message.includes("Stream timeout")) return "timeout";
	return "error";
}

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

const log = new Logger("ResponseHandler");
const MAX_REQUEST_BODY_BYTES = BUFFER_SIZES.MAX_REQUEST_BODY_BYTES;

function safePostMessage(
	worker: UsageWorkerController,
	message: StartMessage | ChunkMessage | EndMessage,
	transfer?: Transferable[],
): void {
	try {
		worker.postMessage(message, transfer);
	} catch (error) {
		// Worker "not ready" throws are expected during startup/shutdown —
		// silently ignore those. Log anything else (e.g. DataCloneError from a
		// bad transferable) at warn level for observability.
		if (error instanceof Error && !error.message.includes("worker state is")) {
			const { requestId } = message as { requestId?: string };
			log.warn(
				`Unexpected postMessage failure for ${requestId ?? "?"}: ${error.name}: ${error.message}`,
			);
		}
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
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	comboName?: string | null;
	routing?: RequestRoutingMeta | null;
	/**
	 * When true, the mid-stream rate-limit cooldown sniffer is disabled: a
	 * streamed 429/529 error is still streamed and recorded, but does NOT mutate
	 * the account's rate-limit/provider-overload cooldown state. Used by the
	 * force-account path, which returns the forced account's response (errors
	 * included) as-is without touching cooldown state.
	 */
	disableCooldown?: boolean;
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
		apiKeyId,
		apiKeyName,
		comboName,
		routing,
		disableCooldown,
	} = options;

	// Always strip compression headers *before* we do anything else
	const response = withSanitizedProxyHeaders(responseRaw);

	// Prepare objects once for serialisation - sanitize headers before storing
	const sanitizedReq = sanitizeRequestHeaders(requestHeaders);
	const requestHeadersObj = Object.fromEntries(sanitizedReq.entries());

	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;
	const shouldStorePayloads = ctx.config.getStorePayloads?.() ?? true;

	// Canonical recordable-request predicate (S1): the UNION of the historical
	// response-handler filter (count_tokens-on-openai-compatible, auto-refresh
	// probes) and the worker filter (.well-known 404s). Gates the worker post,
	// the dashboard start event, AND recorder.begin so the three stay in sync.
	const shouldProcessRequest = shouldRecordRequest({
		method,
		path,
		providerName: ctx.provider.name,
		responseStatus: response.status,
		getHeader: (name) => requestHeaders.get(name),
	});

	const routingRecord = routing
		? {
				strategy: routing.strategy,
				decision: routing.decision,
				affinityScope: routing.affinityScope ?? null,
				affinityKeyHash: hashRoutingAffinityKey(routing.affinityKey),
				selectedAccountId: account?.id ?? routing.selectedAccountId ?? null,
				previousAccountId: routing.previousAccountId ?? null,
				candidatesCount: routing.candidatesCount ?? null,
				failoverReason: routing.failoverReason ?? null,
			}
		: null;

	// Send START message immediately if not filtered. The worker is now a pure
	// usage computer — it no longer receives the request body (no transfer).
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
			comboName: comboName || null,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			retryAttempt,
			failoverAttempts,
			routing: routingRecord,
		};
		safePostMessage(ctx.usageWorker, startMessage);

		// Begin recording on the main thread. The recorder fires account
		// side-effects immediately (auto-pause-on-overage, updateAccountUsage),
		// captures the (capped) request body within its byte budget, and owns
		// persistence. The capped copy is independent of the caller's
		// `requestBody` (which may be shared with the failover/replay
		// RequestBodyContext) — slice() returns a NEW ArrayBuffer.
		const recordMeta: RecordMeta = {
			requestId,
			method,
			path,
			accountId: account?.id || null,
			accountName: account?.name ?? null,
			responseStatus: response.status,
			responseHeaders: responseHeadersObj,
			requestHeaders: requestHeadersObj,
			isStream,
			providerName: ctx.provider.name,
			accountBillingType: account?.billing_type ?? null,
			accountAutoPauseOnOverageEnabled: account?.auto_pause_on_overage_enabled
				? 1
				: 0,
			authed: !!account?.id && account.id !== NO_ACCOUNT_ID,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			comboName: comboName || null,
			project: project ?? null,
			routing: routingRecord,
			timestamp,
			requestBody:
				shouldStorePayloads && requestBody
					? requestBody.slice(
							0,
							Math.min(requestBody.byteLength, MAX_REQUEST_BODY_BYTES),
						)
					: null,
			retryAttempt,
			failoverAttempts,
		};
		ctx.requestRecorder.begin(recordMeta);

		// The cache-keepalive staging entry (if any) has now been handed to the
		// worker; mark it so a worker restart can reap it as a true orphan while
		// preserving entries not yet handed off. No-op for non-staged requests.
		cacheBodyStore.markStagedHandedOff(requestId);
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
		// or unauthenticated requests can't be failed over. The force-account
		// path passes disableCooldown so a forced 429/529 streamed mid-response
		// does not mutate cooldown state (errors are returned as-is).
		const rateLimitSniffer =
			account && !disableCooldown
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
					// Post every chunk to the worker UNCAPPED so tiktoken
					// output-token counting matches the full output (N2).
					const chunkMsg: ChunkMessage = {
						type: "chunk",
						requestId,
						data: value,
					};
					safePostMessage(ctx.usageWorker, chunkMsg);
					// The recorder captures the (256KB-capped) response body for
					// Request History.
					ctx.requestRecorder.captureResponseChunk(requestId, value);
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
					ctx.requestRecorder.finishTransport(
						requestId,
						success ? "success" : "error",
					);
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
					ctx.requestRecorder.finishTransport(
						requestId,
						streamErrorToOutcome(err),
					);
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
			const success = isExpectedResponse(path, response);
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				responseBody: null,
				success,
			};
			safePostMessage(ctx.usageWorker, endMsg);
			ctx.requestRecorder.finishTransport(
				requestId,
				success ? "success" : "error",
			);
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
				const success = isExpectedResponse(path, analyticsResponse);
				// Feed the captured (256KB-capped) body to the recorder, then
				// finalize transport — INSIDE the IIFE, after cappedBuf is read
				// (amendment B4: never after `})();`, which runs before the read).
				if (cappedBuf.byteLength > 0) {
					ctx.requestRecorder.captureResponseChunk(requestId, cappedBuf);
				}
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					responseBody:
						cappedBuf.byteLength > 0 ? cappedBuf.toString("base64") : null,
					success,
				};
				safePostMessage(ctx.usageWorker, endMsg);
				ctx.requestRecorder.finishTransport(
					requestId,
					success ? "success" : "error",
				);
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
				ctx.requestRecorder.finishTransport(requestId, "error");
			}
		}
	})();

	// Return the sanitized response
	return clientResponse;
}
