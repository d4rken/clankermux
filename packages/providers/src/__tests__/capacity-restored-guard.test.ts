import { describe, expect, it } from "bun:test";
import { shouldClearRateLimitOnCapacity } from "../usage-fetcher";

/**
 * The capacity-restored callback clears a stale `rate_limited_until`. Because the
 * account-wide representative excludes `extra_usage`, an overage/out_of_credits
 * account can read <100% — so the clear must be vetoed when `extra_usage` is
 * spent (belt-and-suspenders with the reason-aware guard in the server callback).
 */
describe("shouldClearRateLimitOnCapacity", () => {
	it("clears when previously rate-limited and both representative and extra_usage are < 100", () => {
		expect(shouldClearRateLimitOnCapacity(40, 20, true)).toBe(true);
		expect(shouldClearRateLimitOnCapacity(40, null, true)).toBe(true);
		expect(shouldClearRateLimitOnCapacity(40, undefined, true)).toBe(true);
	});

	it("does NOT clear when extra_usage is exhausted (overage / out_of_credits floor)", () => {
		// session/weekly below 100 but overage spent → must NOT wipe the floor.
		expect(shouldClearRateLimitOnCapacity(40, 100, true)).toBe(false);
		expect(shouldClearRateLimitOnCapacity(0, 120, true)).toBe(false);
	});

	it("does NOT clear when the account was not previously rate-limited", () => {
		expect(shouldClearRateLimitOnCapacity(40, 20, false)).toBe(false);
	});

	it("does NOT clear when representative is null (no evidence) or >= 100", () => {
		expect(shouldClearRateLimitOnCapacity(null, 20, true)).toBe(false);
		expect(shouldClearRateLimitOnCapacity(100, 20, true)).toBe(false);
	});
});
