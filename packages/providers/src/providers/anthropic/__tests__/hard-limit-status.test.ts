import { describe, expect, it } from "bun:test";
import {
	HARD_LIMIT_STATUSES,
	isAnthropicHardLimitStatus,
	SOFT_WARNING_STATUSES,
} from "../provider";

const UNIFIED_STATUS_HEADER = "anthropic-ratelimit-unified-status";

function responseWithStatus(status?: string): Response {
	const headers = new Headers();
	if (status !== undefined) {
		headers.set(UNIFIED_STATUS_HEADER, status);
	}
	return new Response(null, { status: 200, headers });
}

describe("isAnthropicHardLimitStatus", () => {
	describe("hard statuses ⇒ true", () => {
		for (const status of [
			"rate_limited",
			"blocked",
			"queueing_hard",
			"payment_required",
		]) {
			it(`"${status}" is a hard limit`, () => {
				expect(isAnthropicHardLimitStatus(responseWithStatus(status))).toBe(
					true,
				);
			});
		}

		it("covers exactly the documented hard set", () => {
			expect([...HARD_LIMIT_STATUSES].sort()).toEqual(
				["blocked", "payment_required", "queueing_hard", "rate_limited"].sort(),
			);
		});
	});

	describe("soft / warning statuses ⇒ false", () => {
		for (const status of ["allowed_warning", "queueing_soft"]) {
			it(`"${status}" is not a hard limit`, () => {
				expect(isAnthropicHardLimitStatus(responseWithStatus(status))).toBe(
					false,
				);
			});
		}

		it("the soft set is disjoint from the hard set", () => {
			for (const status of SOFT_WARNING_STATUSES) {
				expect(HARD_LIMIT_STATUSES.has(status)).toBe(false);
			}
		});
	});

	it("normal 'allowed' status ⇒ false", () => {
		expect(isAnthropicHardLimitStatus(responseWithStatus("allowed"))).toBe(
			false,
		);
	});

	it("absent header ⇒ false", () => {
		expect(isAnthropicHardLimitStatus(responseWithStatus(undefined))).toBe(
			false,
		);
	});

	it("empty header value ⇒ false", () => {
		expect(isAnthropicHardLimitStatus(responseWithStatus(""))).toBe(false);
	});

	it("unrecognized status ⇒ false", () => {
		expect(
			isAnthropicHardLimitStatus(responseWithStatus("something_else")),
		).toBe(false);
	});

	describe("comparison is exact and case-sensitive", () => {
		// parseRateLimit compares the raw header against HARD_LIMIT_STATUSES with
		// Set.has(), which is case-sensitive — the predicate must match that.
		for (const status of [
			"RATE_LIMITED",
			"Rate_Limited",
			"Blocked",
			"BLOCKED",
		]) {
			it(`"${status}" (wrong case) ⇒ false`, () => {
				expect(isAnthropicHardLimitStatus(responseWithStatus(status))).toBe(
					false,
				);
			});
		}

		it("a status value embedded in a larger string ⇒ false (exact match, no substring)", () => {
			expect(
				isAnthropicHardLimitStatus(responseWithStatus("rate_limited_soon")),
			).toBe(false);
		});
	});
});
