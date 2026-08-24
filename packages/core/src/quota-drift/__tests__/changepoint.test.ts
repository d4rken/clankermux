import { describe, expect, it } from "bun:test";
import { detectChanges, normalQuantile } from "../changepoint";
import { mulberry32 } from "../fit";
import type { QuotaSegment } from "../types";
import { DAY_MS, makeSyntheticSegments, type Quantizer } from "./synthetic";

const HOUR = 60 * 60 * 1000;
const START = 1_760_000_000_000;

/**
 * `segmentsPerRun` hourly segments per run means one run per day, so `days` runs
 * spans `days` days — the shape the real series has (one monotone run per 5h
 * window instance, several a day, tiled across the history).
 */
function series(opts: {
	days: number;
	weights: Record<string, number>;
	stepAtMs?: number;
	stepWeights?: Record<string, number>;
	seed: number;
	accountIds?: readonly string[];
	quantizer?: Quantizer;
	fixedRatios?: Record<string, number>;
}) {
	return makeSyntheticSegments({
		weights: opts.weights,
		stepAtMs: opts.stepAtMs,
		stepWeights: opts.stepWeights,
		runs: opts.days,
		segmentsPerRun: 23, // 23h of segments + a 1h inter-run gap == one day
		segmentMs: HOUR,
		meanTokens: 2_000_000,
		startMs: START,
		seed: opts.seed,
		accountIds: opts.accountIds,
		quantizer: opts.quantizer,
		fixedRatios: opts.fixedRatios,
	});
}

