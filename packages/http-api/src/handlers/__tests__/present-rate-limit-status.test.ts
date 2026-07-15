import { describe, expect, it } from "bun:test";
import type { AnthropicUsageData } from "@clankermux/types";
import { presentRateLimitStatus } from "../accounts";
import { weeklyExhaustion } from "../health";

const NOW = 1_750_000_000_000;
const MIN = 60_000;

/** The base "no live lock / no stored status" fields → would read "OK". */
const OK_FIELDS = {
	rate_limit_status: null,
	rate_limit_reset: null,
	rate_limited: 0,
	rate_limited_until: null,
} as const;

/** Run the exhaustion derivation exactly as the accounts handler does. */
function statusForUsage(usage: AnthropicUsageData, now: number): string {
	const { exhausted, resetMs } = weeklyExhaustion(usage, now);
	return presentRateLimitStatus(OK_FIELDS, now, exhausted ? { resetMs } : null);
}

describe("presentRateLimitStatus", () => {
	it("overrides a stale soft status with rate_limited (Nm) when an active lock exists", () => {
		// Backup2-darken scenario: stored status is allowed_warning but the
		// proxy's model_fallback_429 cooldown locked the account.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 7 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (7m)");
	});

	it("rounds active-lock minutes up (ceil)", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 6 * MIN + 1,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (7m)");
	});

	it("overrides a stale soft status even when legacy rate_limited flag is unset", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "queueing_soft",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: NOW + 3 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (3m)");
	});

	it("keeps a hard stored status untouched during an active lock (with reset minutes)", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: NOW + 12 * MIN,
				rate_limited: 1,
				rate_limited_until: NOW + 12 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (12m)");
	});

	it("falls back to the lock countdown for a hard status during an active lock (no reset set)", () => {
		// Hard stored status + active lock, but the provider never sent a usable
		// rate_limit_reset — surface the lock-based countdown instead of a bare
		// status with no ETA.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "blocked",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 5 * MIN,
			},
			NOW,
		);
		expect(status).toBe("blocked (5m)");
	});

	it("hard status + active lock + null reset shows the lock-based countdown", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 8 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (8m)");
	});

	it("hard status + active lock + past reset falls back to the lock countdown", () => {
		// The provider reset is stale (already elapsed) — the lock is the only
		// live signal, so its countdown wins.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: NOW - MIN,
				rate_limited: 1,
				rate_limited_until: NOW + 10 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (10m)");
	});

	it("hard status + active lock + future reset uses the reset-based countdown (reset wins)", () => {
		// Provider reset and lock disagree — the provider reset takes precedence.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: NOW + 12 * MIN,
				rate_limited: 1,
				rate_limited_until: NOW + 30 * MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited (12m)");
	});

	it("hard status with no active lock and no reset stays bare", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: NOW - MIN,
			},
			NOW,
		);
		expect(status).toBe("rate_limited");
	});

	it("treats every hard prefix as hard, case-insensitively (no soft override, lock countdown shown)", () => {
		for (const stored of [
			"rate_limited",
			"Rate_Limited",
			"blocked",
			"queueing_hard",
			"payment_required",
		]) {
			const status = presentRateLimitStatus(
				{
					rate_limit_status: stored,
					rate_limit_reset: null,
					rate_limited: 1,
					rate_limited_until: NOW + 5 * MIN,
				},
				NOW,
			);
			// Hard statuses are never rewritten to the normalized `rate_limited`
			// base; with an active lock and no reset they carry the lock countdown.
			expect(status).toBe(`${stored} (5m)`);
		}
	});

	it("shows soft status unchanged when there is no active lock", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
		);
		expect(status).toBe("allowed_warning");
	});

	it("shows soft status with reset minutes when there is no active lock", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: NOW + 9 * MIN,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
		);
		expect(status).toBe("allowed_warning (9m)");
	});

	it("treats an expired rate_limited_until as no lock", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW - MIN,
			},
			NOW,
		);
		expect(status).toBe("allowed_warning");
	});

	it("falls back to legacy 'Rate limited (Nm)' when stored status is null", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 4 * MIN,
			},
			NOW,
		);
		expect(status).toBe("Rate limited (4m)");
	});

	it("returns OK when stored status is null and the legacy lock has expired", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW - MIN,
			},
			NOW,
		);
		expect(status).toBe("OK");
	});

	it("returns OK when nothing is set", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
		);
		expect(status).toBe("OK");
	});

	it("surfaces usage_exhausted (Nm) instead of OK when the weekly window is spent", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
			{ resetMs: NOW + 15 * MIN },
		);
		expect(status).toBe("usage_exhausted (15m)");
	});

	it("shows a bare usage_exhausted when the weekly reset is unknown/null", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
			{ resetMs: null },
		);
		expect(status).toBe("usage_exhausted");
	});

	it("prefers an active rate-limit lock over weekly exhaustion", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 4 * MIN,
			},
			NOW,
			{ resetMs: NOW + 15 * MIN },
		);
		expect(status).toBe("Rate limited (4m)");
	});

	it("does not override an OK-returning path when weeklyExhausted is null", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: null,
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
			null,
		);
		expect(status).toBe("OK");
	});

	it("reflects a spent seven_day_oauth_apps window (binding), not just seven_day", () => {
		// seven_day below 100 but the OAuth-apps weekly quota is spent → non-OK.
		const usage: AnthropicUsageData = {
			five_hour: {
				utilization: 10,
				resets_at: new Date(NOW + 30 * MIN).toISOString(),
			},
			seven_day: {
				utilization: 50,
				resets_at: new Date(NOW + 20 * MIN).toISOString(),
			},
			seven_day_oauth_apps: {
				utilization: 100,
				resets_at: new Date(NOW + 15 * MIN).toISOString(),
			},
		};
		expect(statusForUsage(usage, NOW)).toBe("usage_exhausted (15m)");
	});

	it("does not flag a spent seven_day_oauth_apps whose reset is already past (stale) — stays OK", () => {
		const usage: AnthropicUsageData = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 50, resets_at: null },
			seven_day_oauth_apps: {
				utilization: 100,
				resets_at: new Date(NOW - MIN).toISOString(),
			},
		};
		expect(statusForUsage(usage, NOW)).toBe("OK");
	});

	it("overrides a no-lock SOFT stored status with usage_exhausted when weekly is spent", () => {
		// allowed_warning is a soft (non-blocking) status; with no active lock and a
		// spent weekly window, the account IS blocked account-wide → usage_exhausted.
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: null,
			},
			NOW,
			{ resetMs: NOW + 12 * MIN },
		);
		expect(status).toBe("usage_exhausted (12m)");
	});

	it("does NOT override a HARD stored status with usage_exhausted (hard keeps precedence)", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "rate_limited",
				rate_limit_reset: null,
				rate_limited: 0,
				rate_limited_until: NOW - MIN, // no active lock
			},
			NOW,
			{ resetMs: NOW + 12 * MIN },
		);
		expect(status).toBe("rate_limited");
	});

	it("does NOT override a soft status when there is an active lock (lock precedence)", () => {
		const status = presentRateLimitStatus(
			{
				rate_limit_status: "allowed_warning",
				rate_limit_reset: null,
				rate_limited: 1,
				rate_limited_until: NOW + 5 * MIN,
			},
			NOW,
			{ resetMs: NOW + 12 * MIN },
		);
		expect(status).toBe("rate_limited (5m)");
	});
});
