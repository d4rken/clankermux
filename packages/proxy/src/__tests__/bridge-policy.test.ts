import { describe, expect, it } from "bun:test";
import {
	BRIDGE_JITTER_MAX_MS,
	DEFAULT_MIN_CACHE_TOKENS,
	hasCacheWritePremium,
	IDLE_GAP_FOR_PROMOTION_MS,
	isBridgeableProvider,
	isEligibleByTokens,
	KEEPALIVE_REFRESH_1H_MS,
	KEEPALIVE_REFRESH_MS,
	keepaliveBudgetUsd,
	keepaliveHitCostUsd,
	keepaliveMissCostUsd,
	MAX_PROMOTION_TRACKER_ENTRIES,
	MAX_SESSION_BODY_BYTES,
	MAX_SESSION_BRIDGE_BYTES,
	MAX_SESSION_SLOTS,
	PREMIUM_CACHE_PROVIDERS,
	PROMOTE_AFTER_TURNS,
	RISK_FACTOR,
	resumePenaltyUsd,
} from "../bridge-policy";

// Real Opus 4.8 cache rates (USD per 1M tokens): read 0.5, write 6.25.
const OPUS_READ = 0.5;
const OPUS_WRITE = 6.25;

describe("bridge-policy constants", () => {
	it("exposes the documented tuning values", () => {
		expect(RISK_FACTOR).toBe(0.4);
		expect(DEFAULT_MIN_CACHE_TOKENS).toBe(100_000);
		expect(MAX_SESSION_SLOTS).toBe(100);
		expect(MAX_SESSION_BRIDGE_BYTES).toBe(64 * 1024 * 1024);
		expect(MAX_SESSION_BODY_BYTES).toBe(2 * 1024 * 1024);
		expect(BRIDGE_JITTER_MAX_MS).toBe(1_000);
		expect(KEEPALIVE_REFRESH_MS).toBe(3 * 60_000);
	});

	it("exposes the Phase 2 predictive-promotion tuning values", () => {
		expect(PROMOTE_AFTER_TURNS).toBe(3);
		expect(IDLE_GAP_FOR_PROMOTION_MS).toBe(3 * 60_000);
		expect(KEEPALIVE_REFRESH_1H_MS).toBe(50 * 60_000);
		expect(MAX_PROMOTION_TRACKER_ENTRIES).toBe(500);
	});
});

describe("PREMIUM_CACHE_PROVIDERS / isBridgeableProvider", () => {
	it("contains exactly anthropic", () => {
		expect(PREMIUM_CACHE_PROVIDERS.has("anthropic")).toBe(true);
		expect(PREMIUM_CACHE_PROVIDERS.size).toBe(1);
	});

	it("is true for anthropic", () => {
		expect(isBridgeableProvider("anthropic")).toBe(true);
	});

	it("is false for non-Anthropic providers", () => {
		for (const p of ["codex", "openai", "zai"]) {
			expect(isBridgeableProvider(p)).toBe(false);
		}
	});

	it("is false for null, undefined, and empty string", () => {
		expect(isBridgeableProvider(null)).toBe(false);
		expect(isBridgeableProvider(undefined)).toBe(false);
		expect(isBridgeableProvider("")).toBe(false);
	});
});

describe("hasCacheWritePremium", () => {
	it("is true when write > read > 0 (Opus)", () => {
		expect(hasCacheWritePremium(OPUS_READ, OPUS_WRITE)).toBe(true);
	});

	it("is false when write is 0 (zai/GLM-style, no premium)", () => {
		expect(hasCacheWritePremium(0.11, 0)).toBe(false);
	});

	it("is false when write == read", () => {
		expect(hasCacheWritePremium(0.5, 0.5)).toBe(false);
	});

	it("is false when write < read", () => {
		expect(hasCacheWritePremium(0.5, 0.4)).toBe(false);
	});

	it("is false when read is 0 (no cache-read pricing)", () => {
		expect(hasCacheWritePremium(0, 6.25)).toBe(false);
	});

	it("is false when read is negative", () => {
		expect(hasCacheWritePremium(-1, 6.25)).toBe(false);
	});

	it("is false for NaN / Infinity inputs", () => {
		expect(hasCacheWritePremium(NaN, 6.25)).toBe(false);
		expect(hasCacheWritePremium(0.5, NaN)).toBe(false);
		expect(hasCacheWritePremium(Infinity, 6.25)).toBe(false);
		expect(hasCacheWritePremium(0.5, Infinity)).toBe(false);
		expect(hasCacheWritePremium(-Infinity, 6.25)).toBe(false);
	});
});

describe("keepaliveBudgetUsd", () => {
	it("computes the derated resume-penalty budget for Opus@100k", () => {
		// (6.25 - 0.5) / 1e6 * 100000 * 0.4 = 0.575 * 0.4 = 0.23
		expect(keepaliveBudgetUsd(100_000, OPUS_READ, OPUS_WRITE)).toBeCloseTo(
			0.23,
			10,
		);
	});

	it("returns 0 when there is no write premium (write 0)", () => {
		expect(keepaliveBudgetUsd(100_000, 0.11, 0)).toBe(0);
	});

	it("returns 0 when write == read", () => {
		expect(keepaliveBudgetUsd(100_000, 0.5, 0.5)).toBe(0);
	});

	it("returns 0 when read is 0", () => {
		expect(keepaliveBudgetUsd(100_000, 0, 6.25)).toBe(0);
	});

	it("returns 0 for zero / negative tokens", () => {
		expect(keepaliveBudgetUsd(0, OPUS_READ, OPUS_WRITE)).toBe(0);
		expect(keepaliveBudgetUsd(-100, OPUS_READ, OPUS_WRITE)).toBe(0);
	});

	it("returns 0 for non-finite inputs", () => {
		expect(keepaliveBudgetUsd(NaN, OPUS_READ, OPUS_WRITE)).toBe(0);
		expect(keepaliveBudgetUsd(100_000, NaN, OPUS_WRITE)).toBe(0);
		expect(keepaliveBudgetUsd(100_000, OPUS_READ, NaN)).toBe(0);
		expect(keepaliveBudgetUsd(Infinity, OPUS_READ, OPUS_WRITE)).toBe(0);
	});
});