describe("changepoint detection", () => {
	it("reports no change on a flat series (the over-firing guard)", () => {
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			seed: 2024,
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["flat"],
			maxDepth: 1,
		});

		expect(result.changes).toEqual([]);
		expect(result.verdict).toBe("no-change-detected");
	});

	it("finds exactly one change on a stepped series", () => {
		const boundary = START + 40 * DAY_MS;
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			stepAtMs: boundary,
			stepWeights: { "claude-opus-5": 1.2, "claude-sonnet-5": 0.9 },
			seed: 4711,
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["stepped"],
			maxDepth: 1,
		});

		expect(result.verdict).toBe("changed");
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].direction).toBe("cheaper");
		expect(
			Math.abs(result.changes[0].boundaryMs - boundary),
		).toBeLessThanOrEqual(3 * DAY_MS);
	});

	it("produces a usable verdict on ~82 days of history, not a structural insufficiency", () => {
		// Regression for the design this replaced: comparing non-overlapping 14-day
		// blocks with four required per side needs 112 days, so it could never fire
		// on the ~82 days that exist. An unfireable test reports "no change"
		// forever and is indistinguishable from a working one.
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			seed: 8282,
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 100,
			seedParts: ["82d"],
			maxDepth: 1,
		});

		expect(result.verdict).not.toBe("insufficient-evidence");
		expect(result.nCandidates).toBeGreaterThan(0);
	});

	it("reports insufficient-evidence, never stable, when there is too little history", () => {
		// `stable` is a claim that the test ran and found nothing. An underpowered
		// scan has established no such thing.
		const segments = series({
			days: 6,
			weights: { "claude-opus-5": 2.4 },
			seed: 606,
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 50,
			seedParts: ["short"],
			maxDepth: 1,
		});

		expect(result.verdict).toBe("insufficient-evidence");
		expect(result.changes).toEqual([]);
	});

	it("does not fire on pure noise across many seeds", () => {
		// The Bonferroni adjustment is what stops a ~70-candidate scan from
		// manufacturing a finding at a nominal 5%.
		let fired = 0;
		for (let seed = 0; seed < 8; seed++) {
			const segments = series({
				days: 82,
				weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
				seed: 90_000 + seed * 131,
			});
			const result = detectChanges(segments, "claude-opus-5", {
				bootstrapB: 100,
				seedParts: ["noise", seed],
				maxDepth: 1,
			});
			if (result.verdict === "changed") fired += 1;
		}
		expect(fired).toBe(0);
	});

	it("never attributes a difference across a boundary the two sides do not share", () => {
		// A cohort whose entire membership turned over at the boundary changed
		// composition; the difference there is not the provider's doing, and with
		// no account on both sides there is no like-for-like comparison to make.
		// Such a date is not a candidate AT ALL — it cannot be selected, scored or
		// reported.
		//
		// The verdict is `insufficient-evidence`, not `stable`. The turnover leaves
		// an INTERNAL hole in the candidate grid: dates before and after it are
		// scanned, but no account bridges the middle, so a step AT the turnover is
		// unidentifiable and the comparisons on either side establish nothing
		// across it. That is unlike the `minSideDays` exclusions at each END of
		// history, which trim the examined span but leave what remains connected.
		const boundary = START + 40 * DAY_MS;
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			stepAtMs: boundary,
			stepWeights: { "claude-opus-5": 1.2, "claude-sonnet-5": 0.9 },
			seed: 4711,
		}).map((s) =>
			// Everything after the boundary comes from a second account only.
			s.t0 >= boundary ? { ...s, accountId: "acct-b" } : s,
		);

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 100,
			seedParts: ["composition"],
			maxDepth: 1,
		});

		expect(result.changes).toEqual([]);
		expect(result.verdict).toBe("insufficient-evidence");
		// Comparisons really did run outside the hole: every scanned date sits
		// inside one account's own history, and the twenty-day stretch around the
		// turnover offers no shared account, so it is absent from the candidate set
		// and the Bonferroni divisor never counts it either.
		expect(result.nCandidates).toBe(42);
	});

	it("records the adjusted level it cleared", () => {
		const boundary = START + 40 * DAY_MS;
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			stepAtMs: boundary,
			stepWeights: { "claude-opus-5": 1.2, "claude-sonnet-5": 0.9 },
			seed: 4711,
		});

		const change = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["stepped"],
			maxDepth: 1,
		}).changes[0];

		expect(change.nCandidates).toBeGreaterThan(1);
		expect(change.adjustedLevel).toBeCloseTo(0.05 / change.nCandidates, 12);
	});

	it("finds a step even when an account joined the pool mid-history", () => {
		// The confound guard this replaced required the two account sets to be
		// IDENTICAL across the split. On the live pool two accounts joined
		// mid-history, so every one of the 62 candidate splits differed and no
		// model could ever reach a verdict. Restricting both sides to the SHARED
		// accounts keeps the comparison like-for-like and lets the scan run.
		const boundary = START + 40 * DAY_MS;
		const joinsAtDay = 55;
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			stepAtMs: boundary,
			stepWeights: { "claude-opus-5": 1.2, "claude-sonnet-5": 0.9 },
			seed: 4711,
		}).map((s) => {
			// Each run is one day, so a whole run moves to the new account at once.
			const day = Math.floor((s.t0 - START) / DAY_MS);
			return day >= joinsAtDay && day % 2 === 1
				? { ...s, accountId: "acct-b", runId: `${s.runId}:b` }
				: s;
		});

		// The scenario really is the one the equality guard rejected: the account
		// set before the planted boundary is a strict subset of the one after it.
		const accountsBefore = segments
			.filter((s) => s.t1 <= boundary)
			.map((s) => s.accountId);
		const accountsAfter = segments
			.filter((s) => s.t0 >= boundary)
			.map((s) => s.accountId);
		expect([...new Set(accountsBefore)].sort()).toEqual(["acct-a"]);
		expect([...new Set(accountsAfter)].sort()).toEqual(["acct-a", "acct-b"]);

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["joined"],
			maxDepth: 1,
		});

		expect(result.verdict).toBe("changed");
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].direction).toBe("cheaper");
		expect(
			Math.abs(result.changes[0].boundaryMs - boundary),
		).toBeLessThanOrEqual(3 * DAY_MS);
	});

	it("restricts to the shared accounts BEFORE choosing the boundary", () => {
		// Restricting only AFTER the argmax measures a different dataset than it
		// selected on. A transient account is enough to break it: its arrival is a
		// composition change, so the unrestricted difference at that date is large
		// and wins the scan, and the genuine step is never even scored.
		const boundary = START + 15 * DAY_MS;
		const base = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			stepAtMs: boundary,
			stepWeights: { "claude-opus-5": 1.9, "claude-sonnet-5": 0.9 },
			seed: 4711,
		});

		// The control: one account, planted step, correctly found.
		const alone = detectChanges(base, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["f11-control"],
			maxDepth: 1,
		});
		expect(alone.verdict).toBe("changed");
		expect(
			Math.abs(alone.changes[0].boundaryMs - boundary),
		).toBeLessThanOrEqual(3 * DAY_MS);

		// A second account appears for ONE 23-hour run on day 50, an order of
		// magnitude more expensive. It shares no boundary with the planted step.
		const transient = makeSyntheticSegments({
			weights: { "claude-opus-5": 20, "claude-sonnet-5": 0.9 },
			runs: 1,
			segmentsPerRun: 23,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			startMs: START + 50 * DAY_MS,
			seed: 6011,
			accountIds: ["acct-transient"],
		});
		const withTransient = [...base, ...transient].sort((a, b) => a.t0 - b.t0);

		const result = detectChanges(withTransient, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["f11"],
			maxDepth: 1,
		});

		// The transient account is on ONE side of every boundary, so it is never
		// shared and never enters the comparison. The verdict must be the control's.
		expect(result.verdict).toBe("changed");
		expect(result.changes).toHaveLength(1);
		expect(
			Math.abs(result.changes[0].boundaryMs - boundary),
		).toBeLessThanOrEqual(3 * DAY_MS);
		// The counts are the RESTRICTED ones, and they cleared the floors the
		// candidate was admitted on rather than merely the unrestricted ones.
		expect(result.changes[0].nSegmentsBefore).toBeGreaterThanOrEqual(50);
		expect(result.changes[0].nSegmentsAfter).toBeGreaterThanOrEqual(50);
	});

	it("reports insufficient-evidence when neither side can identify the key", () => {
		// `stable` is a claim that the comparison RAN. Two perfectly collinear
		// models never identify a coefficient on either side of any boundary, so
		// nothing was ever compared, however many candidates the grid offered.
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			seed: 3131,
			fixedRatios: { "claude-opus-5": 1, "claude-sonnet-5": 0.6 },
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 100,
			seedParts: ["collinear"],
			maxDepth: 1,
		});

		expect(result.nCandidates).toBeGreaterThan(0);
		expect(result.verdict).toBe("insufficient-evidence");
		expect(result.changes).toEqual([]);
	});

	it("refuses a step whose difference bootstrap redrew the same dataset every time", () => {
		// Two identical runs per side, and dpct generated EXACTLY from the weights,
		// so every run-block resample rebuilds the same rows and all 1000 draws of
		// the difference are bit-identical. There is a large, perfectly clean step
		// here and the scan must still decline: with no measured spread the
		// interval has zero width and excludes zero for free.
		//
		// The guard cannot be written on the spread. Summing 1000 identical values
		// and dividing recovers a mean a few ulps off the value, so a two-pass
		// deviation squares that rounding into ~1e-15 of "variance" and passes.
		const segments = exactLinearRunSeries({
			beforeWeight: 2.4,
			afterWeight: 1.2,
			seed: 1301,
			sharedPattern: true,
		});
		const runs = new Set(segments.map((s) => s.runId));
		expect(runs.size).toBe(4);

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 1000,
			seedParts: ["degenerate"],
			maxDepth: 1,
		});

		expect(result.changes).toEqual([]);
		// NOT `stable`: nothing was established about the difference, because the
		// comparison never acquired an uncertainty to judge it against.
		expect(result.verdict).toBe("insufficient-evidence");
		expect(result.nCandidates).toBeGreaterThan(0);
	});

	it("refuses a step whose difference bootstrap varied only by solver noise", () => {
		// The near-degenerate case, which neither of the guards this replaced can
		// see. The runs are DISTINCT, so the resamples genuinely rebuild different
		// datasets and the draws are not bit-identical — but `dpct` is generated
		// exactly as the weighted sum, so every one of those datasets is solved by
		// the same coefficients and the draws differ only in the last bits of the
		// solve. Measured here: 16 distinct values across 1000 resamples, standard
		// deviation 5.4e-15 against a coefficient scale of 1.8.
		//
		// A spread that small is not uncertainty, and a 1.2-versus-2.4 difference
		// judged against it clears the interval by more than ten orders of
		// magnitude. The scan must decline, as it does on the bit-identical case.
		const segments = exactLinearRunSeries({
			beforeWeight: 2.4,
			afterWeight: 1.2,
			seed: 2602,
			sharedPattern: false,
		});
		const runs = new Set(segments.map((s) => s.runId));
		expect(runs.size).toBe(4);
		// The runs really do differ, so a guard written on draw equality passes.
		const firstRun = segments.filter((s) => s.runId === "exact-linear:0");
		const secondRun = segments.filter((s) => s.runId === "exact-linear:1");
		expect(firstRun.map((s) => s.dpct)).not.toEqual(
			secondRun.map((s) => s.dpct),
		);

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 1000,
			seedParts: ["near-degenerate"],
			maxDepth: 1,
		});

		expect(result.changes).toEqual([]);
		expect(result.verdict).toBe("insufficient-evidence");
		expect(result.nCandidates).toBeGreaterThan(0);
	});

	it("still selects a boundary on an exactly flat series and calls it stable", () => {
		// Un-quantized, so the fit is exact and every candidate scores exactly 0.
		// A scan that only accepted a score strictly above 0 would select no
		// boundary at all here, and would have to report "could not evaluate" for
		// a series it measured perfectly.
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			seed: 5150,
			quantizer: "none",
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 100,
			seedParts: ["exact-flat"],
			maxDepth: 1,
		});

		expect(result.verdict).toBe("no-change-detected");
		expect(result.changes).toEqual([]);
	});
});

