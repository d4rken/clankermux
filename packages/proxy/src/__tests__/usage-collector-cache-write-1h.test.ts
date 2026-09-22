import { describe, expect, it } from "bun:test";
import type { PricingEstimateContext, TokenBreakdown } from "@clankermux/core";
import {
	createUsageState,
	feedChunk,
	feedNonStreamBody,
	finalizeUsage,
} from "../usage-collector";

// Anthropic reports the TTL split of a request's cache writes alongside the
// total; the 1-hour part is billed at 2x input, the rest at the 5-minute rate.

const enc = new TextEncoder();

function sse(event: string, data: unknown): Uint8Array {
	return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function recordingCost(): {
	fn: (
		model: string,
		t: TokenBreakdown,
		context?: PricingEstimateContext,
	) => Promise<number>;
	calls: TokenBreakdown[];
} {
	const calls: TokenBreakdown[] = [];
	return {
		calls,
		fn: async (_model, tokens) => {
			calls.push(tokens);
			return 1;
		},
	};
}

const SPLIT_USAGE = {
	input_tokens: 10,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 1_000,
	cache_creation: {
		ephemeral_5m_input_tokens: 600,
		ephemeral_1h_input_tokens: 400,
	},
	output_tokens: 1,
};

describe("usage collector — 1-hour cache writes", () => {
	it("carries the split from message_start into pricing and the summary", async () => {
		const state = createUsageState();
		feedChunk(
			state,
			sse("message_start", {
				type: "message_start",
				message: { model: "claude-opus-5", usage: SPLIT_USAGE },
			}),
			1000,
		);
		feedChunk(
			state,
			sse("message_delta", {
				type: "message_delta",
				usage: { output_tokens: 50 },
			}),
			1100,
		);

		const cost = recordingCost();
		const summary = await finalizeUsage(
			state,
			{ responseTimeMs: 1000, providerName: "anthropic", isStream: true },
			{ estimateCostUSD: cost.fn },
		);
		expect(cost.calls[0]?.cacheCreationInputTokens).toBe(1_000);
		expect(cost.calls[0]?.cacheCreation1hInputTokens).toBe(400);
		expect(summary.usage.cacheCreation1hInputTokens).toBe(400);
	});

	it("takes a later message_delta's split over message_start's", async () => {
		const state = createUsageState();
		feedChunk(
			state,
			sse("message_start", {
				type: "message_start",
				message: { model: "claude-opus-5", usage: SPLIT_USAGE },
			}),
			1000,
		);
		feedChunk(
			state,
			sse("message_delta", {
				type: "message_delta",
				usage: {
					output_tokens: 50,
					cache_creation_input_tokens: 1_000,
					cache_creation: {
						ephemeral_5m_input_tokens: 0,
						ephemeral_1h_input_tokens: 1_000,
					},
				},
			}),
			1100,
		);

		const summary = await finalizeUsage(
			state,
			{ responseTimeMs: 1000, providerName: "anthropic", isStream: true },
			{ estimateCostUSD: recordingCost().fn },
		);
		expect(summary.usage.cacheCreation1hInputTokens).toBe(1_000);
	});

	it("drops message_start's split when a delta reports a different total without one", async () => {
		const state = createUsageState();
		feedChunk(
			state,
			sse("message_start", {
				type: "message_start",
				message: { model: "claude-opus-5", usage: SPLIT_USAGE },
			}),
			1000,
		);
		feedChunk(
			state,
			sse("message_delta", {
				type: "message_delta",
				usage: { output_tokens: 50, cache_creation_input_tokens: 500 },
			}),
			1100,
		);

		const summary = await finalizeUsage(
			state,
			{ responseTimeMs: 1000, providerName: "anthropic", isStream: true },
			{ estimateCostUSD: recordingCost().fn },
		);
		expect(summary.usage.cacheCreationInputTokens).toBe(500);
		expect(summary.usage.cacheCreation1hInputTokens).toBeUndefined();
	});

	it("keeps message_start's split when a delta repeats the same total without one", async () => {
		const state = createUsageState();
		feedChunk(
			state,
			sse("message_start", {
				type: "message_start",
				message: { model: "claude-opus-5", usage: SPLIT_USAGE },
			}),
			1000,
		);
		feedChunk(
			state,
			sse("message_delta", {
				type: "message_delta",
				usage: { output_tokens: 50, cache_creation_input_tokens: 1_000 },
			}),
			1100,
		);

		const summary = await finalizeUsage(
			state,
			{ responseTimeMs: 1000, providerName: "anthropic", isStream: true },
			{ estimateCostUSD: recordingCost().fn },
		);
		expect(summary.usage.cacheCreation1hInputTokens).toBe(400);
	});

	it("never records more 1-hour writes than the total", async () => {
		const state = createUsageState();
		feedNonStreamBody(
			state,
			JSON.stringify({
				model: "claude-opus-5",
				usage: {
					...SPLIT_USAGE,
					cache_creation: { ephemeral_1h_input_tokens: 5_000 },
				},
			}),
		);

		const cost = recordingCost();
		const summary = await finalizeUsage(
			state,
			{ responseTimeMs: 1000, providerName: "anthropic", isStream: false },
			{ estimateCostUSD: cost.fn },
		);
		expect(cost.calls[0]?.cacheCreation1hInputTokens).toBe(1_000);
		expect(summary.usage.cacheCreation1hInputTokens).toBe(1_000);
	});

	it("reads the split from a non-stream body", async () => {
		const state = createUsageState();
		feedNonStreamBody(
			state,
			JSON.stringify({ model: "claude-opus-5", usage: SPLIT_USAGE }),
		);

		const cost = recordingCost();
		const summary = await finalizeUsage(
			state,
			{ responseTimeMs: 1000, providerName: "anthropic", isStream: false },
			{ estimateCostUSD: cost.fn },
		);
		expect(cost.calls[0]?.cacheCreation1hInputTokens).toBe(400);
		expect(summary.usage.cacheCreation1hInputTokens).toBe(400);
	});

	it("leaves the split absent when upstream reports only the total", async () => {
		const state = createUsageState();
		const { cache_creation: _omitted, ...totalOnly } = SPLIT_USAGE;
		feedNonStreamBody(
			state,
			JSON.stringify({ model: "claude-opus-5", usage: totalOnly }),
		);

		const cost = recordingCost();
		const summary = await finalizeUsage(
			state,
			{ responseTimeMs: 1000, providerName: "anthropic", isStream: false },
			{ estimateCostUSD: cost.fn },
		);
		expect(cost.calls[0]?.cacheCreation1hInputTokens).toBeUndefined();
		expect(summary.usage.cacheCreation1hInputTokens).toBeUndefined();
	});

	it("drops the split with the rest of the usage for a provider that reports none", async () => {
		const state = createUsageState();
		feedNonStreamBody(
			state,
			JSON.stringify({ model: "llama3", usage: SPLIT_USAGE }),
		);

		const summary = await finalizeUsage(
			state,
			{ responseTimeMs: 1000, providerName: "ollama", isStream: false },
			{ estimateCostUSD: recordingCost().fn },
		);
		expect(summary.usage.cacheCreationInputTokens).toBeUndefined();
		expect(summary.usage.cacheCreation1hInputTokens).toBeUndefined();
	});
});
