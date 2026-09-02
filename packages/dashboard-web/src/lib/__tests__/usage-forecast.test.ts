import { describe, expect, it } from "bun:test";
import type { AccountResponse, FullUsageData } from "@clankermux/types";
import {
	computeWindowForecast,
	FORECAST_POST_RESET_TAIL_MS,
	type ForecastSeries,
} from "../usage-forecast";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FAR_HORIZON = NOW + 30 * DAY; // effectively uncapped
const FIVE_HOUR_TAIL = FORECAST_POST_RESET_TAIL_MS.five_hour;
const SEVEN_DAY_TAIL = FORECAST_POST_RESET_TAIL_MS.seven_day;

/** Projected pct at an exact ts on a series; throws when nothing is plotted. */
function pctAt(series: ForecastSeries, ts: number): number {
	const point = series.points.find((p) => p.ts === ts);
	if (!point) throw new Error(`no forecast point at ts=${ts}`);
	return point.pct;
}

function lastPoint(series: ForecastSeries): { ts: number; pct: number } {
	const point = series.points[series.points.length - 1];
	if (!point) throw new Error("series has no points");
	return point;
}

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

/** Anthropic-shaped usage data with a 7-day window. */
function sevenDayUsage(pct: number, resetMs: number): FullUsageData {
	return {
		five_hour: { utilization: null, resets_at: null },
		seven_day: {
			utilization: pct,
			resets_at: new Date(resetMs).toISOString(),
		},
	} as unknown as FullUsageData;
}

/**
 * A held (paused / cooling down / maxed) line: flat at `pct` up to and
 * including the reset, then flat at 0 for the post-reset tail.
 */
