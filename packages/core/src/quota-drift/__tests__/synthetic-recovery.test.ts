import { describe, expect, it } from "bun:test";
import { detectChanges } from "../changepoint";
import { fitWithIntervals } from "../fit";
import { DAY_MS, makeSyntheticSegments } from "./synthetic";

const HOUR = 60 * 60 * 1000;

describe("recovery from known weights", () => {
	it("recovers each weight inside its interval under 1pp quantization", () => {
		const weights = { "claude-opus-5": 2.4, "claude-sonnet-5": 0.8 };
		// Sized so each segment moves the window by several points, as a 1h anchor
		// bucket on a 5h window does in practice. With Δ this far above the 1pp
		// quantization step, the rounding is a small perturbation rather than the
		// dominant term.
		const segments = makeSyntheticSegments({
			weights,
			runs: 30,
			segmentsPerRun: 12,
			meanTokens: 2_000_000,
			seed: 12345,
		});

		const result = fitWithIntervals(segments, {
			bootstrapB: 200,
			seedParts: ["recovery"],
		});

		for (const [key, truth] of Object.entries(weights)) {
			const coef = result.coefficients.find((c) => c.key === key);
			expect(coef?.identified).toBe(true);
			expect(coef?.ciLow).toBeLessThanOrEqual(truth);
			expect(coef?.ciHigh).toBeGreaterThanOrEqual(truth);
			expect(coef?.pointEstimate).toBeCloseTo(truth, 0);
		}
		expect(result.r2).toBeGreaterThan(0.9);
	});

	it("reports the implied full-window capacity as 100 / w", () => {
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": 2 },
			runs: 30,
			segmentsPerRun: 12,
			meanTokens: 2_000_000,
			seed: 777,
		});

		const coef = fitWithIntervals(segments, { bootstrapB: 150 })
			.coefficients[0];

		expect(coef.identified).toBe(true);
		expect(coef.impliedCapacityMtok).toBeCloseTo(
			100 / (coef.pointEstimate as number),
			9,
		);
	});

	it("reports a model with too little traffic as unidentified, never as a number", () => {
		// The rare model is pooled into `other` by the share threshold, so it never
		// gets a column of its own — the panel shows a gap, not a fabricated value.
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 30,
			segmentsPerRun: 12,
			meanTokens: 2_000_000,
			seed: 4242,
		});
		// Sprinkle a trace of a second model well under the 2% share floor.
		const withRare = segments.map((s, i) => ({
			...s,
			eqTokensByModel:
				i % 10 === 0
					? { ...s.eqTokensByModel, "claude-haiku-4-5": 500 }
					: s.eqTokensByModel,
		}));

		const result = fitWithIntervals(withRare, { bootstrapB: 150 });

		const rare = result.coefficients.find((c) => c.key === "claude-haiku-4-5");
		expect(rare).toBeUndefined();
		expect(result.coefficients.map((c) => c.key)).toContain("other");
	});

	it("finds a planted step change at the right boundary, direction and magnitude", () => {
		const start = 1_760_000_000_000;
		const boundary = start + 40 * DAY_MS;
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.8 },
			stepAtMs: boundary,
			stepWeights: { "claude-opus-5": 1.2, "claude-sonnet-5": 0.8 },
			runs: 80,
			segmentsPerRun: 24,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			startMs: start,
			seed: 99,
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["planted"],
			maxDepth: 1,
		});

		expect(result.verdict).toBe("changed");
		expect(result.changes).toHaveLength(1);
		const change = result.changes[0];
		expect(change.direction).toBe("cheaper");
		// Halving the weight is a -50% relative change.
		expect(change.relativeChange).toBeCloseTo(-0.5, 1);
		// The boundary lands within a couple of days of the plant. Candidates sit on
		// a daily grid and the score is a noisy statistic, so exact recovery is not
		// the claim; localising an 80-day series to within ~2 days is.
		expect(Math.abs(change.boundaryMs - boundary)).toBeLessThanOrEqual(
			2 * DAY_MS,
		);
	});
});
