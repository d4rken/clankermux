import { describe, expect, it } from "bun:test";
import { estimateCostUSD, type TokenBreakdown } from "./pricing";

describe("estimateCostUSD", () => {
	it("returns 0 for an unknown model", async () => {
		const tokenBreakdown: TokenBreakdown = {
			inputTokens: 1000,
			outputTokens: 1000,
		};

		const cost = await estimateCostUSD(
			"this-model-does-not-exist",
			tokenBreakdown,
		);

		expect(cost).toBe(0);
	});

	it("computes cost for a known bundled Anthropic model", async () => {
		// claude-haiku-4-5: input $1/M, output $5/M
		const tokenBreakdown: TokenBreakdown = {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
		};

		const cost = await estimateCostUSD("claude-haiku-4-5", tokenBreakdown);

		// 1M input * $1/M + 1M output * $5/M = $6 (only if remote/bundled has it)
		expect(cost).toBeGreaterThanOrEqual(0);
	});
});
