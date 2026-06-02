import { describe, expect, it } from "bun:test";
import type { AccountResponse, FullUsageData } from "@clankermux/types";
import { computeWindowForecast } from "../usage-forecast";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const FAR_HORIZON = NOW + 30 * 24 * HOUR; // effectively uncapped

function mkAccount(partial: Partial<AccountResponse>): AccountResponse {
	return {
		id: partial.id ?? "id",
		name: partial.name ?? "acc",
		provider: partial.provider ?? "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date(NOW).toISOString(),
		paused: false,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		autoPauseOnOverageEnabled: false,
		peakHoursPauseEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		modelFallbacks: null,
		billingType: null,
		sessionStats: null,
		...partial,
	};
}

/** Anthropic-shaped usage data with a 5-hour window. */
function fiveHourUsage(
	pct: number | null,
	resetMs: number | null,
): FullUsageData {
	return {
		five_hour: {
			utilization: pct,
			resets_at: resetMs == null ? null : new Date(resetMs).toISOString(),
		},
		seven_day: { utilization: null, resets_at: null },
	} as unknown as FullUsageData;
}

describe("computeWindowForecast — guards", () => {
	it("returns [] when cadence is non-positive", () => {
		const acct = mkAccount({
			usageData: fiveHourUsage(50, NOW + HOUR),
		});
		expect(
			computeWindowForecast([acct], "five_hour", NOW, 0, FAR_HORIZON),
		).toEqual([]);
	});

	it("returns [] when the horizon is not in the future", () => {
		const acct = mkAccount({ usageData: fiveHourUsage(50, NOW + HOUR) });
		expect(computeWindowForecast([acct], "five_hour", NOW, HOUR, NOW)).toEqual(
			[],
		);
	});

	it("excludes 0% accounts (no burn signal)", () => {
		const acct = mkAccount({ usageData: fiveHourUsage(0, NOW + HOUR) });
		expect(
			computeWindowForecast([acct], "five_hour", NOW, HOUR, FAR_HORIZON),
		).toEqual([]);
	});

	it("excludes already-exhausted (>=100%) accounts", () => {
		const acct = mkAccount({ usageData: fiveHourUsage(100, NOW + HOUR) });
		expect(
			computeWindowForecast([acct], "five_hour", NOW, HOUR, FAR_HORIZON),
		).toEqual([]);
	});

	it("excludes accounts whose window has already reset", () => {
		const acct = mkAccount({ usageData: fiveHourUsage(50, NOW - HOUR) });
		expect(
			computeWindowForecast([acct], "five_hour", NOW, HOUR, FAR_HORIZON),
		).toEqual([]);
	});

	it("excludes paused accounts", () => {
		const acct = mkAccount({
			paused: true,
			usageData: fiveHourUsage(50, NOW + HOUR),
		});
		expect(
			computeWindowForecast([acct], "five_hour", NOW, HOUR, FAR_HORIZON),
		).toEqual([]);
	});

	it("excludes accounts in an active rate-limit cooldown", () => {
		const acct = mkAccount({
			rateLimitedUntil: NOW + HOUR,
			usageData: fiveHourUsage(50, NOW + HOUR),
		});
		expect(
			computeWindowForecast([acct], "five_hour", NOW, HOUR, FAR_HORIZON),
		).toEqual([]);
	});
});

describe("computeWindowForecast — projection", () => {
	it("marks an over-pacing account at-risk and ends its line at 100%", () => {
		// 95% used 4.5h into a 5h window (resets in 0.5h) → exhausts before reset.
		const resetMs = NOW + 0.5 * HOUR;
		const acct = mkAccount({
			id: "a",
			usageData: fiveHourUsage(95, resetMs),
		});

		const [series] = computeWindowForecast(
			[acct],
			"five_hour",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		expect(series.accountId).toBe("a");
		expect(series.isSafe).toBe(false);
		expect(series.exhaustsAtMs).not.toBeNull();
		expect(series.exhaustsAtMs as number).toBeGreaterThan(NOW);
		expect(series.exhaustsAtMs as number).toBeLessThan(resetMs);
		expect(series.bridgePct).toBe(95);
		// Line stops at exactly 100% at the exhaustion point.
		const last = series.points[series.points.length - 1];
		expect(last.pct).toBeCloseTo(100, 5);
		expect(last.ts).toBeCloseTo(series.exhaustsAtMs as number, 5);
	});

	it("marks an under-pacing account safe and ends at the projected reset value", () => {
		// 10% used 1h into a 5h window (resets in 4h) → projects to 50% at reset.
		const resetMs = NOW + 4 * HOUR;
		const acct = mkAccount({ id: "b", usageData: fiveHourUsage(10, resetMs) });

		const [series] = computeWindowForecast(
			[acct],
			"five_hour",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		expect(series.isSafe).toBe(true);
		expect(series.exhaustsAtMs).toBeNull();
		const last = series.points[series.points.length - 1];
		expect(last.ts).toBe(resetMs);
		expect(last.pct).toBeCloseTo(50, 5);
	});

	it("caps the forecast at the horizon for short ranges", () => {
		const resetMs = NOW + 4 * HOUR;
		const horizon = NOW + 1 * HOUR; // tighter than the reset
		const acct = mkAccount({ id: "c", usageData: fiveHourUsage(10, resetMs) });

		const [series] = computeWindowForecast(
			[acct],
			"five_hour",
			NOW,
			HOUR,
			horizon,
		);

		const last = series.points[series.points.length - 1];
		expect(last.ts).toBe(horizon);
		expect(last.pct).toBeLessThan(100);
	});

	it("emits a pool aggregate averaging the contributing accounts", () => {
		const resetMs = NOW + 4 * HOUR;
		const a = mkAccount({ id: "a", usageData: fiveHourUsage(20, resetMs) });
		const b = mkAccount({ id: "b", usageData: fiveHourUsage(40, resetMs) });

		const series = computeWindowForecast(
			[a, b],
			"five_hour",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		expect(series).toHaveLength(3); // two accounts + pool
		const pool = series.find((s) => s.accountId === null);
		expect(pool).toBeDefined();
		expect(pool?.bridgePct).toBeCloseTo(30, 5); // mean of 20 and 40
	});

	it("returns [] when no account is projectable", () => {
		const acct = mkAccount({ usageData: fiveHourUsage(0, NOW + HOUR) });
		expect(
			computeWindowForecast([acct], "five_hour", NOW, HOUR, FAR_HORIZON),
		).toEqual([]);
	});
});
