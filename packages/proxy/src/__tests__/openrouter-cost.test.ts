import { describe, expect, it } from "bun:test";
import {
	createUsageState,
	type FinalizeOpts,
	feedChunk,
	feedNonStreamBody,
	finalizeUsage,
} from "../usage-collector";

const opts: FinalizeOpts = {
	providerName: "openrouter",
	accountProvider: "openrouter",
	isStream: true,
	responseTimeMs: 100,
};
const encoder = new TextEncoder();
function event(type: string, fields: object) {
	return encoder.encode(
		`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
	);
}
function stream(cost: unknown, isByok?: unknown) {
	const state = createUsageState();
	feedChunk(
		state,
		event("message_start", {
			message: {
				model: "deepseek/deepseek-v4-pro",
				usage: { input_tokens: 100, cost: 0 },
			},
		}),
		1000,
	);
	const delta = event("message_delta", {
		delta: { stop_reason: "end_turn" },
		usage: { output_tokens: 20, cost, is_byok: isByok },
	});
	// Arbitrary transport chunks must preserve the terminal cost.
	feedChunk(state, delta.slice(0, 37), 1010);
	feedChunk(state, delta.slice(37), 1020);
	feedChunk(state, event("message_stop", {}), 1030);
	return state;
}

describe("OpenRouter reported charges", () => {
	it("prefers streamed charges while retaining the estimate and BYOK status", async () => {
		const result = await finalizeUsage(stream(0.013, true), opts, {
			estimateCostUSD: async () => 0.02,
		});
		expect(result.usage).toMatchObject({
			costUsd: 0.013,
			estimatedCostUsd: 0.02,
			costSource: "reported",
			costIsByok: true,
		});
	});
	it("keeps an explicitly reported zero even with no catalogue price", async () => {
		const result = await finalizeUsage(stream(0, false), opts, {
			estimateCostUSD: async () => null,
		});
		expect(result.usage).toMatchObject({
			costUsd: 0,
			costSource: "reported",
			costIsByok: false,
		});
		expect(result.usage.estimatedCostUsd).toBeUndefined();
	});
	it("captures nonstream charges, including a charge with no model", async () => {
		const state = createUsageState();
		feedNonStreamBody(
			state,
			JSON.stringify({
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					cost: 0.013,
					is_byok: false,
				},
			}),
		);
		const result = await finalizeUsage(
			state,
			{ ...opts, isStream: false },
			{ estimateCostUSD: async () => null },
		);
		expect(result.usage).toMatchObject({
			costUsd: 0.013,
			costSource: "reported",
			costIsByok: false,
		});
	});
	it("ignores start placeholders and falls back when a stream is interrupted", async () => {
		const state = createUsageState();
		feedChunk(
			state,
			event("message_start", {
				message: {
					model: "deepseek/deepseek-v4-pro",
					usage: { input_tokens: 100, cost: 0 },
				},
			}),
			1000,
		);
		const result = await finalizeUsage(
			state,
			{ ...opts, endedCleanly: false },
			{ estimateCostUSD: async () => 0.02 },
		);
		expect(result.usage).toMatchObject({
			costUsd: 0.02,
			estimatedCostUsd: 0.02,
			costSource: "estimated",
		});
	});
	it("uses the estimate after a cut stream with a partial charge, but retains completed charges", async () => {
		const partial = createUsageState();
		feedChunk(
			partial,
			event("message_start", {
				message: { model: "deepseek/test", usage: { input_tokens: 100 } },
			}),
			1000,
		);
		feedChunk(
			partial,
			event("message_delta", {
				usage: { cost: 0.01, output_tokens: 10, is_byok: true },
			}),
			1010,
		);
		const interrupted = { ...opts, endedCleanly: false };
		expect(
			(
				await finalizeUsage(partial, interrupted, {
					estimateCostUSD: async () => 0.02,
				})
			).usage,
		).toMatchObject({
			costUsd: 0.02,
			costSource: "estimated",
			costIsByok: true,
		});
		expect(
			(
				await finalizeUsage(partial, interrupted, {
					estimateCostUSD: async () => null,
				})
			).usage,
		).toMatchObject({ costUsd: undefined, costSource: "unknown" });
		feedChunk(partial, event("message_stop", {}), 1030);
		expect(
			(
				await finalizeUsage(partial, interrupted, {
					estimateCostUSD: async () => 0.02,
				})
			).usage,
		).toMatchObject({ costUsd: 0.01, costSource: "reported" });
	});
	it("does not add cumulative charges or accept a stray charge after message_stop", async () => {
		const state = createUsageState();
		feedChunk(
			state,
			event("message_start", {
				message: { model: "deepseek/test", usage: { input_tokens: 100 } },
			}),
			1000,
		);
		feedChunk(
			state,
			event("message_delta", { usage: { cost: 0.01, output_tokens: 10 } }),
			1010,
		);
		feedChunk(
			state,
			event("message_delta", {
				delta: { stop_reason: "end_turn" },
				usage: { cost: 0.015, output_tokens: 20 },
			}),
			1020,
		);
		feedChunk(state, event("message_stop", {}), 1030);
		feedChunk(state, event("message_delta", { usage: { cost: 99 } }), 1040);
		expect(
			(await finalizeUsage(state, opts, { estimateCostUSD: async () => 0.02 }))
				.usage.costUsd,
		).toBe(0.015);
	});
	it("rejects invalid costs and preserves unknown rather than publishing a zero", async () => {
		for (const cost of [undefined, null, "0.013", -1, {}, []]) {
			const result = await finalizeUsage(stream(cost), opts, {
				estimateCostUSD: async () => null,
			});
			expect(result.usage.costUsd).toBeUndefined();
			expect(result.usage.costSource).toBe("unknown");
		}
	});
	it("does not trust charges from other providers, missing accounts, or custom endpoints", async () => {
		for (const overrides of [
			{ accountProvider: "codex" },
			{ accountProvider: undefined },
			{ accountCustomEndpoint: "https://example.test" },
		]) {
			const result = await finalizeUsage(
				stream(0, true),
				{ ...opts, ...overrides },
				{ estimateCostUSD: async () => 0.02 },
			);
			expect(result.usage).toMatchObject({
				costUsd: 0.02,
				costSource: "estimated",
			});
			expect(result.usage.costIsByok).toBeUndefined();
		}
	});
});
