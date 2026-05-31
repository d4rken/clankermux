declare var self: Worker;

import {
	BUFFER_SIZES,
	estimateCostUSD,
	TIME_CONSTANTS,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { formatCost } from "@clankermux/ui-common";
import model from "@dqbd/tiktoken/encoders/cl100k_base.json";
import { init, Tiktoken } from "@dqbd/tiktoken/lite/init";
import { EMBEDDED_TIKTOKEN_WASM } from "./embedded-tiktoken-wasm";
import type {
	AckMessage,
	ChunkMessage,
	EndMessage,
	ReadyMessage,
	ShutdownCompleteMessage,
	StartMessage,
	SummaryMessage,
	WorkerMessage,
} from "./worker-messages";

/**
 * Pure usage/cost computer.
 *
 * This worker used to own request persistence: it received the (up-to-4MB)
 * request body via StartMessage transfer, accumulated the response body,
 * derived billing type, fired account side-effects, and wrote requests /
 * routing / payload rows to the DB. That made it the source of the proxy's
 * memory leak — Bun #5709 never reclaims the structured-clone backing stores
 * of large transferred payloads in a long-lived worker, even after deref +
 * Bun.gc(true).
 *
 * All of that moved to the main-thread RequestRecorder. The worker now holds
 * only tiny per-request usage counters: it parses SSE (streaming) or the
 * 256KB-capped response body (non-stream) to extract token usage + cost +
 * tokens/sec, then posts a SLIM SummaryMessage back. No request body, no
 * response-body accumulation, no DB, no account side-effects, no project
 * extraction. Response chunks are parsed transiently and dropped.
 */

interface RequestState {
	requestId: string;
	timestamp: number;
	buffer: string;
	streamDecoder: TextDecoder;
	usage: {
		model?: string;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
		outputTokensComputed?: number;
		totalTokens?: number;
		costUsd?: number;
		tokensPerSecond?: number;
	};
	lastActivity: number;
	createdAt: number; // TTL tracking
	firstTokenTimestamp?: number;
	lastTokenTimestamp?: number;
	providerFinalOutputTokens?: number;
	currentEvent?: string; // Track SSE event type across chunks
}

const log = new Logger("PostProcessor");
const requests = new Map<string, RequestState>();

console.log("[WORKER] Post-processor worker started");
log.info("Post-processor worker started");

// Limits to prevent unbounded growth.
const MAX_REQUESTS_MAP_SIZE = 10000;
// Realigned to the stream's own total + inactivity windows (see B2). The old
// 2-minute TTL deleted active per-request state before EndMessage on legitimate
// long streams, losing usage entirely. The slim worker holds only tiny usage
// counters, so this larger TTL costs nothing while it bounds genuinely-orphaned
// state. ~35 minutes = total stream timeout (30m) + chunk timeout (5m).
const REQUEST_TTL_MS =
	TIME_CONSTANTS.STREAM_FORWARD_TOTAL_TIMEOUT_MS +
	TIME_CONSTANTS.STREAM_FORWARD_CHUNK_TIMEOUT_MS;

// Initialize tiktoken encoder (cl100k_base is used for Claude models)
// Using embedded WASM to avoid "Missing tiktoken_bg.wasm" errors in bunx
let tokenEncoder: Tiktoken | null = null;

(async () => {
	try {
		// Decode embedded WASM from base64
		const wasmBuffer = Buffer.from(EMBEDDED_TIKTOKEN_WASM, "base64");

		// Initialize tiktoken with embedded WASM
		await init((imports) => WebAssembly.instantiate(wasmBuffer, imports));

		// Create encoder with cl100k_base model
		tokenEncoder = new Tiktoken(
			model.bpe_ranks,
			model.special_tokens,
			model.pat_str,
		);

		log.info("Tiktoken encoder initialized successfully with embedded WASM");
		self.postMessage({ type: "ready" } satisfies ReadyMessage);
	} catch (error) {
		log.error("Failed to initialize tiktoken encoder:", error);
		console.error("[WORKER] Tiktoken initialization failed:", error);
	}
})();

// Environment variables
const MAX_BUFFER_SIZE =
	Number(
		process.env.CF_STREAM_USAGE_BUFFER_KB ||
			BUFFER_SIZES.STREAM_USAGE_BUFFER_KB,
	) * 1024;
const TIMEOUT_MS = Number(
	process.env.CF_STREAM_TIMEOUT_MS || TIME_CONSTANTS.STREAM_TIMEOUT_DEFAULT,
);

// Parse SSE lines to extract usage (reuse existing logic)
function parseSSELine(line: string): { event?: string; data?: string } {
	// Handle both "event: message_start" and "event:message_start" formats
	// Some providers use no space after colon, Anthropic uses space
	if (line.startsWith("event: ") || line.startsWith("event:")) {
		const event = line.startsWith("event: ")
			? line.slice(7).trim()
			: line.slice(6).trim();
		return { event };
	}
	// Handle both "data: {...}" and "data:{...}" formats
	if (line.startsWith("data: ") || line.startsWith("data:")) {
		const data = line.startsWith("data: ")
			? line.slice(6).trim()
			: line.slice(5).trim();
		return { data };
	}
	return {};
}

function shouldParseSSEData(data: string, eventType: string): boolean {
	if (!data.startsWith("{")) return false;

	switch (eventType) {
		case "message_start":
		case "message_delta":
		case "content_block_start":
		case "content_block_delta":
			return true;
		default:
			return (
				data.includes("usage") ||
				data.includes("message") ||
				data.includes("model")
			);
	}
}

function processSSELine(line: string, state: RequestState): void {
	const trimmed = line.trim();
	if (!trimmed) return;

	const parsed = parseSSELine(trimmed);
	if (parsed.event) {
		state.currentEvent = parsed.event;
	} else if (
		parsed.data &&
		state.currentEvent &&
		shouldParseSSEData(parsed.data, state.currentEvent)
	) {
		extractUsageFromData(parsed.data, state.currentEvent, state);
	}
}

// Extract usage data from non-stream JSON response bodies
function extractUsageFromJson(
	json: {
		model?: string;
		usage?: {
			input_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
			output_tokens?: number;
		};
	},
	state: RequestState,
): void {
	if (!json) return;

	const usageObj = json.usage;
	if (!usageObj) return;

	state.usage.model = json.model ?? state.usage.model;

	state.usage.inputTokens = usageObj.input_tokens ?? 0;
	state.usage.cacheReadInputTokens = usageObj.cache_read_input_tokens ?? 0;
	state.usage.cacheCreationInputTokens =
		usageObj.cache_creation_input_tokens ?? 0;
	state.usage.outputTokens = usageObj.output_tokens ?? 0;

	// Calculate total tokens
	const prompt =
		(state.usage.inputTokens ?? 0) +
		(state.usage.cacheReadInputTokens ?? 0) +
		(state.usage.cacheCreationInputTokens ?? 0);
	const completion = state.usage.outputTokens ?? 0;
	state.usage.totalTokens = prompt + completion;
}

function extractUsageFromData(
	data: string,
	eventType: string,
	state: RequestState,
): void {
	try {
		const parsed = JSON.parse(data);

		// Handle message_start - check both parsed.type and eventType
		// (Some providers put type in event line, Anthropic puts it in JSON)
		const isMessageStart =
			parsed.type === "message_start" || eventType === "message_start";
		if (isMessageStart) {
			if (parsed.message?.usage) {
				const usage = parsed.message.usage;
				state.usage.inputTokens = usage.input_tokens || 0;
				state.usage.cacheReadInputTokens = usage.cache_read_input_tokens || 0;
				state.usage.cacheCreationInputTokens =
					usage.cache_creation_input_tokens || 0;
				state.usage.outputTokens = usage.output_tokens || 0;
			}
			if (parsed.message?.model) {
				state.usage.model = parsed.message.model;
			}
		}

		// Track streaming start time on first content block
		if (parsed.type === "content_block_start" && !state.firstTokenTimestamp) {
			state.firstTokenTimestamp = Date.now();
		}

		// Handle message_delta - check both parsed.type and eventType
		const isMessageDelta =
			parsed.type === "message_delta" || eventType === "message_delta";
		if (isMessageDelta) {
			state.lastTokenTimestamp = Date.now();

			if (parsed.usage) {
				// Update all token counts from message_delta (authoritative for zai)
				if (parsed.usage.output_tokens !== undefined) {
					state.providerFinalOutputTokens = parsed.usage.output_tokens;
					state.usage.outputTokens = parsed.usage.output_tokens;
				}
				if (parsed.usage.input_tokens !== undefined) {
					state.usage.inputTokens = parsed.usage.input_tokens;
				}
				if (parsed.usage.cache_read_input_tokens !== undefined) {
					state.usage.cacheReadInputTokens =
						parsed.usage.cache_read_input_tokens;
				}
				return; // No further processing needed
			}
			// Even if no usage info, we still set the timestamp for duration calculation
		}

		// Count tokens locally as fallback (but provider's count takes precedence)
		if (
			parsed.type === "content_block_delta" &&
			parsed.delta &&
			state.providerFinalOutputTokens === undefined // Avoid double counting
		) {
			let textToCount: string | undefined;

			// Extract text from different delta types
			if (parsed.delta.type === "text_delta" && parsed.delta.text) {
				textToCount = parsed.delta.text;
			} else if (
				parsed.delta.type === "thinking_delta" &&
				parsed.delta.thinking
			) {
				textToCount = parsed.delta.thinking;
			}

			if (textToCount && tokenEncoder) {
				// Count tokens using tiktoken
				try {
					const tokens = tokenEncoder.encode(textToCount);
					state.usage.outputTokensComputed =
						(state.usage.outputTokensComputed || 0) + tokens.length;
				} catch (err) {
					log.debug("Failed to count tokens:", err);
				}
			}
		}

		// Handle any usage field in the data
		if (parsed.usage) {
			if (parsed.usage.input_tokens !== undefined) {
				state.usage.inputTokens = parsed.usage.input_tokens;
			}
			if (parsed.usage.output_tokens !== undefined) {
				state.usage.outputTokens = parsed.usage.output_tokens;
			}
			if (parsed.usage.cache_read_input_tokens !== undefined) {
				state.usage.cacheReadInputTokens = parsed.usage.cache_read_input_tokens;
			}
			if (parsed.usage.cache_creation_input_tokens !== undefined) {
				state.usage.cacheCreationInputTokens =
					parsed.usage.cache_creation_input_tokens;
			}
		}
	} catch {
		// Silent fail for non-JSON lines
	}
}

function processStreamChunk(chunk: Uint8Array, state: RequestState): void {
	const text = state.streamDecoder.decode(chunk, { stream: true });
	state.buffer += text;
	state.lastActivity = Date.now();

	// Limit buffer size - preserve event boundaries
	if (state.buffer.length > MAX_BUFFER_SIZE) {
		const excess = state.buffer.length - MAX_BUFFER_SIZE;
		// Find the first newline after cutting the excess to avoid cutting mid-event
		const firstNewlineAfterCut = state.buffer.indexOf("\n", excess);
		if (firstNewlineAfterCut !== -1) {
			state.buffer = state.buffer.slice(firstNewlineAfterCut + 1);
		} else {
			// Fallback: if no newline found, slice from end but this might cut mid-event
			state.buffer = state.buffer.slice(-MAX_BUFFER_SIZE);
		}
	}

	let lineStart = 0;
	for (;;) {
		const lineEnd = state.buffer.indexOf("\n", lineStart);
		if (lineEnd === -1) break;

		processSSELine(state.buffer.slice(lineStart, lineEnd), state);
		lineStart = lineEnd + 1;
	}

	if (lineStart > 0) {
		state.buffer = state.buffer.slice(lineStart);
	}
}

function handleStart(msg: StartMessage): void {
	self.postMessage({
		type: "ack",
		messageId: msg.messageId,
	} satisfies AckMessage);

	// Emergency cleanup if map is at capacity (shouldn't happen with periodic cleanup)
	if (requests.size >= MAX_REQUESTS_MAP_SIZE) {
		log.error(
			`Requests map at capacity (${MAX_REQUESTS_MAP_SIZE})! Running emergency cleanup...`,
		);
		cleanupStaleRequests();

		// If still at capacity after cleanup, force evict oldest 10%
		if (requests.size >= MAX_REQUESTS_MAP_SIZE) {
			const toRemove = Math.floor(MAX_REQUESTS_MAP_SIZE * 0.1);
			const sortedByAge = Array.from(requests.entries()).sort(
				(a, b) => a[1].createdAt - b[1].createdAt,
			);

			log.error(
				`Emergency cleanup insufficient, force evicting ${toRemove} oldest entries...`,
			);

			for (let i = 0; i < toRemove; i++) {
				const [id] = sortedByAge[i];
				requests.delete(id);
			}
		}
	}

	// Create tiny request state — usage counters only. No body, no chunks, no
	// DB, no account side-effects: those all moved to RequestRecorder.
	const now = Date.now();
	const state: RequestState = {
		requestId: msg.requestId,
		timestamp: msg.timestamp,
		buffer: "",
		streamDecoder: new TextDecoder(),
		usage: {},
		lastActivity: now,
		createdAt: now,
	};

	requests.set(msg.requestId, state);
}

function handleChunk(msg: ChunkMessage): void {
	const state = requests.get(msg.requestId);
	if (!state) {
		log.warn(`No state found for request ${msg.requestId}`);
		return;
	}

	// Parse for usage extraction only. The chunk is NOT stored — the
	// RequestRecorder on the main thread captures the (256KB-capped) response
	// body for Request History. The worker's parse stream is UNCAPPED so
	// tiktoken output-token counting matches the full output (N2).
	processStreamChunk(msg.data, state);
}

async function handleEnd(msg: EndMessage): Promise<void> {
	const state = requests.get(msg.requestId);
	if (!state) {
		log.warn(`No state found for request ${msg.requestId}`);
		return;
	}

	const responseTime = Date.now() - state.timestamp;

	// Flush any incomplete multi-byte UTF-8 sequences held in the streaming decoder
	const trailing = state.streamDecoder.decode();
	if (trailing) {
		state.buffer += trailing;
		const lines = state.buffer.split("\n");
		state.buffer = lines.pop() ?? "";
		for (const line of lines) {
			processSSELine(line, state);
		}
	}

	// For non-stream responses, extract usage data from response body
	if (!state.usage.model && msg.responseBody) {
		try {
			const decoded = Buffer.from(msg.responseBody, "base64").toString("utf-8");
			const json = JSON.parse(decoded);
			extractUsageFromJson(json, state);
		} catch {
			// Ignore parse errors
		}
	}

	// Calculate total tokens and cost
	if (state.usage.model) {
		// Use provider's authoritative count if available, fallback to computed
		const finalOutputTokens =
			state.providerFinalOutputTokens ??
			state.usage.outputTokens ??
			state.usage.outputTokensComputed ??
			0;

		// Update usage with final values
		state.usage.outputTokens = finalOutputTokens;
		state.usage.outputTokensComputed = undefined; // Clear to avoid confusion

		state.usage.totalTokens =
			(state.usage.inputTokens || 0) +
			finalOutputTokens +
			(state.usage.cacheReadInputTokens || 0) +
			(state.usage.cacheCreationInputTokens || 0);

		state.usage.costUsd = await estimateCostUSD(state.usage.model, {
			inputTokens: state.usage.inputTokens,
			outputTokens: finalOutputTokens,
			cacheReadInputTokens: state.usage.cacheReadInputTokens,
			cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
		});

		// Calculate tokens per second - zai specific vs other providers
		if (finalOutputTokens > 0) {
			const totalDurationSec = responseTime / 1000;

			if (totalDurationSec > 0) {
				// Check if this is a zai model (glm-*)
				const isZaiModel = state.usage.model?.startsWith("glm-");

				if (isZaiModel) {
					// For zai models, use total response time (more intuitive for users)
					state.usage.tokensPerSecond = finalOutputTokens / totalDurationSec;
					if (
						process.env.DEBUG?.includes("worker") ||
						process.env.DEBUG === "true" ||
						process.env.NODE_ENV === "development"
					) {
						log.debug(
							`ZAI token/s calculation: ${finalOutputTokens} tokens / ${totalDurationSec}s = ${state.usage.tokensPerSecond} tok/s (using total response time: ${responseTime}ms)`,
						);
					}
				} else {
					// For other providers (like Anthropic), use streaming duration if available
					if (state.firstTokenTimestamp && state.lastTokenTimestamp) {
						const streamingDurationMs =
							state.lastTokenTimestamp - state.firstTokenTimestamp;
						const streamingDurationSec = streamingDurationMs / 1000;

						if (streamingDurationMs > 0) {
							// Use streaming duration for generation speed
							state.usage.tokensPerSecond =
								finalOutputTokens / streamingDurationSec;
							if (
								process.env.DEBUG?.includes("worker") ||
								process.env.DEBUG === "true" ||
								process.env.NODE_ENV === "development"
							) {
								log.info(
									`Token/s calculation (streaming): ${finalOutputTokens} tokens / ${streamingDurationSec}s = ${state.usage.tokensPerSecond} tok/s (streaming duration: ${streamingDurationMs}ms)`,
								);
							}
						} else {
							// Fallback to total response time
							state.usage.tokensPerSecond =
								finalOutputTokens / totalDurationSec;
							if (
								process.env.DEBUG?.includes("worker") ||
								process.env.DEBUG === "true" ||
								process.env.NODE_ENV === "development"
							) {
								log.info(
									`Token/s calculation (fallback): ${finalOutputTokens} tokens / ${totalDurationSec}s = ${state.usage.tokensPerSecond} tok/s (total response time: ${responseTime}ms)`,
								);
							}
						}
					} else {
						// No streaming timestamps available, use total response time
						state.usage.tokensPerSecond = finalOutputTokens / totalDurationSec;
						if (
							process.env.DEBUG?.includes("worker") ||
							process.env.DEBUG === "true" ||
							process.env.NODE_ENV === "development"
						) {
							log.info(
								`Token/s calculation (no timestamps): ${finalOutputTokens} tokens / ${totalDurationSec}s = ${state.usage.tokensPerSecond} tok/s (total response time: ${responseTime}ms)`,
							);
						}
					}
				}
			} else {
				// If response time is 0, use a very small duration
				state.usage.tokensPerSecond = finalOutputTokens / 0.001;
				if (
					process.env.DEBUG?.includes("worker") ||
					process.env.DEBUG === "true" ||
					process.env.NODE_ENV === "development"
				) {
					log.info(
						`Token/s calculation (instant): ${finalOutputTokens} tokens / 0.001s = ${state.usage.tokensPerSecond} tok/s`,
					);
				}
			}
		}

		// Log if we have usage
		if (
			process.env.DEBUG?.includes("worker") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.debug(
				`Usage for request ${state.requestId}: Model: ${state.usage.model}, ` +
					`Tokens: ${state.usage.totalTokens || 0}, Cost: ${formatCost(state.usage.costUsd)}`,
			);
		}
	}

	// Post a SLIM usage summary back to the main thread. The RequestRecorder
	// merges this with its own meta + billingType + outcome to build the
	// dashboard RequestResponse and persist the row. No DB write, no payload.
	const summary: SummaryMessage["summary"] = {
		requestId: state.requestId,
		usage: {
			model: state.usage.model,
			inputTokens: state.usage.inputTokens,
			outputTokens: state.usage.outputTokens,
			cacheReadInputTokens: state.usage.cacheReadInputTokens,
			cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
			totalTokens: state.usage.totalTokens,
			costUsd: state.usage.costUsd,
		},
		tokensPerSecond: state.usage.tokensPerSecond,
		responseTimeMs: responseTime,
		cacheCreationInputTokens: state.usage.cacheCreationInputTokens,
	};

	self.postMessage({
		type: "summary",
		summary,
	} satisfies SummaryMessage);

	// Clean up
	requests.delete(msg.requestId);
}

async function handleShutdown(): Promise<void> {
	log.info("Worker shutting down...");

	// Stop cleanup interval
	stopCleanupInterval();

	requests.clear();
	self.postMessage({
		type: "shutdown-complete",
	} satisfies ShutdownCompleteMessage);
	// Worker will be terminated by main thread
}

// Periodic cleanup of stale requests (safety net for orphaned requests)
// Enforces both TTL and size limits to prevent memory leaks
let cleanupInterval: Timer | null = null;

const cleanupStaleRequests = () => {
	const now = Date.now();
	let removedCount = 0;

	// 1. Remove TTL-expired requests (hard limit)
	for (const [id, state] of requests) {
		const age = now - state.createdAt;
		if (age > REQUEST_TTL_MS) {
			log.warn(
				`Request ${id} exceeded TTL (age: ${Math.round(age / 1000)}s, limit: ${REQUEST_TTL_MS / 1000}s), removing...`,
			);
			requests.delete(id);
			removedCount++;
		}
	}

	// 2. Remove inactive requests (orphaned)
	for (const [id, state] of requests) {
		const inactivity = now - state.lastActivity;
		if (inactivity > TIMEOUT_MS) {
			log.warn(
				`Request ${id} appears orphaned (no activity for ${Math.round(inactivity / 1000)}s), removing...`,
			);
			requests.delete(id);
			removedCount++;
		}
	}

	// 3. Enforce size limit by evicting oldest entries
	if (requests.size > MAX_REQUESTS_MAP_SIZE) {
		const excess = requests.size - MAX_REQUESTS_MAP_SIZE;
		const sortedByAge = Array.from(requests.entries()).sort(
			(a, b) => a[1].createdAt - b[1].createdAt,
		);

		log.warn(
			`Requests map size (${requests.size}) exceeds limit (${MAX_REQUESTS_MAP_SIZE}), evicting ${excess} oldest entries...`,
		);

		for (let i = 0; i < excess; i++) {
			const [id] = sortedByAge[i];
			requests.delete(id);
			removedCount++;
		}
	}

	if (removedCount > 0 || requests.size > 0) {
		log.info(
			`requests.size=${requests.size} after cleanup (removed=${removedCount})`,
		);
	}
};

const startCleanupInterval = () => {
	if (!cleanupInterval) {
		// Run cleanup every 30 seconds
		cleanupInterval = setInterval(() => {
			cleanupStaleRequests();
			// Force a synchronous GC in the worker thread. The slim worker no
			// longer retains large payloads, but transient SSE-parse strings /
			// decoder buffers still churn the JSC heap; an explicit Bun.gc(true)
			// every 30s keeps RSS from drifting under steady message load (the
			// residual the leak fix explicitly chose to keep + measure). See
			// oven-sh/bun #5709. Worker is off the client path, so the brief
			// synchronous pause is acceptable. Guarded for non-Bun contexts.
			if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
				Bun.gc(true);
			}
		}, 30000);
		// Allow worker to exit if no other work is pending
		cleanupInterval.unref();
	}
};

const stopCleanupInterval = () => {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
};

// Start cleanup interval
startCleanupInterval();

// Message handler
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const msg = event.data;

	switch (msg.type) {
		case "start":
			handleStart(msg);
			break;
		case "chunk":
			handleChunk(msg);
			break;
		case "end":
			await handleEnd(msg);
			break;
		case "shutdown":
			await handleShutdown();
			break;
		default:
			log.warn(`Unknown message type: ${(msg as { type: string }).type}`);
	}
};
