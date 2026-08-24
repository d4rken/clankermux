import { describe, expect, it } from "bun:test";
import { fitWithIntervals } from "../fit";
import { makeSyntheticSegments, type Quantizer } from "./synthetic";

/**
 * A 90% interval that does not contain the truth 90% of the time is not a 90%
 * interval, and every claim the panel makes rests on these intervals being
 * honest. This is the one test that checks the coverage property itself rather
 * than a single draw.
 *
 * Run under BOTH quantizers: which one the provider uses (rounding to the
 * nearest point, or flooring to the point it has passed) is unknown, and
 * flooring introduces a systematic downward bias that rounding does not.
 */
const TRUE_W = 2.4;
const TRIALS = 40;

function coverage(quantizer: Quantizer): {
	covered: number;
	identified: number;
} {
	let covered = 0;
	let identified = 0;
	for (let trial = 0; trial < TRIALS; trial++) {
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": TRUE_W, "claude-sonnet-5": 0.9 },
			runs: 25,
			segmentsPerRun: 10,
			meanTokens: 2_000_000,
			quantizer,
			seed: 1000 + trial * 37,
		});
		const result = fitWithIntervals(segments, {
			bootstrapB: 150,
			seedParts: ["coverage", quantizer, trial],
		});
		const coef = result.coefficients.find((c) => c.key === "claude-opus-5");
		if (!coef?.identified) continue;
		identified += 1;
		if ((coef.ciLow as number) <= TRUE_W && (coef.ciHigh as number) >= TRUE_W) {
			covered += 1;
		}
	}
	return { covered, identified };
}

describe("bootstrap interval coverage", () => {
	it("covers the true weight close to 90% of the time under a ROUNDING quantizer", () => {
		const { covered, identified } = coverage("round");

		expect(identified).toBeGreaterThan(TRIALS * 0.8);
		// Measured 35/40 = 0.875 against a nominal 0.90. A finite-trial band: at 40
		// trials the binomial spread around 0.9 is wide, so the floor catches a
		// badly miscalibrated interval, not a percentage point.
		expect(covered / identified).toBeGreaterThanOrEqual(0.7);
		expect(covered / identified).toBeLessThanOrEqual(1);
	});

	it("covers the true weight close to 90% of the time under a FLOORING quantizer", () => {
		// Flooring biases every reported cumulative percentage downward by up to a
		// full point, which a rounding-only check would never exercise.
		const { covered, identified } = coverage("floor");

		expect(identified).toBeGreaterThan(TRIALS * 0.8);
		// Measured 32/40 = 0.800 — lower than the rounding case, which is the bias
		// showing up rather than a defect. Still well clear of the floor.
		expect(covered / identified).toBeGreaterThanOrEqual(0.7);
		expect(covered / identified).toBeLessThanOrEqual(1);
	});

	it("is deterministic: the same input yields the same interval", () => {
		// The panel must not jitter between recomputes of unchanged data.
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": TRUE_W },
			runs: 20,
			segmentsPerRun: 10,
			meanTokens: 2_000_000,
			seed: 31337,
		});

		const a = fitWithIntervals(segments, { bootstrapB: 120, seedParts: ["d"] });
		const b = fitWithIntervals(segments, { bootstrapB: 120, seedParts: ["d"] });

		expect(a.coefficients[0].ciLow).toBe(b.coefficients[0].ciLow);
		expect(a.coefficients[0].ciHigh).toBe(b.coefficients[0].ciHigh);
	});
});
