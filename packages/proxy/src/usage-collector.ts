import {
	isPlausibleSpeed,
	estimateCostUSD as realEstimateCostUSD,
} from "@clankermux/core";
import type { SlimUsageSummary } from "./request-recorder";

/**
 * usage-collector — main-thread, per-request usage/cost computer.
 *
 * Computes per-request usage/cost inline (no worker thread) and needs neither
 * tiktoken nor parsing of high-frequency content deltas:
 *
 *   - Streaming: `feedChunk` is called for every response chunk. It always
 *     stamps timestamps + accumulates a byte count, then decodes the chunk with
 *     a STREAMING `TextDecoder` (so a multi-byte UTF-8 sequence split across a
 *     chunk boundary is reassembled, not corrupted) and appends to a per-state
 *     `lineBuffer`. Only COMPLETE lines (terminated by `\n`) are processed; the
 *     trailing partial line is retained for the next chunk so an `event:`/`data:`
 *     line split across chunk boundaries is never lost. Parsing of a `data:`
 *     payload runs only when it could carry usage (the substring guard). The
 *     `event:`/`data:` pairing is tracked via `currentEvent` carried across
 *     chunks. Two disjoint SSE vocabularies are dispatched by event name:
 *       - Anthropic (`message_*`): `message_start` supplies input/cache/model;
 *         `message_delta` supplies the authoritative cumulative
 *         `output_tokens`; `message_stop` sets `sawMessageStop`.
 *       - Codex-Responses (`response.*`, native Responses passthrough):
 *         `response.created` supplies the model; `response.completed` supplies
 *         the authoritative usage (input/output + cached-token details) and
 *         sets `sawMessageStop`. All other `response.*` events are no-ops.
 *     `content_block_delta`/`text_delta`/`response.output_text.delta` are
 *     NEVER parsed for tokens.
 *
 *   - Non-stream: `feedNonStreamBody` parses the (capped) JSON body once. A
 *     `usage` object is authoritative; otherwise the body length seeds the
 *     bytes/4 fallback.
 *
 *   - `finalizeUsage` first flushes any complete-but-unterminated buffered line,
 *     then resolves the final output-token count via the precedence rule below,
 *     computes total tokens, cost (via an injected/real `estimateCostUSD`), and
 *     tokens/sec (zai = total time; others = streaming duration from first/last
 *     chunk timestamps), and returns a `SlimUsageSummary` the RequestRecorder
 *     can attach.
 *
 * PRECEDENCE: an explicit `providerReportedOutput` flag is set ONLY by
 * `message_delta` (streaming) or a non-stream `usage` object — never by
 * `message_start` (whose `output_tokens` is a placeholder 0/1). If the provider
 * reported a count AND the stream ended cleanly, we trust it (even if 0).
 * Otherwise we approximate from streamed bytes (ceil(bytes/4)) and flag it.
 *
 * R5 (non-clean endings): on a disconnect/timeout/error the provider may have
 * reported only a stale partial `output_tokens` before the stream was cut. When
 * `endedCleanly` is false and the provider DID report, finalize takes
 * `max(providerCount, ceil(bytes/4))` and flags `outputApproximate`, so a
 * truncated stream that kept emitting text after the last `message_delta` isn't
 * undercounted.
 */