describe("normalQuantile", () => {
	it("matches the standard normal quantiles", () => {
		expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
		expect(normalQuantile(0.95)).toBeCloseTo(1.6448536269514722, 7);
		expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 7);
		expect(normalQuantile(0.995)).toBeCloseTo(2.575829303548901, 7);
		// The tail branch, which is where a Bonferroni-adjusted level lands.
		expect(normalQuantile(0.999)).toBeCloseTo(3.090232306167813, 7);
		expect(normalQuantile(1 - 0.05 / 61 / 2)).toBeCloseTo(3.3462, 3);
	});

	it("is symmetric about the median and undefined outside (0, 1)", () => {
		for (const p of [0.01, 0.2, 0.4, 0.6, 0.8, 0.99]) {
			expect(normalQuantile(p)).toBeCloseTo(-normalQuantile(1 - p), 9);
		}
		for (const p of [0, 1, -0.1, 1.1, Number.NaN]) {
			expect(Number.isNaN(normalQuantile(p))).toBe(true);
		}
	});
});

/** Segments per run in {@link exactLinearRunSeries}: 48 x 3h == exactly 6 days. */
const EXACT_RUN_SEGMENTS = 48;
const EXACT_SEGMENT_MS = 3 * HOUR;
/** Runs start a whole week apart, so grid dates land in the inter-run gaps. */
const EXACT_RUN_STRIDE_MS = 7 * DAY_MS;

