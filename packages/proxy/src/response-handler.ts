import { BUFFER_SIZES, requestEvents, TIME_CONSTANTS } from "@clankermux/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	Account,
	ContextComposition,
	RequestRoutingMeta,
	ToolCallStat,
} from "@clankermux/types";
import { cacheBodyStore } from "./cache-body-store";
import type { ProxyContext } from "./handlers";
import { markAnthropicBurstThrottle } from "./handlers/burst-cooldown";
import { applyRateLimitCooldown } from "./handlers/rate-limit-cooldown";
import { createSseRateLimitSniffer } from "./handlers/sse-rate-limit-sniffer";
import { isOAuthAnthropicAccount } from "./handlers/transparent-retry";
import { missingMessageStopStats } from "./missing-message-stop-stats";
import {
	applyProviderOverloadCooldown,
	completeProviderOverloadProbe,
	type OverloadProbeToken,
} from "./provider-overload-cooldown";
import { RequestBodyContext } from "./request-body-context";
import {
	NO_ACCOUNT_ID,
	type RecordMeta,
	type TransportOutcome,
} from "./request-recorder";
import { hashRoutingAffinityKey } from "./routing-telemetry";
import { shouldRecordRequest } from "./should-record-request";
import { createStreamAnalyticsPassthrough } from "./stream-analytics";
import {
	getStreamForwardChunkTimeoutMs,
	getStreamForwardTotalTimeoutMs,
} from "./stream-timeouts";
import {
	createUsageState,
	detectMissingMessageStop,
	feedChunk,
	feedNonStreamBody,
	finalizeUsage,
	type UsageState,
} from "./usage-collector";

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
// (TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS) that
// response-processor.ts uses for headerless 429 responses.
const MID_STREAM_RATE_LIMIT_COOLDOWN_MS =
	TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS;

const log = new Logger("ResponseHandler");
const MAX_REQUEST_BODY_BYTES = BUFFER_SIZES.MAX_REQUEST_BODY_BYTES;

/**
 * In-flight usage-finalize promises. The worker used to compute usage off the
 * hot path; now `finalizeUsage` runs on the main thread as a tracked promise
 * AFTER `recorder.finishTransport`. Each promise is added here on launch and
 * removed on settle so graceful shutdown can await the stragglers via
 * {@link drainPendingUsageFinalizers} before the recorder / async-writer are
 * disposed (R6 — without this the in-flight finalizers would be lost, exactly
 * as `terminateUsageWorker()` used to guard against).
 */
const pendingUsageFinalizers = new Set<Promise<void>>();

/**
 * Launch a usage finalize for `requestId` as a tracked promise. On resolve it
 * drives `cacheBodyStore.onSummary` (staging promotion/cleanup) + the
 * recorder's `attachUsageSummary`; on reject it discards the staged body and
 * leaves the recorder's grace path to persist the row usage-less. The promise
 * never rejects out of this helper (errors are swallowed after cleanup) so a
 * finalize failure can't crash the stream callback or the drain.
 */