describe("keepaliveHitCostUsd", () => {
	it("computes a cache-read hit cost for Opus@100k", () => {
		// 0.5 / 1e6 * 100000 = 0.05
		expect(keepaliveHitCostUsd(100_000, OPUS_READ)).toBeCloseTo(0.05, 10);
	});

	it("returns 0 for zero / negative tokens", () => {
		expect(keepaliveHitCostUsd(0, OPUS_READ)).toBe(0);
		expect(keepaliveHitCostUsd(-100, OPUS_READ)).toBe(0);
	});

	it("returns 0 for non-finite inputs", () => {
		expect(keepaliveHitCostUsd(NaN, OPUS_READ)).toBe(0);
		expect(keepaliveHitCostUsd(100_000, NaN)).toBe(0);
		expect(keepaliveHitCostUsd(100_000, Infinity)).toBe(0);
	});
});

describe("keepaliveMissCostUsd", () => {
	it("computes a cache-write miss cost for Opus@100k", () => {
		// 6.25 / 1e6 * 100000 = 0.625
		expect(keepaliveMissCostUsd(100_000, OPUS_WRITE)).toBeCloseTo(0.625, 10);
	});

	it("returns 0 for zero / negative tokens", () => {
		expect(keepaliveMissCostUsd(0, OPUS_WRITE)).toBe(0);
		expect(keepaliveMissCostUsd(-100, OPUS_WRITE)).toBe(0);
	});

	it("returns 0 for non-finite inputs", () => {
		expect(keepaliveMissCostUsd(NaN, OPUS_WRITE)).toBe(0);
		expect(keepaliveMissCostUsd(100_000, NaN)).toBe(0);
		expect(keepaliveMissCostUsd(100_000, Infinity)).toBe(0);
	});
});

describe("resumePenaltyUsd (LRU priority)", () => {
	it("computes the full (underated) recache penalty for Opus@100k", () => {
		// (6.25 - 0.5) / 1e6 * 100000 = 0.575
		expect(resumePenaltyUsd(100_000, OPUS_READ, OPUS_WRITE)).toBeCloseTo(
			0.575,
			10,
		);
	});

	it("returns 0 when write <= read (no premium)", () => {
		expect(resumePenaltyUsd(100_000, 0.5, 0.5)).toBe(0);
		expect(resumePenaltyUsd(100_000, 0.5, 0.4)).toBe(0);
		expect(resumePenaltyUsd(100_000, 0.11, 0)).toBe(0);
	});

	it("returns 0 for zero / negative tokens", () => {
		expect(resumePenaltyUsd(0, OPUS_READ, OPUS_WRITE)).toBe(0);
		expect(resumePenaltyUsd(-100, OPUS_READ, OPUS_WRITE)).toBe(0);
	});

	it("returns 0 for non-finite inputs", () => {
		expect(resumePenaltyUsd(NaN, OPUS_READ, OPUS_WRITE)).toBe(0);
		expect(resumePenaltyUsd(100_000, NaN, OPUS_WRITE)).toBe(0);
		expect(resumePenaltyUsd(100_000, OPUS_READ, NaN)).toBe(0);
		expect(resumePenaltyUsd(Infinity, OPUS_READ, OPUS_WRITE)).toBe(0);
	});
});

describe("budget vs hit/miss economics (Opus@100k)", () => {
	it("fits ~4-5 hits within the budget; one miss exceeds it", () => {
		const budget = keepaliveBudgetUsd(100_000, OPUS_READ, OPUS_WRITE); // 0.23
		const hit = keepaliveHitCostUsd(100_000, OPUS_READ); // 0.05
		const miss = keepaliveMissCostUsd(100_000, OPUS_WRITE); // 0.625

		// 4 hits = 0.20 < budget; 5 hits = 0.25 >= budget.
		expect(4 * hit).toBeLessThan(budget);
		expect(5 * hit).toBeGreaterThanOrEqual(budget);
		// A single miss alone blows the whole budget.
		expect(miss).toBeGreaterThan(budget);

		// Simulate spend accumulation: count how many hits stay under budget.
		let spent = 0;
		let hits = 0;
		while (spent < budget) {
			spent += hit;
			hits++;
		}
		// 5th hit is the one that crosses the threshold → ~4-5 fit.
		expect(hits).toBeGreaterThanOrEqual(4);
		expect(hits).toBeLessThanOrEqual(5);
	});
});

describe("isEligibleByTokens", () => {
	it("rejects below the threshold", () => {
		expect(isEligibleByTokens(99_999, DEFAULT_MIN_CACHE_TOKENS)).toBe(false);
	});

	it("accepts exactly the threshold (100_000 boundary)", () => {
		expect(isEligibleByTokens(100_000, DEFAULT_MIN_CACHE_TOKENS)).toBe(true);
	});

	it("accepts above the threshold", () => {
		expect(isEligibleByTokens(250_000, DEFAULT_MIN_CACHE_TOKENS)).toBe(true);
	});

	it("honors a custom (lower) threshold", () => {
		expect(isEligibleByTokens(50_000, 20_000)).toBe(true);
		expect(isEligibleByTokens(50_000, 60_000)).toBe(false);
	});
});
