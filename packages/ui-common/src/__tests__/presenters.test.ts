import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { AccountPresenter } from "../presenters";

function makeAccount(
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id: "a1",
		name: "acct",
		provider: "anthropic",
		paused: false,
		rateLimitStatus: "OK",
		rateLimitCause: "ok",
		rateLimitCauseResetMs: null,
		rateLimitProviderStatus: null,
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		...overrides,
	} as AccountResponse;
}

describe("AccountPresenter.isRateLimited", () => {
	it("is false for the `ok` cause", () => {
		expect(new AccountPresenter(makeAccount()).isRateLimited).toBe(false);
	});

	it("is false for the soft `allowed` / `allowed_warning` causes", () => {
		for (const cause of ["allowed", "allowed_warning"] as const) {
			expect(
				new AccountPresenter(makeAccount({ rateLimitCause: cause }))
					.isRateLimited,
			).toBe(false);
		}
	});

	it("is TRUE for an `unknown` cause (we cannot tell that the account is fine)", () => {
		const account = makeAccount({
			rateLimitStatus: "some_new_status (5m)",
			rateLimitCause: "unknown",
			rateLimitProviderStatus: "some_new_status",
		});
		expect(new AccountPresenter(account).isRateLimited).toBe(true);
	});

	it("is true for usage_exhausted and rate_limited", () => {
		for (const cause of ["usage_exhausted", "rate_limited"] as const) {
			expect(
				new AccountPresenter(makeAccount({ rateLimitCause: cause }))
					.isRateLimited,
			).toBe(true);
		}
	});

	it("falls back to the display string when no cause is present (legacy payload)", () => {
		const legacy = makeAccount({
			rateLimitStatus: "some_new_status (5m)",
			rateLimitCause: undefined as unknown as AccountResponse["rateLimitCause"],
		});
		expect(new AccountPresenter(legacy).isRateLimited).toBe(true);
	});
});