function expectHeldShape(
	series: ForecastSeries,
	resetMs: number,
	pct: number,
): void {
	for (const point of series.points) {
		expect(point.pct).toBe(point.ts <= resetMs ? pct : 0);
	}
	expect(pctAt(series, resetMs)).toBe(pct);
	expect(pctAt(series, resetMs + 1)).toBe(0);
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
	it("marks an over-pacing account at-risk and carries its line past the reset", () => {
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
		// Reaches 100% at the projected exhaustion and now HOLDS there instead of
		// stopping, all the way to the reset.
		const eta = series.exhaustsAtMs as number;
		expect(pctAt(series, resetMs)).toBeCloseTo(100, 5);
		// The window rolls: a one-slot step down to 0%...
		expect(pctAt(series, resetMs + 1)).toBe(0);
		// ...then the same burn rate restarts from 0 for the post-reset tail.
		const slopePerMs = 5 / (eta - NOW);
		const last = lastPoint(series);
		expect(last.ts).toBe(resetMs + FIVE_HOUR_TAIL);
		expect(last.pct).toBeCloseTo(slopePerMs * FIVE_HOUR_TAIL, 5);
	});

	it("marks an under-pacing account safe and restarts it after the reset", () => {
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
		// The projected landing value at the reset, then the drop.
		expect(pctAt(series, resetMs)).toBeCloseTo(50, 5);
		expect(pctAt(series, resetMs + 1)).toBe(0);
		// Two hours of the same 10%/h burn into the fresh window.
		const last = lastPoint(series);
		expect(last.ts).toBe(resetMs + FIVE_HOUR_TAIL);
		expect(last.pct).toBeCloseTo(20, 5);
	});

	it("caps the forecast at the horizon when the reset is beyond it", () => {
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

		const last = lastPoint(series);
		expect(last.ts).toBe(horizon);
		expect(last.pct).toBeLessThan(100);
	});

	it("caps the post-reset tail at the selected range span", () => {
		// Reset inside the horizon, but the range spans less than the 2h tail:
		// the drop is still drawn, the tail only runs to the range span.
		const resetMs = NOW + 1 * HOUR;
		const horizon = NOW + 1.5 * HOUR;
		const acct = mkAccount({ id: "c", usageData: fiveHourUsage(40, resetMs) });

		const [series] = computeWindowForecast(
			[acct],
			"five_hour",
			NOW,
			HOUR / 4,
			horizon,
		);

		expect(pctAt(series, resetMs + 1)).toBe(0);
		expect(lastPoint(series).ts).toBe(resetMs + (horizon - NOW));
	});

	it("draws the full tail once the horizon clears reset + tail", () => {
		const resetMs = NOW + 1 * HOUR;
		const horizon = NOW + 4 * HOUR; // >= resetMs + 2h tail
		const acct = mkAccount({ id: "c", usageData: fiveHourUsage(40, resetMs) });

		const [series] = computeWindowForecast(
			[acct],
			"five_hour",
			NOW,
			HOUR / 4,
			horizon,
		);

		expect(lastPoint(series).ts).toBe(resetMs + FIVE_HOUR_TAIL);
	});

	it("draws the weekly tail past a reset late in the 7-day range", () => {
		// The reset sits 6.5 days out with a 7-day horizon: the tail runs past
		// the horizon rather than clipping the roll-over off the right edge.
		const resetMs = NOW + 6.5 * DAY;
		const horizon = NOW + 7 * DAY;
		const acct = mkAccount({
			id: "w",
			usageData: sevenDayUsage(30, resetMs),
		});

		const [series] = computeWindowForecast(
			[acct],
			"seven_day",
			NOW,
			HOUR,
			horizon,
		);

		expect(pctAt(series, resetMs + 1)).toBe(0);
		expect(lastPoint(series).ts).toBe(resetMs + SEVEN_DAY_TAIL);
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
		// Flat at 100% up to and including the reset, then the fresh window.
		expectHeldShape(series, resetMs, 100);
		expect(lastPoint(series).ts).toBe(resetMs + FIVE_HOUR_TAIL);
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
		expectHeldShape(series, resetMs, 50);
		expect(lastPoint(series).ts).toBe(resetMs + FIVE_HOUR_TAIL);
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
		expectHeldShape(series, resetMs, 50);
		expect(lastPoint(series).ts).toBe(resetMs + FIVE_HOUR_TAIL);
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
		// 100% at the anchored ETA, held there to the reset, then the roll-over
		// and the 2-DAY weekly tail.
		expect(pctAt(anchored, NOW + 18 * HOUR)).toBeCloseTo(100, 5);
		expect(pctAt(anchored, resetMs)).toBeCloseTo(100, 5);
		expect(pctAt(anchored, resetMs + 1)).toBe(0);
		expect(lastPoint(anchored).ts).toBe(resetMs + SEVEN_DAY_TAIL);
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

describe("computeWindowForecast — pool line across staggered resets", () => {
	// Two members whose resets are further apart than the tail: the pool line
	// ends where the FIRST member's own line ends, so every pool point is a mean
	// over members that are all still drawn.
	const earlyReset = NOW + 1 * HOUR;
	const lateReset = NOW + 4 * HOUR;

	function poolOf(): ForecastSeries {
		const early = mkAccount({
			id: "early",
			usageData: fiveHourUsage(40, earlyReset),
		});
		const late = mkAccount({
			id: "late",
			usageData: fiveHourUsage(20, lateReset),
		});
		const series = computeWindowForecast(
			[early, late],
			"five_hour",
			NOW,
			HOUR,
			FAR_HORIZON,
		);
		const pool = series.find((s) => s.accountId === null);
		if (!pool) throw new Error("no pool series");
		return pool;
	}

	it("ends the pool line at the earliest member's end", () => {
		expect(lastPoint(poolOf()).ts).toBe(earlyReset + FIVE_HOUR_TAIL);
	});

	it("steps the pool down at a member reset inside the pool line", () => {
		const pool = poolOf();
		// At the reset the early member is still at its landing value (50%), the
		// late member is at 20 + 20%/h over 1h = 40, so the mean is 45.
		expect(pctAt(pool, earlyReset)).toBeCloseTo(45, 5);
		// One slot later the early member has rolled to 0, so the mean is ~20.
		expect(pctAt(pool, earlyReset + 1)).toBeCloseTo(20, 3);
	});

	it("omits a member reset that falls beyond the pool line", () => {
		const pool = poolOf();
		expect(pool.points.some((p) => p.ts === lateReset)).toBe(false);
		expect(pool.points.some((p) => p.ts === lateReset + 1)).toBe(false);
	});
});

describe("computeWindowForecast — point ordering", () => {
	it("emits strictly ascending, duplicate-free timestamps in every series", () => {
		// A cadence tick landing exactly on a reset is the collision case: the
		// reset pair owns that instant, and must not double it up.
		const resetMs = NOW + 2 * HOUR;
		const burning = mkAccount({
			id: "burning",
			usageData: fiveHourUsage(60, resetMs),
		});
		const held = mkAccount({
			id: "held",
			paused: true,
			usageData: fiveHourUsage(100, NOW + 3 * HOUR),
		});

		const series = computeWindowForecast(
			[burning, held],
			"five_hour",
			NOW,
			HOUR,
			FAR_HORIZON,
		);

		expect(series).toHaveLength(3);
		for (const s of series) {
			const timestamps = s.points.map((p) => p.ts);
			expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
			expect(new Set(timestamps).size).toBe(timestamps.length);
		}
	});
});
