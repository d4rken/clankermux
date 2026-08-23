import { describe, expect, it } from "bun:test";
import { detectChanges, normalQuantile } from "../changepoint";
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
		expect(result.verdict).toBe("stable");
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

	it("refuses to attribute a difference when the two sides share no account", () => {
		// A cohort whose entire membership turned over at the boundary changed
		// composition; the difference is not the provider's doing, and with no
		// account on both sides there is no like-for-like comparison to make.
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

		expect(result.verdict).toBe("stable");
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