export interface UsageState {
	model: string | undefined;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	/**
	 * The authoritative cumulative output-token count last seen from the
	 * provider (`message_delta` while streaming, or a non-stream `usage`
	 * object). `undefined` until the provider reports one.
	 */
	providerFinalOutputTokens: number | undefined;
	/**
	 * True once the provider reported an output-token count we should trust.
	 * Set ONLY by `message_delta` (streaming) or a non-stream `usage` object —
	 * never by `message_start` (whose `output_tokens` is a placeholder 0/1).
	 */
	providerReportedOutput: boolean;
	/** Total response bytes seen (drives the bytes/4 output fallback). */
	streamedBytes: number;
	firstChunkTs: number | undefined;
	lastChunkTs: number | undefined;
	/**
	 * Streaming UTF-8 decoder. Per-state (NOT module-shared) so a multi-byte
	 * sequence split across a chunk boundary is reassembled with `{stream:true}`
	 * rather than emitting a replacement char that could desync line buffering.
	 */
	decoder: TextDecoder;
	/**
	 * Decoded-but-not-yet-newline-terminated text carried across chunks. Only
	 * complete lines are processed; this holds the trailing partial.
	 */
	lineBuffer: string;
	/**
	 * The most recent `event:` line's type, carried across chunks so an
	 * `event:`/`data:` pair split over a boundary still associates correctly.
	 */
	currentEvent: string | undefined;
	/** True once a `message_stop` event was seen (clean-ending signal). */
	sawMessageStop: boolean;
	/**
	 * True while we're discarding an overlong, newline-free line (see
	 * `MAX_SSE_LINE_BYTES`). Once the `lineBuffer` exceeds the cap without a
	 * terminating `\n`, the buffered content is dropped and this flag is set so
	 * every subsequent chunk is discarded UNTIL the next `\n` resyncs parsing on
	 * the following line. Bounds main-thread memory against an upstream that
	 * never emits a newline (small leak / DoS guard).
	 */
	skippingOverlongLine: boolean;
}

/**
 * Cap on the decoded, not-yet-newline-terminated `lineBuffer`. A single SSE
 * line should never approach this — a `message_start` carrying a large system
 * prompt is the biggest legitimate line and stays well under 256KB. Anything
 * larger is treated as a runaway/never-terminated line: it is discarded and
 * skipped (not JSON-parsed) until the next newline resyncs the parser.
 */
export const MAX_SSE_LINE_BYTES = 256 * 1024;

/**
 * Test/diagnostic accessor for the retained partial-line buffer length, used to
 * assert the buffer stays bounded under newline-free input.
 */
export function getLineBufferLength(state: UsageState): number {
	return state.lineBuffer.length;
}

export function createUsageState(): UsageState {
	return {
		model: undefined,
		inputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		providerFinalOutputTokens: undefined,
		providerReportedOutput: false,
		streamedBytes: 0,
		firstChunkTs: undefined,
		lastChunkTs: undefined,
		decoder: new TextDecoder(),
		lineBuffer: "",
		currentEvent: undefined,
		sawMessageStop: false,
		skippingOverlongLine: false,
	};
}

/**
 * Substring guard: only bother JSON-parsing an SSE `data:` payload when it could
 * carry usage. A pure `text_delta` payload contains neither marker, so it's a
 * no-op past decode + byte accounting.
 */
function dataMayCarryUsage(data: string): boolean {
	return (
		data.includes("usage") || data.includes("message") || data.includes("model")
	);
}

/** Parse one already-trimmed SSE line into its event or data component. */
function parseSSELine(line: string): { event?: string; data?: string } {
	if (line.startsWith("event: ") || line.startsWith("event:")) {
		const event = line.startsWith("event: ")
			? line.slice(7).trim()
			: line.slice(6).trim();
		return { event };
	}
	if (line.startsWith("data: ") || line.startsWith("data:")) {
		const data = line.startsWith("data: ")
			? line.slice(6).trim()
			: line.slice(5).trim();
		return { data };
	}
	return {};
}

interface SseParsed {
	type?: string;
	model?: string;
	message?: {
		model?: string;
		usage?: {
			input_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
			output_tokens?: number;
		};
	};
	usage?: {
		input_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		output_tokens?: number;
	};
	/**
	 * Codex-Responses vocabulary (native Responses passthrough):
	 * `response.created` / `response.completed` carry a `response` envelope —
	 * model on created, OpenAI-shaped usage (cached-token info nested under
	 * `input_tokens_details`) on completed. Mirrors the shape
	 * CodexProvider.transformStreamingResponse parses.
	 */
	response?: {
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			input_tokens_details?: {
				cached_tokens?: number;
				cache_creation_input_tokens?: number;
			};
		};
	};
}