/**
 * Four runs of ONE account — two before a step, two after — in which `dpct` is
 * generated exactly as `Σ w · Mtok` with no quantization, so every subset of the
 * rows is solved by the same coefficients.
 *
 * The point is a bootstrap that measures nothing, not a realistic series, and
 * `sharedPattern` picks which flavour of that:
 *
 * - `true`: all four runs carry the identical exposure pattern, so drawing runs
 *   with replacement rebuilds the same row sequence whatever it draws and every
 *   resampled difference is bit-identical.
 * - `false`: each run gets its own pattern, so the resamples really are
 *   different datasets and the draws differ — but only in the last bits of the
 *   solve, because the exact-linear rows pin the coefficients regardless.
 *
 * Each side holds two distinct run ids either way, so the per-side interval gate
 * does not intercept the case before the difference bootstrap is reached.
 */
function exactLinearRunSeries(opts: {
	beforeWeight: number;
	afterWeight: number;
	seed: number;
	sharedPattern: boolean;
}): QuotaSegment[] {
	const rand = mulberry32(opts.seed);
	const drawPattern = () =>
		Array.from({ length: EXACT_RUN_SEGMENTS }, () => ({
			"claude-opus-5": 2_000_000 * (0.2 + 1.6 * rand()),
			"claude-sonnet-5": 2_000_000 * (0.2 + 1.6 * rand()),
		}));
	const shared = opts.sharedPattern ? drawPattern() : null;

	const segments: QuotaSegment[] = [];
	for (let run = 0; run < 4; run++) {
		const pattern = shared ?? drawPattern();
		const opus = run < 2 ? opts.beforeWeight : opts.afterWeight;
		const runStart = START + run * EXACT_RUN_STRIDE_MS;
		for (let i = 0; i < EXACT_RUN_SEGMENTS; i++) {
			const tokens = pattern[i];
			segments.push({
				runId: `exact-linear:${run}`,
				accountId: "acct-a",
				t0: runStart + i * EXACT_SEGMENT_MS,
				t1: runStart + (i + 1) * EXACT_SEGMENT_MS,
				dpct:
					(opus * tokens["claude-opus-5"]) / 1e6 +
					(0.9 * tokens["claude-sonnet-5"]) / 1e6,
				eqTokensByModel: { ...tokens },
			});
		}
	}
	return segments;
}
