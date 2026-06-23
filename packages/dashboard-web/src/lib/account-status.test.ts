import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@clankermux/types";
import { deriveAccountStatus } from "./account-status";

// Wednesday 2024-01-03, noon UTC. Anthropic peak is 13:00–19:00 UTC weekdays,
// so noon is OFF-peak — a predictable default for non-peak-related assertions.
const NOW = Date.UTC(2024, 0, 3, 12, 0, 0);
const MINUTE = 60_000;

function makeAccount(
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id: "a1",
		name: "acct",
		provider: "openai-compatible",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: "2024-01-01T00:00:00Z",
		paused: false,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "No active session",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: false,
		sessionStats: null,
		isPrimary: false,
		autoPauseOnOverageEnabled: false,
		peakHoursPauseEnabled: false,
		providerOverloadKey: null,
		providerOverloadedUntil: null,
		modelFallbacks: null,
		billingType: null,
		renewalAnchor: null,
		renewalCadence: null,
		...overrides,
	};
}

describe("deriveAccountStatus — identity fields", () => {
	it("passes through isPrimary, priority and hasRefreshToken", () => {
		const status = deriveAccountStatus(
			makeAccount({ isPrimary: true, priority: 3, hasRefreshToken: true }),
			NOW,
		);
		expect(status.isPrimary).toBe(true);
		expect(status.priority).toBe(3);
		expect(status.hasRefreshToken).toBe(true);
	});

	it("defaults a healthy account to no chips", () => {
		const status = deriveAccountStatus(makeAccount(), NOW);
		expect(status.isRateLimited).toBe(false);
		expect(status.isPaused).toBe(false);
		expect(status.showRateLimitChip).toBe(false);
		expect(status.showForceReset).toBe(false);
		expect(status.staleLockDetected).toBe(false);
		expect(status.isUsageThrottled).toBe(false);
		expect(status.providerOverloadedUntil).toBeNull();
		expect(status.providerOverloadMinutes).toBeNull();
	});
});

describe("deriveAccountStatus — rate-limit status", () => {
	it("flags a hard rate_limited status as limited and offers Force Reset", () => {
		const status = deriveAccountStatus(
			makeAccount({ rateLimitStatus: "rate_limited (30m)" }),
			NOW,
		);
		expect(status.isHardLimited).toBe(true);
		expect(status.isRateLimited).toBe(true);
		expect(status.showRateLimitChip).toBe(true);
		expect(status.showForceReset).toBe(true);
	});

	it("treats a soft warning as usable: chip shows, no hard-limit, no Force Reset", () => {
		const status = deriveAccountStatus(
			makeAccount({ rateLimitStatus: "allowed_warning (10m)" }),
			NOW,
		);
		expect(status.isHardLimited).toBe(false);
		// starts with "allowed" → not the bare warning icon
		expect(status.isRateLimited).toBe(false);
		// non-OK status → the colored health chip still renders
		expect(status.showRateLimitChip).toBe(true);
		expect(status.showForceReset).toBe(false);
	});

	it("shows the health chip for an 'allowed' status without the warning icon", () => {
		const status = deriveAccountStatus(
			makeAccount({ rateLimitStatus: "allowed (242m)" }),
			NOW,
		);
		expect(status.isRateLimited).toBe(false);
		expect(status.showRateLimitChip).toBe(true);
	});

	it("hides the chip entirely for an OK status", () => {
		const status = deriveAccountStatus(
			makeAccount({ rateLimitStatus: "OK" }),
			NOW,
		);
		expect(status.showRateLimitChip).toBe(false);
		expect(status.isRateLimited).toBe(false);
	});

	it("recognizes blocked, payment_required and queueing_hard as hard limits", () => {
		expect(
			deriveAccountStatus(makeAccount({ rateLimitStatus: "blocked" }), NOW)
				.isHardLimited,
		).toBe(true);
		expect(
			deriveAccountStatus(
				makeAccount({ rateLimitStatus: "payment_required" }),
				NOW,
			).isHardLimited,
		).toBe(true);
		expect(
			deriveAccountStatus(
				makeAccount({ rateLimitStatus: "queueing_hard (15m)" }),
				NOW,
			).isHardLimited,
		).toBe(true);
	});

	it("treats queueing_soft as a soft limit, not a hard one", () => {
		const status = deriveAccountStatus(
			makeAccount({ rateLimitStatus: "queueing_soft (5m)" }),
			NOW,
		);
		expect(status.isHardLimited).toBe(false);
		expect(status.showForceReset).toBe(false);
		// non-OK status still surfaces the colored chip
		expect(status.showRateLimitChip).toBe(true);
	});
});

