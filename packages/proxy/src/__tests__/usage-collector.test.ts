import { describe, expect, it } from "bun:test";
import {
	createUsageState,
	feedChunk,
	feedNonStreamBody,
	finalizeUsage,
	getLineBufferLength,
	MAX_SSE_LINE_BYTES,
} from "../usage-collector";

// ---------------------------------------------------------------------------
// Helpers — a fake estimateCostUSD + a fixed clock so cost and tokens/sec are
// deterministic and the test never touches the real pricing catalogue.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/** Encode an SSE event (event line + data line) the way Anthropic streams it. */
function sse(event: string, data: unknown): Uint8Array {
	return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A fake cost function: $1 per input token, $2 per output token, recorded. */
function fakeCost(): {
	fn: (model: string, t: Record<string, number | undefined>) => Promise<number>;
	calls: Array<{ model: string; tokens: Record<string, number | undefined> }>;
} {
	const calls: Array<{
		model: string;
		tokens: Record<string, number | undefined>;
	}> = [];
	return {
		calls,
		fn: async (model, tokens) => {
			calls.push({ model, tokens });
			return (tokens.inputTokens ?? 0) * 1 + (tokens.outputTokens ?? 0) * 2;
		},
	};
}

describe("usage-collector", () => {
	describe("Anthropic-style stream", () => {
		it("computes totals from message_start + message_delta and ignores content_block_delta", async () => {
			const state = createUsageState();

			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: {
							input_tokens: 100,
							cache_read_input_tokens: 20,
							cache_creation_input_tokens: 5,
							output_tokens: 1,
						},
					},
				}),
				1000,
			);

			// A pile of content_block_delta chunks — these MUST NOT change any token
			// counts; they only advance bytes + lastChunkTs.
			const before = {
				input: state.inputTokens,
				cacheRead: state.cacheReadInputTokens,
				cacheCreation: state.cacheCreationInputTokens,
				finalOutput: state.providerFinalOutputTokens,
				reported: state.providerReportedOutput,
			};
			feedChunk(
				state,
				sse("content_block_delta", {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "hello world" },
				}),
				1100,
			);
			feedChunk(
				state,
				sse("content_block_delta", {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "more text here" },
				}),
				1200,
			);
			expect(state.inputTokens).toBe(before.input);
			expect(state.cacheReadInputTokens).toBe(before.cacheRead);
			expect(state.cacheCreationInputTokens).toBe(before.cacheCreation);
			// content_block_delta never sets the provider-reported flag or output.
			expect(state.providerFinalOutputTokens).toBe(before.finalOutput);
			expect(state.providerReportedOutput).toBe(before.reported);

			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 250 },
				}),
				1300,
			);

			expect(state.inputTokens).toBe(100);
			expect(state.cacheReadInputTokens).toBe(20);
			expect(state.cacheCreationInputTokens).toBe(5);
			expect(state.providerFinalOutputTokens).toBe(250);
			expect(state.providerReportedOutput).toBe(true);

			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 2000, providerName: "anthropic", isStream: true },
				{ estimateCostUSD: cost.fn },
			);

			expect(summary.usage.model).toBe("claude-opus-4-8");
			expect(summary.usage.inputTokens).toBe(100);
			expect(summary.usage.outputTokens).toBe(250);
			expect(summary.usage.cacheReadInputTokens).toBe(20);
			expect(summary.usage.cacheCreationInputTokens).toBe(5);
			// total = 100 + 20 + 5 + 250
			expect(summary.usage.totalTokens).toBe(375);
			expect(summary.outputApproximate).toBeUndefined();
		});
	});

	describe("precedence: provider-reported vs byte fallback", () => {
		it("message_start output_tokens:0 then message_delta N → final = N (not 0)", async () => {
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			// message_start with output_tokens:0 must NOT flip providerReportedOutput.
			expect(state.providerReportedOutput).toBe(false);

			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 77 },
				}),
				1100,
			);
			expect(state.providerReportedOutput).toBe(true);

			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 1000, providerName: "anthropic", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.outputTokens).toBe(77);
			expect(summary.outputApproximate).toBeUndefined();
		});

		it("provider never reports output → fallback ceil(bytes/4), outputApproximate=true", async () => {
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			// Stream raw text deltas only — no message_delta ever arrives.
			const a = sse("content_block_delta", {
				type: "content_block_delta",
				delta: { type: "text_delta", text: "x".repeat(40) },
			});
			feedChunk(state, a, 1100);
			expect(state.providerReportedOutput).toBe(false);

			const expectedBytes = state.streamedBytes;
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 1000, providerName: "anthropic", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.outputApproximate).toBe(true);
			expect(summary.usage.outputTokens).toBe(Math.ceil(expectedBytes / 4));
		});
	});

	describe("tokens/sec", () => {
		it("zai (glm-) uses total response time", async () => {
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "glm-4.5-air",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 100 },
				}),
				1500, // streaming duration would be 500ms = 0.5s
			);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 4000, providerName: "zai", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			// zai → 100 tokens / (4000ms/1000) = 25 tok/s (total time, NOT 0.5s)
			expect(summary.tokensPerSecond).toBeCloseTo(25, 5);
		});

		it("Anthropic uses streaming duration from first/last chunk ts", async () => {
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000, // firstChunkTs
			);
			feedChunk(
				state,
				sse("content_block_delta", {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "hi" },
				}),
				1250,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 100 },
				}),
				3000, // lastChunkTs → streaming duration = 2000ms = 2s
			);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 10000, providerName: "anthropic", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			// Anthropic → 100 / ((3000-1000)/1000) = 100 / 2 = 50 tok/s
			// (streaming duration, NOT the 10s total response time)
			expect(summary.tokensPerSecond).toBeCloseTo(50, 5);
		});

		it("records NULL (undefined) instead of an artifact when there is no usable duration", async () => {
			// Single-chunk stream: firstChunkTs === lastChunkTs → no streaming
			// duration. responseTimeMs is 0 → no total duration either. The old
			// code divided by a 0.001s floor and produced 100/0.001 = 100,000
			// tok/s; we now record nothing rather than poison the averages.
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 100 },
				}),
				1000, // same ts → streamingDuration = 0
			);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 0, providerName: "anthropic", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.tokensPerSecond).toBeUndefined();
		});

		it("discards an implausibly fast result (above the sanity ceiling)", async () => {
			// 100 output tokens over a 10ms total duration = 10,000 tok/s, far
			// above MAX_PLAUSIBLE_TOKENS_PER_SECOND (1500) — a measurement
			// artifact, so it is dropped rather than recorded.
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "glm-4.5-air",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 100 },
				}),
				1010,
			);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 10, providerName: "zai", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.tokensPerSecond).toBeUndefined();
		});

		it("keeps a genuinely fast result that is still under the ceiling", async () => {
			// 1000 tokens over 2s streaming = 500 tok/s — fast but plausible.
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 1000 },
				}),
				3000, // streaming duration = 2000ms = 2s
			);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 5000, providerName: "anthropic", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.tokensPerSecond).toBeCloseTo(500, 5);
		});
	});

	describe("non-stream body", () => {
		it("uses the usage object when present", async () => {
			const state = createUsageState();
			feedNonStreamBody(
				state,
				JSON.stringify({
					model: "claude-opus-4-8",
					usage: {
						input_tokens: 200,
						cache_read_input_tokens: 50,
						cache_creation_input_tokens: 10,
						output_tokens: 333,
					},
				}),
			);
			expect(state.providerReportedOutput).toBe(true);

			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 1000, providerName: "anthropic", isStream: false },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.model).toBe("claude-opus-4-8");
			expect(summary.usage.inputTokens).toBe(200);
			expect(summary.usage.outputTokens).toBe(333);
			expect(summary.usage.cacheReadInputTokens).toBe(50);
			expect(summary.usage.cacheCreationInputTokens).toBe(10);
			expect(summary.usage.totalTokens).toBe(200 + 50 + 10 + 333);
			expect(summary.outputApproximate).toBeUndefined();
		});

		it("falls back to bytes/4 when the body has no usage object", async () => {
			const state = createUsageState();
			const body = JSON.stringify({ model: "claude-opus-4-8", foo: "bar" });
			feedNonStreamBody(state, body);
			expect(state.providerReportedOutput).toBe(false);
			expect(state.streamedBytes).toBe(body.length);

			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 1000, providerName: "anthropic", isStream: false },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.outputApproximate).toBe(true);
			expect(summary.usage.outputTokens).toBe(Math.ceil(body.length / 4));
		});
	});

	describe("cost + totals", () => {
		it("cost is computed via the injected function with the final token breakdown", async () => {
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 100, output_tokens: 0 },
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 10 },
				}),
				1100,
			);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 1000, providerName: "anthropic", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			// fake cost = input*1 + output*2 = 100 + 20 = 120
			expect(summary.usage.costUsd).toBe(120);
			expect(cost.calls).toHaveLength(1);
			expect(cost.calls[0].model).toBe("claude-opus-4-8");
			expect(cost.calls[0].tokens.inputTokens).toBe(100);
			expect(cost.calls[0].tokens.outputTokens).toBe(10);
			expect(summary.usage.totalTokens).toBe(110);
		});
	});

	describe("substring guard", () => {
		it("does not JSON.parse a pure text_delta chunk lacking the markers (no throw)", () => {
			const state = createUsageState();
			// A data line whose payload is NOT valid JSON. If feedChunk tried to
			// JSON.parse it, it would either throw or we'd have to catch — but the
			// substring guard means the line is never even parsed because the chunk
			// contains neither "usage" nor "message_".
			const chunk = enc.encode(
				"event: ping\ndata: this-is-not-json-and-has-no-markers\n\n",
			);
			expect(() => feedChunk(state, chunk, 1000)).not.toThrow();
			// Bytes still counted; no token state touched.
			expect(state.streamedBytes).toBe(chunk.byteLength);
			expect(state.providerReportedOutput).toBe(false);
			expect(state.providerFinalOutputTokens).toBeUndefined();
			expect(state.model).toBeUndefined();
		});

		it("stamps firstChunkTs once and lastChunkTs on every chunk", () => {
			const state = createUsageState();
			const c = enc.encode("event: ping\ndata: {}\n\n");
			feedChunk(state, c, 1000);
			expect(state.firstChunkTs).toBe(1000);
			expect(state.lastChunkTs).toBe(1000);
			feedChunk(state, c, 1500);
			expect(state.firstChunkTs).toBe(1000); // unchanged
			expect(state.lastChunkTs).toBe(1500);
		});
	});

	describe("incremental SSE parsing across chunk boundaries (B1)", () => {
		it("parses a message_start split across two feedChunk calls", () => {
			const state = createUsageState();
			const full = `event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					model: "claude-opus-4-8",
					usage: { input_tokens: 123, output_tokens: 1 },
				},
			})}\n\n`;
			// Split mid-way through the data line (after "data: {" but before the rest).
			const splitAt = full.indexOf("input_tokens") - 5;
			feedChunk(state, enc.encode(full.slice(0, splitAt)), 1000);
			// Nothing complete yet — the data line is still buffered.
			expect(state.model).toBeUndefined();
			expect(state.inputTokens).toBe(0);
			feedChunk(state, enc.encode(full.slice(splitAt)), 1100);
			expect(state.model).toBe("claude-opus-4-8");
			expect(state.inputTokens).toBe(123);
		});

		it("parses a message_delta split across two feedChunk calls", () => {
			const state = createUsageState();
			const full = `event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				usage: { output_tokens: 456 },
			})}\n\n`;
			const splitAt = full.indexOf("output_tokens") + 3;
			feedChunk(state, enc.encode(full.slice(0, splitAt)), 1000);
			expect(state.providerReportedOutput).toBe(false);
			feedChunk(state, enc.encode(full.slice(splitAt)), 1100);
			expect(state.providerReportedOutput).toBe(true);
			expect(state.providerFinalOutputTokens).toBe(456);
		});

		it("parses a data: line spanning 3 chunks", () => {
			const state = createUsageState();
			const full = `event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					model: "claude-opus-4-8",
					usage: { input_tokens: 999, output_tokens: 1 },
				},
			})}\n\n`;
			const third = Math.floor(full.length / 3);
			feedChunk(state, enc.encode(full.slice(0, third)), 1000);
			feedChunk(state, enc.encode(full.slice(third, third * 2)), 1010);
			expect(state.inputTokens).toBe(0); // still incomplete
			feedChunk(state, enc.encode(full.slice(third * 2)), 1020);
			expect(state.model).toBe("claude-opus-4-8");
			expect(state.inputTokens).toBe(999);
		});

		it("does not throw on a partial trailing line that never completes", () => {
			const state = createUsageState();
			// A chunk that contains the 'message_' marker but is cut off mid-JSON.
			const chunk = enc.encode(
				'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tok',
			);
			expect(() => feedChunk(state, chunk, 1000)).not.toThrow();
			// Nothing applied — the data line was never terminated by a newline.
			expect(state.inputTokens).toBe(0);
			expect(state.providerReportedOutput).toBe(false);
		});

		it("splits the event: line from its data: line across chunks", () => {
			const state = createUsageState();
			// event line in chunk 1 (no trailing newline yet → the 'message_delta'
			// event marker only resolves once the newline arrives in chunk 2).
			feedChunk(state, enc.encode("event: message_delta\nda"), 1000);
			feedChunk(
				state,
				enc.encode(
					`ta: ${JSON.stringify({ usage: { output_tokens: 42 } })}\n\n`,
				),
				1100,
			);
			expect(state.providerReportedOutput).toBe(true);
			expect(state.providerFinalOutputTokens).toBe(42);
		});

		it("tracks sawMessageStop on a message_stop event", () => {
			const state = createUsageState();
			expect(state.sawMessageStop).toBe(false);
			feedChunk(
				state,
				enc.encode(
					`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
				),
				1000,
			);
			expect(state.sawMessageStop).toBe(true);
		});

		it("decodes a multi-byte UTF-8 sequence split across chunks without corrupting later parses", () => {
			const state = createUsageState();
			// "€" is 0xE2 0x82 0xAC in UTF-8. Split it across two chunks inside a
			// text_delta, then send a real message_delta — a non-streaming decoder
			// would emit a replacement char and could desync line buffering.
			const euro = enc.encode("€");
			const head = enc.encode(
				'event: content_block_delta\ndata: {"delta":{"text":"',
			);
			// chunk1: head + first byte of €
			feedChunk(state, new Uint8Array([...head, euro[0]]), 1000);
			// chunk2: rest of € + close + a real message_delta
			const tail = enc.encode(
				`"}}\n\nevent: message_delta\ndata: ${JSON.stringify({ usage: { output_tokens: 7 } })}\n\n`,
			);
			feedChunk(state, new Uint8Array([euro[1], euro[2], ...tail]), 1100);
			expect(state.providerReportedOutput).toBe(true);
			expect(state.providerFinalOutputTokens).toBe(7);
		});
	});

	describe("bounded SSE line buffer (overlong newline-free input)", () => {
		it("keeps lineBuffer bounded when no newline ever arrives, and does not crash", () => {
			const state = createUsageState();
			// A 64KB newline-free chunk; feed it many times. Without a cap the
			// lineBuffer would grow to MBs. With the cap it stays bounded.
			const blob = enc.encode("x".repeat(64 * 1024));
			for (let i = 0; i < 64; i++) {
				expect(() => feedChunk(state, blob, 1000 + i)).not.toThrow();
				// The retained buffer never exceeds the cap (the +blob headroom is the
				// single chunk appended before the cap check trims it).
				expect(getLineBufferLength(state)).toBeLessThanOrEqual(
					MAX_SSE_LINE_BYTES,
				);
			}
			// Bytes are still accounted even though the overlong line was discarded.
			expect(state.streamedBytes).toBe(blob.byteLength * 64);
			// Nothing was parsed (the garbage was never valid SSE).
			expect(state.providerReportedOutput).toBe(false);
		});

		it("discards an overlong line, then resumes parsing the line after the next newline", () => {
			const state = createUsageState();
			// Garbage with NO newline that exceeds the cap → discarded + skip armed.
			const overlong = enc.encode("g".repeat(MAX_SSE_LINE_BYTES + 100));
			feedChunk(state, overlong, 1000);
			expect(getLineBufferLength(state)).toBeLessThanOrEqual(
				MAX_SSE_LINE_BYTES,
			);
			expect(state.providerReportedOutput).toBe(false);

			// More garbage (still mid-overlong-line) before the terminating newline —
			// this must also be skipped, not parsed.
			feedChunk(state, enc.encode("g".repeat(1000)), 1010);
			expect(state.providerReportedOutput).toBe(false);

			// The newline that ends the discarded garbage line, immediately followed
			// by a clean, complete message_delta line — that NEXT line must parse.
			const recovery = enc.encode(
				`\nevent: message_delta\ndata: ${JSON.stringify({
					usage: { output_tokens: 321 },
				})}\n\n`,
			);
			feedChunk(state, recovery, 1020);
			expect(state.providerReportedOutput).toBe(true);
			expect(state.providerFinalOutputTokens).toBe(321);
		});

		it("does not JSON.parse a truncated overlong line (no false usage applied)", () => {
			const state = createUsageState();
			// An overlong line that STARTS like a usage-bearing data line but is cut
			// off — it must be discarded wholesale, never parsed as if complete.
			const head = enc.encode(
				'event: message_delta\ndata: {"usage":{"output_tokens":999,"junk":"',
			);
			const filler = enc.encode("z".repeat(MAX_SSE_LINE_BYTES));
			feedChunk(state, new Uint8Array([...head, ...filler]), 1000);
			// The truncated overlong line was discarded — no count applied.
			expect(state.providerReportedOutput).toBe(false);
			expect(state.providerFinalOutputTokens).toBeUndefined();
		});
	});

	describe("top-level usage/model on message_start (S6)", () => {
		it("reads input/cache/model from a top-level usage object", () => {
			const state = createUsageState();
			// Some shapes put usage/model at the top level of the message_start data
			// rather than nested under `message`.
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					model: "claude-opus-4-8",
					usage: {
						input_tokens: 50,
						cache_read_input_tokens: 7,
						cache_creation_input_tokens: 3,
						output_tokens: 1,
					},
				}),
				1000,
			);
			expect(state.model).toBe("claude-opus-4-8");
			expect(state.inputTokens).toBe(50);
			expect(state.cacheReadInputTokens).toBe(7);
			expect(state.cacheCreationInputTokens).toBe(3);
			// Top-level output_tokens on message_start is still a placeholder.
			expect(state.providerReportedOutput).toBe(false);
		});
	});

	describe("Codex-Responses stream (native passthrough)", () => {
		// Event shapes mirror what CodexProvider.transformStreamingResponse parses:
		// response.created carries `response.{id,model}`; response.completed
		// carries `response.usage` with cache info under `input_tokens_details`.
		function codexCreated(model = "gpt-5.5-codex"): Uint8Array {
			return sse("response.created", {
				type: "response.created",
				response: { id: "resp_backend_1", model },
			});
		}

		function codexTextDelta(text: string): Uint8Array {
			return sse("response.output_text.delta", {
				type: "response.output_text.delta",
				delta: text,
			});
		}

		function codexCompleted(usage?: unknown): Uint8Array {
			return sse("response.completed", {
				type: "response.completed",
				response: {
					id: "resp_backend_1",
					model: "gpt-5.5-codex",
					...(usage !== undefined ? { usage } : {}),
				},
			});
		}

		it("computes totals from response.completed usage — NOT the bytes/4 estimate", async () => {
			const state = createUsageState();
			feedChunk(state, codexCreated(), 1000);
			feedChunk(state, codexTextDelta("Hello"), 1100);
			feedChunk(state, codexTextDelta(" world"), 1200);
			feedChunk(
				state,
				codexCompleted({
					input_tokens: 1117,
					output_tokens: 215,
					input_tokens_details: {
						cached_tokens: 1024,
						cache_creation_input_tokens: 64,
					},
				}),
				1300,
			);

			expect(state.model).toBe("gpt-5.5-codex");
			expect(state.inputTokens).toBe(1117);
			expect(state.providerFinalOutputTokens).toBe(215);
			expect(state.providerReportedOutput).toBe(true);
			expect(state.cacheReadInputTokens).toBe(1024);
			expect(state.cacheCreationInputTokens).toBe(64);

			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 2000, providerName: "codex", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.model).toBe("gpt-5.5-codex");
			expect(summary.usage.inputTokens).toBe(1117);
			expect(summary.usage.outputTokens).toBe(215);
			expect(summary.usage.cacheReadInputTokens).toBe(1024);
			expect(summary.usage.cacheCreationInputTokens).toBe(64);
			expect(summary.usage.totalTokens).toBe(1117 + 1024 + 64 + 215);
			// The provider reported — the bytes/4 fallback must NOT have been used.
			expect(summary.outputApproximate).toBeUndefined();
			expect(summary.usage.outputTokens).not.toBe(
				Math.ceil(state.streamedBytes / 4),
			);
		});

		it("handles a usage object without input_tokens_details (no cached info)", async () => {
			const state = createUsageState();
			feedChunk(state, codexCreated(), 1000);
			feedChunk(
				state,
				codexCompleted({ input_tokens: 50, output_tokens: 9 }),
				1100,
			);
			expect(state.inputTokens).toBe(50);
			expect(state.providerFinalOutputTokens).toBe(9);
			expect(state.cacheReadInputTokens).toBe(0);
			expect(state.cacheCreationInputTokens).toBe(0);

			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 1000, providerName: "codex", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.outputTokens).toBe(9);
			expect(summary.outputApproximate).toBeUndefined();
		});

		it("ignores negative cached-token details (mirrors CodexProvider's >= 0 guard)", () => {
			const state = createUsageState();
			feedChunk(
				state,
				codexCompleted({
					input_tokens: 10,
					output_tokens: 5,
					input_tokens_details: {
						cached_tokens: -1,
						cache_creation_input_tokens: -7,
					},
				}),
				1000,
			);
			expect(state.cacheReadInputTokens).toBe(0);
			expect(state.cacheCreationInputTokens).toBe(0);
			expect(state.inputTokens).toBe(10);
			expect(state.providerFinalOutputTokens).toBe(5);
		});

		it("unknown response.* events are no-ops on token state", () => {
			const state = createUsageState();
			feedChunk(state, codexCreated(), 1000);
			const before = {
				input: state.inputTokens,
				cacheRead: state.cacheReadInputTokens,
				cacheCreation: state.cacheCreationInputTokens,
				finalOutput: state.providerFinalOutputTokens,
				reported: state.providerReportedOutput,
			};
			feedChunk(
				state,
				sse("response.output_item.added", {
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", role: "assistant" },
				}),
				1100,
			);
			feedChunk(
				state,
				sse("response.in_progress", {
					type: "response.in_progress",
					response: { id: "resp_backend_1", model: "gpt-5.5-codex" },
				}),
				1200,
			);
			expect(state.inputTokens).toBe(before.input);
			expect(state.cacheReadInputTokens).toBe(before.cacheRead);
			expect(state.cacheCreationInputTokens).toBe(before.cacheCreation);
			expect(state.providerFinalOutputTokens).toBe(before.finalOutput);
			expect(state.providerReportedOutput).toBe(before.reported);
		});

		it("tolerates mixed garbage between Codex events without losing usage", async () => {
			const state = createUsageState();
			feedChunk(state, codexCreated(), 1000);
			feedChunk(
				state,
				enc.encode("event: ping\ndata: this-is-not-json\n\n"),
				1100,
			);
			feedChunk(state, enc.encode(": comment line\n\n"), 1200);
			feedChunk(
				state,
				codexCompleted({ input_tokens: 20, output_tokens: 7 }),
				1300,
			);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 1000, providerName: "codex", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.inputTokens).toBe(20);
			expect(summary.usage.outputTokens).toBe(7);
			expect(summary.outputApproximate).toBeUndefined();
		});

		it("parses a response.completed split across feedChunk calls", () => {
			const state = createUsageState();
			const full = `event: response.completed\ndata: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_backend_1",
					model: "gpt-5.5-codex",
					usage: { input_tokens: 33, output_tokens: 44 },
				},
			})}\n\n`;
			const splitAt = full.indexOf("output_tokens") + 4;
			feedChunk(state, enc.encode(full.slice(0, splitAt)), 1000);
			expect(state.providerReportedOutput).toBe(false);
			feedChunk(state, enc.encode(full.slice(splitAt)), 1100);
			expect(state.providerReportedOutput).toBe(true);
			expect(state.inputTokens).toBe(33);
			expect(state.providerFinalOutputTokens).toBe(44);
		});

		it("usage-less Codex stream falls back to bytes/4 as today", async () => {
			const state = createUsageState();
			feedChunk(state, codexCreated(), 1000);
			feedChunk(state, codexTextDelta("x".repeat(400)), 1100);
			// response.completed WITHOUT a usage object — nothing reported.
			feedChunk(state, codexCompleted(), 1200);
			expect(state.providerReportedOutput).toBe(false);

			const expectedBytes = state.streamedBytes;
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 1000, providerName: "codex", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.outputApproximate).toBe(true);
			expect(summary.usage.outputTokens).toBe(Math.ceil(expectedBytes / 4));
		});

		it("Anthropic stream regression: behavior is unchanged with the Codex vocabulary present", async () => {
			// Byte-identical Anthropic stream as in the first suite — must produce
			// exactly the same numbers now that response.* events are also handled.
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: {
							input_tokens: 100,
							cache_read_input_tokens: 20,
							cache_creation_input_tokens: 5,
							output_tokens: 1,
						},
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("content_block_delta", {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "hello world" },
				}),
				1100,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 250 },
				}),
				1200,
			);
			feedChunk(state, sse("message_stop", { type: "message_stop" }), 1300);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{ responseTimeMs: 2000, providerName: "anthropic", isStream: true },
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.model).toBe("claude-opus-4-8");
			expect(summary.usage.inputTokens).toBe(100);
			expect(summary.usage.outputTokens).toBe(250);
			expect(summary.usage.cacheReadInputTokens).toBe(20);
			expect(summary.usage.cacheCreationInputTokens).toBe(5);
			expect(summary.usage.totalTokens).toBe(375);
			expect(summary.outputApproximate).toBeUndefined();
			expect(state.sawMessageStop).toBe(true);
		});
	});

	describe("R5: non-clean stream endings (B2)", () => {
		it("clean end trusts the provider's output count", async () => {
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 5 },
				}),
				1100,
			);
			// Stream a lot of bytes so ceil(bytes/4) would dwarf the provider count
			// IF we wrongly took the max on a clean end.
			feedChunk(
				state,
				sse("content_block_delta", {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "x".repeat(4000) },
				}),
				1200,
			);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{
					responseTimeMs: 1000,
					providerName: "anthropic",
					isStream: true,
					endedCleanly: true,
				},
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.outputTokens).toBe(5);
			expect(summary.outputApproximate).toBeUndefined();
		});

		it("truncated end uses max(provider, ceil(bytes/4)) and flags approximate", async () => {
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			// Provider reported a small count early...
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 5 },
				}),
				1100,
			);
			// ...then lots more text streamed before the connection dropped (no final
			// message_delta). ceil(bytes/4) should exceed the stale provider count.
			feedChunk(
				state,
				sse("content_block_delta", {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "x".repeat(4000) },
				}),
				1200,
			);
			const expectedEstimate = Math.ceil(state.streamedBytes / 4);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{
					responseTimeMs: 1000,
					providerName: "anthropic",
					isStream: true,
					endedCleanly: false,
				},
				{ estimateCostUSD: cost.fn },
			);
			expect(expectedEstimate).toBeGreaterThan(5);
			expect(summary.usage.outputTokens).toBe(expectedEstimate);
			expect(summary.outputApproximate).toBe(true);
		});

		it("truncated end keeps the provider count when it already exceeds the estimate", async () => {
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 100000 },
				}),
				1100,
			);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{
					responseTimeMs: 1000,
					providerName: "anthropic",
					isStream: true,
					endedCleanly: false,
				},
				{ estimateCostUSD: cost.fn },
			);
			// max(100000, tiny estimate) = 100000; still flagged approximate because
			// the ending wasn't clean.
			expect(summary.usage.outputTokens).toBe(100000);
			expect(summary.outputApproximate).toBe(true);
		});

		it("natural EOF (onEnd, endedCleanly=true) uses the provider count even on a non-2xx/error response", async () => {
			// BLOCKER B: a stream that reaches its natural end is NOT truncated, so
			// finalize must trust the provider's reported output_tokens — regardless
			// of the HTTP success/error outcome, which is recorded separately on the
			// row. The bytes streamed dwarf the provider count; if onEnd wrongly
			// reported endedCleanly=false (the old `success || sawMessageStop`
			// behaviour on a non-2xx EOF), we'd take max(provider, bytes/4) instead.
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 12 },
				}),
				1100,
			);
			feedChunk(
				state,
				sse("content_block_delta", {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "y".repeat(4000) },
				}),
				1200,
			);
			expect(Math.ceil(state.streamedBytes / 4)).toBeGreaterThan(12);
			const cost = fakeCost();
			// endedCleanly=true is what the streaming onEnd now ALWAYS passes.
			const summary = await finalizeUsage(
				state,
				{
					responseTimeMs: 1000,
					providerName: "anthropic",
					isStream: true,
					endedCleanly: true,
				},
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.outputTokens).toBe(12);
			expect(summary.outputApproximate).toBeUndefined();
		});

		it("disconnect/onError mid-stream (endedCleanly=false) still uses the max(provider, bytes/4) fallback", async () => {
			// The truncation path: onError passes endedCleanly=false so a cut stream
			// that kept emitting text after the last message_delta isn't undercounted.
			const state = createUsageState();
			feedChunk(
				state,
				sse("message_start", {
					type: "message_start",
					message: {
						model: "claude-opus-4-8",
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
				1000,
			);
			feedChunk(
				state,
				sse("message_delta", {
					type: "message_delta",
					usage: { output_tokens: 12 },
				}),
				1100,
			);
			feedChunk(
				state,
				sse("content_block_delta", {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "y".repeat(4000) },
				}),
				1200,
			);
			const expectedEstimate = Math.ceil(state.streamedBytes / 4);
			expect(expectedEstimate).toBeGreaterThan(12);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{
					responseTimeMs: 1000,
					providerName: "anthropic",
					isStream: true,
					endedCleanly: false,
				},
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.outputTokens).toBe(expectedEstimate);
			expect(summary.outputApproximate).toBe(true);
		});

		it("flushes a complete buffered line at finalize when no trailing newline arrived", async () => {
			const state = createUsageState();
			// A message_delta whose data line is terminated by EOF (no trailing \n),
			// e.g. the provider closed the stream right after the last byte. The
			// finalize flush must still parse the complete line.
			feedChunk(
				state,
				enc.encode(
					`event: message_delta\ndata: ${JSON.stringify({ usage: { output_tokens: 88 } })}`,
				),
				1000,
			);
			// Not yet parsed (no newline terminator).
			expect(state.providerReportedOutput).toBe(false);
			const cost = fakeCost();
			const summary = await finalizeUsage(
				state,
				{
					responseTimeMs: 1000,
					providerName: "anthropic",
					isStream: true,
					endedCleanly: true,
				},
				{ estimateCostUSD: cost.fn },
			);
			expect(summary.usage.outputTokens).toBe(88);
		});
	});
});