/**
 * Apply a parsed SSE `data:` object to the state. Dispatch is by event name
 * across two disjoint vocabularies:
 *   - Anthropic: ONLY `message_start` (input/cache/model) and `message_delta`
 *     (cumulative output_tokens → providerReportedOutput) are honoured.
 *     content_block_delta / text_delta are intentionally ignored.
 *     `message_stop` flips `sawMessageStop`.
 *   - Codex-Responses (native passthrough): `response.created` supplies the
 *     model, `response.completed` supplies the authoritative usage. All other
 *     `response.*` events are no-ops.
 */
function applySseData(
	parsed: SseParsed,
	eventType: string,
	state: UsageState,
): void {
	const isMessageStart =
		parsed.type === "message_start" || eventType === "message_start";
	if (isMessageStart) {
		// Most shapes nest usage/model under `message`; some put them at the top
		// level of the message_start data (S6) — handle both, preferring nested.
		const usage = parsed.message?.usage ?? parsed.usage;
		const model = parsed.message?.model ?? parsed.model;
		if (usage) {
			if (usage.input_tokens !== undefined)
				state.inputTokens = usage.input_tokens;
			if (usage.cache_read_input_tokens !== undefined)
				state.cacheReadInputTokens = usage.cache_read_input_tokens;
			if (usage.cache_creation_input_tokens !== undefined)
				state.cacheCreationInputTokens = usage.cache_creation_input_tokens;
			// NOTE: message_start's output_tokens is a placeholder (0/1). It does
			// NOT set providerReportedOutput — only message_delta does.
		}
		if (model) state.model = model;
	}

	const isMessageDelta =
		parsed.type === "message_delta" || eventType === "message_delta";
	if (isMessageDelta && parsed.usage) {
		const u = parsed.usage;
		if (u.output_tokens !== undefined) {
			state.providerFinalOutputTokens = u.output_tokens;
			state.providerReportedOutput = true;
		}
		if (u.input_tokens !== undefined) state.inputTokens = u.input_tokens;
		if (u.cache_read_input_tokens !== undefined)
			state.cacheReadInputTokens = u.cache_read_input_tokens;
		if (u.cache_creation_input_tokens !== undefined)
			state.cacheCreationInputTokens = u.cache_creation_input_tokens;
	}

	if (parsed.type === "message_stop" || eventType === "message_stop") {
		state.sawMessageStop = true;
	}

	// ── Codex-Responses vocabulary (native Responses passthrough) ────────────
	// On the native path the stream is raw Codex-Responses SSE (`response.*`
	// events) instead of Anthropic SSE. Field mapping mirrors
	// CodexProvider.handleCodexEvent: the model comes from `response.created`'s
	// `response.model`; usage comes from `response.completed`'s
	// `response.usage` (OpenAI shape, cached-token info nested under
	// `input_tokens_details` with the same >= 0 guards).
	const isResponseCreated =
		parsed.type === "response.created" || eventType === "response.created";
	if (isResponseCreated && parsed.response?.model) {
		state.model = parsed.response.model;
	}

	const isResponseCompleted =
		parsed.type === "response.completed" || eventType === "response.completed";
	if (isResponseCompleted) {
		const usage = parsed.response?.usage;
		if (usage) {
			if (typeof usage.input_tokens === "number") {
				state.inputTokens = usage.input_tokens;
			}
			if (typeof usage.output_tokens === "number") {
				// `response.completed` is the terminal event — its count is the Codex
				// analogue of Anthropic's authoritative `message_delta`.
				state.providerFinalOutputTokens = usage.output_tokens;
				state.providerReportedOutput = true;
			}
			const inputTokenDetails = usage.input_tokens_details;
			if (
				typeof inputTokenDetails?.cached_tokens === "number" &&
				inputTokenDetails.cached_tokens >= 0
			) {
				state.cacheReadInputTokens = inputTokenDetails.cached_tokens;
			}
			if (
				typeof inputTokenDetails?.cache_creation_input_tokens === "number" &&
				inputTokenDetails.cache_creation_input_tokens >= 0
			) {
				state.cacheCreationInputTokens =
					inputTokenDetails.cache_creation_input_tokens;
			}
		}
		// Terminal event — the Codex analogue of message_stop (diagnostic-only
		// clean-ending signal; endedCleanly is still the caller's flag).
		state.sawMessageStop = true;
	}
}

