import { describe, expect, it } from "bun:test";
import type {
	AccountResponse,
	AccountUsagePrediction,
	UsagePrediction,
} from "@clankermux/types";
import { computeWindowForecast, type ForecastSeries } from "./usage-forecast";

// Fixed clock so window starts/resets are exact.
const NOW = Date.UTC(2024, 0, 10, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** Minimal Anthropic-style account with a five-hour + seven-day window. */
function makeAccount(
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id: "a1",
		name: "acct",
		provider: "anthropic",
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
		prediction: null,
		...overrides,
	};
}

/**
 * Anthropic-style usageData for a five-hour window with `fiveHourPct` observed
 * exactly one hour into the window (so the window resets four hours from now,
 * lifetime-average burn rate = fiveHourPct % / hour). The seven-day window is
 * inert (0%) so only the five-hour window projects.
 */
function anthropicUsage(fiveHourPct: number, fiveHourResetMs: number) {
	return {
		five_hour: {
			utilization: fiveHourPct,
			resets_at: new Date(fiveHourResetMs).toISOString(),
		},
		seven_day: { utilization: 0, resets_at: null },
	} as AccountResponse["usageData"];
}

function fiveHourPrediction(
	pred: Partial<UsagePrediction>,
): AccountUsagePrediction {
	return {
		fiveHour: {
			state: "rising",
			slopePerHour: 5,
			etaExhaustMs: null,
			predictedAtReset: null,
			resetsAtMs: null,
			willExhaustBeforeReset: false,
			lowConfidence: false,
			...pred,
		},
	};
}

function accountSeries(result: ForecastSeries[], id: string): ForecastSeries {
	const s = result.find((f) => f.accountId === id);
	if (!s) throw new Error(`no series for ${id}`);
	return s;
}

function poolSeries(result: ForecastSeries[]): ForecastSeries {
	const s = result.find((f) => f.accountId === null);
	if (!s) throw new Error("no pool series");
	return s;
}

/** Projected pct at an absolute future ts on a series' forecast points. */
function pctAt(series: ForecastSeries, ts: number): number {
	const p = series.points.find((pt) => pt.ts === ts);
	if (!p) throw new Error(`no forecast point at ts=${ts}`);
	return p.pct;
}

// Window resets four hours from now => observed one hour into a 5h window,
// so the lifetime-average burn rate is `pct` %/hour.
const RESET_5H = NOW + 4 * HOUR;
const CADENCE = HOUR;
const HORIZON = NOW + 4 * HOUR;

describe("computeWindowForecast — regression slope source", () => {
	it("uses the server regression slope for a usable rising prediction", () => {
		// Burn rate would be 20%/hr; the regression predicts 5%/hr. The two must
		// diverge measurably so we can prove which slope was used.
		const account = makeAccount({
			usageData: anthropicUsage(20, RESET_5H),
			prediction: fiveHourPrediction({
				slopePerHour: 5,
				resetsAtMs: RESET_5H,
			}),
		});

		const result = computeWindowForecast(
			[account],
			"five_hour",
			NOW,
			CADENCE,
			HORIZON,
		);
		const series = accountSeries(result, "a1");

		// Anchored at live pct at now.
		expect(series.bridgePct).toBeCloseTo(20, 6);
		// One hour out: regression => 20 + 5 = 25 (NOT burn-rate's 20 + 20 = 40).
		expect(pctAt(series, NOW + HOUR)).toBeCloseTo(25, 6);
		// Two hours out: 20 + 10 = 30.
		expect(pctAt(series, NOW + 2 * HOUR)).toBeCloseTo(30, 6);
	});

	it("falls back to burn-rate math when there is no prediction", () => {
		const account = makeAccount({
			usageData: anthropicUsage(20, RESET_5H),
			prediction: null,
		});

		const series = accountSeries(
			computeWindowForecast([account], "five_hour", NOW, CADENCE, HORIZON),
			"a1",
		);

		expect(series.bridgePct).toBeCloseTo(20, 6);
		// Lifetime-average burn rate = 20%/hr: one hour out => 40, two hours => 60.
		expect(pctAt(series, NOW + HOUR)).toBeCloseTo(40, 6);
		expect(pctAt(series, NOW + 2 * HOUR)).toBeCloseTo(60, 6);
	});

	it("falls back to burn-rate when the prediction is low-confidence", () => {
		const account = makeAccount({
			usageData: anthropicUsage(20, RESET_5H),
			prediction: fiveHourPrediction({
				slopePerHour: 5,
				resetsAtMs: RESET_5H,
				lowConfidence: true,
			}),
		});

		const series = accountSeries(
			computeWindowForecast([account], "five_hour", NOW, CADENCE, HORIZON),
			"a1",
		);
		expect(pctAt(series, NOW + HOUR)).toBeCloseTo(40, 6);
	});

	it("falls back to burn-rate when the prediction is insufficient_data", () => {
		const account = makeAccount({
			usageData: anthropicUsage(20, RESET_5H),
			prediction: fiveHourPrediction({
				state: "insufficient_data",
				slopePerHour: 5,
				resetsAtMs: RESET_5H,
			}),
		});

		const series = accountSeries(
			computeWindowForecast([account], "five_hour", NOW, CADENCE, HORIZON),
			"a1",
		);
		expect(pctAt(series, NOW + HOUR)).toBeCloseTo(40, 6);
	});

	it("falls back to burn-rate when the prediction reset does not match the live reset", () => {
		const account = makeAccount({
			usageData: anthropicUsage(20, RESET_5H),
			prediction: fiveHourPrediction({
				slopePerHour: 5,
				// Off by more than RESET_JITTER_TOLERANCE_MS (60s) => stale window.
				resetsAtMs: RESET_5H + 5 * 60 * 1000,
			}),
		});

		const series = accountSeries(
			computeWindowForecast([account], "five_hour", NOW, CADENCE, HORIZON),
			"a1",
		);
		expect(pctAt(series, NOW + HOUR)).toBeCloseTo(40, 6);
	});

	it("holds flat (not burn-rate) when a usable prediction is stable", () => {
		const account = makeAccount({
			usageData: anthropicUsage(20, RESET_5H),
			prediction: fiveHourPrediction({
				state: "stable",
				slopePerHour: 0,
				resetsAtMs: RESET_5H,
			}),
		});

		const series = accountSeries(
			computeWindowForecast([account], "five_hour", NOW, CADENCE, HORIZON),
			"a1",
		);
		// A usable stable trend holds flat at the live utilization — it must NOT
		// revert to the lifetime-average burn-rate (which would project 40 here).
		expect(series.bridgePct).toBeCloseTo(20, 6);
		expect(pctAt(series, NOW + HOUR)).toBeCloseTo(20, 6);
		expect(pctAt(series, NOW + 2 * HOUR)).toBeCloseTo(20, 6);
	});

	it("holds flat when a usable prediction has a negative slope", () => {
		const account = makeAccount({
			usageData: anthropicUsage(20, RESET_5H),
			prediction: fiveHourPrediction({
				state: "stable",
				slopePerHour: -3,
				resetsAtMs: RESET_5H,
			}),
		});

		const series = accountSeries(
			computeWindowForecast([account], "five_hour", NOW, CADENCE, HORIZON),
			"a1",
		);
		expect(pctAt(series, NOW + HOUR)).toBeCloseTo(20, 6);
	});

	it("resolves the seven-day prediction for the seven_day window", () => {
		// Observed one day into a 7-day window (resets 6 days out) at 20% => burn
		// rate 20%/day. The seven-day regression predicts 5%/hour.
		const DAY = 24 * HOUR;
		const reset7d = NOW + 6 * DAY;
		const account = makeAccount({
			usageData: {
				five_hour: { utilization: 0, resets_at: null },
				seven_day: {
					utilization: 20,
					resets_at: new Date(reset7d).toISOString(),
				},
			} as AccountResponse["usageData"],
			prediction: {
				sevenDay: {
					state: "rising",
					slopePerHour: 5,
					etaExhaustMs: null,
					predictedAtReset: null,
					resetsAtMs: reset7d,
					willExhaustBeforeReset: false,
					lowConfidence: false,
				},
			},
		});

		const series = accountSeries(
			computeWindowForecast([account], "seven_day", NOW, HOUR, NOW + 12 * HOUR),
			"a1",
		);

		expect(series.bridgePct).toBeCloseTo(20, 6);
		// One hour out: regression 5%/hr => 25. Burn rate (20%/day ≈ 0.83%/hr)
		// would give ~20.83, so this proves the seven-day slope was used.
		expect(pctAt(series, NOW + HOUR)).toBeCloseTo(25, 6);
	});
});

