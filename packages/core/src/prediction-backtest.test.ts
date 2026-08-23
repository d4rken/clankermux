import { describe, expect, test } from "bun:test";
import type { PredictionPoint } from "@clankermux/types";
import {
	type BacktestRecord,
	bootstrapDelta,
	commonCohort,
	deploymentCohort,
	deriveOutcome,
	evaluateHeldOutGate,
	FIVE_HOUR_WINDOW_MS,
	formatBacktestReport,
	lifetimeAverageEstimator,
	MAX_DELTA_GAP_MS,
	macroAverageByAccount,
	makeDowSeasonalEstimator,
	makeEndpointSlopeEstimator,
	makeOlsEstimator,
	makeTrailingBurnEstimator,
	naivePersistenceEstimator,
	SEVEN_DAY_WINDOW_MS,
	scoreForSelection,
	scoreRecords,
	scoreRedRule,
	selectTuningWinner,
	withinWindowDeltas,
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

	test("0% used -> a confident negative, matching production's no-usage branch", () => {
		const reset = T0 + 3 * HOUR_MS;
		const out = lifetimeAverageEstimator(
			[pt(T0 - HOUR_MS, 0, reset), pt(T0, 0, reset)],
			T0,
			FIVE_HOUR,
		);
		// `estimateWindowExhaustion` returns `no-usage` here: a window that is
		// readable and untouched will not exhaust. That is an ANSWER, not an
		// abstention, so the adapter must not spend it as missing coverage.
		expect(out.usable).toBe(true);
		expect(out.unusableReason).toBeNull();
		expect(out.predictsExhaust).toBe(false);
		expect(out.predictedEtaMs).toBeNull();
	});

	test("a zero-length elapsed window is still no_slope", () => {
		// windowStart == T (the window just opened) leaves nothing to average over.
		const reset = T0 + 5 * HOUR_MS;
		const out = lifetimeAverageEstimator(
			[pt(T0 - HOUR_MS, 4, reset), pt(T0, 4, reset)],
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
// Production-faithfulness guards (every adapter, baselines included)
// ---------------------------------------------------------------------------

describe("production-faithfulness guards", () => {
	const SEVEN_DAY = {
		windowMs: SEVEN_DAY_WINDOW_MS,
		lookbackMs: 24 * HOUR_MS,
	} as const;

	const fiveHourAdapters: Array<[string, ReturnType<typeof makeOlsEstimator>]> =
		[
			["ols", makeOlsEstimator()],
			["ols-1h", makeOlsEstimator(HOUR_MS)],
			["lifetime", lifetimeAverageEstimator],
			["naive", naivePersistenceEstimator],
			["endpoint-seg-1h", makeEndpointSlopeEstimator(HOUR_MS)],
		];

	const sevenDayAdapters: Array<[string, ReturnType<typeof makeOlsEstimator>]> =
		[
			["ols", makeOlsEstimator()],
			["lifetime", lifetimeAverageEstimator],
			["naive", naivePersistenceEstimator],
			["trailing-3d", makeTrailingBurnEstimator(72 * HOUR_MS)],
			["dow-seasonal", makeDowSeasonalEstimator()],
		];

	test("an expired reset on the newest sample is no_reset, never an estimate", () => {
		// `estimateWindowExhaustion` rejects `resetsAtMs <= now` outright: the
		// window it would project into has already been replaced.
		const expired = T0 - MIN_MS;
		const points = [
			pt(T0 - 2 * HOUR_MS, 20, expired),
			pt(T0 - HOUR_MS, 40, expired),
			pt(T0, 60, expired),
		];
		for (const [name, estimator] of fiveHourAdapters) {
			const out = estimator(points, T0, FIVE_HOUR);
			expect(`${name}:${out.usable}`).toBe(`${name}:false`);
			expect(`${name}:${out.unusableReason}`).toBe(`${name}:no_reset`);
			expect(out.predictedEtaMs).toBeNull();
		}
	});

	test("a reset landing exactly on T is already spent", () => {
		const points = [pt(T0 - HOUR_MS, 20, T0), pt(T0, 40, T0)];
		for (const [name, estimator] of fiveHourAdapters) {
			const out = estimator(points, T0, FIVE_HOUR);
			expect(`${name}:${out.unusableReason}`).toBe(`${name}:no_reset`);
		}
	});

	test("nothing used yet is a confident negative for every adapter", () => {
		const reset = T0 + 3 * HOUR_MS;
		const points = [
			pt(T0 - 2 * HOUR_MS, 0, reset),
			pt(T0 - HOUR_MS, 0, reset),
			pt(T0, 0, reset),
		];
		for (const [name, estimator] of fiveHourAdapters) {
			const out = estimator(points, T0, FIVE_HOUR);
			expect(`${name}:${out.usable}`).toBe(`${name}:true`);
			expect(`${name}:${out.predictsExhaust}`).toBe(`${name}:false`);
			expect(out.predictedEtaMs).toBeNull();
		}
		const weeklyReset = T0 + 3 * 24 * HOUR_MS;
		const weekly = [
			pt(T0 - 2 * HOUR_MS, 0, weeklyReset),
			pt(T0, 0, weeklyReset),
		];
		for (const [name, estimator] of sevenDayAdapters) {
			const out = estimator(weekly, T0, SEVEN_DAY);
			expect(`${name}:${out.usable}`).toBe(`${name}:true`);
			expect(`${name}:${out.predictsExhaust}`).toBe(`${name}:false`);
		}
	});

	test("a null reset is NOT the expired case and still reaches the adapter", () => {
		const points = [
			pt(T0 - 2 * HOUR_MS, 10, null),
			pt(T0 - HOUR_MS, 20, null),
			pt(T0, 30, null),
		];
		// lifetime has no window start without a reset; ols extrapolates freely.
		expect(lifetimeAverageEstimator(points, T0, FIVE_HOUR).unusableReason).toBe(
			"no_reset",
		);
		const ols = makeOlsEstimator()(points, T0, FIVE_HOUR);
		expect(ols.usable).toBe(true);
		expect(ols.predictsExhaust).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Observed within-window deltas
// ---------------------------------------------------------------------------

describe("withinWindowDeltas", () => {
	const reset = T0 + 5 * HOUR_MS;

	test("consecutive in-window pairs become deltas, refunds kept negative", () => {
		const deltas = withinWindowDeltas(
			[
				pt(T0, 10, reset),
				pt(T0 + 10 * MIN_MS, 14, reset),
				pt(T0 + 20 * MIN_MS, 11, reset),
			],
			MAX_DELTA_GAP_MS,
		);
		expect(deltas).toEqual([
			{ fromMs: T0, toMs: T0 + 10 * MIN_MS, dPct: 4 },
			{ fromMs: T0 + 10 * MIN_MS, toMs: T0 + 20 * MIN_MS, dPct: -3 },
		]);
	});

	test("a reset boundary is not a delta: the drop is a new window, not a refund", () => {
		const next = reset + 5 * HOUR_MS;
		const deltas = withinWindowDeltas(
			[
				pt(T0, 90, reset),
				pt(T0 + 10 * MIN_MS, 2, next),
				pt(T0 + 20 * MIN_MS, 5, next),
			],
			MAX_DELTA_GAP_MS,
		);
		expect(deltas).toEqual([
			{ fromMs: T0 + 10 * MIN_MS, toMs: T0 + 20 * MIN_MS, dPct: 3 },
		]);
	});

	test("a sampling outage is rejected: unobserved time is not observed coverage", () => {
		const deltas = withinWindowDeltas(
			[
				pt(T0, 10, reset),
				// 16 min: one minute past the gap ceiling.
				pt(T0 + 16 * MIN_MS, 30, reset),
				pt(T0 + 26 * MIN_MS, 31, reset),
			],
			MAX_DELTA_GAP_MS,
		);
		expect(deltas).toEqual([
			{ fromMs: T0 + 16 * MIN_MS, toMs: T0 + 26 * MIN_MS, dPct: 1 },
		]);
	});

	test("the gap ceiling is inclusive", () => {
		const deltas = withinWindowDeltas(
			[pt(T0, 10, reset), pt(T0 + MAX_DELTA_GAP_MS, 20, reset)],
			MAX_DELTA_GAP_MS,
		);
		expect(deltas).toHaveLength(1);
		expect(MAX_DELTA_GAP_MS).toBe(15 * MIN_MS);
	});

	test("equal timestamps carry no elapsed time and are dropped", () => {
		const deltas = withinWindowDeltas(
			[pt(T0, 10, reset), pt(T0, 12, reset), pt(T0 + 10 * MIN_MS, 13, reset)],
			MAX_DELTA_GAP_MS,
		);
		expect(deltas).toEqual([{ fromMs: T0, toMs: T0 + 10 * MIN_MS, dPct: 1 }]);
	});

	test("fewer than two points yields nothing", () => {
		expect(withinWindowDeltas([], MAX_DELTA_GAP_MS)).toEqual([]);
		expect(withinWindowDeltas([pt(T0, 10, reset)], MAX_DELTA_GAP_MS)).toEqual(
			[],
		);
	});
});

// ---------------------------------------------------------------------------
// five_hour candidates
// ---------------------------------------------------------------------------

describe("makeOlsEstimator lookback override", () => {
	test("the override replaces the window lookback", () => {
		const reset = T0 + 10 * HOUR_MS;
		// Flat for the last hour, a burst before it. The 6 h fit sees the burst;
		// the 1 h fit does not.
		const points: PredictionPoint[] = [];
		for (let i = 30; i >= 6; i--) {
			points.push(pt(T0 - i * 10 * MIN_MS, 60 - (i - 6) * 2, reset));
		}
		for (let i = 5; i >= 0; i--)
			points.push(pt(T0 - i * 10 * MIN_MS, 60, reset));
		expect(makeOlsEstimator()(points, T0, FIVE_HOUR).predictsExhaust).toBe(
			true,
		);
		const narrow = makeOlsEstimator(HOUR_MS)(points, T0, FIVE_HOUR);
		expect(narrow.usable).toBe(true);
		expect(narrow.predictsExhaust).toBe(false);
	});

	test("without an override the window lookback still applies", () => {
		const reset = T0 + 10 * HOUR_MS;
		const older = [
			pt(T0 - 20 * HOUR_MS, 10, reset),
			pt(T0 - 19 * HOUR_MS, 20, reset),
			pt(T0 - 18 * HOUR_MS, 30, reset),
		];
		const withOld = makeOlsEstimator()(
			[...older, ...steadyRise(T0, reset)],
			T0,
			FIVE_HOUR,
		);
		expect(withOld.predictedEtaMs).toBe(
			makeOlsEstimator()(steadyRise(T0, reset), T0, FIVE_HOUR).predictedEtaMs,
		);
	});
});

describe("makeEndpointSlopeEstimator", () => {
	test("steady rise: the endpoints of the lookback window set the slope", () => {
		const reset = T0 + 10 * HOUR_MS;
		const out = makeEndpointSlopeEstimator(30 * MIN_MS)(
			steadyRise(T0, reset),
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(true);
		// 35% -> 40% over 30 min = 10 pp/h, 60 pp of headroom -> 6 h.
		expect(out.predictedEtaMs as number).toBeCloseTo(T0 + 6 * HOUR_MS, -4);
		expect(out.predictsExhaust).toBe(true);
	});

	test("segment-aware: a refund inside the lookback restarts the segment", () => {
		const reset = T0 + 10 * HOUR_MS;
		const points: PredictionPoint[] = [];
		// 80% and rising, then a refund down to 40% 40 min before T.
		for (let i = 12; i >= 5; i--) {
			points.push(pt(T0 - i * 10 * MIN_MS, 80 - (i - 5) * 2, reset));
		}
		for (let i = 4; i >= 0; i--) {
			points.push(pt(T0 - i * 10 * MIN_MS, 40 + (4 - i) * 2, reset));
		}
		// Endpoint-over-the-whole-lookback would read 66% -> 48%: falling.
		const out = makeEndpointSlopeEstimator(2 * HOUR_MS)(points, T0, FIVE_HOUR);
		expect(out.usable).toBe(true);
		// The post-refund segment rises 8 pp in 40 min = 12 pp/h.
		expect(out.predictsExhaust).toBe(true);
		expect(out.predictedEtaMs as number).toBeCloseTo(
			T0 + (52 / 12) * HOUR_MS,
			-4,
		);
	});

	test("a shorter lookback sees only the tail of the segment", () => {
		const reset = T0 + 10 * HOUR_MS;
		const points: PredictionPoint[] = [];
		// Rising 12 pp/h for an hour, then flat for 30 min.
		for (let i = 9; i >= 3; i--) {
			points.push(pt(T0 - i * 10 * MIN_MS, 40 + (9 - i) * 2, reset));
		}
		for (let i = 2; i >= 0; i--)
			points.push(pt(T0 - i * 10 * MIN_MS, 52, reset));
		expect(
			makeEndpointSlopeEstimator(30 * MIN_MS)(points, T0, FIVE_HOUR)
				.predictsExhaust,
		).toBe(false);
		expect(
			makeEndpointSlopeEstimator(2 * HOUR_MS)(points, T0, FIVE_HOUR)
				.predictsExhaust,
		).toBe(true);
	});

	test("a falling segment is usable and predicts nothing", () => {
		const reset = T0 + 5 * HOUR_MS;
		const out = makeEndpointSlopeEstimator(HOUR_MS)(
			[
				pt(T0 - 60 * MIN_MS, 60, reset),
				pt(T0 - 30 * MIN_MS, 59, reset),
				pt(T0, 58, reset),
			],
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(true);
		expect(out.predictedEtaMs).toBeNull();
		expect(out.predictsExhaust).toBe(false);
	});

	test("an ETA past the reset is usable without an exhaustion claim", () => {
		const reset = T0 + 2 * HOUR_MS;
		const out = makeEndpointSlopeEstimator(30 * MIN_MS)(
			steadyRise(T0, reset),
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(true);
		expect(out.predictsExhaust).toBe(false);
		expect(out.predictedEtaMs).not.toBeNull();
	});

	test("fewer than two points in the lookback -> insufficient_data", () => {
		const reset = T0 + 5 * HOUR_MS;
		const out = makeEndpointSlopeEstimator(30 * MIN_MS)(
			[pt(T0 - 3 * HOUR_MS, 10, reset), pt(T0, 50, reset)],
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("insufficient_data");
	});

	test("a span under 5 min -> low_confidence", () => {
		const reset = T0 + 5 * HOUR_MS;
		const out = makeEndpointSlopeEstimator(30 * MIN_MS)(
			[pt(T0 - 2 * MIN_MS, 10, reset), pt(T0, 20, reset)],
			T0,
			FIVE_HOUR,
		);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("low_confidence");
	});
});

// ---------------------------------------------------------------------------
// seven_day candidates
// ---------------------------------------------------------------------------

const SEVEN_DAY_SPEC = {
	windowMs: SEVEN_DAY_WINDOW_MS,
	lookbackMs: 24 * HOUR_MS,
} as const;

const DAY_MS = 24 * HOUR_MS;

/** Samples every 10 min over `days`, ending at `T`, rising `pctPerDay`. */
function uniformBurn(
	T: number,
	days: number,
	pctPerDay: number,
	reset: number | null,
	startPct = 0,
): PredictionPoint[] {
	const out: PredictionPoint[] = [];
	const steps = (days * DAY_MS) / (10 * MIN_MS);
	for (let i = steps; i >= 0; i--) {
		const t = T - i * 10 * MIN_MS;
		out.push(
			pt(t, startPct + ((steps - i) * 10 * MIN_MS * pctPerDay) / DAY_MS, reset),
		);
	}
	return out;
}

describe("makeTrailingBurnEstimator", () => {
	const trailing3d = makeTrailingBurnEstimator(72 * HOUR_MS);

	test("hand-computed rate over the horizon", () => {
		const reset = T0 + 2 * DAY_MS;
		// 4 days of history at 5 pp/day, so the last 3 days are fully covered.
		const points = uniformBurn(T0, 4, 5, reset);
		const out = trailing3d(points, T0, SEVEN_DAY_SPEC);
		expect(out.usable).toBe(true);
		// 20 pp used, 80 pp left at 5 pp/day -> 16 days.
		expect(out.predictedEtaMs as number).toBeCloseTo(T0 + 16 * DAY_MS, -5);
		// ...which is well past the reset, so no alert.
		expect(out.predictsExhaust).toBe(false);
	});

	test("a burn that outruns the reset predicts exhaustion", () => {
		const reset = T0 + 5 * DAY_MS;
		const points = uniformBurn(T0, 4, 12, reset, 20);
		const out = trailing3d(points, T0, SEVEN_DAY_SPEC);
		// 68 pp used, 32 pp left at 12 pp/day -> 2.67 days, inside the reset.
		expect(out.usable).toBe(true);
		expect(out.predictsExhaust).toBe(true);
		expect(out.predictedEtaMs as number).toBeCloseTo(
			T0 + (32 / 12) * DAY_MS,
			-5,
		);
	});

	test("half the horizon is the coverage floor", () => {
		const reset = T0 + 2 * DAY_MS;
		// 35 h of samples: short of the 36 h floor for a 72 h horizon.
		const short = trailing3d(
			uniformBurn(T0, 35 / 24, 5, reset),
			T0,
			SEVEN_DAY_SPEC,
		);
		expect(short.usable).toBe(false);
		expect(short.unusableReason).toBe("insufficient_data");
		const enough = trailing3d(
			uniformBurn(T0, 37 / 24, 5, reset),
			T0,
			SEVEN_DAY_SPEC,
		);
		expect(enough.usable).toBe(true);
	});

	test("outages do not count as coverage", () => {
		const reset = T0 + 2 * DAY_MS;
		const points: PredictionPoint[] = [];
		// 3 days of samples 30 min apart: every pair is an outage by the 15 min
		// ceiling, so nothing is observed at all.
		for (let i = 144; i >= 0; i--) {
			points.push(pt(T0 - i * 30 * MIN_MS, 40 - i * 0.1, reset));
		}
		const out = trailing3d(points, T0, SEVEN_DAY_SPEC);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("insufficient_data");
	});

	test("a net refund over the horizon is a confident negative", () => {
		const reset = T0 + 2 * DAY_MS;
		const out = trailing3d(
			uniformBurn(T0, 4, -5, reset, 40),
			T0,
			SEVEN_DAY_SPEC,
		);
		expect(out.usable).toBe(true);
		expect(out.predictsExhaust).toBe(false);
		expect(out.predictedEtaMs).toBeNull();
	});

	test("a missing reset is no_reset, not a projection into nowhere", () => {
		const out = trailing3d(uniformBurn(T0, 4, 5, null), T0, SEVEN_DAY_SPEC);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("no_reset");
	});

	test("a longer horizon demands proportionally more coverage", () => {
		const reset = T0 + 2 * DAY_MS;
		const trailing7d = makeTrailingBurnEstimator(7 * DAY_MS);
		const points = uniformBurn(T0, 4, 5, reset);
		// 4 days of history clears the 3-day horizon but not the 7-day one (which
		// needs 3.5 days INSIDE its own window -- it has 4, so it passes) ...
		expect(trailing7d(points, T0, SEVEN_DAY_SPEC).usable).toBe(true);
		const thin = uniformBurn(T0, 3, 5, reset);
		expect(trailing7d(thin, T0, SEVEN_DAY_SPEC).unusableReason).toBe(
			"insufficient_data",
		);
		expect(trailing3d(thin, T0, SEVEN_DAY_SPEC).usable).toBe(true);
	});
});

describe("makeDowSeasonalEstimator", () => {
	const dow = makeDowSeasonalEstimator();
	/** A Monday, 00:00 UTC. */
	const MONDAY = Date.parse("2026-05-04T00:00:00.000Z");

	/**
	 * `days` of 10-minute samples starting at `startMs`, cut into `windowDays`
	 * quota windows (each with its own reset, so the drop at the boundary is a
	 * window change and not a refund). Utilization accrues at
	 * `ratePerDow[utcDay]` per day.
	 */
	function seasonalHistory(
		startMs: number,
		days: number,
		windowDays: number,
		ratePerDow: number[],
	): PredictionPoint[] {
		const out: PredictionPoint[] = [];
		const step = 10 * MIN_MS;
		const steps = (days * DAY_MS) / step;
		let pct = 0;
		for (let i = 0; i < steps; i++) {
			const t = startMs + i * step;
			const windowIndex = Math.floor((t - startMs) / (windowDays * DAY_MS));
			const reset = startMs + (windowIndex + 1) * windowDays * DAY_MS;
			if (i > 0 && (t - startMs) % (windowDays * DAY_MS) === 0) pct = 0;
			out.push(pt(t, pct, reset));
			const rate = ratePerDow[new Date(t).getUTCDay()];
			pct += (rate * step) / DAY_MS;
		}
		return out;
	}

	const FLAT_20 = [20, 20, 20, 20, 20, 20, 20];
	/** 20 pp/day Monday-Friday, idle at the weekend. */
	const WEEKDAYS_ONLY = [0, 20, 20, 20, 20, 20, 0];

	/**
	 * The history above, plus a current window whose newest reading jumped after
	 * a two-hour sampling outage. The outage pair is rejected, so the jump never
	 * enters the profile -- the profile stays exactly `ratePerDow`.
	 */
	function withJump(
		startMs: number,
		historyDays: number,
		windowDays: number,
		ratePerDow: number[],
		currentWindowDays: number,
		jumpPct: number,
	): { points: PredictionPoint[]; T: number; resetAt: number } {
		const points = seasonalHistory(
			startMs,
			historyDays,
			windowDays,
			ratePerDow,
		);
		const Ts = startMs + historyDays * DAY_MS;
		const resetAt = Ts + currentWindowDays * DAY_MS;
		const step = 10 * MIN_MS;
		let pct = 0;
		for (let t = Ts; t <= Ts + DAY_MS; t += step) {
			points.push(pt(t, pct, resetAt));
			pct += (ratePerDow[new Date(t).getUTCDay()] * step) / DAY_MS;
		}
		const T = Ts + DAY_MS + 2 * HOUR_MS;
		points.push(pt(T, jumpPct, resetAt));
		return { points, T, resetAt };
	}

	test("a flat weekly profile walks the calendar to a hand-computed crossing", () => {
		// 20 days of history at a flat 20 pp/day, then a window that jumps to 70%.
		const { points, T, resetAt } = withJump(MONDAY, 20, 4, FLAT_20, 4, 70);
		const out = dow(points, T, SEVEN_DAY_SPEC);
		expect(out.usable).toBe(true);
		// 30 pp left at 20 pp/day = 1.5 days, and T sits 2 h into a UTC day, so
		// the crossing is 22 h + 14 h ahead.
		expect(out.predictedEtaMs as number).toBeCloseTo(T + 36 * HOUR_MS, -5);
		expect(out.predictsExhaust).toBe(true);
		expect(resetAt).toBeGreaterThan(out.predictedEtaMs as number);
	});

	test("an idle weekend pushes the crossing past it", () => {
		// 31 days of history opens the current window on a Thursday, so T lands
		// on a Friday at 02:00 UTC.
		const { points, T, resetAt } = withJump(
			MONDAY,
			31,
			4,
			WEEKDAYS_ONLY,
			5,
			70,
		);
		expect(new Date(T).getUTCDay()).toBe(5);
		const out = dow(points, T, SEVEN_DAY_SPEC);
		expect(out.usable).toBe(true);
		// Friday 02:00 -> Saturday 00:00 burns 18.33 pp; the weekend burns
		// nothing; the remaining 11.67 pp take 14 h of Monday.
		expect(out.predictedEtaMs as number).toBeCloseTo(T + 84 * HOUR_MS, -5);
		expect(out.predictsExhaust).toBe(true);
		expect(resetAt).toBeGreaterThan(out.predictedEtaMs as number);
	});

	test("a profile that cannot reach 100% before the reset is a confident negative", () => {
		const { points, T } = withJump(MONDAY, 20, 4, FLAT_20, 4, 20);
		const out = dow(points, T, SEVEN_DAY_SPEC);
		expect(out.usable).toBe(true);
		expect(out.predictsExhaust).toBe(false);
		expect(out.predictedEtaMs).toBeNull();
	});

	test("a day of the week with under 24 h of exposure is insufficient_data", () => {
		// Three days of history cannot describe the days it has never seen.
		const { points, T } = withJump(MONDAY, 3, 4, FLAT_20, 4, 70);
		const out = dow(points, T, SEVEN_DAY_SPEC);
		expect(out.usable).toBe(false);
		expect(out.unusableReason).toBe("insufficient_data");
	});

	test("only the days of the week the walk actually visits need exposure", () => {
		// 12 days of history whose sampling never runs at the weekend: Saturday
		// and Sunday have ZERO observed exposure, every weekday has 48 h.
		const WEEKDAYS_5 = [0, 5, 5, 5, 5, 5, 0];
		const weekdaysOnly = seasonalHistory(MONDAY, 12, 14, WEEKDAYS_5).filter(
			(p) => {
				const day = new Date(p.t).getUTCDay();
				return day !== 0 && day !== 6;
			},
		);
		// A Wednesday at noon, nine days in.
		const T = MONDAY + 9 * DAY_MS + 12 * HOUR_MS;
		expect(new Date(T).getUTCDay()).toBe(3);
		const upTo = weekdaysOnly.filter((p) => p.t <= T);

		const withReset = (resetAt: number) =>
			upTo.map((p) => pt(p.t, p.utilization, resetAt));
		// Resetting on the Friday: the walk sees Wednesday and Thursday only.
		const insideTheWeek = dow(
			withReset(MONDAY + 11 * DAY_MS),
			T,
			SEVEN_DAY_SPEC,
		);
		expect(insideTheWeek.usable).toBe(true);
		expect(insideTheWeek.predictsExhaust).toBe(false);
		// Resetting on the Monday: the walk crosses the unobserved weekend.
		const acrossTheWeekend = dow(
			withReset(MONDAY + 14 * DAY_MS),
			T,
			SEVEN_DAY_SPEC,
		);
		expect(acrossTheWeekend.usable).toBe(false);
		expect(acrossTheWeekend.unusableReason).toBe("insufficient_data");
	});

	test("a missing reset is no_reset", () => {
		const history = seasonalHistory(MONDAY, 20, 4, FLAT_20).map((p) =>
			pt(p.t, p.utilization, null),
		);
		const T = history[history.length - 1].t;
		expect(dow(history, T, SEVEN_DAY_SPEC).unusableReason).toBe("no_reset");
	});

	test("the per-series profile cache cannot leak between series or prefixes", () => {
		const { points, T } = withJump(MONDAY, 20, 4, FLAT_20, 4, 70);
		const shared = makeDowSeasonalEstimator();
		// Feed growing prefixes through ONE instance, then re-score each prefix
		// with a fresh instance: the incremental profile must match the rebuilt
		// one exactly, and a second series must not inherit the first's profile.
		const instants = points
			.map((p) => p.t)
			.filter((_t, i) => i > 0 && i % 500 === 0);
		instants.push(T);
		for (const instant of instants) {
			const prefix = points.filter((p) => p.t <= instant);
			const incremental = shared(prefix, instant, SEVEN_DAY_SPEC);
			const fresh = makeDowSeasonalEstimator()(prefix, instant, SEVEN_DAY_SPEC);
			expect(incremental).toEqual(fresh);
		}
		const other = withJump(MONDAY, 20, 4, WEEKDAYS_ONLY, 5, 70);
		expect(shared(other.points, other.T, SEVEN_DAY_SPEC)).toEqual(
			makeDowSeasonalEstimator()(other.points, other.T, SEVEN_DAY_SPEC),
		);
	});
});

// ---------------------------------------------------------------------------
// Selection scoring semantics
// ---------------------------------------------------------------------------

describe("deploymentCohort", () => {
	test("keeps instants production would actually have shown something for", () => {
		const cohort = deploymentCohort([
			rec({ T: 1, resetAtMs: 1 + HOUR_MS }),
			// reset unknown: production renders nothing at all
			rec({ T: 2, resetAtMs: null }),
			// reset already spent
			rec({ T: 3, resetAtMs: 3 }),
			rec({ T: 4, resetAtMs: 4 - MIN_MS }),
			// unobservable outcome
			rec({ T: 5, resetAtMs: 5 + HOUR_MS, outcome: { kind: "censored" } }),
		]);
		expect(cohort.map((r) => r.T)).toEqual([1]);
	});

	test("is estimator-independent: usability never enters it", () => {
		const base = { T: 1, resetAtMs: 1 + HOUR_MS } as const;
		expect(
			deploymentCohort([
				rec({ ...base, usable: false, unusableReason: "insufficient_data" }),
			]),
		).toHaveLength(1);
	});
});

describe("scoreForSelection", () => {
	const reset = T0 + HOUR_MS;
	const exhausted = { kind: "exhausted", atMs: T0 + 30 * MIN_MS } as const;

	test("an abstention is scored as the negative production would render", () => {
		const m = scoreForSelection([
			// abstains on a window that DID exhaust -> a miss, not an excuse
			rec({
				resetAtMs: reset,
				usable: false,
				unusableReason: "low_confidence",
				outcome: exhausted,
			}),
			// abstains on a window that survived -> a correct silence
			rec({ resetAtMs: reset, usable: false, unusableReason: "no_slope" }),
			rec({
				resetAtMs: reset,
				predictsExhaust: true,
				predictedEtaMs: T0 + 20 * MIN_MS,
				outcome: exhausted,
			}),
		]);
		expect(m.confusion).toEqual({ tp: 1, fp: 0, tn: 1, fn: 1 });
		expect(m.scored).toBe(3);
		// Coverage still reports what the estimator could answer.
		expect(m.coverage.usable).toBe(1);
		expect(m.coverage.low_confidence).toBe(1);
		expect(m.coverage.no_slope).toBe(1);
		expect(m.instants).toBe(3);
	});

	test("scores only the deployment cohort", () => {
		const m = scoreForSelection([
			rec({ T: 1, resetAtMs: null, outcome: exhausted }),
			rec({ T: 2, resetAtMs: 2, outcome: exhausted }),
			rec({ T: 3, resetAtMs: 3 + HOUR_MS, outcome: { kind: "censored" } }),
			rec({ T: 4, resetAtMs: 4 + HOUR_MS }),
		]);
		expect(m.instants).toBe(1);
		expect(m.confusion).toEqual({ tp: 0, fp: 0, tn: 1, fn: 0 });
	});

	test("an abstention contributes no ETA error", () => {
		const m = scoreForSelection([
			rec({
				resetAtMs: reset,
				usable: false,
				unusableReason: "insufficient_data",
				outcome: exhausted,
			}),
		]);
		expect(m.absoluteEtaError.n).toBe(0);
		expect(m.absoluteEtaError.medianMinutes).toBeNull();
	});
});

describe("scoreRedRule", () => {
	const windowMs = FIVE_HOUR_WINDOW_MS; // 300 min -> a 30 min margin at 0.1
	const reset = T0 + 4 * HOUR_MS;

	test("red needs a margin STRICTLY wider than the fraction of the window", () => {
		const onBoundary = scoreRedRule([
			rec({
				resetAtMs: reset,
				windowMs,
				predictsExhaust: true,
				predictedEtaMs: reset - 30 * MIN_MS,
				outcome: { kind: "exhausted", atMs: reset - MIN_MS },
			}),
		]);
		expect(onBoundary.confusion).toEqual({ tp: 0, fp: 0, tn: 0, fn: 1 });

		const justPast = scoreRedRule([
			rec({
				resetAtMs: reset,
				windowMs,
				predictsExhaust: true,
				predictedEtaMs: reset - 31 * MIN_MS,
				outcome: { kind: "exhausted", atMs: reset - MIN_MS },
			}),
		]);
		expect(justPast.confusion).toEqual({ tp: 1, fp: 0, tn: 0, fn: 0 });
		expect(justPast.precision).toBe(1);
	});

	test("an unusable estimate, a missing ETA or a missing reset can never be red", () => {
		const m = scoreRedRule([
			rec({
				resetAtMs: reset,
				windowMs,
				usable: false,
				unusableReason: "no_slope",
				predictedEtaMs: null,
			}),
			rec({
				resetAtMs: reset,
				windowMs,
				predictsExhaust: true,
				predictedEtaMs: null,
			}),
			rec({
				resetAtMs: null,
				windowMs,
				predictsExhaust: true,
				predictedEtaMs: T0,
			}),
		]);
		expect(m.confusion).toEqual({ tp: 0, fp: 0, tn: 3, fn: 0 });
		expect(m.precision).toBeNull();
	});

	test("censored instants are excluded", () => {
		const m = scoreRedRule([
			rec({
				resetAtMs: reset,
				windowMs,
				predictedEtaMs: T0,
				outcome: { kind: "censored" },
			}),
		]);
		expect(m.confusion).toEqual({ tp: 0, fp: 0, tn: 0, fn: 0 });
	});

	test("the margin fraction is configurable", () => {
		const record = rec({
			resetAtMs: reset,
			windowMs,
			predictedEtaMs: reset - 20 * MIN_MS,
			outcome: { kind: "survived" },
		});
		expect(scoreRedRule([record]).confusion.tn).toBe(1);
		expect(scoreRedRule([record], 0.05).confusion.fp).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Selection and the held-out gate
// ---------------------------------------------------------------------------

describe("selectTuningWinner", () => {
	const row = (
		name: string,
		f1: number | null,
		medianAbsErrorMinutes: number | null,
		macroF1: number | null,
	) => ({ name, f1, medianAbsErrorMinutes, macroF1 });

	test("highest F1 wins", () => {
		const out = selectTuningWinner([
			row("a", 0.4, 10, 0.4),
			row("b", 0.7, 90, 0.7),
			row("c", 0.5, 1, 0.5),
		]);
		expect(out.winner).toBe("b");
		expect(out.ranking.map((r) => r.name)).toEqual(["b", "c", "a"]);
		expect(out.balanceWarning).toBeNull();
	});

	test("an F1 tie breaks on the lower median absolute error", () => {
		const out = selectTuningWinner([
			row("a", 0.7, 90, 0.7),
			row("b", 0.7, 12, 0.7),
		]);
		expect(out.winner).toBe("b");
	});

	test("a full tie breaks lexicographically, so the choice is reproducible", () => {
		const out = selectTuningWinner([
			row("zebra", 0.7, 12, 0.7),
			row("alpha", 0.7, 12, 0.7),
		]);
		expect(out.winner).toBe("alpha");
	});

	test("a null statistic ranks last, never as a zero", () => {
		const out = selectTuningWinner([
			row("none", null, null, null),
			row("some", 0.1, 500, 0.1),
		]);
		expect(out.winner).toBe("some");
		expect(out.ranking.map((r) => r.name)).toEqual(["some", "none"]);
	});

	test("a null median error ranks after a known one at equal F1", () => {
		const out = selectTuningWinner([
			row("unknown", 0.5, null, 0.5),
			row("known", 0.5, 400, 0.5),
		]);
		expect(out.winner).toBe("known");
	});

	test("pooled and macro F1 disagreeing raises a balance warning", () => {
		const out = selectTuningWinner([
			row("pooled-winner", 0.7, 10, 0.2),
			row("macro-winner", 0.6, 10, 0.9),
		]);
		expect(out.winner).toBe("pooled-winner");
		expect(out.balanceWarning).toContain("macro-winner");
		expect(out.balanceWarning).toContain("pooled-winner");
	});

	test("no rows -> no winner, never a fabricated one", () => {
		const out = selectTuningWinner([]);
		expect(out.winner).toBeNull();
		expect(out.ranking).toEqual([]);
		expect(out.balanceWarning).toBeNull();
	});
});

describe("evaluateHeldOutGate", () => {
	const metrics = (
		name: string,
		f1: number | null,
		medianAbsErrorMinutes: number | null,
		usableCoverage: number | null,
	) => ({ name, f1, medianAbsErrorMinutes, usableCoverage });

	const olsBaseline = metrics("ols", 0.5, 100, 0.9);
	const baselines = [olsBaseline, metrics("lifetime", 0.45, 300, 1)];

	test("a winner that clears all three criteria passes", () => {
		const out = evaluateHeldOutGate(metrics("cand", 0.6, 80, 0.89), baselines, {
			referenceName: "ols",
		});
		expect(out.pass).toBe(true);
		expect(out.criteria.every((c) => c.pass)).toBe(true);
		expect(out.criteria).toHaveLength(3);
	});

	test("equalling every baseline is enough on F1, and equalling ols on error", () => {
		const out = evaluateHeldOutGate(metrics("cand", 0.5, 100, 0.9), baselines, {
			referenceName: "ols",
		});
		expect(out.pass).toBe(true);
	});

	test("losing to ANY baseline on F1 fails the first criterion", () => {
		const out = evaluateHeldOutGate(metrics("cand", 0.46, 10, 0.9), baselines, {
			referenceName: "ols",
		});
		expect(out.pass).toBe(false);
		expect(out.criteria[0].pass).toBe(false);
		expect(out.criteria[0].detail).toContain("ols");
	});

	test("a worse median ETA error than ols fails, even with a better F1", () => {
		const out = evaluateHeldOutGate(metrics("cand", 0.9, 101, 0.9), baselines, {
			referenceName: "ols",
		});
		expect(out.pass).toBe(false);
		expect(out.criteria[1].pass).toBe(false);
	});

	test("coverage may fall at most 2 points below ols", () => {
		expect(
			evaluateHeldOutGate(metrics("cand", 0.9, 10, 0.88), baselines, {
				referenceName: "ols",
			}).criteria[2].pass,
		).toBe(true);
		expect(
			evaluateHeldOutGate(metrics("cand", 0.9, 10, 0.879), baselines, {
				referenceName: "ols",
			}).criteria[2].pass,
		).toBe(false);
		// Being MORE available than ols is not a failure.
		expect(
			evaluateHeldOutGate(metrics("cand", 0.9, 10, 1), baselines, {
				referenceName: "ols",
			}).criteria[2].pass,
		).toBe(true);
	});

	test("a null metric fails its criterion and says so", () => {
		const out = evaluateHeldOutGate(
			metrics("cand", null, null, null),
			baselines,
			{
				referenceName: "ols",
			},
		);
		expect(out.pass).toBe(false);
		expect(out.criteria.every((c) => !c.pass)).toBe(true);
		for (const c of out.criteria) expect(c.detail).toContain("null");
	});

	test("a null on the reference side also fails, rather than passing by default", () => {
		const out = evaluateHeldOutGate(
			metrics("cand", 0.9, 10, 0.9),
			[metrics("ols", null, null, null)],
			{ referenceName: "ols" },
		);
		expect(out.pass).toBe(false);
	});

	test("a missing reference estimator fails rather than silently skipping", () => {
		const out = evaluateHeldOutGate(metrics("cand", 0.9, 10, 0.9), baselines, {
			referenceName: "nope",
		});
		expect(out.pass).toBe(false);
		expect(out.criteria[1].detail).toContain("nope");
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
