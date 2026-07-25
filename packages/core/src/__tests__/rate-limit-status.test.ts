import { describe, expect, it } from "bun:test";
import {
	ACCOUNT_WIDE_HARD_STATUSES,
	INDEPENDENT_BLOCK_STATUSES,
	isIndependentBlock,
	providerStatusToCause,
	REJECTING_STATUSES,
	SOFT_WARNING_STATUSES,
} from "../rate-limit-status";

describe("unified rate-limit status vocabulary", () => {
	it("ACCOUNT_WIDE_HARD_STATUSES holds exactly the four account-wide blocks", () => {
		expect([...ACCOUNT_WIDE_HARD_STATUSES].sort()).toEqual([
			"blocked",
			"payment_required",
			"queueing_hard",
			"rate_limited",
		]);
	});

	it("REJECTING_STATUSES is the hard set plus `rejected` (five values)", () => {
		expect([...REJECTING_STATUSES].sort()).toEqual([
			"blocked",
			"payment_required",
			"queueing_hard",
			"rate_limited",
			"rejected",
		]);
		for (const status of ACCOUNT_WIDE_HARD_STATUSES) {
			expect(REJECTING_STATUSES.has(status)).toBe(true);
		}
	});

	it("`rejected` is deliberately NOT account-wide-hard (family-weekly gate unaffected)", () => {
		expect(ACCOUNT_WIDE_HARD_STATUSES.has("rejected")).toBe(false);
	});

	it("INDEPENDENT_BLOCK_STATUSES is a subset of the hard set", () => {
		expect([...INDEPENDENT_BLOCK_STATUSES].sort()).toEqual([
			"blocked",
			"payment_required",
		]);
		for (const status of INDEPENDENT_BLOCK_STATUSES) {
			expect(ACCOUNT_WIDE_HARD_STATUSES.has(status)).toBe(true);
		}
	});

	it("the soft set is disjoint from the hard set", () => {
		expect([...SOFT_WARNING_STATUSES].sort()).toEqual([
			"allowed_warning",
			"queueing_soft",
		]);
		for (const status of SOFT_WARNING_STATUSES) {
			expect(ACCOUNT_WIDE_HARD_STATUSES.has(status)).toBe(false);
			expect(REJECTING_STATUSES.has(status)).toBe(false);
		}
	});
});

describe("isIndependentBlock", () => {
	it("is true for an out_of_credits cooldown reason", () => {
		expect(isIndependentBlock(null, "out_of_credits")).toBe(true);
		// The reason wins regardless of the provider status.
		expect(isIndependentBlock("allowed_warning", "out_of_credits")).toBe(true);
	});

	it("is true for the administrative/billing provider statuses", () => {
		expect(isIndependentBlock("payment_required", null)).toBe(true);
		expect(isIndependentBlock("blocked", null)).toBe(true);
	});

	it("is FALSE for generic throttle mechanisms (a spent quota explains those)", () => {
		for (const status of [
			"rate_limited",
			"queueing_hard",
			"queueing_soft",
			"rejected",
			"allowed_warning",
			"allowed",
			"some_new_status",
		]) {
			expect(isIndependentBlock(status, null)).toBe(false);
		}
	});

	it("is false for other cooldown reasons", () => {
		for (const reason of [
			"model_fallback_429",
			"weekly_exhausted_429",
			"family_weekly_exhausted_429",
		]) {
			expect(isIndependentBlock(null, reason)).toBe(false);
		}
	});

	it("is false for null / undefined / empty inputs", () => {
		expect(isIndependentBlock(null, null)).toBe(false);
		expect(isIndependentBlock(undefined, undefined)).toBe(false);
		expect(isIndependentBlock("", "")).toBe(false);
	});

	it("matches case-insensitively", () => {
		expect(isIndependentBlock("Payment_Required", null)).toBe(true);
		expect(isIndependentBlock("BLOCKED", null)).toBe(true);
	});

	it("matches as a PREFIX (the stored column can carry a suffix)", () => {
		expect(isIndependentBlock("payment_required (30m)", null)).toBe(true);
		expect(isIndependentBlock("blocked_by_provider", null)).toBe(true);
		// …but never as a substring.
		expect(isIndependentBlock("soft_payment_required", null)).toBe(false);
	});
});

describe("providerStatusToCause", () => {
	it("maps every known provider status to its cause", () => {
		expect(providerStatusToCause("allowed")).toBe("allowed");
		expect(providerStatusToCause("allowed_warning")).toBe("allowed_warning");
		expect(providerStatusToCause("queueing_soft")).toBe("queueing_soft");
		expect(providerStatusToCause("queueing_hard")).toBe("queueing_hard");
		expect(providerStatusToCause("rate_limited")).toBe("rate_limited");
		expect(providerStatusToCause("blocked")).toBe("blocked");
		expect(providerStatusToCause("payment_required")).toBe("payment_required");
	});

	it("normalizes `rejected` to the rate_limited cause", () => {
		expect(providerStatusToCause("rejected")).toBe("rate_limited");
	});

	it("is case-insensitive (stored values are compared lowercased)", () => {
		expect(providerStatusToCause("Rate_Limited")).toBe("rate_limited");
	});

	it("returns null for an unrecognized status", () => {
		expect(providerStatusToCause("some_new_status")).toBeNull();
		expect(providerStatusToCause("")).toBeNull();
	});
});