describe("deriveAccountStatus — paused gating", () => {
	it("suppresses the chip and Force Reset while paused", () => {
		const status = deriveAccountStatus(
			makeAccount({ paused: true, rateLimitStatus: "rate_limited (30m)" }),
			NOW,
		);
		expect(status.isPaused).toBe(true);
		// chip and Force Reset are both gated on !paused
		expect(status.showRateLimitChip).toBe(false);
		expect(status.showForceReset).toBe(false);
		// the underlying hard-limit fact is still reported
		expect(status.isHardLimited).toBe(true);
		expect(status.isRateLimited).toBe(true);
	});
});

describe("deriveAccountStatus — legacy lock", () => {
	it("offers Force Reset when rateLimitedUntil is in the future even on an OK status", () => {
		const status = deriveAccountStatus(
			makeAccount({ rateLimitedUntil: NOW + 5 * MINUTE }),
			NOW,
		);
		expect(status.isBlockedByLegacyLock).toBe(true);
		expect(status.showForceReset).toBe(true);
	});

	it("ignores an expired legacy lock", () => {
		const status = deriveAccountStatus(
			makeAccount({ rateLimitedUntil: NOW - 5 * MINUTE }),
			NOW,
		);
		expect(status.isBlockedByLegacyLock).toBe(false);
		expect(status.showForceReset).toBe(false);
	});
});

describe("deriveAccountStatus — stale lock detection", () => {
	it("fires when locked but usage shows capacity below 100%", () => {
		const status = deriveAccountStatus(
			makeAccount({
				rateLimitStatus: "rate_limited (30m)",
				usageUtilization: 50,
			}),
			NOW,
		);
		expect(status.staleLockDetected).toBe(true);
	});

	it("fires at 0% utilization (the clearest stale case, guarding against falsy 0)", () => {
		const status = deriveAccountStatus(
			makeAccount({
				rateLimitStatus: "rate_limited (30m)",
				usageUtilization: 0,
			}),
			NOW,
		);
		expect(status.staleLockDetected).toBe(true);
	});

	it("does not fire at exactly 100% utilization", () => {
		const status = deriveAccountStatus(
			makeAccount({
				rateLimitStatus: "rate_limited (30m)",
				usageUtilization: 100,
			}),
			NOW,
		);
		expect(status.staleLockDetected).toBe(false);
	});

	it("does not fire without numeric usage data", () => {
		const status = deriveAccountStatus(
			makeAccount({
				rateLimitStatus: "rate_limited (30m)",
				usageUtilization: null,
			}),
			NOW,
		);
		expect(status.staleLockDetected).toBe(false);
	});

	it("does not fire when the account is not force-resettable", () => {
		const status = deriveAccountStatus(
			makeAccount({ rateLimitStatus: "OK", usageUtilization: 50 }),
			NOW,
		);
		expect(status.staleLockDetected).toBe(false);
	});
});

describe("deriveAccountStatus — usage throttling", () => {
	it("is true while the throttle window is in the future", () => {
		const status = deriveAccountStatus(
			makeAccount({ usageThrottledUntil: NOW + MINUTE }),
			NOW,
		);
		expect(status.isUsageThrottled).toBe(true);
	});

	it("is false once the throttle window has passed", () => {
		const status = deriveAccountStatus(
			makeAccount({ usageThrottledUntil: NOW - MINUTE }),
			NOW,
		);
		expect(status.isUsageThrottled).toBe(false);
	});
});

describe("deriveAccountStatus — provider overload", () => {
	it("rounds the remaining cooldown up to whole minutes", () => {
		const status = deriveAccountStatus(
			makeAccount({ providerOverloadedUntil: NOW + 90_000 }),
			NOW,
		);
		expect(status.providerOverloadedUntil).toBe(NOW + 90_000);
		expect(status.providerOverloadMinutes).toBe(2);
	});

	it("reports a minimum of 1 minute for a sub-minute cooldown", () => {
		const status = deriveAccountStatus(
			makeAccount({ providerOverloadedUntil: NOW + 10_000 }),
			NOW,
		);
		expect(status.providerOverloadMinutes).toBe(1);
	});

	it("clears once the cooldown has expired", () => {
		const status = deriveAccountStatus(
			makeAccount({ providerOverloadedUntil: NOW - 10_000 }),
			NOW,
		);
		expect(status.providerOverloadedUntil).toBeNull();
		expect(status.providerOverloadMinutes).toBeNull();
	});
});

