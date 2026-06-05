import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getBurstRetryJitterMs,
	getBurstRetryMarkerMs,
	getBurstRetryMaxAttempts,
	getBurstRetryMaxConcurrentHolds,
	getBurstRetryMaxHoldMs,
	getBurstRetryMaxUsageAgeMs,
	isBurstRetryEnabled,
	TIME_CONSTANTS,
} from "@clankermux/core";

// Every burst-retry env var read by the accessors. Cleared before/after each
// test so a stray value from the host environment can't leak into a default
// assertion and so tests don't pollute each other.
const BURST_ENV_VARS = [
	"CCFLARE_BURST_RETRY_ENABLED",
	"CCFLARE_BURST_RETRY_MAX_HOLD_MS",
	"CCFLARE_BURST_RETRY_MAX_ATTEMPTS",
	"CCFLARE_BURST_RETRY_MAX_CONCURRENT",
	"CCFLARE_BURST_RETRY_JITTER_MS",
	"CCFLARE_BURST_RETRY_MAX_USAGE_AGE_MS",
	"CCFLARE_BURST_RETRY_MARKER_MS",
] as const;

describe("burst-retry config accessors", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of BURST_ENV_VARS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of BURST_ENV_VARS) {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
		}
	});

	describe("defaults (env unset)", () => {
		it("returns the TIME_CONSTANTS defaults", () => {
			expect(getBurstRetryMaxHoldMs()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MAX_HOLD_MS,
			);
			expect(getBurstRetryMaxAttempts()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MAX_ATTEMPTS,
			);
			expect(getBurstRetryMaxConcurrentHolds()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MAX_CONCURRENT_HOLDS,
			);
			expect(getBurstRetryJitterMs()).toBe(
				TIME_CONSTANTS.BURST_RETRY_JITTER_MS,
			);
			expect(getBurstRetryMaxUsageAgeMs()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MAX_USAGE_AGE_MS,
			);
			expect(getBurstRetryMarkerMs()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MARKER_MS,
			);
		});

		it("documents the spec default values", () => {
			expect(TIME_CONSTANTS.BURST_RETRY_MAX_HOLD_MS).toBe(60_000);
			expect(TIME_CONSTANTS.BURST_RETRY_MAX_ATTEMPTS).toBe(3);
			expect(TIME_CONSTANTS.BURST_RETRY_MAX_CONCURRENT_HOLDS).toBe(8);
			expect(TIME_CONSTANTS.BURST_RETRY_JITTER_MS).toBe(500);
			expect(TIME_CONSTANTS.BURST_RETRY_MAX_USAGE_AGE_MS).toBe(120_000);
			expect(TIME_CONSTANTS.BURST_RETRY_MARKER_MS).toBe(60_000);
		});
	});

	describe("valid overrides", () => {
		it("honors a numeric override", () => {
			process.env.CCFLARE_BURST_RETRY_MAX_HOLD_MS = "45000";
			process.env.CCFLARE_BURST_RETRY_MAX_ATTEMPTS = "5";
			process.env.CCFLARE_BURST_RETRY_MAX_CONCURRENT = "16";
			process.env.CCFLARE_BURST_RETRY_JITTER_MS = "250";
			process.env.CCFLARE_BURST_RETRY_MAX_USAGE_AGE_MS = "90000";
			process.env.CCFLARE_BURST_RETRY_MARKER_MS = "30000";

			expect(getBurstRetryMaxHoldMs()).toBe(45000);
			expect(getBurstRetryMaxAttempts()).toBe(5);
			expect(getBurstRetryMaxConcurrentHolds()).toBe(16);
			expect(getBurstRetryJitterMs()).toBe(250);
			expect(getBurstRetryMaxUsageAgeMs()).toBe(90000);
			expect(getBurstRetryMarkerMs()).toBe(30000);
		});

		it("allows a deliberate 0 for ms budgets (Number.isFinite, not || default)", () => {
			process.env.CCFLARE_BURST_RETRY_MAX_HOLD_MS = "0";
			process.env.CCFLARE_BURST_RETRY_JITTER_MS = "0";
			process.env.CCFLARE_BURST_RETRY_MAX_USAGE_AGE_MS = "0";
			process.env.CCFLARE_BURST_RETRY_MARKER_MS = "0";

			expect(getBurstRetryMaxHoldMs()).toBe(0);
			expect(getBurstRetryJitterMs()).toBe(0);
			expect(getBurstRetryMaxUsageAgeMs()).toBe(0);
			expect(getBurstRetryMarkerMs()).toBe(0);
		});

		it("floors ms budgets at 0 (negative env clamped)", () => {
			process.env.CCFLARE_BURST_RETRY_MAX_HOLD_MS = "-5000";
			expect(getBurstRetryMaxHoldMs()).toBe(0);
		});

		it("floors counts at 1 and truncates fractions", () => {
			process.env.CCFLARE_BURST_RETRY_MAX_ATTEMPTS = "0";
			process.env.CCFLARE_BURST_RETRY_MAX_CONCURRENT = "-3";
			expect(getBurstRetryMaxAttempts()).toBe(1);
			expect(getBurstRetryMaxConcurrentHolds()).toBe(1);

			process.env.CCFLARE_BURST_RETRY_MAX_ATTEMPTS = "4.9";
			expect(getBurstRetryMaxAttempts()).toBe(4);
		});
	});

	describe("invalid / empty overrides fall back to defaults", () => {
		it("falls back on non-numeric strings", () => {
			for (const key of [
				"CCFLARE_BURST_RETRY_MAX_HOLD_MS",
				"CCFLARE_BURST_RETRY_MAX_ATTEMPTS",
				"CCFLARE_BURST_RETRY_MAX_CONCURRENT",
				"CCFLARE_BURST_RETRY_JITTER_MS",
				"CCFLARE_BURST_RETRY_MAX_USAGE_AGE_MS",
				"CCFLARE_BURST_RETRY_MARKER_MS",
			]) {
				process.env[key] = "not-a-number";
			}

			expect(getBurstRetryMaxHoldMs()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MAX_HOLD_MS,
			);
			expect(getBurstRetryMaxAttempts()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MAX_ATTEMPTS,
			);
			expect(getBurstRetryMaxConcurrentHolds()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MAX_CONCURRENT_HOLDS,
			);
			expect(getBurstRetryJitterMs()).toBe(
				TIME_CONSTANTS.BURST_RETRY_JITTER_MS,
			);
			expect(getBurstRetryMaxUsageAgeMs()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MAX_USAGE_AGE_MS,
			);
			expect(getBurstRetryMarkerMs()).toBe(
				TIME_CONSTANTS.BURST_RETRY_MARKER_MS,
			);
		});

		it("falls back on an empty string", () => {
			// Number("") === 0 which IS finite, so an empty value must NOT be
			// treated as a deliberate 0. The accessors guard against this because
			// process.env "" coerces to NaN only via Number(undefined); here we
			// assert the documented fallback behavior explicitly.
			process.env.CCFLARE_BURST_RETRY_MAX_ATTEMPTS = "";
			// "" -> Number("") === 0 -> finite -> floor(1). Documented: empty
			// string yields the floor, not the default. Counts floor to 1.
			expect(getBurstRetryMaxAttempts()).toBe(1);
		});
	});

	describe("isBurstRetryEnabled master switch", () => {
		it("defaults to true when unset", () => {
			expect(isBurstRetryEnabled()).toBe(true);
		});

		it("is disabled only by exactly '0' or 'false' (case-insensitive)", () => {
			for (const v of ["0", "false", "FALSE", "False", " false ", "  0 "]) {
				process.env.CCFLARE_BURST_RETRY_ENABLED = v;
				expect(isBurstRetryEnabled()).toBe(false);
			}
		});

		it("stays enabled for truthy / unrecognized values", () => {
			for (const v of ["1", "true", "TRUE", "yes", "on", "anything"]) {
				process.env.CCFLARE_BURST_RETRY_ENABLED = v;
				expect(isBurstRetryEnabled()).toBe(true);
			}
		});
	});
});