/**
 * Process one COMPLETE (newline-stripped) SSE line: update `currentEvent` for
 * `event:` lines; for `data:` lines, parse JSON only when the substring guard
 * passes. Shared by feedChunk (per complete line) and the finalize flush.
 */
function processLine(state: UsageState, rawLine: string): void {
	const line = rawLine.trim();
	if (!line) return;
	const parsed = parseSSELine(line);
	if (parsed.event !== undefined) {
		state.currentEvent = parsed.event;
		return;
	}
	if (!parsed.data) return;
	if (!parsed.data.startsWith("{")) return;
	// Guard per data line so a non-usage event (e.g. ping) isn't parsed.
	if (!dataMayCarryUsage(parsed.data)) return;
	try {
		const obj = JSON.parse(parsed.data) as SseParsed;
		applySseData(obj, state.currentEvent ?? "", state);
	} catch {
		// Silent — non-JSON or still-partial data line.
	}
}

/**
 * Feed a streaming response chunk. Always stamps timestamps + accumulates the
 * byte count. Decodes incrementally (stream:true) into a per-state line buffer
 * and processes only COMPLETE lines, so an event/data line — or even a single
 * multi-byte UTF-8 char — split across chunk boundaries is never lost (B1).
 */
export function feedChunk(
	state: UsageState,
	chunk: Uint8Array,
	now: number,
): void {
	if (state.firstChunkTs === undefined) state.firstChunkTs = now;
	state.lastChunkTs = now;
	state.streamedBytes += chunk.byteLength;

	// Streaming decode reassembles multi-byte sequences across boundaries.
	state.lineBuffer += state.decoder.decode(chunk, { stream: true });

	// Skip mode: we're inside an overlong, never-terminated line that was already
	// discarded. Drop everything up to and including the next `\n` (which ends the
	// runaway line) and resume normal parsing on the line after it. If no newline
	// is in the buffer yet, discard it all and stay in skip mode.
	if (state.skippingOverlongLine) {
		const nl = state.lineBuffer.indexOf("\n");
		if (nl === -1) {
			state.lineBuffer = "";
			return;
		}
		state.lineBuffer = state.lineBuffer.slice(nl + 1);
		state.skippingOverlongLine = false;
	}

	// Process only complete lines; retain the trailing partial in lineBuffer.
	let newlineIdx = state.lineBuffer.indexOf("\n");
	while (newlineIdx !== -1) {
		const rawLine = state.lineBuffer.slice(0, newlineIdx);
		state.lineBuffer = state.lineBuffer.slice(newlineIdx + 1);
		processLine(state, rawLine);
		newlineIdx = state.lineBuffer.indexOf("\n");
	}

	// Cap guard: the trailing partial (no newline yet) must never grow without
	// bound. If it exceeds the cap, the line is runaway/never-terminated — discard
	// the buffered content and arm skip mode so following chunks are dropped until
	// the next `\n`. We never JSON-parse a truncated overlong line.
	if (state.lineBuffer.length > MAX_SSE_LINE_BYTES) {
		state.lineBuffer = "";
		state.skippingOverlongLine = true;
	}
}

