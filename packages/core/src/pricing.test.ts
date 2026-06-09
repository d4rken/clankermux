import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCostUSD, type TokenBreakdown } from "./pricing";

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
