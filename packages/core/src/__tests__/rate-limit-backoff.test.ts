import { describe, expect, it } from "bun:test";
import {
	computeRateLimitBackoffMs,
	getRateLimitResetStabilityMs,
	TIME_CONSTANTS,
} from "@clankermux/core";

const BASE = TIME_CONSTANTS.RATE_LIMIT_BACKOFF_BASE_MS; // 30_000
const MAX = TIME_CONSTANTS.RATE_LIMIT_BACKOFF_MAX_MS; // 300_000

describe("computeRateLimitBackoffMs", () => {
	it("returns BASE for n=1 (first 429 in the streak)", () => {
		expect(computeRateLimitBackoffMs(1)).toBe(BASE);
	});

	it("returns 2*BASE for n=2", () => {
		expect(computeRateLimitBackoffMs(2)).toBe(2 * BASE);
	});

	it("returns 4*BASE for n=3", () => {
		expect(computeRateLimitBackoffMs(3)).toBe(4 * BASE);
	});

	it("caps at MAX once the exponential ramp would exceed it (n=5)", () => {
		// 16 * 30_000 = 480_000 > MAX (300_000), so it must be clamped to MAX
		expect(computeRateLimitBackoffMs(5)).toBe(MAX);
	});

	it("returns MAX for very large n (n=100) without overflowing", () => {
		const result = computeRateLimitBackoffMs(100);
		expect(result).toBe(MAX);
		expect(Number.isFinite(result)).toBe(true);
	});

	it("clamps n=0 to n=1 (returns BASE)", () => {
		expect(computeRateLimitBackoffMs(0)).toBe(BASE);
	});

	it("clamps negative n to n=1 (returns BASE)", () => {
		expect(computeRateLimitBackoffMs(-5)).toBe(BASE);
	});
});

describe("getRateLimitResetStabilityMs", () => {
	it("returns the configured stability window (5 min)", () => {
		expect(getRateLimitResetStabilityMs()).toBe(
			TIME_CONSTANTS.RATE_LIMIT_RESET_STABILITY_MS,
		);
	});
});
