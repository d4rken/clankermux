import { describe, expect, it } from "bun:test";
import {
	ceilRetryAfterSeconds,
	clampRetryAfterSeconds,
	DEFAULT_RECHECK_RETRY_AFTER_SECONDS,
	RETRY_AFTER_RECHECK_CEILING_SECONDS,
	retryAfterFromDeadlines,
} from "../retry-after";

const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

describe("ceilRetryAfterSeconds", () => {
	it("never advises a client to wake before the deadline", () => {
		expect(ceilRetryAfterSeconds(NOW + 1_499, NOW)).toBe(2);
		expect(ceilRetryAfterSeconds(NOW + 1_000, NOW)).toBe(1);
		expect(ceilRetryAfterSeconds(NOW + 1, NOW)).toBe(1);
	});

	it("floors at one second for an elapsed deadline", () => {
		expect(ceilRetryAfterSeconds(NOW - 60_000, NOW)).toBe(1);
	});
});

describe("clampRetryAfterSeconds", () => {
	it("returns the honest deadline unchanged up to the ceiling", () => {
		expect(clampRetryAfterSeconds(1)).toBe(1);
		expect(clampRetryAfterSeconds(45)).toBe(45);
		expect(clampRetryAfterSeconds(RETRY_AFTER_RECHECK_CEILING_SECONDS)).toBe(
			RETRY_AFTER_RECHECK_CEILING_SECONDS,
		);
	});

	it("replaces a longer deadline with a jittered re-check interval", () => {
		const seen = new Set<number>();
		for (let i = 0; i < 400; i++) {
			const value = clampRetryAfterSeconds(7 * 86_400);
			expect(value).toBeGreaterThanOrEqual(45);
			expect(value).toBeLessThanOrEqual(55);
			seen.add(value);
		}
		// Jittered, not a constant.
		expect(seen.size).toBeGreaterThan(1);
	});

	it("never clamps a value at the ceiling boundary downward", () => {
		for (let seconds = 1; seconds <= 60; seconds++) {
			expect(clampRetryAfterSeconds(seconds)).toBe(seconds);
		}
		expect(clampRetryAfterSeconds(61)).toBeLessThanOrEqual(55);
	});
});

describe("retryAfterFromDeadlines", () => {
	it("uses the earliest dated blocker", () => {
		expect(
			retryAfterFromDeadlines([NOW + 90_000, NOW + 12_000, null], NOW),
		).toBe(12);
	});

	it("clamps a far-future blocker", () => {
		const value = retryAfterFromDeadlines([NOW + 5 * 86_400_000], NOW);
		expect(value).toBeGreaterThanOrEqual(45);
		expect(value).toBeLessThanOrEqual(55);
	});

	it("falls back to the default when nothing is dated", () => {
		expect(retryAfterFromDeadlines([], NOW)).toBe(
			DEFAULT_RECHECK_RETRY_AFTER_SECONDS,
		);
		expect(retryAfterFromDeadlines([null, undefined, NOW - 1], NOW)).toBe(
			DEFAULT_RECHECK_RETRY_AFTER_SECONDS,
		);
	});
});