function trackFinalize(
	state: UsageState,
	requestId: string,
	opts: {
		responseTimeMs: number;
		providerName: string;
		isStream: boolean;
		endedCleanly: boolean;
	},
	ctx: ProxyContext,
): void {
	const promise = finalizeUsage(state, opts)
		.then((summary) => {
			// Diagnostic (observational only): an Anthropic stream that reached clean
			// EOF and reported output but never sent `message_stop` — the condition
			// that hangs Claude Code at end-of-stream. Runs here (after finalizeUsage,
			// whose flush can still set sawMessageStop from a trailing line) so we can
			// tell from logs/counter whether this occurs before adopting the upstream
			// stream-repair wrapper. Does not touch usage/cost.
			if (detectMissingMessageStop(state, opts)) {
				const occurrence = missingMessageStopStats.record(
					state.model,
					requestId,
					Date.now(),
				);
				log.warn(
					`Anthropic stream ended without message_stop ` +
						`(occurrence #${occurrence} since restart): requestId=${requestId} ` +
						`model=${state.model ?? "unknown"} ` +
						`reportedOutputTokens=${state.providerFinalOutputTokens ?? "?"}`,
				);
			}
			cacheBodyStore.onSummary(
				requestId,
				summary.usage.cacheCreationInputTokens ??
					summary.cacheCreationInputTokens,
				summary.usage.cacheReadInputTokens,
				summary.usage.model,
			);
			ctx.requestRecorder.attachUsageSummary(requestId, {
				...summary,
				requestId,
			});
		})
		.catch((error) => {
			// Finalize failed — no summary will ever arrive. Drop the staged body
			// now and persist the row IMMEDIATELY usage-waived rather than waiting on
			// the recorder's grace timer: during shutdown the finalizer drain runs
			// THEN dispose() clears the recorder, so a fast reject that left the row
			// for grace would lose it (B5). markUsageUnavailable closes that window.
			cacheBodyStore.discardStaged(requestId);
			ctx.requestRecorder.markUsageUnavailable(requestId);
			log.warn(
				`Usage finalize failed for ${requestId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		})
		.finally(() => {
			pendingUsageFinalizers.delete(promise);
		});
	pendingUsageFinalizers.add(promise);
}

/**
 * Await all in-flight usage finalizers, bounded by `timeoutMs`. Called from the
 * server's graceful shutdown BEFORE the recorder + async-writer are disposed so
 * a finalize that lands during drain can still attach its usage and enqueue the
 * patch write. Resolves on timeout regardless (best-effort) — shutdown must not
 * hang on a stuck cost lookup.
 */
export async function drainPendingUsageFinalizers(
	timeoutMs = 5_000,
): Promise<void> {
	if (pendingUsageFinalizers.size === 0) return;
	const all = Promise.allSettled([...pendingUsageFinalizers]);
	const timeout = new Promise<void>((resolve) => {
		setTimeout(resolve, timeoutMs);
	});
	await Promise.race([all.then(() => undefined), timeout]);
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
	/** Ingress model, supplied by the already-parsed request path when available. */
	requestedModel?: string | null;
	project?: string | null;
	/** Ingest-time context composition (see RequestMeta.contextComposition). */
	contextComposition?: ContextComposition | null;
	/** Ingest-time per-tool call/error stats (see RequestMeta.toolCallStats). */
	toolCallStats?: ToolCallStat[] | null;
	/** Per-request reasoning effort (see RequestMeta.reasoningEffort). */
	reasoningEffort?: string | null;
	response: Response;
	timestamp: number;
	retryAttempt: number;
	failoverAttempts: number;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	comboName?: string | null;
	routing?: RequestRoutingMeta | null;
	/**
	 * The canonical overload-attribution model (see proxyWithAccount): the
	 * model actually sent upstream (post model-mapping / fallback cycling)
	 * when it resolves to a family, else the request's logical model. A
	 * mid-stream `overloaded_error` trips the overload breaker bucket of THIS
	 * model's family. Absent/null falls back to the provider-wide bucket
	 * (conservatively gates every family).
	 */
	upstreamModel?: string | null;
	/**
	 * Half-open overload-probe token whose OWNERSHIP transfers to
	 * forwardToClient at CALL time — the caller must not settle it after
	 * passing it here, on ANY outcome including a throw. The verdict is judged
	 * on FULL transport completion — mid-stream overloads arrive after 200
	 * headers, so headers alone prove nothing:
	 *   - streaming clean EOF + success + sniffer silent → "recovered"
	 *   - sniffer `overloaded_error`                     → "reopened"
	 *   - sniffer `rate_limit_error` / stream error      → "abandoned"
	 *   - non-streaming: 2xx → "recovered", else "abandoned" (at forward time)
	 *   - a throw anywhere in forwardToClient's setup (e.g. recorder.begin)
	 *     → "abandoned" (settled by forwardToClient itself before rethrow, so
	 *     a setup failure can never orphan the lease until the safety TTL)
	 * Completion is idempotent, so overlapping paths are safe.
	 */
	overloadProbeToken?: OverloadProbeToken | null;
	/**
	 * When true, the mid-stream rate-limit cooldown sniffer is disabled: a
	 * streamed 429/529 error is still streamed and recorded, but does NOT mutate
	 * the account's rate-limit/provider-overload cooldown state. Used by the
	 * force-account path, which returns the forced account's response (errors
	 * included) as-is without touching cooldown state.
	 */
	disableCooldown?: boolean;
	/**
	 * Best-effort re-arm of the client connection's Bun idle timer, threaded into
	 * the streaming passthrough so long quiet gaps between chunks don't reap the
	 * connection at the 180s base idleTimeout. No-op when omitted (non-streaming
	 * responses, or callers without a Server handle).
	 */
	bumpIdleTimeout?: () => void;
}

/**
 * Unified response handler that immediately streams the response to the client
 * while computing usage inline (no worker). Per chunk: feed the UsageState +
 * capture the (capped) body for Request History; at transport finish: finalize
 * usage as a tracked async promise and attach it to the RequestRecorder.
 *
 * Single-owner story for `options.overloadProbeToken`: ownership transfers to
 * forwardToClient the moment it is called. If the setup phase throws before
 * the streaming callbacks / non-stream forward-time verdict take over (e.g.
 * `requestRecorder.begin`), the lease is settled "abandoned" here and the
 * error rethrown — the caller (proxyWithAccount) has already nulled its local
 * reference and must NOT settle again. Completion is idempotent, so the
 * belt-and-suspenders overlap with an already-armed stream verdict is safe.
 */
export async function forwardToClient(
	options: ResponseHandlerOptions,
	ctx: ProxyContext,
): Promise<Response> {
	try {
		return await forwardToClientInner(options, ctx);
	} catch (err) {
		// A throw during setup would otherwise orphan the probe lease until the
		// safety TTL (~an hour), wedging the half-open bucket against every
		// other would-be prober. Release it as "abandoned" — no verdict was
		// reached — and surface the original error.
		completeProviderOverloadProbe(
			options.overloadProbeToken ?? null,
			"abandoned",
		);
		throw err;
	}
}

async function forwardToClientInner(
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
		requestedModel: requestedModelOption,
		project,
		contextComposition,
		toolCallStats,
		reasoningEffort,
		response: responseRaw,
		timestamp,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		apiKeyId,
		apiKeyName,
		comboName,
		routing,
		disableCooldown,
		overloadProbeToken,
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
	// probes) and the .well-known-404 filter. Gates the inline usage collection,
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

	// Per-request usage accumulator. Created here when the request is recordable
	// and held for the streaming callbacks / non-stream IIFE below, replacing the
	// post-processor worker entirely: `feedChunk`/`feedNonStreamBody` accumulate
	// counters + first/last timestamps inline, and `finalizeUsage` resolves the
	// SlimUsageSummary AFTER transport finish (see trackFinalize). Null for
	// filtered requests (no usage computed for them, same as before).
	const usageState: UsageState | null = shouldProcessRequest
		? createUsageState()
		: null;
	// Production supplies this from the request's existing parse. Keep the body
	// fallback for direct callers/tests without imposing a second large JSON parse
	// on every normal proxied request.
	const requestedModel =
		requestedModelOption === undefined
			? new RequestBodyContext(requestBody).getModel()
			: requestedModelOption;

	if (shouldProcessRequest) {
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
			requestedModel,
			accountBillingType: account?.billing_type ?? null,
			accountAutoPauseOnOverageEnabled: account?.auto_pause_on_overage_enabled
				? 1
				: 0,
			authed: !!account?.id && account.id !== NO_ACCOUNT_ID,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			comboName: comboName || null,
			project: project ?? null,
			contextComposition: contextComposition ?? null,
			toolCallStats: toolCallStats ?? null,
			reasoningEffort: reasoningEffort ?? null,
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
		// Detection is independent of cooldown mutation: even anonymous/forced
		// requests must be recorded as failures when a nominal HTTP 200 stream ends
		// in an SSE error frame. `disableCooldown` only suppresses account state.
		const rateLimitSniffer = createSseRateLimitSniffer({
			provider: account?.provider ?? ctx.provider.name,
		});

		// Configurable via env vars to support long agentic workloads where
		// nested sub-calls (e.g. recursive claude-code-sdk sessions) can leave
		// the outer stream silent for extended periods (issue #84). Shared
		// helper (stream-timeouts.ts) so the probe-lease safety TTL reads the
		// SAME effective values and can never drift from what is honored here.
		const STREAM_TIMEOUT_MS = getStreamForwardTotalTimeoutMs();
		const CHUNK_TIMEOUT_MS = getStreamForwardChunkTimeoutMs();

		// Computed once upfront from path + status only (isExpectedResponse does
		// NOT read the body), matching the old analyticsResponse status.
		const success = isExpectedResponse(path, response);

		const clientStream = createStreamAnalyticsPassthrough(response.body, {
			totalTimeoutMs: STREAM_TIMEOUT_MS,
			chunkTimeoutMs: CHUNK_TIMEOUT_MS,
			bumpIdleTimeout: options.bumpIdleTimeout,
			onChunk: (value) => {
				if (usageState) {
					// Feed the chunk to the inline usage collector (decode + cheap
					// substring guard; only message_start/message_delta are parsed).
					// Nothing crosses a worker boundary, so there is no off-heap
					// structured-clone retention (Bun #5709).
					feedChunk(usageState, value, Date.now());
					// The recorder captures the (256KB-capped) response body for
					// Request History.
					ctx.requestRecorder.captureResponseChunk(requestId, value);
				}

				// Mid-stream rate-limit detection. The sniffer fires exactly once;
				// after that feed() is a no-op. Detection still runs when cooldown
				// mutation is disabled so Request History gets the correct outcome.
				if (rateLimitSniffer.feed(value) && account && !disableCooldown) {
					if (rateLimitSniffer.firedReason === "overloaded_error") {
						// Mid-stream `overloaded_error` (SSE 529 shape) is a
						// provider/family incident, not an account-level limit: trip the
						// family-scoped overload breaker (attributed via the model
						// actually sent upstream) so ALL same-family routing across the
						// provider's accounts backs off at once. Deliberately NO
						// per-account cooldown here — pre-stream 529s don't mark
						// individual accounts either, and marking here inflated
						// consecutive_rate_limits during provider incidents while a
						// client retry walked every account in the pool.
						applyProviderOverloadCooldown(
							account.provider,
							Date.now() + MID_STREAM_RATE_LIMIT_COOLDOWN_MS,
							options.upstreamModel ?? null,
						);
						// Probe verdict: the probe stream itself carried the overload.
						// The trip above invalidated the tripped bucket's lease;
						// "reopened" releases any sibling-bucket lease too.
						completeProviderOverloadProbe(
							overloadProbeToken ?? null,
							"reopened",
						);
					} else {
						// Mid-stream `rate_limit_error` is a per-account 429: apply the
						// per-account cooldown (auto-derived reason).
						applyRateLimitCooldown(
							account,
							{ resetTime: Date.now() + MID_STREAM_RATE_LIMIT_COOLDOWN_MS },
							ctx,
						);
						// A mid-stream rate_limit_error is a per-ACCOUNT signal, not an
						// overload-health verdict for the family — release the probe
						// lease without closing or re-opening the bucket.
						completeProviderOverloadProbe(
							overloadProbeToken ?? null,
							"abandoned",
						);

						// Reliable burst marker (storm-affinity-hold Part 1). A mid-stream
						// `rate_limit_error` frame is the per-IP burst throttle revealing
						// itself after the 200 headers were already sent — it can't rescue
						// THIS response, but it must trip the shared Anthropic-OAuth burst
						// marker so the session's NEXT affinity_hold requests hold their
						// cache account instead of diverting to a sibling. Only for a
						// genuine OAuth-Anthropic 429 (the 529 overloaded_error branch
						// above drives the family-scoped provider-overload breaker
						// instead). The SSE frame carries no HTTP status, so there is no
						// hard-limit-status check here — a mid-stream rate_limit_error is
						// by nature the transient burst shape.
						//
						// Exclude synthetic cache-keepalive replays: the keepalive
						// scheduler fires parallel requests across every cached account at
						// once, so a burst of 4+ trips Anthropic's per-IP limit and a
						// keepalive replay can itself surface a mid-stream
						// rate_limit_error. That is a self-inflicted probe artifact, not a
						// user-driven storm — tripping the marker on it would suppress
						// sibling diversion for real requests off a synthetic burst.
						// Mirrors the keepalive guard in response-processor.ts /
						// proxy-operations.ts.
						if (
							isOAuthAnthropicAccount(account) &&
							requestHeaders.get("x-clankermux-keepalive") !== "true"
						) {
							markAnthropicBurstThrottle(Date.now());
						}
					}
				}
			},
			onEnd: () => {
				// Probe verdict on natural stream end: recovered only when the
				// response was successful AND the sniffer never fired mid-stream
				// (a fired sniffer already settled the token — idempotent no-op
				// here). A non-success stream that drained cleanly is no health
				// proof, so its lease is released without closing the bucket.
				// Outside the usageState guard: filtered requests still settle.
				completeProviderOverloadProbe(
					overloadProbeToken ?? null,
					success && rateLimitSniffer?.firedReason == null
						? "recovered"
						: "abandoned",
				);
				if (usageState) {
					// R3: finish transport FIRST (terminal responseTimeMs computed
					// here), then finalize usage as a tracked async promise. The stream
					// drained to completion → endedCleanly so the provider's reported
					// output count is trusted (R5).
					const responseTimeMs = Math.max(0, Date.now() - timestamp);
					ctx.requestRecorder.finishTransport(
						requestId,
						rateLimitSniffer.firedReason
							? "error"
							: success
								? "success"
								: "error",
						rateLimitSniffer.firedReason ?? undefined,
					);
					trackFinalize(
						usageState,
						requestId,
						{
							responseTimeMs,
							providerName: ctx.provider.name,
							isStream: true,
							// onEnd fires when the upstream stream reaches its natural end
							// (the reader saw `done`), so the body was NOT truncated →
							// endedCleanly is ALWAYS true here, independent of HTTP success.
							// A non-2xx stream that drains to EOF still ended cleanly (it
							// just carried an error/short body), so finalize must trust the
							// provider's reported output count rather than the
							// max(provider, bytes/4) truncation fallback. The row's
							// success/error outcome is a SEPARATE signal recorded via
							// finishTransport above. Only onError (disconnect/timeout/read
							// error) marks the stream non-clean (truncated).
							endedCleanly: true,
						},
						ctx,
					);
				}
			},
			onError: (err) => {
				// Probe verdict: the stream was cut (disconnect/timeout/read error)
				// before a verdict — release the lease so another request may probe.
				completeProviderOverloadProbe(overloadProbeToken ?? null, "abandoned");
				if (usageState) {
					// R3: finish transport FIRST, then finalize on the partial stream.
					// The stream was cut (disconnect/timeout/error) → NOT endedCleanly,
					// so finalize takes max(providerCount, bytes/4) to avoid
					// undercounting a truncated response (R5).
					const responseTimeMs = Math.max(0, Date.now() - timestamp);
					ctx.requestRecorder.finishTransport(
						requestId,
						streamErrorToOutcome(err),
					);
					trackFinalize(
						usageState,
						requestId,
						{
							responseTimeMs,
							providerName: ctx.provider.name,
							isStream: true,
							endedCleanly: false,
						},
						ctx,
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
	 *  NON-STREAMING RESPONSES — read body in background, finalize once
	 *********************************************************************/
	// Probe verdict for non-streaming responses at forward time: the status is
	// the whole verdict (the mid-stream overload failure mode is SSE-specific).
	// 2xx proves the family answered healthily; anything else releases the
	// lease without closing the bucket.
	completeProviderOverloadProbe(
		overloadProbeToken ?? null,
		response.ok ? "recovered" : "abandoned",
	);
	if (!response.body) {
		if (usageState) {
			// No body to parse — finish transport, then finalize (empty usage state
			// → zero output, no provider count). Keeps the same record lifecycle as
			// a body-carrying response without special-casing the recorder. A
			// no-body response is a complete transport → endedCleanly.
			const success = isExpectedResponse(path, response);
			const responseTimeMs = Math.max(0, Date.now() - timestamp);
			ctx.requestRecorder.finishTransport(
				requestId,
				success ? "success" : "error",
			);
			trackFinalize(
				usageState,
				requestId,
				{
					responseTimeMs,
					providerName: ctx.provider.name,
					isStream: false,
					endedCleanly: true,
				},
				ctx,
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
			if (usageState) {
				const success = isExpectedResponse(path, analyticsResponse);
				// Capture the (256KB-capped) body for Request History, then — INSIDE
				// the IIFE, after cappedBuf is read (B4: never after `})();`, which
				// runs before the read) — finish transport FIRST (R3), then feed the
				// capped body to the inline collector and finalize as a tracked
				// promise.
				if (cappedBuf.byteLength > 0) {
					ctx.requestRecorder.captureResponseChunk(requestId, cappedBuf);
				}
				const responseTimeMs = Math.max(0, Date.now() - timestamp);
				ctx.requestRecorder.finishTransport(
					requestId,
					success ? "success" : "error",
				);
				if (cappedBuf.byteLength > 0) {
					feedNonStreamBody(usageState, cappedBuf.toString("utf8"));
				}
				trackFinalize(
					usageState,
					requestId,
					{
						responseTimeMs,
						providerName: ctx.provider.name,
						isStream: false,
						// Body was fully read (capped) → complete transport, clean end.
						endedCleanly: true,
					},
					ctx,
				);
			}
		} catch (err) {
			if (usageState) {
				// Body read failed — finish transport as an error, then finalize on
				// whatever (empty) state we have so the staging path is still driven.
				// The read was interrupted → NOT endedCleanly.
				const responseTimeMs = Math.max(0, Date.now() - timestamp);
				ctx.requestRecorder.finishTransport(requestId, "error");
				trackFinalize(
					usageState,
					requestId,
					{
						responseTimeMs,
						providerName: ctx.provider.name,
						isStream: false,
						endedCleanly: false,
					},
					ctx,
				);
				log.debug(
					`Non-stream body read failed for ${requestId}: ${(err as Error).message}`,
				);
			}
		}
	})();

	// Return the sanitized response
	return clientResponse;
}
