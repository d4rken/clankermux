import {
	BUFFER_SIZES,
	extractUnifiedClaimReadings,
	extractUnifiedSummaryReading,
	requestEvents,
	TIME_CONSTANTS,
} from "@clankermux/core";
import {
	sanitizeRequestHeaders,
	stripHopByHopHeaders,
	withSanitizedProxyHeaders,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import {
	type Account,
	type CachePrefixCapture,
	type ContextComposition,
	type InternalDispatchSpendRow,
	type InternalDispatchSpendSource,
	NATIVE_RESPONSES_RESPONSE_HEADER,
	type ProjectAttributionSource,
	type RequestRoutingMeta,
	type ToolCallStat,
	type UnifiedClaimObservationRow,
	type UnifiedClaimObservationSource,
	type UnifiedSummaryObservationRow,
} from "@clankermux/types";
import { cacheBodyStore } from "./cache-body-store";
import type { ProxyContext } from "./handlers";
import { markAnthropicBurstThrottle } from "./handlers/burst-cooldown";
import { isTrustedSyntheticProbe } from "./handlers/proxy-operations";
import { applyRateLimitCooldown } from "./handlers/rate-limit-cooldown";
import { createSseRateLimitSniffer } from "./handlers/sse-rate-limit-sniffer";
import { isOAuthAnthropicAccount } from "./handlers/transparent-retry";
import { missingMessageStopStats } from "./missing-message-stop-stats";
import {
	applyProviderOverloadCooldown,
	completeProviderOverloadProbe,
	type OverloadProbeEvidence,
	type OverloadProbeToken,
} from "./provider-overload-cooldown";
import { RequestBodyContext } from "./request-body-context";
import {
	NO_ACCOUNT_ID,
	type RecordMeta,
	type TransportOutcome,
} from "./request-recorder";
import { hashRoutingAffinityKey } from "./routing-telemetry";
import {
	dispatchObservationSource,
	shouldRecordRequest,
} from "./should-record-request";
import { createStreamAnalyticsPassthrough } from "./stream-analytics";
import {
	getStreamForwardChunkTimeoutMs,
	getStreamForwardTotalTimeoutMs,
} from "./stream-timeouts";
import {
	classifyNativeResponsesEnd,
	createUsageState,
	detectMissingMessageStop,
	expectsMessageStart,
	expectsResponsesTerminal,
	feedChunk,
	feedNonStreamBody,
	finalizeUsage,
	flushPendingSseLine,
	NATIVE_RESPONSES_STREAM_FAILED,
	STREAM_TRUNCATED_MID_CONTENT,
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

// Per-boot INFO budget for non-disconnect stream read errors (see onError):
// enough samples to identify a runtime-level regression's error shape from a
// default-level journal, without flooding it when a shape occurs at scale.
let readErrorInfoSamples = 5;

/**
 * Stable event id — the non-streaming analytics read stopped at its 256 KiB cap
 * without ever seeing EOF, so the body fed to the usage collector is truncated.
 *
 * The consequence is total, not partial: a truncated JSON body fails
 * `JSON.parse`, so the collector never learns the model, and
 * `RequestRecorder.toRequestUsage()` returns `undefined` for a summary with no
 * model — the request row persists with NO tokens and NO cost at all.
 *
 * A stable identifier (rather than log prose) so post-deploy occurrences can be
 * counted by field.
 */
export const EVENT_ANALYTICS_BODY_CAP_WITHOUT_EOF =
	"analytics_body_cap_without_eof";

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
		accountProvider?: string;
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
 * Which dispatch produced this request, for the claim-observation row.
 *
 * Trust-gated exactly like `isInternalProbe` in should-record-request.ts: the
 * marker headers are client-settable, so without the unspoofable in-process
 * dispatch flag any caller could file its traffic under an internal source and
 * corrupt the demand signal the series exists to carry. The two markers stay
 * separate checks so neither can borrow the other's label.
 */
function claimObservationSource(
	requestHeaders: Headers,
	internal: boolean,
): UnifiedClaimObservationSource {
	return dispatchObservationSource(
		(name) => requestHeaders.get(name),
		internal,
	);
}

/**
 * Which internal scheduler produced this dispatch, or null for client traffic.
 *
 * Derived from {@link claimObservationSource} so the spend rows and the claim
 * rows of one dispatch can never disagree about what produced it — same
 * trust-gated `internal` flag, same marker headers, one place.
 */
function internalDispatchSpendSource(
	requestHeaders: Headers,
	internal: boolean,
): InternalDispatchSpendSource | null {
	const source = claimObservationSource(requestHeaders, internal);
	return source === "client" ? null : source;
}

/**
 * The token vector a probe's response reported, with absences preserved.
 *
 * A fresh `UsageState` initialises every counter to 0, so the counters alone
 * cannot tell "the provider reported zero" from "the response carried no usage
 * at all" — the discriminator is whether anything usage-bearing was ever parsed
 * (`message_start` for Anthropic SSE, or an authoritative report for the
 * non-stream / Codex-terminal shapes). Without a reading every field is null.
 *
 * Deliberately NOT `finalizeUsage`: that resolves output via the bytes/4
 * approximation when the provider stayed silent, which is the right answer for a
 * cost estimate and the wrong one for a record of what upstream said.
 */
function probeUsageVector(state: UsageState): {
	model: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
} {
	const sawUsage = state.sawMessageStart || state.providerReportedOutput;
	if (!sawUsage) {
		return {
			model: state.model ?? null,
			inputTokens: null,
			outputTokens: null,
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
		};
	}
	return {
		model: state.model ?? null,
		inputTokens: state.inputTokens,
		cacheReadInputTokens: state.cacheReadInputTokens,
		cacheCreationInputTokens: state.cacheCreationInputTokens,
		// Only an AUTHORITATIVE count goes in; a stream that never reported one
		// records null rather than an estimate.
		outputTokens: state.providerReportedOutput
			? (state.providerFinalOutputTokens ?? null)
			: null,
	};
}

/** Per-dispatch spend sink for internal probes; see {@link createProbeSpendSink}. */
interface ProbeSpendSink {
	/** Feed one streamed response chunk. */
	feed(chunk: Uint8Array): void;
	/** Feed a fully-read non-streaming body. */
	feedBody(bodyText: string): void;
	/** Emit the row. Idempotent — the first terminal wins. */
	finish(completedAt: number | null): void;
}

/**
 * Sink that records what ONE internal probe dispatch (a cache-keepalive replay
 * or an auto-refresh prime) actually spent.
 *
 * These dispatches are excluded from `requests` by `shouldRecordRequest`, and
 * they get `usageState = null` for exactly that reason — so the proxy's own
 * upstream burn is invisible to every analysis built on the request series, even
 * though it comes out of the same quota as user traffic. This sink is the one
 * place that keeps it.
 *
 * Placed HERE and not in the schedulers on purpose: only this site has the
 * dispatch's request id (the id its claim-observation rows carry), the account,
 * the response status, the start time and the body stream all at once, and only
 * this site runs once per UPSTREAM ATTEMPT — the auto-refresh scheduler's retry
 * loop dispatches several, and a scheduler-side hook would see only the last.
 *
 * Returns null for client traffic, for unauthenticated dispatches, and whenever
 * the marker headers are not backed by the unspoofable in-process flag.
 */
function createProbeSpendSink(
	args: {
		requestId: string;
		account: Account | null;
		requestHeaders: Headers;
		internal: boolean;
		response: Response;
		/** Request start (the handler's `timestamp` input), epoch ms. */
		timestamp: number;
	},
	ctx: ProxyContext,
): ProbeSpendSink | null {
	const source = internalDispatchSpendSource(
		args.requestHeaders,
		args.internal,
	);
	const account = args.account;
	if (source === null || !account) return null;

	const state = createUsageState();
	let done = false;
	return {
		feed(chunk: Uint8Array): void {
			if (done) return;
			feedChunk(state, chunk, Date.now());
		},
		feedBody(bodyText: string): void {
			if (done) return;
			feedNonStreamBody(state, bodyText);
		},
		finish(completedAt: number | null): void {
			if (done) return;
			done = true;
			// A provider that closed right after the last `data:` byte can leave a
			// complete usage-bearing line unterminated in the buffer.
			flushPendingSseLine(state);
			const vector = probeUsageVector(state);
			const row: InternalDispatchSpendRow = {
				id: args.requestId,
				accountId: account.id,
				source,
				model: vector.model,
				httpStatus: args.response.status,
				startedAt: args.timestamp,
				completedAt,
				inputTokens: vector.inputTokens,
				outputTokens: vector.outputTokens,
				cacheReadInputTokens: vector.cacheReadInputTokens,
				cacheCreationInputTokens: vector.cacheCreationInputTokens,
			};
			const accepted = ctx.asyncWriter.enqueue(() =>
				ctx.dbOps.saveInternalDispatchSpend(row),
			);
			if (!accepted) {
				log.warn(
					`Dropped internal dispatch spend row for request ${args.requestId} ` +
						`(account=${account.name}, source=${source}): the metadata write queue is at capacity`,
				);
			}
		},
	};
}

/**
 * Record the per-claim rate-limit readings this response carried, as one row
 * per claim aligned to the request that received them.
 *
 * Deliberately OUTSIDE the `shouldRecordRequest` gate: cache-keepalive replays
 * and auto-refresh probes are kept out of Request History because they are not
 * user traffic, but they consume real quota and their responses report the same
 * claim state. Omitting them would leave gaps in the series exactly where the
 * proxy's own spend happened, which is one of the limits the ledger-burn
 * feasibility study ran into.
 *
 * Anthropic OAuth accounts only: a custom endpoint is some other upstream, and
 * no other provider emits these headers. Responses the proxy synthesised itself
 * carry no upstream headers, so the extractor yields nothing for them and no row
 * is written. A DELIVERED 429 does get captured — it carries real claim state.
 *
 * The response's SUMMARY block is captured here too, and INDEPENDENTLY: a
 * summary-only response exists (a per-IP burst 429 carries a bare `retry-after`
 * and no claim lines at all), so nesting the summary behind a non-empty claim
 * list would drop exactly the shapes that are otherwise unrecorded. Both sides
 * share ONE `observedAt` and one source, and go out as ONE writer job — two jobs
 * could be split by a queue rejection into a half-recorded response.
 */
function captureUnifiedClaimObservations(
	args: {
		requestId: string;
		account: Account | null;
		requestHeaders: Headers;
		internal: boolean;
		response: Response;
		/** Request start (the handler's `timestamp` input), epoch ms. */
		timestamp: number;
	},
	ctx: ProxyContext,
): void {
	const { account } = args;
	if (account?.provider !== "anthropic" || account.custom_endpoint) return;

	const readings = extractUnifiedClaimReadings(args.response.headers);
	const summary = extractUnifiedSummaryReading(args.response.headers);
	if (readings.length === 0 && summary === null) return;

	// Headers-arrival time, captured HERE: the row must say when the reading was
	// true, not when the queued write happened to run. Shared by both sides so a
	// joined read never has to reconcile two clocks for one response.
	const observedAt = Date.now();
	const source = claimObservationSource(args.requestHeaders, args.internal);
	const rows: UnifiedClaimObservationRow[] = readings.map((reading) => ({
		requestId: args.requestId,
		accountId: account.id,
		source,
		requestStartedAt: args.timestamp,
		observedAt,
		httpStatus: args.response.status,
		claim: reading.claim,
		status: reading.status,
		utilization: reading.utilization,
		resetAt: reading.resetMs,
		surpassedThreshold: reading.surpassedThreshold,
	}));
	const summaryRow: UnifiedSummaryObservationRow | null = summary && {
		requestId: args.requestId,
		accountId: account.id,
		source,
		httpStatus: args.response.status,
		requestStartedAt: args.timestamp,
		observedAt,
		status: summary.status,
		resetAt: summary.resetMs,
		remaining: summary.remaining,
		representativeClaim: summary.representativeClaim,
		fallback: summary.fallback,
		fallbackPercentage: summary.fallbackPercentage,
		overageStatus: summary.overageStatus,
		overageDisabledReason: summary.overageDisabledReason,
		retryAfter: summary.retryAfter,
	};

	const accepted = ctx.asyncWriter.enqueue(async () => {
		if (rows.length > 0) await ctx.dbOps.saveUnifiedClaimObservations(rows);
		if (summaryRow) await ctx.dbOps.saveUnifiedSummaryObservation(summaryRow);
	});
	if (!accepted) {
		log.warn(
			`Dropped ${rows.length} claim observation rows` +
				`${summaryRow ? " and the summary row" : ""} for request ${args.requestId} ` +
				`(account=${account.name}): the metadata write queue is at capacity`,
		);
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
	/**
	 * True only for an in-process dispatch (`handleProxy`'s own `isInternal`
	 * parameter, threaded through `requestMeta.internal`). Unspoofable — it never
	 * comes from a request header. Every synthetic-probe exemption in this module
	 * is gated on it, because the `x-clankermux-keepalive` / `-auto-refresh`
	 * marker headers are client-settable on their own. Defaults to false, so an
	 * omitted value is the safe (untrusted) one.
	 */
	internal?: boolean;
	/** Ingress model, supplied by the already-parsed request path when available. */
	requestedModel?: string | null;
	/** True when the request carried a fallback credit token (see RequestMeta). */
	fallbackCreditClaimed?: boolean | null;
	/** The model whose refusal this retry redeems (see RequestMeta). */
	fallbackFromModel?: string | null;
	project?: string | null;
	/** Which tier produced `project` (see RequestMeta.projectAttributionSource). */
	projectAttributionSource?: ProjectAttributionSource | null;
	/** Ingest-time context composition (see RequestMeta.contextComposition). */
	contextComposition?: ContextComposition | null;
	/** Ingest-time per-tool call/error stats (see RequestMeta.toolCallStats). */
	toolCallStats?: ToolCallStat[] | null;
	/** Per-request reasoning effort (see RequestMeta.reasoningEffort). */
	reasoningEffort?: string | null;
	/** Cache-measurement session identity (see RequestMeta.sessionKey). */
	sessionKey?: string | null;
	/** Cache-measurement prefix digests (see RequestMeta.cachePrefixHashes). */
	cachePrefixHashes?: CachePrefixCapture | null;
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
	 * passing it here, on ANY outcome including a throw. Headers alone never
	 * decide it (mid-stream overloads arrive after 200 headers); a qualifying
	 * stream settles "recovered" at the first healthy `message_start`, and the
	 * EOF / error / read-error paths are the fallback verdict for everything
	 * that never produced one:
	 * Each row below applies only while the token is still UNSETTLED — the first
	 * verdict wins, so a mid-stream `overloaded_error` AFTER a `message_start`
	 * does not settle "reopened"; it opens a fresh breaker generation instead.
	 *   - streaming `message_start` + success + sniffer silent → "recovered"
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
			"forward_setup_threw",
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
		internal: internalDispatch = false,
		requestedModel: requestedModelOption,
		project,
		projectAttributionSource,
		contextComposition,
		toolCallStats,
		reasoningEffort,
		sessionKey,
		cachePrefixHashes,
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

	// The single capture site for the request-aligned claim series. Runs before
	// the recordable-request gate below, because internal probes must be captured
	// even though they are excluded from Request History.
	captureUnifiedClaimObservations(
		{
			requestId,
			account,
			requestHeaders,
			internal: internalDispatch,
			response,
			timestamp,
		},
		ctx,
	);

	// Spend sink for the proxy's OWN dispatches. Null for client traffic, which
	// is recorded in `requests` instead — and for everything whose probe marker
	// isn't backed by the in-process dispatch flag.
	const probeSpend = createProbeSpendSink(
		{
			requestId,
			account,
			requestHeaders,
			internal: internalDispatch,
			response,
			timestamp,
		},
		ctx,
	);

	// Prepare objects once for serialisation - sanitize headers before storing
	const sanitizedReq = sanitizeRequestHeaders(requestHeaders);
	const requestHeadersObj = Object.fromEntries(sanitizedReq.entries());

	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	// `requests.is_stream` means the UPSTREAM TRANSPORT, not what the client
	// asked for. A native Responses request with `"stream": false` records
	// is_stream = true: the Codex leg really was SSE, and the adapter reduced it
	// to one JSON document after this row was begun. Recording client intent
	// instead would break every consumer that reads this column to reason about
	// the upstream (usage collection, truncation checks); the client's own answer
	// stays recoverable from the stored request payload's `"stream"` field, which
	// is why this stayed one column rather than becoming two.
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
		internal: internalDispatch,
		getHeader: (name) => requestHeaders.get(name),
	});

	// Provider the request was actually served by, for signals that must follow
	// the ACCOUNT rather than the registered handler: accounts stored as
	// `claude-console-api` have no provider registered under that name and fall
	// back to the default `anthropic` provider, so `ctx.provider.name` would
	// mislabel them. Used by the mid-stream rate-limit sniffer and by
	// pricing-gap attribution; falls back to the handler for anonymous/forced
	// requests that have no account.
	const accountProvider = account?.provider ?? ctx.provider.name;

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
			fallbackCreditClaimed: options.fallbackCreditClaimed ?? null,
			fallbackFromModel: options.fallbackFromModel ?? null,
			accountBillingType: account?.billing_type ?? null,
			accountAutoPauseOnOverageEnabled: account?.auto_pause_on_overage_enabled
				? 1
				: 0,
			authed: !!account?.id && account.id !== NO_ACCOUNT_ID,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			comboName: comboName || null,
			project: project ?? null,
			projectAttributionSource: projectAttributionSource ?? null,
			contextComposition: contextComposition ?? null,
			toolCallStats: toolCallStats ?? null,
			reasoningEffort: reasoningEffort ?? null,
			sessionKey: sessionKey ?? null,
			cachePrefixHashes: cachePrefixHashes ?? null,
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

	// Emit request start event for real-time dashboard. `project` and
	// `requestedModel` ride along so a client that connected after this
	// request's ingress event — or that never saw one, e.g. an internal
	// dispatch — can still attribute it to a project lane.
	if (shouldProcessRequest) {
		requestEvents.emit("event", {
			type: "start",
			id: requestId,
			timestamp,
			method,
			path,
			accountId: account?.id || null,
			statusCode: response.status,
			project: project ?? null,
			model: requestedModel ?? null,
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
			provider: accountProvider,
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
		//
		// NOT the whole story for a stream: a Bun-clean `done:true` close midway
		// through the content still leaves this `true`, which recorded a stream
		// that produced no model, no tokens and no content as a success. The
		// no-`message_start` check in `onEnd` refines it (see
		// `expectsMessageStart`).
		const success = isExpectedResponse(path, response);
		// Precomputed here so `onEnd` only has to look at what the stream produced.
		const mustSeeMessageStart = expectsMessageStart({
			method,
			path,
			status: response.status,
			contentType: response.headers.get("content-type"),
			// Native Codex passthrough: the adapter rewrote the client's
			// `/v1/responses` call to `/v1/messages`, so only this marker tells the
			// two apart here (see `expectsMessageStart`).
			nativeResponsesMarker: response.headers.get(
				NATIVE_RESPONSES_RESPONSE_HEADER,
			),
		});
		// The Responses-vocabulary counterpart, for the path `mustSeeMessageStart`
		// exempts. Precomputed here for the same reason it is.
		const mustSeeResponsesTerminal = expectsResponsesTerminal({
			status: response.status,
			nativeResponsesMarker: response.headers.get(
				NATIVE_RESPONSES_RESPONSE_HEADER,
			),
		});

		// Single mutable owner of the probe lease for the whole stream. Every
		// settle site below reads and then CLEARS it, so the lease is reported
		// exactly once no matter which verdict fires first. (Completion is also
		// idempotent via generation + lease identity, but an explicit single
		// owner keeps the early-settle below from reading as a double-settle.)
		let streamProbeToken = overloadProbeToken ?? null;
		const settleStreamProbe = (
			outcome: "recovered" | "reopened" | "abandoned",
			evidence: OverloadProbeEvidence,
		): void => {
			if (!streamProbeToken) return;
			const token = streamProbeToken;
			streamProbeToken = null;
			completeProviderOverloadProbe(token, outcome, evidence);
		};

		const clientStream = createStreamAnalyticsPassthrough(response.body, {
			totalTimeoutMs: STREAM_TIMEOUT_MS,
			chunkTimeoutMs: CHUNK_TIMEOUT_MS,
			bumpIdleTimeout: options.bumpIdleTimeout,
			onChunk: (value) => {
				// Internal probes have no usageState (they are kept out of Request
				// History), so their tokens are collected here instead.
				probeSpend?.feed(value);
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
							// The SSE error frame carries no headers, so this deadline is
							// OUR default, not upstream's hint — say so, or the trip line
							// claims a reset source that never existed.
							{ syntheticReset: true, accountName: account.name },
						);
						// Probe verdict: the probe stream itself carried the overload.
						// The trip above invalidated the tripped bucket's lease;
						// "reopened" releases any sibling-bucket lease too.
						settleStreamProbe("reopened", "sse_overloaded_error");
					} else {
						// Synthetic cache-keepalive replays are NOT authoritative evidence
						// of an account limit. The keepalive scheduler replays warm bodies
						// in waves of up to KEEPALIVE_CONCURRENCY, so its own requests can
						// contend with each other and with live traffic for Anthropic's
						// per-IP burst allowance. An SSE error frame is body data and
						// carries no rate-limit headers, so this code genuinely cannot tell
						// a self-inflicted burst apart from a real per-account limit —
						// which is exactly why the probe's verdict must not mutate account
						// state. Every pre-stream 429 site already takes that position (see
						// the `isKeepalive` guards in proxy-operations.ts and
						// response-processor.ts); letting identical upstream semantics cool
						// an account here purely because the provider delivered them as
						// 200-plus-error-frame instead of a 429 status would be an
						// arbitrary split. If real traffic does reach this account while it
						// is genuinely limited, its own (non-synthetic) 429 or error frame
						// applies the normal cooldown — but nothing guarantees that happens
						// inside the window skipped here, so this trades a possible late
						// cooldown for never cooling an account off traffic no user sent.
						//
						// Trust-gated: the marker header alone is client-spoofable, so the
						// exemption also requires the unspoofable in-process dispatch flag
						// (an external caller cannot suppress its own cooldown with it).
						const isKeepalive = isTrustedSyntheticProbe(
							requestHeaders,
							internalDispatch,
							"keepalive",
						);

						// Mid-stream `rate_limit_error` is a per-account 429: apply the
						// per-account cooldown (auto-derived reason).
						if (!isKeepalive) {
							applyRateLimitCooldown(
								account,
								{ resetTime: Date.now() + MID_STREAM_RATE_LIMIT_COOLDOWN_MS },
								ctx,
							);
						}
						// A mid-stream rate_limit_error is a per-ACCOUNT signal, not an
						// overload-health verdict for the family — release the probe
						// lease without closing or re-opening the bucket.
						settleStreamProbe("abandoned", "sse_rate_limit_error");

						// Reliable burst marker (storm-affinity-hold Part 1). A mid-stream
						// `rate_limit_error` frame arrives after the 200 headers were
						// already sent — it can't rescue THIS response, but it trips the
						// shared Anthropic-OAuth burst marker so the session's NEXT
						// affinity_hold requests hold their cache account instead of
						// diverting to a sibling. Only for an OAuth-Anthropic
						// `rate_limit_error` frame (the 529 overloaded_error branch above
						// drives the family-scoped provider-overload breaker instead). The
						// frame carries no HTTP status, so there is no hard-limit-status
						// check here — nor could there be: the marker is
						// deliberately optimistic about the frame being the transient burst
						// shape, because holding a session on its warm cache account for a
						// short window is cheap even when the cause was something else.
						//
						// Excluded on synthetic keepalive replays for the same reason the
						// cooldown above is: a probe's verdict must not stand in for a
						// user-driven storm. Tripping the marker on one would suppress
						// sibling diversion for real requests off self-inflicted traffic.
						if (isOAuthAnthropicAccount(account) && !isKeepalive) {
							markAnthropicBurstThrottle(Date.now());
						}
					}
				}

				// Probe verdict AS SOON AS the provider has demonstrated health,
				// rather than when this generation finishes.
				//
				// Settling at stream end meant the half-open bucket stayed leased
				// for the entire turn: a probe that got healthy headers in ~2s held
				// the lease for the 60-120s of generation that followed, and every
				// other holder sat in `holdForOverloadRecovery` polling
				// `probe-active` until its own budget ran out — waiting on an
				// upstream that had already recovered. That convoy, not the breaker
				// cooldown, is what burned the hold budget during the 2026-08-24
				// incident (holds exiting at the 120s ceiling with 30+ suppressed
				// rounds against a breaker that only ever tripped for 60s).
				//
				// `message_start` is the provider committing to a turn, and the SSE
				// overload shape arrives as an `error` frame INSTEAD of it — so a
				// seen `message_start` with a silent sniffer is real evidence. It is
				// also strictly stronger than what onEnd already accepts as
				// "recovered": that path deliberately counts a TRUNCATED stream as
				// health evidence on the grounds that 200 headers plus streamed
				// bytes prove the family is not overloaded.
				//
				// A later mid-stream `overloaded_error` is not lost: its branch
				// above re-trips the breaker via applyProviderOverloadCooldown,
				// which mints a fresh bucket generation. The cost of being early is
				// bounded by that window — between `message_start` and an error
				// frame — during which waiting holders are released and may hit an
				// upstream that turns out to still be sick, re-tripping it. Closing
				// at stream end has the same release-everyone-at-once shape; this
				// only moves it earlier.
				//
				// Requires an EXPLICIT positive event, never merely "bytes arrived
				// and the sniffer stayed quiet". A silent sniffer is not evidence:
				// the chunk may be an SSE ping or comment, the first half of an
				// `event: error` envelope whose type has not arrived yet, or a
				// stream shape this proxy does not model. Streams with no parsed
				// `message_start` — and requests with usage tracking off, where we
				// cannot observe one — keep the original end-of-stream verdict.
				if (
					streamProbeToken &&
					success &&
					rateLimitSniffer.firedReason == null &&
					usageState?.sawMessageStart === true
				) {
					settleStreamProbe("recovered", "message_start");
				}
			},
			onEnd: () => {
				probeSpend?.finish(Date.now());
				// Fallback probe verdict on natural stream end, for a token still
				// UNSETTLED here — a stream that produced `message_start` already
				// settled in onChunk, and a fired sniffer settled at that frame, so
				// both reach this as a no-op. Recovered only when the response was
				// successful AND the sniffer never fired mid-stream. A non-success stream that drained cleanly is no health
				// proof, so its lease is released without closing the bucket.
				// Outside the usageState guard: filtered requests still settle.
				//
				// DELIBERATELY unaffected by the truncation check below: a truncated
				// stream still means the provider returned 200 headers and streamed
				// bytes, which IS evidence the family is not overloaded. Marking it
				// "abandoned" would keep a healthy bucket half-open for no reason.
				// Flush BEFORE classifying. A provider may close right after the last
				// `data:` byte with no trailing newline, so a final `message_start` or
				// terminal event can still be sitting in the line buffer here —
				// classifying first would call a complete stream truncated.
				// finalizeUsage's own flush then no-ops. Hoisted above the probe
				// settle because the native verdict below reads the flushed state.
				if (usageState) flushPendingSseLine(usageState);
				// Native passthrough: the backend returned 200 headers and streamed,
				// but the stream itself can still declare failure. Nothing else here
				// can see that — the sniffer matches only Anthropic error types, and
				// `mustSeeMessageStart` is false by construction on this path — so
				// without this the outcome came from the HTTP status alone and a
				// `response.failed` was recorded as a success.
				const nativeEndReason =
					usageState && mustSeeResponsesTerminal
						? classifyNativeResponsesEnd(usageState)
						: null;
				// A `response.failed` does NOT count as recovery evidence: the
				// failure can itself be `server_is_overloaded` / `slow_down`, so
				// treating it as proof the family is healthy is exactly backwards.
				// "abandoned" releases the lease without closing the breaker, leaving
				// the next request free to probe. A truncated (non-native) stream
				// still recovers — see the note above; that case carries no such
				// self-reported failure.
				const cleanEof =
					success &&
					rateLimitSniffer?.firedReason == null &&
					nativeEndReason !== NATIVE_RESPONSES_STREAM_FAILED;
				settleStreamProbe(
					cleanEof ? "recovered" : "abandoned",
					cleanEof ? "clean_eof" : "stream_not_success",
				);
				if (usageState) {
					// A qualifying stream that never produced `message_start` died
					// before any content. Bun reported a clean `done:true`, so the
					// header-only `success` above says 200/OK — but the row would carry
					// no model and no tokens, which is not a success.
					const truncatedBeforeStart =
						mustSeeMessageStart && !usageState.sawMessageStart;
					// R3: finish transport FIRST (terminal responseTimeMs computed
					// here), then finalize usage as a tracked async promise. The stream
					// drained to completion → endedCleanly so the provider's reported
					// output count is trusted (R5).
					const responseTimeMs = Math.max(0, Date.now() - timestamp);
					ctx.requestRecorder.finishTransport(
						requestId,
						rateLimitSniffer.firedReason ||
							truncatedBeforeStart ||
							nativeEndReason
							? "error"
							: success
								? "success"
								: "error",
						// An in-band SSE error frame is the more specific diagnosis and
						// keeps precedence — that path already records correctly, and it
						// CAN fire on a native stream (a native `event: error` carrying
						// `rate_limit_error` matches the sniffer), so this ordering is
						// load-bearing, not cosmetic. `truncatedBeforeStart` is the one
						// that cannot fire natively.
						rateLimitSniffer.firedReason ??
							(truncatedBeforeStart
								? STREAM_TRUNCATED_MID_CONTENT
								: (nativeEndReason ?? undefined)),
					);
					trackFinalize(
						usageState,
						requestId,
						{
							responseTimeMs,
							providerName: ctx.provider.name,
							accountProvider,
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
				// A cut stream still spent whatever the provider had already reported;
				// record it rather than losing the dispatch entirely.
				probeSpend?.finish(Date.now());
				// Flush BEFORE classifying (same rationale as onEnd): a provider that
				// closes abruptly right after the last data byte can leave the terminal
				// event's line unterminated in the SSE line buffer — which is exactly
				// the shape of cut this branch has to judge.
				if (usageState) {
					flushPendingSseLine(usageState);
				}
				const outcome = streamErrorToOutcome(err);
				// A stream whose terminal event was already parsed (`message_stop`, or
				// `response.completed` on the Codex native path — both set
				// `sawMessageStop` together with `providerReportedOutput`) delivered
				// the complete response into the client stream before the cut. Two
				// independent consequences, deliberately decoupled:
				//
				// 1. USAGE (any outcome): the provider's reported token counts are
				//    authoritative → endedCleanly, no bytes/4 anti-undercount max()
				//    (which inflated reasoning-heavy Codex streams ~180x).
				// 2. TRANSPORT: only a GENERIC read error reclassifies to success —
				//    the "error" is then merely the missing clean EOF. Seen at scale
				//    on Codex passthrough under the Bun 1.4 canary, whose fetch
				//    surfaces the ChatGPT backend's abrupt post-response connection
				//    close as a read error where Bun 1.3.14 reported EOF. A client
				//    disconnect or timeout keeps its outcome: an ENQUEUED terminal
				//    chunk does not prove the client consumed it, and a post-terminal
				//    hang is still an operational timeout worth seeing.
				//
				// An in-band SSE error frame wins over both: a fired sniffer keeps
				// the error classification and the untrusted counts.
				// The two consequences above are keyed SEPARATELY, because they ask
				// different questions — the paragraph above has always claimed they
				// were decoupled, but a single `terminalSeen` used to gate both.
				//
				// USAGE trust: did a terminal carrying the provider's own final
				// counts arrive? A Responses terminal is terminal in the protocol —
				// no content follows it — so `response.failed` / `.incomplete` report
				// the backend's billing record for the request just as authoritatively
				// as `response.completed` does. Withholding that trust made finalize
				// take max(exactCount, bytes/4) over every raw SSE frame, inflating
				// counts the backend had already reported precisely.
				//
				// The Responses-terminal arm is what makes this safe for Anthropic.
				// `providerReportedOutput` alone would NOT do: on the Anthropic path
				// every `message_delta` sets it, and a stream cut after the last delta
				// really can have emitted more text — that is the R5 anti-undercount
				// case the max() exists for. `responsesTerminalKind` is non-null only
				// on native passthrough, so for Anthropic and every translated
				// provider this expression stays bit-identical to the old one.
				const usageTerminalSeen =
					usageState?.providerReportedOutput === true &&
					(usageState.sawMessageStop === true ||
						usageState.responsesTerminalKind !== null) &&
					rateLimitSniffer.firedReason == null;
				// TRANSPORT reclassification and the probe verdict: only a CLEAN
				// terminal means the complete response reached the client stream
				// before the cut. A failed response did not become successful because
				// the connection also dropped.
				const terminalSeen =
					usageState?.sawMessageStop === true &&
					usageState.providerReportedOutput === true &&
					rateLimitSniffer.firedReason == null;
				const completedBeforeCut =
					terminalSeen && outcome === "error" && success;
				// Probe verdict: a complete-then-cut stream is the same family-health
				// evidence as a clean EOF (mirrors onEnd's success verdict); a
				// genuinely cut stream releases the lease so another request may probe.
				settleStreamProbe(
					completedBeforeCut ? "recovered" : "abandoned",
					completedBeforeCut
						? "terminal_event_before_cut"
						: "stream_read_error",
				);
				if (usageState) {
					// The read error's message is surfaced nowhere else — log it so
					// runtime-level read-error regressions (e.g. canary end-of-stream
					// shapes) stay visible and reportable. Routine client disconnects
					// go to DEBUG; everything else gets a few INFO samples per boot so
					// the next incident is diagnosable without DEBUG logging enabled.
					const detail =
						`Stream read error for request ${requestId} ` +
						`(provider=${ctx.provider.name}, model=${usageState.model ?? "unknown"}, ` +
						`outcome=${completedBeforeCut ? "success (terminal event seen before cut)" : outcome}, ` +
						`terminalSeen=${terminalSeen}): ${err.name}: ${err.message}`;
					if (outcome !== "disconnect" && readErrorInfoSamples > 0) {
						readErrorInfoSamples--;
						log.info(detail);
					} else {
						log.debug(detail);
					}
					// R3: finish transport FIRST, then finalize. With the terminal event
					// parsed, provider counts are trusted (R5, consequence 1 above).
					// Otherwise the stream was cut mid-content → NOT endedCleanly, so
					// finalize takes max(providerCount, bytes/4) to avoid undercounting
					// a truncated response.
					const responseTimeMs = Math.max(0, Date.now() - timestamp);
					ctx.requestRecorder.finishTransport(
						requestId,
						completedBeforeCut ? "success" : outcome,
					);
					trackFinalize(
						usageState,
						requestId,
						{
							responseTimeMs,
							providerName: ctx.provider.name,
							accountProvider,
							isStream: true,
							// The USAGE key, not the transport one: this decides only
							// whether finalize trusts the provider's counts.
							endedCleanly: usageTerminalSeen,
						},
						ctx,
					);
				}
			},
		});

		// Return the sanitized response backed by the single-reader stream. The
		// upstream's hop-by-hop headers (connection, keep-alive, …) describe ITS
		// link, not the client's — strip them before re-serving (RFC 9110 §7.6.1).
		const clientHeaders = new Headers(response.headers);
		stripHopByHopHeaders(clientHeaders);
		return new Response(clientStream, {
			status: response.status,
			statusText: response.statusText,
			headers: clientHeaders,
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
		response.ok ? "non_stream_2xx" : "non_stream_non_2xx",
	);
	if (!response.body) {
		// No body to read — the dispatch still happened and its status is real, so
		// the row is written with null tokens (no reading, never a fabricated 0).
		probeSpend?.finish(Date.now());
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
					accountProvider,
					isStream: false,
					endedCleanly: true,
				},
				ctx,
			);
		}

		return response;
	}

	const [clientStream, analyticsStream] = response.body.tee();
	// Same hop-by-hop strip as the streaming path: the upstream's link headers
	// must not be re-served to the client.
	const clientHeaders = new Headers(response.headers);
	stripHopByHopHeaders(clientHeaders);
	const clientResponse = new Response(clientStream, {
		status: response.status,
		statusText: response.statusText,
		headers: clientHeaders,
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
				// Tracked EXPLICITLY rather than inferred from `bytesRead`: a body
				// whose chunks sum to exactly the cap leaves the loop through the
				// `while` condition, without EOF and without ever entering the
				// oversize branch below. Warning only from that branch would miss it.
				let observedEof = false;
				// Set by the oversize branch, which SAW bytes past the cap: that is a
				// proven truncation, and the reader is cancelled there, so the
				// disambiguating read below must not run for it (a cancelled reader
				// reports `done` and would erase a true positive).
				let sawDataPastCap = false;
				while (bytesRead < MAX_NON_STREAM_BODY_BYTES) {
					const { value, done } = await reader.read();
					if (done) {
						observedEof = true;
						break;
					}
					const remaining = MAX_NON_STREAM_BODY_BYTES - bytesRead;
					if (value.length <= remaining) {
						chunks.push(value);
						bytesRead += value.length;
					} else {
						chunks.push(value.slice(0, remaining));
						bytesRead += remaining;
						sawDataPastCap = true;
						await reader.cancel();
						break;
					}
				}
				if (
					!observedEof &&
					!sawDataPastCap &&
					bytesRead === MAX_NON_STREAM_BODY_BYTES
				) {
					// Exactly-at-the-cap is ambiguous: the loop left through its `while`
					// condition WITHOUT performing the read that would have reported
					// `done`, so a complete body and a truncated one look identical here.
					// One extra read settles it. A `done` means the body really ended at
					// the cap, its usage is exact, and warning would be a false positive
					// — and since any occurrence of this event is a rollback trigger, a
					// false positive is a false rollback.
					const { done } = await reader.read();
					if (done) observedEof = true;
				}
				if (!observedEof) {
					// The usage collector is fed `cappedBuf`, so a truncated body loses
					// the tail — where a non-streaming response carries its `usage`
					// object. The damage is not an estimate, it is total: the truncated
					// JSON fails to parse, the collector never learns the model, and
					// `RequestRecorder.toRequestUsage()` drops the WHOLE usage summary
					// for a model-less summary. The request row therefore persists with
					// NO tokens and NO cost. Production says non-streaming bodies are far
					// below 256 KiB; this proves it, and names the request if not.
					log.warn(
						`event=${EVENT_ANALYTICS_BODY_CAP_WITHOUT_EOF} ` +
							`requestId=${requestId} capBytes=${MAX_NON_STREAM_BODY_BYTES} ` +
							`bytesRead=${bytesRead} status=${response.status} ` +
							`provider=${ctx.provider.name} accountProvider=${
								accountProvider ?? "unknown"
							} — non-streaming analytics body hit the cap before EOF; ` +
							`the request row will persist with NO usage and NO cost`,
					);
				}
				cappedBuf = Buffer.concat(chunks);
			}
			if (probeSpend) {
				if (cappedBuf.byteLength > 0) {
					probeSpend.feedBody(cappedBuf.toString("utf8"));
				}
				probeSpend.finish(Date.now());
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
						accountProvider,
						isStream: false,
						// Body was fully read (capped) → complete transport, clean end.
						endedCleanly: true,
					},
					ctx,
				);
			}
		} catch (err) {
			// The read failed, so no usage was learned — the row records the
			// dispatch and its status with null tokens.
			probeSpend?.finish(Date.now());
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
						accountProvider,
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
