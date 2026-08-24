import { describe, expect, it } from "bun:test";
import {
	buildFitInput,
	columnTolerances,
	fitWithIntervals,
	selectKeys,
} from "../fit";
import { makeSyntheticSegments } from "./synthetic";

/**
 * The failure mode the tolerance criterion exists for.
 *
 * When two high-volume models always run in a fixed ratio, share, segment count
 * and even the bootstrap interval all look healthy while the individual
 * coefficients are not separately identified at all: resampling preserves the
 * collinearity, so the interval is narrow around an arbitrary split of a sum.
 * Narrow intervals alone must therefore NOT be enough to pass the gate.
 */
describe("collinear exposure columns", () => {
	const weights = { "claude-opus-5": 2.0, "claude-sonnet-5": 1.0 };

	function collinearSegments() {
		return makeSyntheticSegments({
			weights,
			runs: 40,
			segmentsPerRun: 12,
			meanTokens: 2_000_000,
			// Every segment uses the two models in a FIXED 1 : 0.6 ratio.
			fixedRatios: { "claude-opus-5": 1, "claude-sonnet-5": 0.6 },
			seed: 5150,
		});
	}

	it("both models clear the share and segment-count floors", () => {
		const segments = collinearSegments();
		const keys = selectKeys(segments);

		expect(keys).toContain("claude-opus-5");
		expect(keys).toContain("claude-sonnet-5");
		expect(segments.length).toBeGreaterThanOrEqual(20);
	});

	it("reports near-zero tolerance for both columns", () => {
		const segments = collinearSegments();
		const keys = selectKeys(segments);
		const tolerances = columnTolerances(buildFitInput(segments, keys));

		for (const t of tolerances) expect(t).toBeLessThan(0.1);
	});

	it("marks BOTH as unidentified even though the intervals are narrow", () => {
		const segments = collinearSegments();

		const result = fitWithIntervals(segments, {
			bootstrapB: 200,
			seedParts: ["collinear"],
		});

		const opus = result.coefficients.find((c) => c.key === "claude-opus-5");
		const sonnet = result.coefficients.find((c) => c.key === "claude-sonnet-5");

		expect(opus?.identified).toBe(false);
		expect(sonnet?.identified).toBe(false);
		expect(opus?.unidentifiedReasons).toContain("collinear");
		expect(sonnet?.unidentifiedReasons).toContain("collinear");

		// Unidentified means a GAP, never a number.
		expect(opus?.pointEstimate).toBeNull();
		expect(opus?.ciLow).toBeNull();
		expect(opus?.ciHigh).toBeNull();
		expect(opus?.impliedCapacityMtok).toBeNull();
	});

	it("identifies the same two models once their ratio varies", () => {
		// The control: nothing about the models changed, only whether their
		// exposures move independently.
		const segments = makeSyntheticSegments({
			weights,
			runs: 40,
			segmentsPerRun: 12,
			meanTokens: 2_000_000,
			seed: 5150,
		});

		const result = fitWithIntervals(segments, {
			bootstrapB: 200,
			seedParts: ["independent"],
		});

		for (const key of Object.keys(weights)) {
			const coef = result.coefficients.find((c) => c.key === key);
			expect(coef?.identified).toBe(true);
			expect(coef?.tolerance).toBeGreaterThanOrEqual(0.1);
		}
	});
});
