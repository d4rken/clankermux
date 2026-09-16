/**
 * The request-path evidence that an account's subscription no longer covers
 * the service — and, just as load-bearing, everything that looks similar and
 * must NOT count, because every false positive here pauses a healthy account
 * until a human notices.
 */
import { describe, expect, it } from "bun:test";
import {
	isCodexSubscriptionLapse,
	isDevinSubscriptionLapse,
	PAUSE_REASON_SUBSCRIPTION_EXPIRED,
} from "../subscription-expiry";

describe("PAUSE_REASON_SUBSCRIPTION_EXPIRED", () => {
	it("is the string the dashboard and the public DTO already carry", () => {
		expect(PAUSE_REASON_SUBSCRIPTION_EXPIRED).toBe("subscription_expired");
	});
});

describe("isCodexSubscriptionLapse", () => {
	it("matches usage_not_included under error.code", () => {
		expect(
			isCodexSubscriptionLapse({
				error: {
					code: "usage_not_included",
					message: "Your ChatGPT plan does not include Codex.",
				},
			}),
		).toBe(true);
	});

	it("matches usage_not_included under error.type", () => {
		// The Codex error mapper keys on code first and type second, so the value
		// can arrive under either.
		expect(
			isCodexSubscriptionLapse({ error: { type: "usage_not_included" } }),
		).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(
			isCodexSubscriptionLapse({ error: { code: "USAGE_NOT_INCLUDED" } }),
		).toBe(true);
	});

	it("is false for the rate limit that sits beside it in the same branch", () => {
		expect(
			isCodexSubscriptionLapse({
				error: { code: "usage_limit_reached", message: "Rate limit reached" },
			}),
		).toBe(false);
	});

	it("is false for quota exhaustion", () => {
		expect(
			isCodexSubscriptionLapse({ error: { code: "insufficient_quota" } }),
		).toBe(false);
	});

	it("is false for anything unshaped", () => {
		expect(isCodexSubscriptionLapse(null)).toBe(false);
		expect(isCodexSubscriptionLapse("usage_not_included")).toBe(false);
		expect(isCodexSubscriptionLapse({ code: "usage_not_included" })).toBe(
			false,
		);
		expect(isCodexSubscriptionLapse({ error: null })).toBe(false);
		expect(
			isCodexSubscriptionLapse([{ error: { code: "usage_not_included" } }]),
		).toBe(false);
	});
});

describe("isDevinSubscriptionLapse", () => {
	it("matches a plan that lapsed to free", () => {
		expect(
			isDevinSubscriptionLapse(
				"free user account exceeded, please use an existing account or upgrade to a paid plan",
			),
		).toBe(true);
	});

	it("matches a seat the team removed", () => {
		expect(isDevinSubscriptionLapse("user is disabled by team")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isDevinSubscriptionLapse("User Is Disabled By Team")).toBe(true);
	});

	it("is false for daily quota exhaustion", () => {
		// Recovers at the daily reset; pausing would hold the account out of
		// rotation long past the reset that fixes it.
		expect(
			isDevinSubscriptionLapse(
				"failed_precondition: Your daily usage quota has been exhausted",
			),
		).toBe(false);
	});

	it("is false for a message rate limit", () => {
		expect(isDevinSubscriptionLapse("Reached overall message rate limit")).toBe(
			false,
		);
	});

	it("is false for an absent message", () => {
		expect(isDevinSubscriptionLapse(null)).toBe(false);
		expect(isDevinSubscriptionLapse(undefined)).toBe(false);
		expect(isDevinSubscriptionLapse("")).toBe(false);
	});
});
