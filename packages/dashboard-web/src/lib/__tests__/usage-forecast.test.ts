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

	it("excludes accounts whose window has already reset", () => {
		const acct = mkAccount({ usageData: fiveHourUsage(50, NOW - HOUR) });
		expect(
			computeWindowForecast([acct], "five_hour", NOW, HOUR, FAR_HORIZON),
		).toEqual([]);
	});

	it("excludes a paused account at 0% (no value to plot)", () => {
		const acct = mkAccount({
			paused: true,
			usageData: fiveHourUsage(0, NOW + HOUR),
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

describe("computeWindowForecast — held (unavailable) accounts", () => {
	it("holds an already-exhausted (>=100%) account flat at 100% until reset", () => {
		const resetMs = NOW + HOUR;
		const acct = mkAccount({ id: "x", usageData: fiveHourUsage(100, resetMs) });

		const [series] = computeWindowForecast(
			[acct],
			"five_hour",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		expect(series.accountId).toBe("x");
		expect(series.isSafe).toBe(false); // already maxed
		expect(series.exhaustsAtMs).toBeNull();
		expect(series.bridgePct).toBe(100);
		expect(series.points.every((p) => p.pct === 100)).toBe(true);
		// Flat line ends at the window reset.
		expect(series.points[series.points.length - 1]?.ts).toBe(resetMs);
	});

	it("holds a paused account flat at its current utilization", () => {
		const resetMs = NOW + HOUR;
		const acct = mkAccount({
			id: "p",
			paused: true,
			usageData: fiveHourUsage(50, resetMs),
		});

		const [series] = computeWindowForecast(
			[acct],
			"five_hour",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		expect(series.accountId).toBe("p");
		expect(series.isSafe).toBe(true); // paused below 100 won't exhaust
		expect(series.exhaustsAtMs).toBeNull();
		expect(series.bridgePct).toBe(50);
		expect(series.points.every((p) => p.pct === 50)).toBe(true);
		expect(series.points[series.points.length - 1]?.ts).toBe(resetMs);
	});

	it("holds an account in an active rate-limit cooldown flat", () => {
		const resetMs = NOW + 4 * HOUR;
		const acct = mkAccount({
			id: "r",
			rateLimitedUntil: NOW + HOUR,
			usageData: fiveHourUsage(50, resetMs),
		});

		const [series] = computeWindowForecast(
			[acct],
			"five_hour",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		expect(series.accountId).toBe("r");
		expect(series.exhaustsAtMs).toBeNull();
		expect(series.points.every((p) => p.pct === 50)).toBe(true);
	});

	it("keeps a maxed/paused account in the projected pool average (no drop)", () => {
		// A burning peer at 40% plus a paused-at-100% account. The pool projection
		// must include the held 100% account, not silently drop it.
		const resetMs = NOW + 4 * HOUR;
		const peer = mkAccount({
			id: "peer",
			usageData: fiveHourUsage(40, resetMs),
		});
		const maxed = mkAccount({
			id: "maxed",
			paused: true,
			usageData: fiveHourUsage(100, resetMs),
		});

		const series = computeWindowForecast(
			[peer, maxed],
			"five_hour",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		const pool = series.find((s) => s.accountId === null);
		expect(pool).toBeDefined();
		// Mean of the burning peer (40) and the held maxed account (100) = 70.
		// Dropping the maxed account would wrongly report 40.
		expect(pool?.bridgePct).toBeCloseTo(70, 5);
	});
});

describe("computeWindowForecast — burn anchor + shared ETA", () => {
	const DAY = 24 * HOUR;

	function sevenDayUsage(pct: number, resetMs: number): FullUsageData {
		return {
			five_hour: { utilization: null, resets_at: null },
			seven_day: {
				utilization: pct,
				resets_at: new Date(resetMs).toISOString(),
			},
		} as unknown as FullUsageData;
	}

	it("re-anchors the weekly line at a served burn anchor", () => {
		// Gift 12h ago, 40% burned since; reset 1.5d out. Un-anchored the line is
		// safe (40% over 5.5d clears the reset); anchored it lands 100% at +18h.
		const resetMs = NOW + 1.5 * DAY;
		const base = mkAccount({
			id: "gifted",
			usageData: sevenDayUsage(40, resetMs),
			usageAsOfIso: new Date(NOW).toISOString(),
		});

		const [safe] = computeWindowForecast(
			[base],
			"seven_day",
			NOW,
			HOUR,
			FAR_HORIZON,
		);
		expect(safe.isSafe).toBe(true);

		const [anchored] = computeWindowForecast(
			[
				mkAccount({
					...base,
					burnAnchors: {
						sevenDay: {
							anchorMs: NOW - 12 * HOUR,
							anchorPct: 0,
							windowResetMs: resetMs,
						},
					},
				}),
			],
			"seven_day",
			NOW,
			HOUR,
			FAR_HORIZON,
		);
		expect(anchored.isSafe).toBe(false);
		expect(anchored.exhaustsAtMs).toBe(NOW + 18 * HOUR);
		expect(anchored.bridgePct).toBe(40);
		const last = anchored.points[anchored.points.length - 1];
		expect(last.pct).toBeCloseTo(100, 5);
		expect(last.ts).toBeCloseTo(NOW + 18 * HOUR, 5);
	});

	it("lands 100% at the estimator's observation-anchored ETA, not a now-derived one", () => {
		// The reading is 6h old. The full-confidence weekly estimate anchors its
		// ETA at the OBSERVATION; re-deriving the landing from `now` would push
		// it 6h later. elapsed = obs − windowStart = 4.75d, so
		// eta = obs + (20/80)·4.75d = obs + 28.5h = NOW + 22.5h.
		const obs = NOW - 6 * HOUR;
		const resetMs = NOW + 2 * DAY;
		const [series] = computeWindowForecast(
			[
				mkAccount({
					id: "aged",
					usageData: sevenDayUsage(80, resetMs),
					usageAsOfIso: new Date(obs).toISOString(),
				}),
			],
			"seven_day",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		expect(series.isSafe).toBe(false);
		expect(series.exhaustsAtMs).toBe(obs + 28.5 * HOUR);
		// Still bridges at the live reading at `now`.
		expect(series.bridgePct).toBe(80);
	});

	it("clamps a past-ETA aged reading to an immediate run-out", () => {
		// 99.5% observed 20h ago on a window whose anchored ETA already passed:
		// hold flat and report the run-out as now rather than inventing a ramp.
		const obs = NOW - 20 * HOUR;
		const resetMs = NOW + 1 * DAY;
		const [series] = computeWindowForecast(
			[
				mkAccount({
					id: "overdue",
					usageData: sevenDayUsage(99.5, resetMs),
					usageAsOfIso: new Date(obs).toISOString(),
				}),
			],
			"seven_day",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		expect(series.isSafe).toBe(false);
		expect(series.exhaustsAtMs).toBe(NOW);
	});
});
