import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type {
	Account,
	AnthropicUsageData,
	LoadBalancingStrategy,
} from "@clankermux/types";
import { peekPrimaryAccountId } from "../peek-primary";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "../provider-overload-cooldown";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		...overrides,
	} as Account;
}

// A usage-cache payload whose five_hour window is far ahead of the elapsed
// pace, so getUsageThrottleUntil() returns a resume time after `now`.
function makeThrottlingUsage(now: number): AnthropicUsageData {
	const fiveHourMs = 5 * 60 * 60 * 1000;
	// Window started 1 minute ago, resets in ~5h; utilization 90% is far above
	// the ~0.3% expected by elapsed pace, so the account is throttled.
	return {
		five_hour: {
			utilization: 90,
			resets_at: new Date(now + fiveHourMs - 60_000).toISOString(),
		},
		seven_day: {
			utilization: 0,
			resets_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
		},
	} as AnthropicUsageData;
}

const throttleEnabledConfig = {
	getUsageThrottlingFiveHourEnabled: () => true,
	getUsageThrottlingWeeklyEnabled: () => true,
};
const throttleDisabledConfig = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
};

// Strategy mock that returns a fixed ranking from peekRanked and throws if
// select() is ever called (the badge must never mutate routing state).
function makeStrategy(ranked: Account[]): LoadBalancingStrategy & {
	selectCalls: number;
} {
	const wrapper = {
		selectCalls: 0,
		select(): Account[] {
			wrapper.selectCalls += 1;
			throw new Error("peekPrimaryAccountId must not call select()");
		},
		peekRanked: (_accounts: Account[]) => ranked,
		peek: (_accounts: Account[]) => ranked[0]?.id ?? null,
	};
	return wrapper as LoadBalancingStrategy & { selectCalls: number };
}

describe("peekPrimaryAccountId", () => {
	afterEach(() => {
		clearProviderOverloadCooldown();
		usageCache.delete("anthropicA");
		usageCache.delete("anthropicB");
		usageCache.delete("codex");
		usageCache.delete("acc-1");
	});

	it("returns null when there is no strategy", () => {
		expect(
			peekPrimaryAccountId([makeAccount()], null, throttleDisabledConfig),
		).toBeNull();
		expect(
			peekPrimaryAccountId([makeAccount()], undefined, throttleDisabledConfig),
		).toBeNull();
	});

	it("(a) returns the first ranked account when nothing is gated", () => {
		const now = 1_000_000;
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const b = makeAccount({ id: "anthropicB", provider: "anthropic" });
		const strategy = makeStrategy([a, b]);
		expect(
			peekPrimaryAccountId([a, b], strategy, throttleDisabledConfig, now),
		).toBe("anthropicA");
	});

	it("(b) falls through to Codex when Anthropic provider is overloaded", () => {
		const now = 1_000_000;
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const b = makeAccount({ id: "anthropicB", provider: "anthropic" });
		const codex = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([a, b, codex]);

		applyProviderOverloadCooldown("anthropic", now + 60_000);

		expect(
			peekPrimaryAccountId(
				[a, b, codex],
				strategy,
				throttleDisabledConfig,
				now,
			),
		).toBe("codex");
	});

	it("(c) skips a usage-throttled first account and returns the next survivor", () => {
		const now = 1_000_000;
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const b = makeAccount({ id: "anthropicB", provider: "anthropic" });
		const strategy = makeStrategy([a, b]);

		usageCache.set("anthropicA", makeThrottlingUsage(now));

		expect(
			peekPrimaryAccountId([a, b], strategy, throttleEnabledConfig, now),
		).toBe("anthropicB");
	});

	it("(d) returns null when every ranked account is gated", () => {
		const now = 1_000_000;
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const b = makeAccount({ id: "anthropicB", provider: "anthropic" });
		const strategy = makeStrategy([a, b]);

		// Both anthropic accounts gated by the shared provider overload.
		applyProviderOverloadCooldown("anthropic", now + 60_000);

		expect(
			peekPrimaryAccountId([a, b], strategy, throttleEnabledConfig, now),
		).toBeNull();
	});

	it("(e) does not gate on usage data when both throttle settings are disabled", () => {
		const now = 1_000_000;
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const b = makeAccount({ id: "anthropicB", provider: "anthropic" });
		const strategy = makeStrategy([a, b]);

		// Usage data that WOULD throttle if enabled.
		usageCache.set("anthropicA", makeThrottlingUsage(now));

		expect(
			peekPrimaryAccountId([a, b], strategy, throttleDisabledConfig, now),
		).toBe("anthropicA");
	});

	it("(f) never calls strategy.select", () => {
		const now = 1_000_000;
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const strategy = makeStrategy([a]);

		peekPrimaryAccountId([a], strategy, throttleDisabledConfig, now);

		expect(strategy.selectCalls).toBe(0);
	});
});