describe("deriveAccountStatus — peak windows", () => {
	// Zai peak: 14:00–18:00 SGT (UTC+8). 07:00 UTC == 15:00 SGT.
	it("flags a zai account during peak hours", () => {
		const status = deriveAccountStatus(
			makeAccount({ provider: "zai" }),
			Date.UTC(2024, 0, 3, 7, 0, 0),
		);
		expect(status.showPeakChip).toBe(true);
		expect(status.isPeak).toBe(true);
		expect(status.peakChipLabel).toBe("Peak hours (14:00–18:00 SGT)");
	});

	it("labels a zai account off-peak outside the window", () => {
		// 00:00 UTC == 08:00 SGT → off-peak
		const status = deriveAccountStatus(
			makeAccount({ provider: "zai" }),
			Date.UTC(2024, 0, 3, 0, 0, 0),
		);
		expect(status.showPeakChip).toBe(true);
		expect(status.isPeak).toBe(false);
		expect(status.peakChipLabel).toBe("Off-peak hours");
	});

	// Anthropic peak: weekdays 13:00–19:00 UTC.
	it("flags an anthropic account during a weekday peak window", () => {
		const status = deriveAccountStatus(
			makeAccount({ provider: "anthropic" }),
			Date.UTC(2024, 0, 3, 15, 0, 0), // Wed 15:00 UTC
		);
		expect(status.showPeakChip).toBe(true);
		expect(status.isPeak).toBe(true);
		expect(status.peakChipLabel).toBe("Peak hours (5–11am PT, weekdays)");
	});

	it("treats anthropic peak hours on a weekend as off-peak", () => {
		const status = deriveAccountStatus(
			makeAccount({ provider: "anthropic" }),
			Date.UTC(2024, 0, 6, 15, 0, 0), // Sat 15:00 UTC
		);
		expect(status.isPeak).toBe(false);
		expect(status.peakChipLabel).toBe("Off-peak hours");
	});

	it("does not show a peak chip for providers without peak windows", () => {
		const status = deriveAccountStatus(
			makeAccount({ provider: "codex" }),
			Date.UTC(2024, 0, 3, 15, 0, 0),
		);
		expect(status.showPeakChip).toBe(false);
		expect(status.isPeak).toBe(false);
	});
});

describe("deriveAccountStatus — renewal", () => {
	it("surfaces no renewal for an account without an anchor", () => {
		const status = deriveAccountStatus(makeAccount(), NOW);
		expect(status.renewalNextDate).toBeNull();
		expect(status.renewalDaysLeft).toBeNull();
		expect(status.renewalUrgency).toBe("none");
	});

	it("surfaces a 'soon' renewal for a monthly anchor 5 days out", () => {
		// NOW = 2024-01-03 UTC; in any local TZ a monthly anchor on the 8th of
		// the current month is a few days away. Use a one-time date for a
		// deterministic 5-day gap independent of timezone month boundaries.
		const status = deriveAccountStatus(
			makeAccount({
				renewalAnchor: "2024-01-08",
				renewalCadence: "none",
			}),
			NOW,
		);
		expect(status.renewalNextDate).not.toBeNull();
		expect(status.renewalDaysLeft).toBe(5);
		expect(status.renewalUrgency).toBe("soon");
	});

	it("surfaces an 'imminent' renewal for a one-time date 1 day out", () => {
		const status = deriveAccountStatus(
			makeAccount({
				renewalAnchor: "2024-01-04",
				renewalCadence: "none",
			}),
			NOW,
		);
		expect(status.renewalDaysLeft).toBe(1);
		expect(status.renewalUrgency).toBe("imminent");
	});

	it("surfaces a 'past' renewal for an elapsed one-time date", () => {
		const status = deriveAccountStatus(
			makeAccount({
				renewalAnchor: "2024-01-01",
				renewalCadence: "none",
			}),
			NOW,
		);
		expect(status.renewalDaysLeft).toBe(-2);
		expect(status.renewalUrgency).toBe("past");
	});

	it("shows the renewal chip when an anchor is set and the account is healthy", () => {
		const status = deriveAccountStatus(
			makeAccount({ renewalAnchor: "2024-01-08", renewalCadence: "none" }),
			NOW,
		);
		expect(status.renewalNextDate).not.toBeNull();
		expect(status.showRenewalChip).toBe(true);
	});

	it("does not show the renewal chip without an anchor", () => {
		const status = deriveAccountStatus(makeAccount(), NOW);
		expect(status.showRenewalChip).toBe(false);
	});

	it("suppresses the renewal chip while the subscription is expired", () => {
		// Real provider state (expired) must dominate static renewal metadata: a
		// past one-time date would otherwise render a misleading renewal chip
		// alongside the red "Subscription expired" badge.
		const status = deriveAccountStatus(
			makeAccount({
				paused: true,
				pauseReason: "subscription_expired",
				renewalAnchor: "2024-01-01",
				renewalCadence: "none",
			}),
			NOW,
		);
		expect(status.isSubscriptionExpired).toBe(true);
		// The underlying renewal facts are still derived…
		expect(status.renewalNextDate).not.toBeNull();
		// …but the chip is suppressed.
		expect(status.showRenewalChip).toBe(false);
	});

	it("suppresses the renewal chip while expired even with a future renewal date", () => {
		const status = deriveAccountStatus(
			makeAccount({
				paused: true,
				pauseReason: "subscription_expired",
				renewalAnchor: "2024-02-01",
				renewalCadence: "monthly",
			}),
			NOW,
		);
		expect(status.isSubscriptionExpired).toBe(true);
		expect(status.showRenewalChip).toBe(false);
	});
});