/**
 * Flush any complete-but-unterminated buffered line at stream end. The provider
 * may close the connection right after the last `data:` byte with no trailing
 * newline; without this flush that final `message_delta` would be lost.
 */
function flushLineBuffer(state: UsageState): void {
	// Drain the streaming decoder (no-op if no bytes are pending).
	const tail = state.decoder.decode();
	if (tail) state.lineBuffer += tail;
	// If we ended mid-discard of an overlong, never-terminated line, the buffered
	// tail is part of that runaway line — drop it, never parse a truncated line.
	if (state.skippingOverlongLine) {
		state.lineBuffer = "";
		return;
	}
	if (state.lineBuffer.length === 0) return;
	const rawLine = state.lineBuffer;
	state.lineBuffer = "";
	processLine(state, rawLine);
}

/**
 * Feed a non-stream (capped) response body. A `usage` object is authoritative
 * (sets providerReportedOutput); otherwise the body length seeds the bytes/4
 * output fallback.
 */
export function feedNonStreamBody(state: UsageState, bodyText: string): void {
	try {
		const json = JSON.parse(bodyText) as SseParsed;
		const usage = json.usage;
		if (usage) {
			if (json.model) state.model = json.model;
			state.inputTokens = usage.input_tokens ?? 0;
			state.cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
			state.cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
			state.providerFinalOutputTokens = usage.output_tokens ?? 0;
			state.providerReportedOutput = true;
			return;
		}
		if (json.model) state.model = json.model;
	} catch {
		// Non-JSON body — fall through to the byte fallback.
	}
	// No usage object → seed the bytes/4 fallback from the body length.
	state.streamedBytes = bodyText.length;
}

export interface FinalizeOpts {
	responseTimeMs: number;
	providerName: string;
	isStream: boolean;
	/**
	 * Whether the response stream ended cleanly (R5). Pass `true` for a
	 * successful/complete transport ('success', or a `message_stop` was seen),
	 * `false` for a disconnect/timeout/error. When the provider reported an
	 * output count but the stream did NOT end cleanly, finalize takes
	 * `max(providerCount, ceil(bytes/4))` and flags the result approximate so a
	 * truncated stream that kept emitting text after the last `message_delta`
	 * isn't undercounted. Defaults to `true` (back-compat: trust the provider).
	 */
	endedCleanly?: boolean;
}

export interface FinalizeDeps {
	estimateCostUSD?: typeof realEstimateCostUSD;
	nowMs?: number;
}

export type FinalizedUsage = SlimUsageSummary & { outputApproximate?: boolean };

/**
 * Resolve final usage. Returns a `SlimUsageSummary` (without `requestId` — the
 * caller attaches it via `attachUsageSummary(requestId, summary)`), plus an
 * `outputApproximate` flag set when the output count came from the bytes/4
 * fallback rather than the provider.
 */
