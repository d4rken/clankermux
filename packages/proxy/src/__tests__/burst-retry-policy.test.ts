import { describe, expect, it } from "bun:test";
import { makeAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import {
	createBurstRetryGiveUpResponse,
	isBurstHoldEligible,
} from "../burst-retry-policy";

function heldAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		name: "Main",
		provider: "anthropic",
		created_at: Date.now(),
		...overrides,
	});
}

describe("createBurstRetryGiveUpResponse", () => {
	it("rounds a sub-second cooldown remainder UP so the advice is never early", async () => {
		const realDateNow = Date.now;
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		Date.now = () => now;
		try {
			const res = createBurstRetryGiveUpResponse(
				heldAccount({ rate_limited_until: now + 1_499 }),
			);
			expect(res.status).toBe(429);
			expect(res.headers.get("Retry-After")).toBe("2");
			const body = (await res.json()) as {
				error: { retry_after_seconds: number };
			};
			expect(body.error.retry_after_seconds).toBe(2);
		} finally {
			Date.now = realDateNow;
		}
	});

	it("keeps the 1s floor for a cooldown that has all but elapsed", () => {
		const realDateNow = Date.now;
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		Date.now = () => now;
		try {
			const res = createBurstRetryGiveUpResponse(
				heldAccount({ rate_limited_until: now - 5_000 }),
			);
			expect(res.headers.get("Retry-After")).toBe("1");
		} finally {
			Date.now = realDateNow;
		}
	});

	it("holds only an available or cooldown-held account", () => {
		expect(isBurstHoldEligible("affinity_hit", true)).toBe(true);
		expect(isBurstHoldEligible("affinity_hold", false)).toBe(true);
		expect(isBurstHoldEligible("affinity_hit", false)).toBe(false);
	});
});
