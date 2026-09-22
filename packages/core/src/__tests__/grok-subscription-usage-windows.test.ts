/**
 * A paid Grok plan draws Chat, Imagine, Voice, Build and API from ONE weekly
 * pool, so its payload has a weekly window and no five-hour one.
 *
 * Two things are under test here. First that the weekly pool reaches the
 * account-wide surfaces at all — membership in `SEVEN_DAY_ELIGIBLE_PROVIDERS`
 * plus a `kind`-guarded extractor branch, which pool headroom, the API-key
 * runway and the weekly workloads all read. Second that adding a member to
 * `FullUsageData` changed no other provider's answer: the shape detectors
 * decide which provider's field semantics a payload is read with, so they are
 * the thing a new union member breaks most easily.
 */
import { describe, expect, it } from "bun:test";
import type { FullUsageData } from "@clankermux/types";
import {
	DAILY_ELIGIBLE_PROVIDERS,
	extractFiveHour,
	extractSevenDay,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	isAlibabaShape,
	isAnthropicStyleShape,
	isDevinShape,
	isGrokSubscriptionShape,
	isZaiShape,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
} from "../usage-window-extract";
import { accountWideExhaustionFor } from "../weekly-exhaustion";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function grok(
	weeklyUtilization: number | null,
	weeklyResetAt: number = NOW + 3 * DAY,
): FullUsageData {
	return {
		kind: "grok-subscription",
		weeklyUtilization,
		weeklyResetAt,
		weeklyPeriodStartAt: weeklyResetAt - 7 * DAY,
		onDemandCapCents: null,
		onDemandUsedCents: null,
		prepaidBalanceCents: null,
	};
}

const devin: FullUsageData = {
	kind: "devin",
	quotaBased: true,
	daily: { utilization: 10, resetAt: NOW + HOUR },
	weekly: { utilization: 20, resetAt: NOW + DAY },
	planName: null,
	email: null,
	accountId: null,
	canUseCli: null,
	overageBalanceUsd: 0,
	includedCreditsRemaining: null,
};

const alibaba: FullUsageData = {
	five_hour: { used: 0, total: 0, percentUsed: 11, resetAt: NOW + HOUR },
	weekly: { used: 0, total: 0, percentUsed: 22, resetAt: NOW + DAY },
	monthly: { used: 0, total: 0, percentUsed: 33, resetAt: NOW + 2 * DAY },
	planName: null,
	status: null,
	remainingDays: null,
};

const zai: FullUsageData = {
	time_limit: null,
	tokens_limit: {
		used: 0,
		remaining: 0,
		percentage: 44,
		resetAt: NOW + HOUR,
		type: "tokens_limit",
	},
	tokens_limit_weekly: {
		used: 0,
		remaining: 0,
		percentage: 55,
		resetAt: NOW + DAY,
		type: "tokens_limit_weekly",
	},
};

const anthropic = {
	five_hour: { utilization: 66, resets_at: new Date(NOW + HOUR).toISOString() },
	seven_day: { utilization: 77, resets_at: new Date(NOW + DAY).toISOString() },
} as unknown as FullUsageData;

describe("grok-subscription account-wide windows", () => {
	it("reports the weekly pool as the seven-day window", () => {
		const reset = NOW + 2 * DAY;
		expect(extractSevenDay(grok(64, reset))).toEqual({
			pct: 64,
			resetMs: reset,
		});
	});

	it("keeps an unknown utilization unknown rather than reporting 0%", () => {
		const reset = NOW + 2 * DAY;
		expect(extractSevenDay(grok(null, reset))).toEqual({
			pct: null,
			resetMs: reset,
		});
	});

	it("reports NO five-hour window", () => {
		// Null, not `{ pct: null }`: there is no five-hour window here that a
		// reading is outstanding for, so no caller may render one as unreadable.
		expect(extractFiveHour(grok(30))).toBeNull();
		expect(extractFiveHour(grok(null))).toBeNull();
	});

	it("is eligible for the weekly window set only", () => {
		expect(SEVEN_DAY_ELIGIBLE_PROVIDERS.has("grok-subscription")).toBe(true);
		expect(FIVE_HOUR_ELIGIBLE_PROVIDERS.has("grok-subscription")).toBe(false);
		expect(DAILY_ELIGIBLE_PROVIDERS.has("grok-subscription")).toBe(false);
	});
});

