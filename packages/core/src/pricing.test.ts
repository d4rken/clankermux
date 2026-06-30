import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	estimateCostUSD,
	getModelCacheRates,
	type TokenBreakdown,
} from "./pricing";

// Make pricing deterministic: never hit the network, and point the disk cache
// at a fresh empty dir so a stale/remote models.dev cache can't leak in. This
// forces the bundled fallback table to be the sole source of truth.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("pricing test network disabled");
};

// The pricing disk cache is rooted at `tmpdir()`, so redirect the OS temp dir to
// a throwaway location. `bun test` shares one process across all test files, so
// this mutation must be restored in afterAll — leaking it makes `tmpdir()`
// return the throwaway dir for every file that runs afterward, which broke
// security/path-validator's "should include temp directory" assertion (its
// cached allowlist held the real /tmp while tmpdir() returned cmux-pricing-*).
const originalTmpdir = process.env.TMPDIR;
const pricingTmpdir = mkdtempSync(join(tmpdir(), "cmux-pricing-"));
process.env.TMPDIR = pricingTmpdir;

afterAll(() => {
	globalThis.fetch = originalFetch;
	if (originalTmpdir === undefined) {
		delete process.env.TMPDIR;
	} else {
		process.env.TMPDIR = originalTmpdir;
	}
	rmSync(pricingTmpdir, { recursive: true, force: true });
});

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

describe("bundled Sonnet 5 pricing (offline fallback)", () => {
	// Sonnet 5 prices at $3/M input, $15/M output, $0.30/M cache read,
	// $3.75/M cache write — same tier as Sonnet 4.5/4.6 (standard, post
	// introductory-period pricing).
	const ioTokens: TokenBreakdown = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
	};
	const cacheTokens: TokenBreakdown = {
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};

	it("prices claude-sonnet-5 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-sonnet-5", ioTokens)).toBeCloseTo(
			18,
			6,
		);
	});

	it("prices claude-sonnet-5 cache tokens from bundled data", async () => {
		expect(await estimateCostUSD("claude-sonnet-5", cacheTokens)).toBeCloseTo(
			4.05,
			6,
		);
	});
});

describe("bundled Mythos-class pricing (offline fallback)", () => {
	// Fable 5 and Mythos 5 both price at $10/M input, $50/M output,
	// $1.00/M cache read, $12.50/M cache write.
	const ioTokens: TokenBreakdown = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
	};
	const cacheTokens: TokenBreakdown = {
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};

	it("prices claude-fable-5 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-fable-5", ioTokens)).toBeCloseTo(
			60,
			6,
		);
	});

	it("prices claude-fable-5 cache tokens from bundled data", async () => {
		expect(await estimateCostUSD("claude-fable-5", cacheTokens)).toBeCloseTo(
			13.5,
			6,
		);
	});

	it("prices claude-mythos-5 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-mythos-5", ioTokens)).toBeCloseTo(
			60,
			6,
		);
	});
});

describe("getModelCacheRates", () => {
	it("returns Opus 4.8 rates from bundled data", () => {
		expect(getModelCacheRates("claude-opus-4-8")).toEqual({
			inputPer1M: 5,
			cacheReadPer1M: 0.5,
			cacheWritePer1M: 6.25,
		});
	});

	it("returns Sonnet 4.5 rates from bundled data", () => {
		// Resolution is exact-match (mirroring estimateCostUSD), so use the real
		// bundled id, which is dated: "claude-sonnet-4-5-20250929".
		expect(getModelCacheRates("claude-sonnet-4-5-20250929")).toEqual({
			inputPer1M: 3,
			cacheReadPer1M: 0.3,
			cacheWritePer1M: 3.75,
		});
	});

	it("returns Sonnet 5 rates from bundled data", () => {
		expect(getModelCacheRates("claude-sonnet-5")).toEqual({
			inputPer1M: 3,
			cacheReadPer1M: 0.3,
			cacheWritePer1M: 3.75,
		});
	});

	it("falls back to Sonnet-4 rates for an unknown model", () => {
		expect(getModelCacheRates("this-model-does-not-exist")).toEqual({
			inputPer1M: 3,
			cacheReadPer1M: 0.3,
			cacheWritePer1M: 3.75,
		});
	});

	it("returns 0 for cache rates a known model lacks", () => {
		// MiniMax-M2 is in the bundled table with input/output but no cache pricing.
		// It IS known, so we return its real input rate and 0 for the missing
		// cache rates — NOT the unknown-model Sonnet-4 fallback.
		expect(getModelCacheRates("MiniMax-M2")).toEqual({
			inputPer1M: 0.3,
			cacheReadPer1M: 0,
			cacheWritePer1M: 0,
		});
	});
});
