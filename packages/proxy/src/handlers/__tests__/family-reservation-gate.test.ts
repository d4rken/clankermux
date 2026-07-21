import { describe, expect, it } from "bun:test";
import type {
	Account,
	AnthropicLimitEntry,
	AnthropicUsageData,
	CapacitySignal,
} from "@clankermux/types";
import {
	PROTECTED_FAMILY_DEMAND_LOOKBACK_MS,
	RESERVE_HEADROOM_PCT,
	resolveReservationDemotion,
	WEEKLY_HARVEST_YIELD_HORIZON_MS,
} from "../family-reservation-gate";

const NOW = 1_000_000_000_000;
const FUTURE_ISO = new Date(NOW + 60 * 60 * 1000).toISOString(); // +1h

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Backup1",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
		rate_limited_until: null,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function scopedEntry(displayName: string, percent = 100): AnthropicLimitEntry {
	return {
		kind: "weekly_scoped",
		group: "weekly",
		percent,
		resets_at: FUTURE_ISO,
		scope: { model: { id: "id", display_name: displayName } },
		is_active: true,
	};
}

function usage(limits: AnthropicLimitEntry[]): AnthropicUsageData {
	return {
		five_hour: { utilization: 0, resets_at: FUTURE_ISO },
		seven_day: { utilization: 83, resets_at: FUTURE_ISO },
		limits,
	};
}

// Capacity builder mirroring family-weekly-gate.test.ts, extended with the axes
// this gate reads (sessionHeadroom / weeklyHeadroom / bindingWeeklyResetMs). Full
// headroom by default so tests opt into a constrained axis explicitly. The 7d
// harvest-yield reads bindingWeeklyResetMs (the binding window's reset), NOT
// weeklyResetMs (the earliest across all weekly windows, used by FEFO ranking).
const capacity = (overrides: Partial<CapacitySignal> = {}): CapacitySignal => ({
	minHeadroom: 100,
	sessionHeadroom: 100,
	soonestResetMs: null,
	bindingUtilization: 0,
	weeklyResetMs: null,
	bindingWeeklyResetMs: null,
	weeklyHeadroom: 100,
	...overrides,
});

// A usage payload where the protected family (Fable) is NOT exhausted, so the
// precondition (account can still serve Fable) holds and the 5h/7d axes decide.
const fableAvailable = () => usage([scopedEntry("Opus")]);
// A usage payload where the protected family (Fable) IS exhausted on the account.
const fableExhausted = () => usage([scopedEntry("Fable")]);

describe("resolveReservationDemotion", () => {
	it("keeps the protected family (Fable) itself even at critically low session headroom", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-fable-5",
			fableAvailable(),
			capacity({ sessionHeadroom: 5 }),
			NOW - 1000,
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps when the model resolves to no family (fail open)", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"gpt-5.5",
			fableAvailable(),
			capacity({ sessionHeadroom: 5 }),
			NOW - 1000,
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps when modelForGate is null (fail open)", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			null,
			fableAvailable(),
			capacity({ sessionHeadroom: 5 }),
			NOW - 1000,
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps a non-Anthropic (Codex) account — no per-family quota to reserve", () => {
		const result = resolveReservationDemotion(
			makeAccount({ provider: "codex" }),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({ sessionHeadroom: 5 }),
			NOW - 1000,
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps when capacity is null (stale/unknown, fail open)", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			null,
			NOW - 1000,
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps when Fable itself is exhausted on the account (nothing left to protect)", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableExhausted(),
			capacity({ sessionHeadroom: 5 }),
			NOW - 1000,
			NOW,
		);
		expect(result).toBe(false);
	});

	it("demotes an Opus request when 5h session headroom is below the reserve threshold", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({ sessionHeadroom: 20 }),
			null, // 5h axis is unconditional — no recent demand required
			NOW,
		);
		expect(result).toBe(true);
	});

	it("demotes an Opus request on the 7d axis with recent demand and a far reset", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({
				sessionHeadroom: 80,
				weeklyHeadroom: 20,
				weeklyResetMs: NOW + 5 * 3_600_000,
				bindingWeeklyResetMs: NOW + 5 * 3_600_000,
			}),
			NOW - 1000, // recent Fable demand
			NOW,
		);
		expect(result).toBe(true);
	});

	it("keeps on the 7d axis when there is no recent protected-family demand", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({
				sessionHeadroom: 80,
				weeklyHeadroom: 20,
				weeklyResetMs: NOW + 5 * 3_600_000,
				bindingWeeklyResetMs: NOW + 5 * 3_600_000,
			}),
			null, // no recorded demand
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps on the 7d axis when the last protected-family demand is older than the lookback", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({
				sessionHeadroom: 80,
				weeklyHeadroom: 20,
				weeklyResetMs: NOW + 5 * 3_600_000,
				bindingWeeklyResetMs: NOW + 5 * 3_600_000,
			}),
			NOW - 2 * 3_600_000, // 2h ago > 60min lookback
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps on the 7d axis when the weekly reset is within the harvest-yield horizon", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({
				sessionHeadroom: 80,
				weeklyHeadroom: 20,
				weeklyResetMs: NOW + 30 * 60_000,
				bindingWeeklyResetMs: NOW + 30 * 60_000, // 30min < 2h horizon
			}),
			NOW - 1000, // recent demand
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps on the 7d axis when the binding-weekly reset is unknown (null → fail open)", () => {
		// recentDemand + low weekly headroom, but the binding window's reset is
		// unknown: we only hold weekly quota when we KNOW the reset is beyond the
		// horizon, so an unknown reset fails open (near-reset → keep). A
		// sooner-resetting UNRELATED window in weeklyResetMs must not force a yield.
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({
				sessionHeadroom: 80,
				weeklyHeadroom: 20,
				weeklyResetMs: NOW + 5 * 3_600_000, // an unrelated window's reset
				bindingWeeklyResetMs: null, // binding window's reset unknown
			}),
			NOW - 1000, // recent Fable demand
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps on the 7d axis when the binding-weekly reset is NaN (non-finite → fail open)", () => {
		// A non-finite (NaN) binding reset must fail open exactly like null: we only
		// hold weekly quota when we KNOW the reset lies beyond the horizon.
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({
				sessionHeadroom: 80,
				weeklyHeadroom: 20,
				weeklyResetMs: NOW + 5 * 3_600_000,
				bindingWeeklyResetMs: Number.NaN, // non-finite binding reset
			}),
			NOW - 1000, // recent Fable demand
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps at the exact session-headroom boundary (strictly-less-than)", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({ sessionHeadroom: RESERVE_HEADROOM_PCT }),
			NOW - 1000,
			NOW,
		);
		expect(result).toBe(false);
	});

	it("keeps at the exact weekly-headroom boundary (strictly-less-than)", () => {
		const result = resolveReservationDemotion(
			makeAccount(),
			"claude-opus-4-8",
			fableAvailable(),
			capacity({
				sessionHeadroom: 80,
				weeklyHeadroom: RESERVE_HEADROOM_PCT,
				weeklyResetMs: NOW + 5 * 3_600_000,
				bindingWeeklyResetMs: NOW + 5 * 3_600_000,
			}),
			NOW - 1000, // recent demand, far reset
			NOW,
		);
		expect(result).toBe(false);
	});

	it("exposes the documented constant values", () => {
		expect(RESERVE_HEADROOM_PCT).toBe(25);
		expect(PROTECTED_FAMILY_DEMAND_LOOKBACK_MS).toBe(3_600_000);
		expect(WEEKLY_HARVEST_YIELD_HORIZON_MS).toBe(7_200_000);
	});
});
