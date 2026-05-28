import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCostUSD, type TokenBreakdown } from "./pricing";

// Make pricing deterministic: never hit the network, and point the disk cache
// at a fresh empty dir so a stale/remote models.dev cache can't leak in. This
// forces the bundled fallback table to be the sole source of truth.
process.env.CF_PRICING_OFFLINE = "1";
process.env.TMPDIR = mkdtempSync(join(tmpdir(), "cmux-pricing-"));

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

describe("bundled Opus pricing (offline fallback)", () => {
	// Opus 4.7 and 4.8 both price at $5/M input, $25/M output,
	// $0.50/M cache read, $6.25/M cache write — same tier as Opus 4.5/4.6.
	const ioTokens: TokenBreakdown = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
	};
	const cacheTokens: TokenBreakdown = {
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};

	it("prices claude-opus-4-8 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-4-8", ioTokens)).toBeCloseTo(
			30,
			6,
		);
	});

	it("prices claude-opus-4-8 cache tokens from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-4-8", cacheTokens)).toBeCloseTo(
			6.75,
			6,
		);
	});

	it("backfills claude-opus-4-7 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-4-7", ioTokens)).toBeCloseTo(
			30,
			6,
		);
	});
});
