/**
 * The routing-side reads of a grok-subscription reading: the representative
 * utilization the load balancer asks for, the capacity signal the reservation
 * gates rank on, and the window-reset detection a weekly rollover has to pass.
 *
 * Every one of them is a per-provider table with a null/default arm, so an
 * unlisted provider is silently read as "no utilization, no capacity, no
 * window" rather than failing — which is why each is asserted here rather than
 * inferred from the branch existing.
 */
import { describe, expect, it, mock } from "bun:test";
import type { GrokSubscriptionUsageData } from "@clankermux/types";
import {
	extractWindowResetTime,
	getAccountCapacitySignal,
	getRepresentativeUtilizationForProvider,
	usageCache,
} from "../usage-fetcher";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function grok(
	weeklyUtilization: number | null,
	weeklyResetAt: number = NOW + 3 * DAY,
): GrokSubscriptionUsageData {
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

describe("getRepresentativeUtilizationForProvider — grok-subscription", () => {
	it("reports the weekly pool utilization", () => {
		expect(
			getRepresentativeUtilizationForProvider(grok(72.5), "grok-subscription"),
		).toBe(72.5);
	});

	it("reports null — never 0 — when the reading is unknown", () => {
		expect(
			getRepresentativeUtilizationForProvider(grok(null), "grok-subscription"),
		).toBeNull();
	});
});

describe("extractWindowResetTime — grok-subscription", () => {
	it("returns the weekly refill", () => {
		expect(extractWindowResetTime(grok(40), "grok-subscription")).toBe(
			NOW + 3 * DAY,
		);
	});

	it("returns it even when the utilization is unknown", () => {
		// A rollover is a fact about the clock; it does not depend on the
		// endpoint having reported a percentage for the window.
		expect(extractWindowResetTime(grok(null), "grok-subscription")).toBe(
			NOW + 3 * DAY,
		);
	});
});

describe("grok-subscription weekly rollover detection", () => {
	it("fires the callback when the arrived weekly reset advances", () => {
		const accountId = "grok-weekly-roll";
		const callback = mock(() => {});
		usageCache.set(accountId, grok(97, NOW - 1_000));
		usageCache.notifyWindowReset(
			accountId,
			grok(0, NOW + 7 * DAY),
			"grok-subscription",
			callback,
			NOW,
		);
		expect(callback).toHaveBeenCalledTimes(1);
		usageCache.delete(accountId);
	});

	it("does not fire while the same window is still in the future", () => {
		const accountId = "grok-weekly-drift";
		const callback = mock(() => {});
		usageCache.set(accountId, grok(40, NOW + 2 * DAY));
		usageCache.notifyWindowReset(
			accountId,
			// Sub-second forward drift on the SAME window, which every provider
			// emits and none of them means as a roll.
			grok(41, NOW + 2 * DAY + 200),
			"grok-subscription",
			callback,
			NOW,
		);
		expect(callback).not.toHaveBeenCalled();
		usageCache.delete(accountId);
	});
});

describe("getAccountCapacitySignal — grok-subscription", () => {
	it("reports the weekly pool with no session axis", () => {
		const signal = getAccountCapacitySignal(
			grok(30, NOW + 2 * DAY),
			"grok-subscription",
			NOW,
		);
		expect(signal).toEqual({
			minHeadroom: 70,
			sessionHeadroom: 100,
			soonestResetMs: NOW + 2 * DAY,
			bindingUtilization: 30,
			weeklyResetMs: NOW + 2 * DAY,
			bindingWeeklyResetMs: NOW + 2 * DAY,
			weeklyHeadroom: 70,
			sessionResetMs: null,
			extraUsageUtilization: null,
		});
	});

	it("reports no signal for an unknown utilization", () => {
		// Not a signal at full headroom: nobody measured this account, and the
		// early-recovery listener reads headroom as evidence an account came back.
		expect(
			getAccountCapacitySignal(grok(null), "grok-subscription", NOW),
		).toBeNull();
	});

	it("reports no signal once the reading's own reset has arrived", () => {
		expect(
			getAccountCapacitySignal(grok(80, NOW - 1), "grok-subscription", NOW),
		).toBeNull();
	});
});