describe("computeWindowForecast — flat-hold overrides prediction", () => {
	it("holds a paused account flat even with a positive prediction slope", () => {
		const account = makeAccount({
			id: "paused",
			paused: true,
			usageData: anthropicUsage(40, RESET_5H),
			prediction: fiveHourPrediction({
				slopePerHour: 5,
				resetsAtMs: RESET_5H,
			}),
		});

		const series = accountSeries(
			computeWindowForecast([account], "five_hour", NOW, CADENCE, HORIZON),
			"paused",
		);

		expect(series.bridgePct).toBeCloseTo(40, 6);
		// Every projected point stays flat at 40 — the regression never revives it.
		for (const point of series.points) {
			expect(point.pct).toBeCloseTo(40, 6);
		}
	});

	it("holds a rate-limited (cooldown) account flat despite a prediction", () => {
		const account = makeAccount({
			id: "cooldown",
			rateLimitedUntil: NOW + HOUR,
			usageData: anthropicUsage(50, RESET_5H),
			prediction: fiveHourPrediction({
				slopePerHour: 8,
				resetsAtMs: RESET_5H,
			}),
		});

		const series = accountSeries(
			computeWindowForecast([account], "five_hour", NOW, CADENCE, HORIZON),
			"cooldown",
		);
		for (const point of series.points) {
			expect(point.pct).toBeCloseTo(50, 6);
		}
	});
});

describe("computeWindowForecast — pool aggregation across mixed accounts", () => {
	it("keeps held accounts in the pool denominator", () => {
		const burning = makeAccount({
			id: "burn",
			usageData: anthropicUsage(40, RESET_5H),
		});
		const paused = makeAccount({
			id: "paused",
			paused: true,
			usageData: anthropicUsage(80, RESET_5H),
			// Positive prediction must not pull the paused account into the burn.
			prediction: fiveHourPrediction({
				slopePerHour: 5,
				resetsAtMs: RESET_5H,
			}),
		});

		const result = computeWindowForecast(
			[burning, paused],
			"five_hour",
			NOW,
			CADENCE,
			HORIZON,
		);

		// Two account series + one pool series.
		expect(result.filter((f) => f.accountId !== null)).toHaveLength(2);
		const pool = poolSeries(result);
		// Mean of both live utilizations: (40 + 80) / 2 = 60. If the paused
		// account were dropped, this would read 40.
		expect(pool.bridgePct).toBeCloseTo(60, 6);
		// One hour out: burning climbs 40%/hr => 80; paused stays flat at 80;
		// pool mean = (80 + 80) / 2 = 80.
		expect(pctAt(pool, NOW + HOUR)).toBeCloseTo(80, 6);
	});
});