describe("grok-subscription account-wide exhaustion", () => {
	it("binds weekly when the pool is spent with a future reset", () => {
		const reset = NOW + 2 * DAY;
		expect(
			accountWideExhaustionFor("grok-subscription", grok(100, reset), NOW),
		).toEqual({ exhausted: true, binding: "weekly", resetMs: reset });
	});

	it("is not exhausted while the pool has headroom", () => {
		expect(
			accountWideExhaustionFor("grok-subscription", grok(99.9), NOW).exhausted,
		).toBe(false);
	});

	it("never reads an unknown utilization as exhaustion", () => {
		expect(
			accountWideExhaustionFor("grok-subscription", grok(null), NOW).exhausted,
		).toBe(false);
	});

	it("treats a spent pool with a past reset as stale, not exhausted", () => {
		// A reset that has already arrived means the reading predates the roll, and
		// an account is never sidelined on ambiguous evidence.
		expect(
			accountWideExhaustionFor("grok-subscription", grok(100, NOW - HOUR), NOW)
				.exhausted,
		).toBe(false);
	});
});

describe("shape detection is unchanged by the grok-subscription member", () => {
	const detected = (usage: FullUsageData) => ({
		devin: isDevinShape(usage),
		alibaba: isAlibabaShape(usage),
		zai: isZaiShape(usage),
		grok: isGrokSubscriptionShape(usage),
		anthropic: isAnthropicStyleShape(usage),
	});

	it("keeps each payload matching exactly one detector", () => {
		expect(detected(grok(30))).toEqual({
			devin: false,
			alibaba: false,
			zai: false,
			grok: true,
			anthropic: false,
		});
		expect(detected(devin)).toEqual({
			devin: true,
			alibaba: false,
			zai: false,
			grok: false,
			anthropic: false,
		});
		expect(detected(alibaba)).toEqual({
			devin: false,
			alibaba: true,
			zai: false,
			grok: false,
			anthropic: false,
		});
		expect(detected(zai)).toEqual({
			devin: false,
			alibaba: false,
			zai: true,
			grok: false,
			anthropic: false,
		});
		expect(detected(anthropic)).toEqual({
			devin: false,
			alibaba: false,
			zai: false,
			grok: false,
			anthropic: true,
		});
	});

	it("keeps every other provider's extracted windows intact", () => {
		expect(extractFiveHour(devin)).toBeNull();
		expect(extractSevenDay(devin)).toEqual({ pct: 20, resetMs: NOW + DAY });
		expect(extractFiveHour(alibaba)).toEqual({ pct: 11, resetMs: NOW + HOUR });
		expect(extractSevenDay(alibaba)).toEqual({ pct: 22, resetMs: NOW + DAY });
		expect(extractFiveHour(zai)).toEqual({ pct: 44, resetMs: NOW + HOUR });
		expect(extractSevenDay(zai)).toEqual({ pct: 55, resetMs: NOW + DAY });
		expect(extractFiveHour(anthropic)).toEqual({
			pct: 66,
			resetMs: NOW + HOUR,
		});
		expect(extractSevenDay(anthropic)).toEqual({ pct: 77, resetMs: NOW + DAY });
	});

	it("keeps every other provider's exhaustion verdict intact", () => {
		// Only anthropic/codex and zai have a helper; the rest report no evidence,
		// which must stay distinct from evidence of headroom.
		expect(accountWideExhaustionFor("devin", devin, NOW).exhausted).toBe(false);
		expect(
			accountWideExhaustionFor("alibaba-coding-plan", alibaba, NOW),
		).toEqual({ exhausted: false, binding: null, resetMs: null });
		expect(accountWideExhaustionFor("zai", zai, NOW).exhausted).toBe(false);
		expect(
			accountWideExhaustionFor("anthropic", anthropic, NOW).exhausted,
		).toBe(false);
	});
});
