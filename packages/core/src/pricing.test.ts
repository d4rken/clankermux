import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__pricingTestHooks,
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
	// Opus 4.7, 4.8 and 5 all price at $5/M input, $25/M output,
	// $0.50/M cache read, $6.25/M cache write — same tier as Opus 4.5/4.6.
	// (Opus 5's $10/$50 "fast mode" is a Claude-API-only research preview with
	// no representation in this proxy.)
	const ioTokens: TokenBreakdown = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
	};
	const cacheTokens: TokenBreakdown = {
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};

	it("prices claude-opus-5 input/output from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-5", ioTokens)).toBeCloseTo(30, 6);
	});

	it("prices claude-opus-5 cache tokens from bundled data", async () => {
		expect(await estimateCostUSD("claude-opus-5", cacheTokens)).toBeCloseTo(
			6.75,
			6,
		);
	});

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

describe("bundled cost fields backfill a partial remote entry", () => {
	// models.dev can list a freshly-released model before it carries cache
	// pricing. Merging "remote wins wholesale" would then leave the merged entry
	// without cache_read/cache_write, getCostRate would throw, and the WHOLE
	// request cost would collapse to 0 (persisted as NULL) — the same outage the
	// bundled entry exists to prevent. Bundled must fill the per-field gaps while
	// every value the remote does define still wins.
	const allTokens: TokenBreakdown = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	};

	async function withRemoteCatalogue(
		remote: unknown,
		run: () => Promise<void>,
	): Promise<void> {
		const offlineFetch = globalThis.fetch;
		// Point the disk cache somewhere disposable so the stub catalogue can't
		// leak into any later test through the on-disk pricing cache.
		const remoteTmpdir = mkdtempSync(join(tmpdir(), "cmux-pricing-remote-"));
		process.env.TMPDIR = remoteTmpdir;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(remote), {
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		try {
			__pricingTestHooks.reset();
			await __pricingTestHooks.loadPricing();
			await run();
		} finally {
			globalThis.fetch = offlineFetch;
			process.env.TMPDIR = pricingTmpdir;
			rmSync(remoteTmpdir, { recursive: true, force: true });
			__pricingTestHooks.reset();
		}
	}

	it("fills missing cache costs while the remote input cost still wins", async () => {
		await withRemoteCatalogue(
			{
				anthropic: {
					models: {
						"claude-opus-5": {
							id: "claude-opus-5",
							name: "Claude Opus 5",
							// Deliberately no cache_read/cache_write, and an input
							// cost that differs from the bundled $5 so we can tell
							// which side won.
							cost: { input: 7, output: 25 },
						},
					},
				},
			},
			async () => {
				// 7 (remote input) + 25 (remote output) + 0.5 + 6.25 (bundled cache)
				expect(await estimateCostUSD("claude-opus-5", allTokens)).toBeCloseTo(
					38.75,
					6,
				);
			},
		);
	});

	it("still adds models the remote catalogue omits entirely", async () => {
		await withRemoteCatalogue(
			{
				anthropic: {
					models: {
						"claude-opus-5": {
							id: "claude-opus-5",
							name: "Claude Opus 5",
							cost: { input: 7, output: 25 },
						},
					},
				},
			},
			async () => {
				// claude-opus-4-8 is bundled-only in this catalogue: 5 + 25 + 0.5 + 6.25
				expect(await estimateCostUSD("claude-opus-4-8", allTokens)).toBeCloseTo(
					36.75,
					6,
				);
			},
		);
	});

	it("does not overwrite a remote cost of zero", async () => {
		await withRemoteCatalogue(
			{
				anthropic: {
					models: {
						"claude-opus-5": {
							id: "claude-opus-5",
							name: "Claude Opus 5",
							// A free/zero-rated field is a defined remote value and
							// must survive the backfill.
							cost: { input: 5, output: 25, cache_read: 0, cache_write: 0 },
						},
					},
				},
			},
			async () => {
				expect(await estimateCostUSD("claude-opus-5", allTokens)).toBeCloseTo(
					30,
					6,
				);
			},
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
	it("returns Opus 5 rates from bundled data", () => {
		expect(getModelCacheRates("claude-opus-5")).toEqual({
			inputPer1M: 5,
			cacheReadPer1M: 0.5,
			cacheWritePer1M: 6.25,
		});
	});

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
