import { describe, expect, it } from "bun:test";
import {
	isQuotaDerivedRateLimitReason,
	isRateLimitReason,
	QUOTA_DERIVED_RATE_LIMIT_REASONS,
	RATE_LIMIT_REASONS,
} from "./account";

/**
 * Only quota-derived-BY-CONSTRUCTION reasons may be released early by the usage
 * poller. Every other reason must be refused — most importantly
 * `upstream_429_with_reset`, which a per-IP burst inherits (parseRateLimit
 * synthesizes a 60s reset for a bare 429), and `out_of_credits`, a billing floor.
 * One case per reason, so a newly-added reason is never silently eligible.
 */
describe("isQuotaDerivedRateLimitReason", () => {
	const eligible = ["weekly_exhausted_429", "session_exhausted_429"];
	const ineligible = [
		"upstream_429_with_reset",
		"model_fallback_429",
		"upstream_429_no_reset_probe_cooldown",
		"upstream_429_no_reset_default_5h",
		"upstream_529_overloaded_with_reset",
		"upstream_529_overloaded_no_reset",
		"out_of_credits",
		"all_models_exhausted_429",
		"family_weekly_exhausted_429",
	];

	it("accepts exactly the two quota-derived reasons", () => {
		for (const reason of eligible) {
			expect(isQuotaDerivedRateLimitReason(reason)).toBe(true);
		}
		expect([...QUOTA_DERIVED_RATE_LIMIT_REASONS].sort()).toEqual(
			[...eligible].sort(),
		);
	});

	it("refuses every other persisted reason", () => {
		for (const reason of ineligible) {
			expect(isQuotaDerivedRateLimitReason(reason)).toBe(false);
		}
	});

	it("covers EVERY member of RATE_LIMIT_REASONS (no reason left unclassified)", () => {
		const classified = new Set([...eligible, ...ineligible]);
		for (const reason of RATE_LIMIT_REASONS) {
			expect(classified.has(reason)).toBe(true);
		}
		expect(classified.size).toBe(RATE_LIMIT_REASONS.length);
	});

	it("every set member is a valid RateLimitReason at runtime", () => {
		for (const reason of [...eligible, ...ineligible]) {
			expect(isRateLimitReason(reason)).toBe(true);
		}
	});

	it("refuses an unknown string, null and undefined", () => {
		expect(isQuotaDerivedRateLimitReason("something_new_429")).toBe(false);
		expect(isQuotaDerivedRateLimitReason("")).toBe(false);
		expect(isQuotaDerivedRateLimitReason(null)).toBe(false);
		expect(isQuotaDerivedRateLimitReason(undefined)).toBe(false);
	});
});
