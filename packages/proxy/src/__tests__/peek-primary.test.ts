import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import { usageCache } from "@clankermux/providers";
import type {
	Account,
	AnthropicUsageData,
	LoadBalancingStrategy,
} from "@clankermux/types";
import {
	earliestExclusionRecoveryMs,
	evaluateDefaultCandidates,
	peekPrimaryAccountId,
} from "../peek-primary";
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
		codex_auto_apply_reset_credits_enabled: false,
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
		usageCache.delete("codexPeer");
		usageCache.delete("otherPoolAccount");
		usageCache.delete("zaiA");
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

	it("(g) does NOT skip an account for a family-scoped open bucket", () => {
		const now = Date.now();
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const codex = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([a, codex]);

		// Haiku-only incident: Sonnet/Opus traffic still routes to Anthropic, so
		// the Primary badge must stay put.
		applyProviderOverloadCooldown(
			"anthropic",
			now + 60_000,
			"claude-haiku-4-5",
		);

		expect(
			peekPrimaryAccountId([a, codex], strategy, throttleDisabledConfig, now),
		).toBe("anthropicA");
	});

	it("(h) skips on a provider-wide open bucket even when family buckets also exist", () => {
		const now = Date.now();
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const codex = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([a, codex]);

		applyProviderOverloadCooldown(
			"anthropic",
			now + 60_000,
			"claude-haiku-4-5",
		);
		applyProviderOverloadCooldown("anthropic", now + 60_000); // provider-wide

		expect(
			peekPrimaryAccountId([a, codex], strategy, throttleDisabledConfig, now),
		).toBe("codex");
	});

	it("(i) does not skip on a half-open provider-wide bucket", () => {
		const now = Date.now();
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const codex = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([a, codex]);

		const until = applyProviderOverloadCooldown("anthropic", now + 60_000);

		// Past the deadline the bucket persists half-open; the badge treats the
		// account as routable again (probe admission is a request-path concern).
		expect(
			peekPrimaryAccountId(
				[a, codex],
				strategy,
				throttleDisabledConfig,
				until + 1,
			),
		).toBe("anthropicA");
	});

	it("(f) never calls strategy.select", () => {
		const now = 1_000_000;
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const strategy = makeStrategy([a]);

		peekPrimaryAccountId([a], strategy, throttleDisabledConfig, now);

		expect(strategy.selectCalls).toBe(0);
	});

	// --- pool-liveness reserve parity ---

	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;

	/** Usage with the given 5h / weekly utilization and a weekly reset 5 days out. */
	function usage(
		now: number,
		fiveHour: number,
		weekly: number,
	): AnthropicUsageData {
		return {
			five_hour: {
				utilization: fiveHour,
				resets_at: new Date(now + 4 * HOUR).toISOString(),
			},
			seven_day: {
				utilization: weekly,
				resets_at: new Date(now + 5 * DAY).toISOString(),
			},
		} as AnthropicUsageData;
	}

	it("(j) skips a liveness-reserved account when a surviving peer can absorb", () => {
		const now = Date.now();
		const reserved = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const peer = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([reserved, peer]);

		usageCache.set("anthropicA", usage(now, 0, 95)); // 5% weekly headroom
		usageCache.set("codex", usage(now, 20, 20)); // absorbable

		expect(
			peekPrimaryAccountId(
				[reserved, peer],
				strategy,
				throttleDisabledConfig,
				now,
			),
		).toBe("codex");
	});

	it("(k) counts only accounts that SURVIVED the hard gates as absorbable peers", () => {
		const now = Date.now();
		const reserved = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const peer = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([reserved, peer]);

		usageCache.set("anthropicA", usage(now, 0, 95));
		usageCache.set("codex", usage(now, 20, 20));

		// The only would-be absorber is overload-gated, so routing would keep the
		// reserved account. Evaluating liveness BEFORE the hard gates would count
		// the gated peer and make the badge skip an account real routing keeps.
		applyProviderOverloadCooldown("codex", now + 60_000);

		expect(
			peekPrimaryAccountId(
				[reserved, peer],
				strategy,
				throttleDisabledConfig,
				now,
			),
		).toBe("anthropicA");
	});

	it("(l) fails open on usage older than the routing freshness bound", () => {
		const now = Date.now();
		const reserved = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const peer = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([reserved, peer]);

		usageCache.set("anthropicA", usage(now, 0, 95));
		usageCache.set("codex", usage(now, 20, 20));

		// The reserved account's datum is 4 minutes old: still inside peek()'s
		// 10-minute TTL, but OUTSIDE the 180s bound routing's liveness path uses.
		// Routing fails open there, so the badge must too. The peer stays fresh, so
		// this is not merely "everything is stale".
		const ages = spyOn(usageCache, "peekAge").mockImplementation(
			(id: string) => (id === "anthropicA" ? 240_000 : 1_000),
		);
		try {
			expect(
				peekPrimaryAccountId(
					[reserved, peer],
					strategy,
					throttleDisabledConfig,
					now,
				),
			).toBe("anthropicA");
		} finally {
			ages.mockRestore();
		}
	});

	it("(m) still reports a reserved account as primary when nothing else survives", () => {
		const now = Date.now();
		const reserved = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const strategy = makeStrategy([reserved]);

		usageCache.set("anthropicA", usage(now, 0, 95));

		// Sole candidate: rule 4 (no absorbable peer) already fails the reserve
		// open, and the demotion is soft anyway — the badge must not go blank.
		expect(
			peekPrimaryAccountId([reserved], strategy, throttleDisabledConfig, now),
		).toBe("anthropicA");
	});

	it("(o) models the NON-PROTECTED tier: an account in the 10–20% band is skipped", () => {
		// 15% weekly headroom sits in the Fable-plus-emergencies band. The badge
		// models a generic fresh request, so it must use the ordinary tier (20) —
		// assuming Fable's deeper tier would report a primary that ordinary traffic
		// would never be routed to.
		const now = Date.now();
		const reserved = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const peer = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([reserved, peer]);

		usageCache.set("anthropicA", usage(now, 0, 85));
		usageCache.set("codex", usage(now, 20, 20));

		expect(
			peekPrimaryAccountId(
				[reserved, peer],
				strategy,
				throttleDisabledConfig,
				now,
			),
		).toBe("codex");
	});

	// --- stacked gates: an account can be held by BOTH hard gates at once ---

	it("(p) records BOTH gates holding one account, not just the first", () => {
		const now = Date.now();
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const strategy = makeStrategy([a]);

		// Held by the provider-wide breaker until T1, and by the proactive usage
		// throttle until a LATER T2 (90% of a 5h window that opened a minute ago
		// resumes ~4.5h out). Stopping at the first gate would leave T2 undiscovered.
		applyProviderOverloadCooldown("anthropic", now + 60_000);
		usageCache.set("anthropicA", makeThrottlingUsage(now));

		const evaluation = evaluateDefaultCandidates(
			[a],
			strategy,
			throttleEnabledConfig,
			now,
		);

		// Membership is what it always was: the account is out, nothing survives.
		expect(evaluation.candidateIds).toEqual([]);
		expect(evaluation.exclusions.map((e) => e.reason)).toEqual([
			"provider_overload",
			"usage_throttled",
		]);
		const [overload, throttle] = evaluation.exclusions;
		expect(overload?.accountId).toBe("anthropicA");
		expect(throttle?.accountId).toBe("anthropicA");
		expect(overload?.recoversAtMs).toBe(now + 60_000);
		expect(throttle?.recoversAtMs).toBeGreaterThan(now + 60_000);
	});

	it("(q) recovers on the account's LAST gate, not its first", () => {
		const now = Date.now();
		const a = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const strategy = makeStrategy([a]);

		applyProviderOverloadCooldown("anthropic", now + 60_000);
		usageCache.set("anthropicA", makeThrottlingUsage(now));

		const evaluation = evaluateDefaultCandidates(
			[a],
			strategy,
			throttleEnabledConfig,
			now,
		);
		const throttleAt = evaluation.exclusions.find(
			(e) => e.reason === "usage_throttled",
		)?.recoversAtMs;

		// The overload lifts in a minute and the account is still throttled for
		// hours: reporting T1 would promise a recovery that does not happen.
		expect(earliestExclusionRecoveryMs(evaluation.exclusions)).toBe(
			throttleAt as number,
		);
	});

	it("(r) MAX within an account, MIN across accounts", () => {
		// Pure derivation, independent of the gates that produced the entries.
		expect(
			earliestExclusionRecoveryMs([
				{ accountId: "a", reason: "provider_overload", recoversAtMs: 100 },
				{ accountId: "a", reason: "usage_throttled", recoversAtMs: 900 },
				{ accountId: "b", reason: "provider_overload", recoversAtMs: 500 },
			]),
		).toBe(500);
		// …and with `b` gone, the pool waits for `a`'s later gate, not its earlier.
		expect(
			earliestExclusionRecoveryMs([
				{ accountId: "a", reason: "provider_overload", recoversAtMs: 100 },
				{ accountId: "a", reason: "usage_throttled", recoversAtMs: 900 },
			]),
		).toBe(900);
		expect(earliestExclusionRecoveryMs([])).toBeNull();
	});

	// --- the shape of ONE evaluation, and whose evaluation it is ---

	it("(s) returns candidates, exclusions and reservations from a single evaluation", () => {
		// The whole return value, not just its head: a refactor that recomputed the
		// count, the candidate or the recovery separately would still satisfy a test
		// that only looked at the primary id.
		const now = Date.now();
		const gated = makeAccount({ id: "zaiA", provider: "zai" });
		const reserved = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const peer = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([gated, reserved, peer]);

		applyProviderOverloadCooldown("zai", now + 90_000);
		usageCache.set("anthropicA", usage(now, 0, 95)); // 5% weekly headroom
		usageCache.set("codex", usage(now, 20, 20)); // absorbable

		expect(
			evaluateDefaultCandidates(
				[gated, reserved, peer],
				strategy,
				throttleDisabledConfig,
				now,
			),
		).toEqual({
			// The reserved account is DEMOTED, not dropped: still routable, at the back.
			candidateIds: ["codex", "anthropicA"],
			exclusions: [
				{
					accountId: "zaiA",
					reason: "provider_overload",
					recoversAtMs: now + 90_000,
				},
			],
			livenessReservedIds: ["anthropicA"],
		});
	});

	it("(t) logs the badge diagnostic from its OWN evaluation, not shared state", () => {
		// A module-level skip accumulator would work for a single caller and leak
		// across two. The public snapshot evaluates its own pool silently, and the
		// badge must describe only the pool IT evaluated.
		const now = Date.now();

		// Force the change-only gate open: after this the last primary is `null`, so
		// the call under test necessarily logs.
		peekPrimaryAccountId([], makeStrategy([]), throttleDisabledConfig, now);

		const infoSpy = spyOn(Logger.prototype, "info").mockImplementation(
			() => undefined,
		);
		try {
			// A DIFFERENT caller, a DIFFERENT pool, one exclusion of its own.
			const otherAccount = makeAccount({
				id: "otherPoolAccount",
				provider: "zai",
			});
			applyProviderOverloadCooldown("zai", now + 60_000);
			const otherEvaluation = evaluateDefaultCandidates(
				[otherAccount],
				makeStrategy([otherAccount]),
				throttleDisabledConfig,
				now,
			);
			expect(otherEvaluation.exclusions.map((e) => e.accountId)).toEqual([
				"otherPoolAccount",
			]);
			// …and it is silent, so nothing it excluded can even reach this log.
			expect(infoSpy).not.toHaveBeenCalled();

			const gated = makeAccount({ id: "anthropicA", provider: "anthropic" });
			const reserved = makeAccount({ id: "codex", provider: "codex" });
			const peer = makeAccount({ id: "codexPeer", provider: "codex" });
			applyProviderOverloadCooldown("anthropic", now + 60_000);
			usageCache.set("codex", usage(now, 0, 95));
			usageCache.set("codexPeer", usage(now, 20, 20));

			expect(
				peekPrimaryAccountId(
					[gated, reserved, peer],
					makeStrategy([gated, reserved, peer]),
					throttleDisabledConfig,
					now,
				),
			).toBe("codexPeer");

			expect(infoSpy).toHaveBeenCalledTimes(1);
			const message = String(infoSpy.mock.calls[0]?.[0]);
			expect(message).toContain("Primary account → codexPeer");
			expect(message).toContain("overload-skipped=[anthropicA]");
			expect(message).toContain("liveness-reserved=[codex]");
			// The other caller's pool is nowhere in it.
			expect(message).not.toContain("otherPoolAccount");
		} finally {
			infoSpy.mockRestore();
		}
	});

	it("(n) stays non-evicting: the reserved account's cache entry survives the peek", () => {
		const now = Date.now();
		const reserved = makeAccount({ id: "anthropicA", provider: "anthropic" });
		const peer = makeAccount({ id: "codex", provider: "codex" });
		const strategy = makeStrategy([reserved, peer]);

		usageCache.set("anthropicA", usage(now, 0, 95));
		usageCache.set("codex", usage(now, 20, 20));

		peekPrimaryAccountId(
			[reserved, peer],
			strategy,
			throttleDisabledConfig,
			now,
		);

		expect(usageCache.peek("anthropicA")).not.toBeNull();
		expect(usageCache.peek("codex")).not.toBeNull();
	});
});
