/**
 * Unit tests for the shared auto-unpause predicates. `isAutoUnpauseCandidate`
 * is the structural half (pause state + auto-fallback + provider + elapsed
 * usage window + no live cooldown); `wouldAutoUnpause` adds the pause-reason
 * allowlist on top of it.
 */
import { describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import { isAutoUnpauseCandidate, wouldAutoUnpause } from "../peek-availability";

const NOW = 1_800_000_000_000;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct",
		name: "acct",
		provider: "anthropic",
		api_key: null,
		refresh_token: "r",
		access_token: "t",
		expires_at: NOW + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW - 86_400_000,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: true,
		rate_limit_reset: NOW - 60_000,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: true,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: "overage",
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

describe("isAutoUnpauseCandidate", () => {
	it("accepts a paused auto-fallback account with an elapsed usage window", () => {
		expect(isAutoUnpauseCandidate(makeAccount(), NOW)).toBe(true);
	});

	it("rejects an account that is not paused", () => {
		expect(isAutoUnpauseCandidate(makeAccount({ paused: false }), NOW)).toBe(
			false,
		);
	});

	it("rejects an account without auto_fallback_enabled", () => {
		expect(
			isAutoUnpauseCandidate(
				makeAccount({ auto_fallback_enabled: false }),
				NOW,
			),
		).toBe(false);
	});

	it("rejects providers without a resettable usage window", () => {
		expect(
			isAutoUnpauseCandidate(makeAccount({ provider: "ollama" }), NOW),
		).toBe(false);
	});

	it("rejects an unelapsed usage window (and the 1s clock-skew buffer)", () => {
		expect(
			isAutoUnpauseCandidate(makeAccount({ rate_limit_reset: NOW + 1 }), NOW),
		).toBe(false);
		expect(
			isAutoUnpauseCandidate(makeAccount({ rate_limit_reset: NOW - 500 }), NOW),
		).toBe(false);
		expect(
			isAutoUnpauseCandidate(makeAccount({ rate_limit_reset: null }), NOW),
		).toBe(false);
	});

	it("rejects an account whose cooldown is still running", () => {
		expect(
			isAutoUnpauseCandidate(
				makeAccount({ rate_limited_until: NOW + 60_000 }),
				NOW,
			),
		).toBe(false);
	});

	it("rejects an account whose cooldown ends exactly now", () => {
		// isAccountAvailable requires rate_limited_until < now, so a cooldown
		// ending at `now` is still a cooldown.
		expect(
			isAutoUnpauseCandidate(makeAccount({ rate_limited_until: NOW }), NOW),
		).toBe(false);
	});

	it("accepts an account whose cooldown has already elapsed", () => {
		expect(
			isAutoUnpauseCandidate(makeAccount({ rate_limited_until: NOW - 1 }), NOW),
		).toBe(true);
	});

	it("ignores pause_reason (that is wouldAutoUnpause's job)", () => {
		expect(
			isAutoUnpauseCandidate(makeAccount({ pause_reason: "manual" }), NOW),
		).toBe(true);
	});
});

describe("wouldAutoUnpause", () => {
	it("is true for self-healing pause reasons", () => {
		for (const reason of [null, "", "overage", "rate_limit_window"]) {
			expect(wouldAutoUnpause(makeAccount({ pause_reason: reason }), NOW)).toBe(
				true,
			);
		}
	});

	it("is false for durable pause reasons", () => {
		for (const reason of [
			"manual",
			"failure_threshold",
			"oauth_invalid_grant",
			"subscription_expired",
		]) {
			expect(wouldAutoUnpause(makeAccount({ pause_reason: reason }), NOW)).toBe(
				false,
			);
		}
	});

	it("is false while the cooldown is still running, even for overage", () => {
		expect(
			wouldAutoUnpause(makeAccount({ rate_limited_until: NOW + 60_000 }), NOW),
		).toBe(false);
	});

	it("is false when the cooldown ends exactly now", () => {
		expect(
			wouldAutoUnpause(makeAccount({ rate_limited_until: NOW }), NOW),
		).toBe(false);
	});

	it("is true once the cooldown has elapsed", () => {
		expect(
			wouldAutoUnpause(makeAccount({ rate_limited_until: NOW - 1 }), NOW),
		).toBe(true);
	});
});