export async function finalizeUsage(
	state: UsageState,
	opts: FinalizeOpts,
	deps: FinalizeDeps = {},
): Promise<FinalizedUsage> {
	const estimateCostUSD = deps.estimateCostUSD ?? realEstimateCostUSD;

	// Flush any complete-but-unterminated buffered line (e.g. the provider closed
	// the stream right after the last data: byte with no trailing newline).
	flushLineBuffer(state);

	// Cleanliness: an explicit caller flag wins. The response-handler passes
	// `true` whenever the stream reached natural EOF (onEnd) — truncation, NOT
	// HTTP success, is what this flag tracks — and `false` only on a
	// disconnect/timeout/read error (onError). `sawMessageStop` is still tracked
	// on state as a diagnostic signal but no longer feeds this flag. Absent any
	// caller flag, default to clean for back-compat (trust the provider's count).
	const endedCleanly = opts.endedCleanly ?? true;

	// PRECEDENCE + R5: trust the provider's count when it reported one AND the
	// stream ended cleanly (even a 0 is authoritative then). On a non-clean end
	// the reported count may be stale/partial, so take the larger of it and the
	// bytes/4 estimate. With no provider count at all, always estimate.
	const byteEstimate = Math.ceil(state.streamedBytes / 4);
	let outputApproximate = false;
	let finalOutput: number;
	if (state.providerReportedOutput) {
		const reported = state.providerFinalOutputTokens ?? 0;
		if (endedCleanly) {
			finalOutput = reported;
		} else {
			finalOutput = Math.max(reported, byteEstimate);
			outputApproximate = true;
		}
	} else {
		finalOutput = byteEstimate;
		outputApproximate = true;
	}

	const totalTokens =
		state.inputTokens +
		state.cacheReadInputTokens +
		state.cacheCreationInputTokens +
		finalOutput;

	const model = state.model;
	const costUsd =
		model !== undefined
			? await estimateCostUSD(model, {
					inputTokens: state.inputTokens,
					outputTokens: finalOutput,
					cacheReadInputTokens: state.cacheReadInputTokens,
					cacheCreationInputTokens: state.cacheCreationInputTokens,
				})
			: undefined;

	const tokensPerSecond = computeTokensPerSecond(state, finalOutput, opts);

	const summary: FinalizedUsage = {
		// requestId is attached by the caller via attachUsageSummary(id, summary).
		requestId: "",
		usage: {
			model,
			inputTokens: state.inputTokens,
			outputTokens: finalOutput,
			cacheReadInputTokens: state.cacheReadInputTokens,
			cacheCreationInputTokens: state.cacheCreationInputTokens,
			totalTokens,
			costUsd,
		},
		tokensPerSecond,
		responseTimeMs: opts.responseTimeMs,
		cacheCreationInputTokens: state.cacheCreationInputTokens,
	};
	if (outputApproximate) summary.outputApproximate = true;
	return summary;
}

/**
 * Tokens/sec, with zai-vs-streaming-duration handling:
 *   - zai (glm-*) → finalOutput / (responseTimeMs / 1000) [total time].
 *   - others → streaming duration (lastChunkTs - firstChunkTs)/1000 when both
 *     present and > 0, else fall back to total responseTimeMs / 1000.
 *
 * Returns undefined when there's no output, no usable duration, or the result
 * is implausibly large. The latter two cases used to divide by a 0.001s floor,
 * which turned a sub-millisecond/zero measured duration into an astronomical
 * tok/s artifact (e.g. 137 tokens → 137,000 tok/s) that then skewed every
 * analytics average. We now record NULL instead: no measurable duration means
 * we genuinely don't know the speed, and `isPlausibleSpeed` (shared with the
 * analytics SQL filter) discards anything above MAX_PLAUSIBLE_TOKENS_PER_SECOND.
 */
function computeTokensPerSecond(
	state: UsageState,
	finalOutput: number,
	opts: FinalizeOpts,
): number | undefined {
	if (finalOutput <= 0) return undefined;

	const totalDurationSec = opts.responseTimeMs / 1000;
	const isZaiModel = state.model?.startsWith("glm-") ?? false;

	let result: number | undefined;
	if (isZaiModel) {
		if (totalDurationSec > 0) result = finalOutput / totalDurationSec;
	} else {
		// Other providers: prefer streaming duration from first/last chunk ts.
		if (state.firstChunkTs !== undefined && state.lastChunkTs !== undefined) {
			const streamingDurationMs = state.lastChunkTs - state.firstChunkTs;
			if (streamingDurationMs > 0) {
				result = finalOutput / (streamingDurationMs / 1000);
			}
		}
		if (result === undefined && totalDurationSec > 0) {
			result = finalOutput / totalDurationSec;
		}
	}

	// No usable duration, or a sub-ms-duration artifact: record nothing.
	if (result === undefined || !isPlausibleSpeed(result)) return undefined;
	return result;
}