describe("deriveAccountStatus — subscription expired", () => {
	it("flags isSubscriptionExpired when paused with pause_reason subscription_expired", () => {
		const status = deriveAccountStatus(
			makeAccount({ paused: true, pauseReason: "subscription_expired" }),
			NOW,
		);
		expect(status.isPaused).toBe(true);
		expect(status.isSubscriptionExpired).toBe(true);
	});

	it("does not flag manually paused accounts", () => {
		const status = deriveAccountStatus(
			makeAccount({ paused: true, pauseReason: "manual" }),
			NOW,
		);
		expect(status.isSubscriptionExpired).toBe(false);
	});

	it("does not flag unpaused accounts even with a stale reason", () => {
		const status = deriveAccountStatus(
			makeAccount({ paused: false, pauseReason: "subscription_expired" }),
			NOW,
		);
		expect(status.isSubscriptionExpired).toBe(false);
	});
});

describe("deriveAccountStatus — needs reauth", () => {
	it("flags isNeedsReauth when paused with pause_reason oauth_invalid_grant", () => {
		const status = deriveAccountStatus(
			makeAccount({ paused: true, pauseReason: "oauth_invalid_grant" }),
			NOW,
		);
		expect(status.isPaused).toBe(true);
		expect(status.isNeedsReauth).toBe(true);
		// Distinct from the subscription-expired state.
		expect(status.isSubscriptionExpired).toBe(false);
	});

	it("does not flag other pause reasons", () => {
		for (const reason of [
			"manual",
			"failure_threshold",
			"subscription_expired",
		]) {
			const status = deriveAccountStatus(
				makeAccount({ paused: true, pauseReason: reason }),
				NOW,
			);
			expect(status.isNeedsReauth).toBe(false);
		}
	});

	it("does not flag unpaused accounts even with a stale reason", () => {
		const status = deriveAccountStatus(
			makeAccount({ paused: false, pauseReason: "oauth_invalid_grant" }),
			NOW,
		);
		expect(status.isNeedsReauth).toBe(false);
	});
});

describe("deriveAccountStatus — codex on-credits", () => {
	it("flags a codex account drawing on purchased credits past its weekly limit", () => {
		const status = deriveAccountStatus(
			makeAccount({
				provider: "codex",
				codexCredits: {
					hasCredits: true,
					balance: 2430.25,
					unlimited: false,
					planType: "prolite",
					weeklyUsedPct: 100,
				},
			}),
			NOW,
		);
		expect(status.isOnCredits).toBe(true);
		expect(status.creditsBalance).toBe(2430.25);
		expect(status.creditsPlanType).toBe("prolite");
	});

	it("does not flag an unlimited codex account", () => {
		const status = deriveAccountStatus(
			makeAccount({
				provider: "codex",
				codexCredits: {
					hasCredits: true,
					balance: null,
					unlimited: true,
					planType: "pro",
					weeklyUsedPct: 100,
				},
			}),
			NOW,
		);
		expect(status.isOnCredits).toBe(false);
		expect(status.creditsBalance).toBeNull();
		// balance and plan are both gated on isOnCredits — neither surfaces when
		// the account is not actually drawing on credits (e.g. unlimited).
		expect(status.creditsPlanType).toBeNull();
	});

	it("does not flag a codex account below its weekly limit", () => {
		const status = deriveAccountStatus(
			makeAccount({
				provider: "codex",
				codexCredits: {
					hasCredits: true,
					balance: 100,
					unlimited: false,
					planType: "prolite",
					weeklyUsedPct: 42,
				},
			}),
			NOW,
		);
		expect(status.isOnCredits).toBe(false);
		expect(status.creditsBalance).toBeNull();
	});

	it("does not flag a non-codex account even with credit-like data", () => {
		const status = deriveAccountStatus(
			makeAccount({
				provider: "anthropic",
				codexCredits: {
					hasCredits: true,
					balance: 500,
					unlimited: false,
					planType: "prolite",
					weeklyUsedPct: 100,
				},
			}),
			NOW,
		);
		expect(status.isOnCredits).toBe(false);
		expect(status.creditsBalance).toBeNull();
	});

	it("does not flag a codex account with null codexCredits", () => {
		const status = deriveAccountStatus(
			makeAccount({ provider: "codex", codexCredits: null }),
			NOW,
		);
		expect(status.isOnCredits).toBe(false);
		expect(status.creditsBalance).toBeNull();
		expect(status.creditsPlanType).toBeNull();
	});
});
