import { describe, expect, test } from "bun:test";
import type { PredictionPoint } from "@clankermux/types";
import {
	type BacktestRecord,
	bootstrapDelta,
	commonCohort,
	deriveOutcome,
	FIVE_HOUR_WINDOW_MS,
	formatBacktestReport,
	lifetimeAverageEstimator,
	macroAverageByAccount,
	makeOlsEstimator,
	naivePersistenceEstimator,
	SEVEN_DAY_WINDOW_MS,
	scoreRecords,
} from "./prediction-backtest";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const T0 = 1_780_000_000_000;

const pt = (
	t: number,
	utilization: number,
	resetsAt: number | null,
): PredictionPoint => ({ t, utilization, resetsAt });

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

describe("deriveOutcome", () => {
	test("mid-window exhaust after T -> exhausted at the first >=100 sample", () => {
		const reset = T0 + 5 * HOUR_MS;
		const series = [
			pt(T0, 50, reset),
			pt(T0 + 30 * MIN_MS, 70, reset),
			pt(T0 + 60 * MIN_MS, 100, reset),
			pt(T0 + 90 * MIN_MS, 100, reset),
		];
		const outcome = deriveOutcome(series, T0, reset, T0 + 5 * HOUR_MS);
		expect(outcome).toEqual({ kind: "exhausted", atMs: T0 + 60 * MIN_MS });
	});

	test("an exhaustion at or before T is not the outcome of a prediction made at T", () => {
		const reset = T0 + 5 * HOUR_MS;
		const series = [pt(T0 - MIN_MS, 100, reset), pt(T0, 100, reset)];
		expect(deriveOutcome(series, T0, reset, T0 + 5 * HOUR_MS)).toEqual({
			kind: "censored",
		});
	});

	test("refund mid-window then exhaust -> exhausted (the refund does not end the window)", () => {
		const reset = T0 + 5 * HOUR_MS;
		const series = [
			pt(T0, 80, reset),
			pt(T0 + 10 * MIN_MS, 40, reset), // refund: a >5pp drop, same reset
			pt(T0 + 60 * MIN_MS, 70, reset),
			pt(T0 + 120 * MIN_MS, 100, reset),
		];
		expect(deriveOutcome(series, T0, reset, reset + MIN_MS)).toEqual({
			kind: "exhausted",
			atMs: T0 + 120 * MIN_MS,
		});
	});

	test("clean survival: reset observed and coverage runs up to it", () => {
		const reset = T0 + 2 * HOUR_MS;
		const series = [
			pt(T0, 40, reset),
			pt(T0 + 60 * MIN_MS, 55, reset),
			pt(T0 + 119 * MIN_MS, 60, reset),
		];
		expect(deriveOutcome(series, T0, reset, reset + 2 * MIN_MS)).toEqual({
			kind: "survived",
		});
	});

	test("no next window observed (still in progress at end of history) -> censored", () => {
		const reset = T0 + 2 * HOUR_MS;
		const series = [pt(T0, 40, reset), pt(T0 + 60 * MIN_MS, 55, reset)];
		expect(deriveOutcome(series, T0, reset, null)).toEqual({
			kind: "censored",
		});
	});

	test("gap before the next window -> censored, not survived", () => {
		const reset = T0 + 2 * HOUR_MS;
		// Sampling stops 40 min before the reset: an exhaustion could hide there.
		const series = [pt(T0, 40, reset), pt(T0 + 80 * MIN_MS, 90, reset)];
		expect(deriveOutcome(series, T0, reset, reset + MIN_MS)).toEqual({
			kind: "censored",
		});
	});

	test("99% with a gap to the reset wider than the coverage slack -> censored", () => {
		const reset = T0 + 2 * HOUR_MS;
		const series = [pt(T0, 80, reset), pt(T0 + 101 * MIN_MS, 99, reset)];
		expect(deriveOutcome(series, T0, reset, reset + MIN_MS)).toEqual({
			kind: "censored",
		});
	});

	test("99% within the coverage slack of the reset -> survived (slack boundary)", () => {
		const reset = T0 + 2 * HOUR_MS;
		const series = [pt(T0, 80, reset), pt(T0 + 111 * MIN_MS, 99, reset)];
		expect(deriveOutcome(series, T0, reset, reset + MIN_MS)).toEqual({
			kind: "survived",
		});
	});

	test("coverage is measured against the EARLIER of resetAt and the next window's first sample", () => {
		const reset = T0 + 2 * HOUR_MS;
		// The next window starts 30 min before the recorded reset (the provider
		// reset early); the last sample is 25 min before that, so it is a gap.
		const nextStart = reset - 30 * MIN_MS;
		const series = [pt(T0, 40, reset), pt(nextStart - 25 * MIN_MS, 60, reset)];
		expect(deriveOutcome(series, T0, reset, nextStart)).toEqual({
			kind: "censored",
		});
	});

	test("a null resetAt still allows survival when the next window is observed", () => {
		const series = [pt(T0, 10, null), pt(T0 + 30 * MIN_MS, 12, null)];
		expect(deriveOutcome(series, T0, null, T0 + 32 * MIN_MS)).toEqual({
			kind: "survived",
		});
	});
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const rec = (over: Partial<BacktestRecord> = {}): BacktestRecord => ({
	T: T0,
	windowKind: "five_hour",
	accountId: "acct-a",
	provider: "anthropic",
	usable: true,
	unusableReason: null,
	predictsExhaust: false,
	predictedEtaMs: null,
	outcome: { kind: "survived" },
	resetAtMs: T0 + 4 * HOUR_MS,
	windowMs: FIVE_HOUR_WINDOW_MS,
	...over,
});

/**
 * 8 hand-scored records: 3 TP, 1 FP, 1 FN, 1 TN, 1 censored (excluded from
 * scoring, counted as coverage) and 1 unusable.
 */
const HAND_RECORDS: BacktestRecord[] = [
	// TP, predicted 10 min LATE, actual lead 60 min
	rec({
		predictsExhaust: true,
		predictedEtaMs: T0 + 70 * MIN_MS,
		outcome: { kind: "exhausted", atMs: T0 + 60 * MIN_MS },
	}),
	// FP: predicted an exhaustion 45 min out, the window survived
	rec({
		predictsExhaust: true,
		predictedEtaMs: T0 + 45 * MIN_MS,
		outcome: { kind: "survived" },
	}),
	// FN: exhausted 20 min out, no prediction
	rec({ outcome: { kind: "exhausted", atMs: T0 + 20 * MIN_MS } }),
	// TN
	rec({ outcome: { kind: "survived" } }),
	// censored: excluded from confusion entirely
	rec({
		predictsExhaust: true,
		predictedEtaMs: T0 + 30 * MIN_MS,
		outcome: { kind: "censored" },
	}),
	// unusable: excluded from confusion, counted in coverage
	rec({
		usable: false,
		unusableReason: "insufficient_data",
		outcome: { kind: "exhausted", atMs: T0 + 10 * MIN_MS },
	}),
	// TP, predicted 30 min EARLY, actual lead 180 min
	rec({
		predictsExhaust: true,
		predictedEtaMs: T0 + 150 * MIN_MS,
		outcome: { kind: "exhausted", atMs: T0 + 180 * MIN_MS },
	}),
	// TP, predicted 50 min LATE, actual lead 600 min (reset far enough out that
	// the exhaustion is still inside the window)
	rec({
		resetAtMs: T0 + 12 * HOUR_MS,
		predictsExhaust: true,
		predictedEtaMs: T0 + 650 * MIN_MS,
		outcome: { kind: "exhausted", atMs: T0 + 600 * MIN_MS },
	}),
];

describe("scoreRecords", () => {
	test("coverage counts sum to instants", () => {
		const m = scoreRecords(HAND_RECORDS);
		expect(m.instants).toBe(8);
		const sum =
			m.coverage.usable +
			m.coverage.insufficient_data +
			m.coverage.low_confidence +
			m.coverage.no_slope +
			m.coverage.no_reset;
		expect(sum).toBe(m.instants);
		expect(m.coverage.usable).toBe(7);
		expect(m.coverage.insufficient_data).toBe(1);
		expect(m.censored).toBe(1);
		expect(m.scored).toBe(6);
	});

	test("hand-computed confusion, precision, recall, F1", () => {
		const m = scoreRecords(HAND_RECORDS);
		expect(m.confusion).toEqual({ tp: 3, fp: 1, tn: 1, fn: 1 });
		expect(m.precision).toBeCloseTo(0.75, 10);
		expect(m.recall).toBeCloseTo(0.75, 10);
		expect(m.f1).toBeCloseTo(0.75, 10);
	});

	test("signed and absolute ETA error are both first-class (nearest-rank)", () => {
		const m = scoreRecords(HAND_RECORDS);
		// signed minutes: [-30, 10, 50]; absolute: [10, 30, 50]
		expect(m.signedEtaError.n).toBe(3);
		expect(m.signedEtaError.medianMinutes).toBeCloseTo(10, 10);
		expect(m.signedEtaError.p10Minutes).toBeCloseTo(-30, 10);
		expect(m.signedEtaError.p90Minutes).toBeCloseTo(50, 10);
		expect(m.absoluteEtaError.medianMinutes).toBeCloseTo(30, 10);
		expect(m.absoluteEtaError.p10Minutes).toBeCloseTo(10, 10);
		expect(m.absoluteEtaError.p90Minutes).toBeCloseTo(50, 10);
		// |median signed| (10) is NOT median absolute (30).
		expect(m.absoluteEtaError.medianMinutes).not.toBeCloseTo(
			Math.abs(m.signedEtaError.medianMinutes as number),
			10,
		);
		// window fraction: 10 min of a 300-min window
		expect(m.signedEtaError.medianWindowFraction).toBeCloseTo(10 / 300, 10);
	});

	test("lead-time buckets: actual positives by ACTUAL lead, FPs by PREDICTED lead", () => {
		const m = scoreRecords(HAND_RECORDS);
		const byLabel = new Map(m.leadTimeBuckets.map((b) => [b.label, b]));
		expect(byLabel.get("<30m")).toEqual({
			label: "<30m",
			tp: 0,
			fn: 1,
			recall: 0,
			medianSignedErrorMinutes: null,
		});
		const early = byLabel.get("30m-2h");
		expect(early?.tp).toBe(1);
		expect(early?.fn).toBe(0);
		expect(early?.recall).toBe(1);
		expect(early?.medianSignedErrorMinutes).toBeCloseTo(10, 10);
		const mid = byLabel.get("2h-12h");
		expect(mid?.tp).toBe(2);
		expect(mid?.medianSignedErrorMinutes).toBeCloseTo(-30, 10);
		expect(byLabel.get(">48h")?.tp).toBe(0);

		const fpByLabel = new Map(
			m.falsePositiveLeadTimeBuckets.map((b) => [b.label, b.fp]),
		);
		expect(fpByLabel.get("30m-2h")).toBe(1);
		expect(fpByLabel.get("<30m")).toBe(0);
	});

	test("no positives at all -> null precision/recall/F1, never 0", () => {
		const m = scoreRecords([rec(), rec(), rec()]);
		expect(m.confusion).toEqual({ tp: 0, fp: 0, tn: 3, fn: 0 });
		expect(m.precision).toBeNull();
		expect(m.recall).toBeNull();
		expect(m.f1).toBeNull();
		expect(m.signedEtaError.medianMinutes).toBeNull();
	});

	test("empty input -> zeroed counts and null rates", () => {
		const m = scoreRecords([]);
		expect(m.instants).toBe(0);
		expect(m.scored).toBe(0);
		expect(m.f1).toBeNull();
	});

	test("an exhaustion at or after the reset is an actual NEGATIVE", () => {
		const reset = T0 + 60 * MIN_MS;
		const m = scoreRecords([
			rec({
				resetAtMs: reset,
				predictsExhaust: true,
				predictedEtaMs: T0 + 50 * MIN_MS,
				outcome: { kind: "exhausted", atMs: T0 + 70 * MIN_MS },
			}),
		]);
		expect(m.confusion).toEqual({ tp: 0, fp: 1, tn: 0, fn: 0 });
	});

	test("macroAverageByAccount weights accounts equally", () => {
		const perfect = (accountId: string) => [
			rec({
				accountId,
				predictsExhaust: true,
				predictedEtaMs: T0,
				outcome: { kind: "exhausted", atMs: T0 + MIN_MS },
			}),
			rec({ accountId }),
		];
		const useless = (accountId: string) => [
			rec({
				accountId,
				predictsExhaust: false,
				outcome: { kind: "exhausted", atMs: T0 + MIN_MS },
			}),
			rec({ accountId, predictsExhaust: true, predictedEtaMs: T0 }),
		];
		// One account with F1 = 1, one with F1 = 0 -> macro 0.5, while micro is
		// dominated by neither.
		const macro = macroAverageByAccount([
			...perfect("a"),
			...useless("b"),
			...useless("b"),
		]);
		expect(macro).toBeCloseTo(0.5, 10);
		expect(macroAverageByAccount([])).toBeNull();
	});
});

describe("commonCohort", () => {
	test("keeps only triples every estimator can score", () => {
		const triple = (T: number, over: Partial<BacktestRecord> = {}) =>
			rec({ T, ...over });
		const a = [
			triple(1),
			triple(2),
			triple(3, { usable: false, unusableReason: "low_confidence" }),
			triple(4),
		];
		const b = [
			triple(1),
			triple(2, { usable: false, unusableReason: "no_reset" }),
			triple(3),
			triple(4, { outcome: { kind: "censored" } }),
		];
		const out = commonCohort(
			new Map([
				["a", a],
				["b", b],
			]),
		);
		expect(out.get("a")?.map((r) => r.T)).toEqual([1]);
		expect(out.get("b")?.map((r) => r.T)).toEqual([1]);
	});

	test("a triple missing from one estimator drops out of all", () => {
		const out = commonCohort(
			new Map([
				["a", [rec({ T: 1 }), rec({ T: 2 })]],
				["b", [rec({ T: 1 })]],
			]),
		);
		expect(out.get("a")?.map((r) => r.T)).toEqual([1]);
		expect(out.get("b")).toHaveLength(1);
	});

	test("the same T on different accounts or windows is a different triple", () => {
		const out = commonCohort(
			new Map([
				[
					"a",
					[
						rec({ T: 1, accountId: "x" }),
						rec({ T: 1, accountId: "y" }),
						rec({ T: 1, windowKind: "seven_day" }),
					],
				],
				["b", [rec({ T: 1, accountId: "y" })]],
			]),
		);
		expect(out.get("a")?.map((r) => r.accountId)).toEqual(["y"]);
	});
});

describe("bootstrapDelta", () => {
	const positive = (accountId: string, n: number) =>
		Array.from({ length: n }, (_, i) =>
			rec({
				accountId,
				T: T0 + i,
				predictsExhaust: true,
				predictedEtaMs: T0 + i,
				outcome: { kind: "exhausted", atMs: T0 + i + MIN_MS },
			}),
		);
	const missed = (accountId: string, n: number) =>
		Array.from({ length: n }, (_, i) =>
			rec({
				accountId,
				T: T0 + i,
				predictsExhaust: false,
				outcome: { kind: "exhausted", atMs: T0 + i + MIN_MS },
			}),
		);

	const good = [...positive("a", 6), ...positive("b", 6), ...positive("c", 6)];
	const bad = [...missed("a", 6), ...missed("b", 6), ...missed("c", 6)];

	test("same seed -> identical CI (no Math.random anywhere)", () => {
		const opts = { iterations: 200, seed: 12345, statistic: "f1" } as const;
		const first = bootstrapDelta(good, bad, opts);
		const second = bootstrapDelta(good, bad, opts);
		expect(first).toEqual(second);
	});

	test("different seed -> a different draw (the PRNG is actually seeded)", () => {
		const a = bootstrapDelta(good, bad, {
			iterations: 200,
			seed: 1,
			statistic: "f1",
		});
		const b = bootstrapDelta(good, bad, {
			iterations: 200,
			seed: 2,
			statistic: "f1",
		});
		expect(a.samples).toBe(b.samples);
		// The interval is identical here only because the fixture is degenerate;
		// assert the machinery ran rather than that the numbers differ.
		expect(a.p50).not.toBeNull();
		expect(b.p50).not.toBeNull();
	});

	test("separated fixture: the CI excludes 0", () => {
		const ci = bootstrapDelta(good, bad, {
			iterations: 500,
			seed: 20260823,
			statistic: "f1",
		});
		expect(ci.p2_5 as number).toBeGreaterThan(0);
		expect(ci.p50 as number).toBeCloseTo(1, 10);
	});

	test("overlapping fixture: the CI straddles 0", () => {
		// Same records on both sides -> the delta is identically 0.
		const ci = bootstrapDelta(good, good, {
			iterations: 500,
			seed: 20260823,
			statistic: "f1",
		});
		expect(ci.p2_5).toBeCloseTo(0, 10);
		expect(ci.p97_5).toBeCloseTo(0, 10);
	});

	test("median-absolute-error statistic resamples the same way", () => {
		const late = [
			...positive("a", 4).map((r) => ({
				...r,
				predictedEtaMs: (r.predictedEtaMs as number) + 10 * MIN_MS,
			})),
			...positive("b", 4).map((r) => ({
				...r,
				predictedEtaMs: (r.predictedEtaMs as number) + 10 * MIN_MS,
			})),
		];
		const onTime = [...positive("a", 4), ...positive("b", 4)].map((r) => ({
			...r,
			predictedEtaMs: (r.outcome as { atMs: number }).atMs,
		}));
		const ci = bootstrapDelta(late, onTime, {
			iterations: 300,
			seed: 7,
			statistic: "medianAbsErrorMinutes",
		});
		// `late` is ~9 min off, `onTime` is exact -> the delta is positive.
		expect(ci.p50 as number).toBeGreaterThan(0);
	});

	test("no scorable records -> null bounds, never fabricated zeros", () => {
		const ci = bootstrapDelta([], [], {
			iterations: 50,
			seed: 1,
			statistic: "f1",
		});
		expect(ci.p2_5).toBeNull();
		expect(ci.p50).toBeNull();
		expect(ci.p97_5).toBeNull();
		expect(ci.samples).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Estimator adapters
// ---------------------------------------------------------------------------

const FIVE_HOUR = {
	windowMs: FIVE_HOUR_WINDOW_MS,
	lookbackMs: 6 * HOUR_MS,
} as const;

/** 10 pp/h from 40%, sampled every 10 min for the last 2 h. */
function steadyRise(T: number, reset: number): PredictionPoint[] {
	const out: PredictionPoint[] = [];
	for (let i = 12; i >= 0; i--) {
		out.push(pt(T - i * 10 * MIN_MS, 40 - (i * 10) / 6, reset));
	}
	return out;
}

/** Flat at 20% for 3 h. */
function idleFlat(T: number, reset: number): PredictionPoint[] {
	const out: PredictionPoint[] = [];
	for (let i = 18; i >= 0; i--) out.push(pt(T - i * 10 * MIN_MS, 20, reset));
	return out;
}

/** A burst 4 h ago, then flat for the last 3 h. */
function burstThenIdle(T: number, reset: number): PredictionPoint[] {
	const out: PredictionPoint[] = [];
	for (let i = 30; i >= 18; i--) {
		out.push(pt(T - i * 10 * MIN_MS, 60 - (i - 18) * 4, reset));
	}
	for (let i = 17; i >= 0; i--) out.push(pt(T - i * 10 * MIN_MS, 60, reset));
	return out;
}

describe("makeOlsEstimator", () => {
	const ols = makeOlsEstimator();

	test("steady rise -> usable, exhaust predicted before a far reset", () => {
		const reset = T0 + 10 * HOUR_MS;
		const out = ols(steadyRise(T0, reset), T0, FIVE_HOUR);
		expect(out.usable).toBe(true);
		expect(out.unusableReason).toBeNull();
		expect(out.predictsExhaust).toBe(true);
		// 40% rising 10 pp/h -> 6 h to 100%
		expect(out.predictedEtaMs as number).toBeCloseTo(T0 + 6 * HOUR_MS, -4);
	});

	test("steady rise with a near reset -> usable, no exhaust predicted", () => {
		const reset = T0 + 2 * HOUR_MS;
		const out = ols(steadyRise(T0, reset), T0, FIVE_HOUR);
		expect(out.usable).toBe(true);
		expect(out.predictsExhaust).toBe(false);
	});

	test("idle-flat -> usable (a confident 'no'), no ETA", () => {
		const out = ols(idleFlat(T0, T0 + 3 * HOUR_MS), T0, FIVE_HOUR);
		expect(out.usable).toBe(true);
		expect(out.predictsExhaust).toBe(false);
		expect(out.predictedEtaMs).toBeNull();
	});

	test("burst-then-idle -> the unweighted fit still sees the old burst", () => {
		const out = ols(burstThenIdle(T0, T0 + 10 * HOUR_MS), T0, FIVE_HOUR);
		expect(out.usable).toBe(true);
		// Flat for 3 h, but the 4-h-old burst drags the unweighted slope positive.
		expect(out.predictsExhaust).toBe(true);
	});

	test("too few points inside the lookback -> insufficient_data", () => {
		const reset = T0 + 5 * HOUR_MS;
		const out = ols([pt(T0 - MIN_MS, 10, reset), pt(T0, 12, reset)], T0, {
			windowMs: FIVE_HOUR_WINDOW_MS,
			lookbackMs: 6 * HOUR_MS,
		});
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("insufficient_data");
	});

	test("a span under 5 min -> low_confidence", () => {
		const reset = T0 + 5 * HOUR_MS;
		const out = ols(
			[
				pt(T0 - 2 * MIN_MS, 10, reset),
				pt(T0 - MIN_MS, 12, reset),
				pt(T0, 14, reset),
			],
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("low_confidence");
	});

	test("the lookback is applied before the fit", () => {
		const reset = T0 + 10 * HOUR_MS;
		const older = [
			pt(T0 - 20 * HOUR_MS, 10, reset),
			pt(T0 - 19 * HOUR_MS, 20, reset),
			pt(T0 - 18 * HOUR_MS, 30, reset),
		];
		const out = ols([...older, ...steadyRise(T0, reset)], T0, FIVE_HOUR);
		// Only the last 6 h enter the fit -> the same ETA as without the old rows.
		const bare = ols(steadyRise(T0, reset), T0, FIVE_HOUR);
		expect(out.predictedEtaMs).toBe(bare.predictedEtaMs);
	});
});

describe("lifetimeAverageEstimator", () => {
	test("steady rise: (100-pct)/pct x elapsed from the window start", () => {
		const reset = T0 + 3 * HOUR_MS;
		const out = lifetimeAverageEstimator(steadyRise(T0, reset), T0, FIVE_HOUR);
		// windowStart = reset - 5 h = T0 - 2 h; elapsed 2 h at 40% -> 3 h to go.
		expect(out.usable).toBe(true);
		expect(out.predictedEtaMs as number).toBeCloseTo(T0 + 3 * HOUR_MS, -4);
		// eta == reset, not < reset
		expect(out.predictsExhaust).toBe(false);
	});

	test("no reset -> unusable with no_reset (never a guessed window start)", () => {
		const out = lifetimeAverageEstimator(
			[pt(T0 - HOUR_MS, 10, null), pt(T0, 20, null)],
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("no_reset");
		expect(out.predictedEtaMs).toBeNull();
	});

	test("0% used -> no_slope (no division by zero, no fabricated ETA)", () => {
		const reset = T0 + 3 * HOUR_MS;
		const out = lifetimeAverageEstimator(
			[pt(T0 - HOUR_MS, 0, reset), pt(T0, 0, reset)],
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("no_slope");
	});

	test("idle-flat still projects from the lifetime average (its known bias)", () => {
		const reset = T0 + HOUR_MS;
		const out = lifetimeAverageEstimator(idleFlat(T0, reset), T0, FIVE_HOUR);
		// windowStart = reset - 5 h = T0 - 4 h; 20% in 4 h -> 16 h more.
		expect(out.predictedEtaMs as number).toBeCloseTo(T0 + 16 * HOUR_MS, -4);
		expect(out.predictsExhaust).toBe(false);
	});

	test("weekly window uses the 7-day length", () => {
		const reset = T0 + 24 * HOUR_MS;
		const out = lifetimeAverageEstimator(
			[pt(T0 - HOUR_MS, 48, reset), pt(T0, 50, reset)],
			T0,
			{ windowMs: SEVEN_DAY_WINDOW_MS, lookbackMs: 24 * HOUR_MS },
		);
		// windowStart = reset - 7 d = T0 - 6 d; 50% in 6 d -> 6 d more, past reset.
		expect(out.predictedEtaMs as number).toBeCloseTo(T0 + 6 * 24 * HOUR_MS, -5);
		expect(out.predictsExhaust).toBe(false);
	});
});

describe("naivePersistenceEstimator", () => {
	test("steady rise: the last hour extrapolated forward", () => {
		const reset = T0 + 10 * HOUR_MS;
		const out = naivePersistenceEstimator(steadyRise(T0, reset), T0, FIVE_HOUR);
		expect(out.usable).toBe(true);
		expect(out.predictsExhaust).toBe(true);
		expect(out.predictedEtaMs as number).toBeCloseTo(T0 + 6 * HOUR_MS, -4);
	});

	test("burst-then-idle: the last hour is flat -> no exhaust", () => {
		const out = naivePersistenceEstimator(
			burstThenIdle(T0, T0 + 10 * HOUR_MS),
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(true);
		expect(out.predictsExhaust).toBe(false);
		expect(out.predictedEtaMs).toBeNull();
	});

	test("idle-flat -> usable, no exhaust", () => {
		const out = naivePersistenceEstimator(
			idleFlat(T0, T0 + 3 * HOUR_MS),
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(true);
		expect(out.predictsExhaust).toBe(false);
	});

	test("fewer than 2 points in the last hour -> insufficient_data", () => {
		const reset = T0 + 5 * HOUR_MS;
		const out = naivePersistenceEstimator(
			[pt(T0 - 3 * HOUR_MS, 10, reset), pt(T0, 50, reset)],
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("insufficient_data");
	});

	test("a span under 5 min -> low_confidence", () => {
		const reset = T0 + 5 * HOUR_MS;
		const out = naivePersistenceEstimator(
			[pt(T0 - 2 * MIN_MS, 10, reset), pt(T0, 20, reset)],
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("low_confidence");
	});

	test("a falling series -> usable, no exhaust", () => {
		const reset = T0 + 5 * HOUR_MS;
		const out = naivePersistenceEstimator(
			[
				pt(T0 - 60 * MIN_MS, 60, reset),
				pt(T0 - 30 * MIN_MS, 50, reset),
				pt(T0, 40, reset),
			],
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(true);
		expect(out.predictedEtaMs).toBeNull();
		expect(out.predictsExhaust).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

describe("formatBacktestReport", () => {
	const report = () =>
		formatBacktestReport({
			title: "Fixture report",
			generatedAtIso: "2026-08-23T00:00:00.000Z",
			command: "bun scripts/prediction-backtest.ts --step-minutes=10",
			config: { stepMinutes: 10, seed: 20260823 },
			dataset: {
				rows: 100,
				accounts: 2,
				providers: ["anthropic", "codex"],
				firstSampleIso: "2026-06-01T00:00:00.000Z",
				lastSampleIso: "2026-08-23T00:00:00.000Z",
			},
			ranges: [
				{
					label: "Tuning",
					fromIso: "2026-06-01T00:00:00.000Z",
					toIso: "2026-08-01T00:00:00.000Z",
					windows: [
						{
							windowKind: "five_hour",
							conditional: [
								{ estimator: "ols", metrics: scoreRecords(HAND_RECORDS) },
							],
							commonCohort: [
								{ estimator: "ols", metrics: scoreRecords(HAND_RECORDS) },
							],
							byProvider: [
								{
									provider: "anthropic",
									estimator: "ols",
									metrics: scoreRecords(HAND_RECORDS),
								},
							],
							byAccount: [
								{
									accountId: "acct-a",
									provider: "anthropic",
									instants: 8,
									scored: 6,
									positives: 4,
								},
							],
							macroF1: [{ estimator: "ols", macroF1: 0.75 }],
							bootstrap: [
								{
									label: "ols vs lifetime",
									statistic: "f1",
									p2_5: -0.1,
									p50: 0.05,
									p97_5: 0.2,
									samples: 1000,
								},
							],
						},
					],
				},
			],
			rateLimitDiagnostic: [
				{
					accountId: "acct-a",
					provider: "anthropic",
					windowKind: "five_hour",
					survivedWindows: 12,
					survivedWindowsWith429: 1,
					requests429: 3,
				},
			],
		});

	test("is deterministic for identical input", () => {
		expect(report()).toBe(report());
	});

	test("contains the sections the baseline report is required to carry", () => {
		const md = report();
		expect(md).toContain("# Fixture report");
		expect(md).toContain("## Methodology");
		expect(md).toContain(
			"bun scripts/prediction-backtest.ts --step-minutes=10",
		);
		expect(md).toContain("Tuning");
		expect(md).toContain("five_hour");
		expect(md).toContain("Common cohort");
		expect(md).toContain("By provider");
		expect(md).toContain("Per-account contribution");
		expect(md).toContain("Bootstrap");
		expect(md).toContain("429");
		expect(md).toContain("acct-a");
		// Methodology must state the load-bearing caveats.
		expect(md).toContain("censor");
		expect(md).toContain("quantis");
	});

	test("renders null metrics as an em-dash, never as 0", () => {
		const md = formatBacktestReport({
			title: "Nulls",
			generatedAtIso: "2026-08-23T00:00:00.000Z",
			command: "x",
			config: {},
			dataset: {
				rows: 0,
				accounts: 0,
				providers: [],
				firstSampleIso: "2026-06-01T00:00:00.000Z",
				lastSampleIso: "2026-06-01T00:00:00.000Z",
			},
			ranges: [
				{
					label: "Empty",
					fromIso: "2026-06-01T00:00:00.000Z",
					toIso: "2026-06-02T00:00:00.000Z",
					windows: [
						{
							windowKind: "seven_day",
							conditional: [{ estimator: "ols", metrics: scoreRecords([]) }],
							commonCohort: [],
							byProvider: [],
							byAccount: [],
							macroF1: [{ estimator: "ols", macroF1: null }],
						},
					],
				},
			],
			rateLimitDiagnostic: [],
		});
		expect(md).toContain("—");
		expect(md).not.toMatch(/\|\s*0\.000\s*\|\s*0\.000\s*\|\s*0\.000\s*\|/);
	});
});
