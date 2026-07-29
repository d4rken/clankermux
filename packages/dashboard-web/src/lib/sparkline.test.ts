import { describe, expect, it } from "bun:test";
import { buildSparklinePath } from "./sparkline";

describe("buildSparklinePath", () => {
	it("returns an empty path for no values", () => {
		expect(buildSparklinePath([], 100, 24)).toBe("");
	});

	it("returns an empty path for a single value", () => {
		// One point has no horizontal extent — there is no line to draw.
		expect(buildSparklinePath([420], 100, 24)).toBe("");
	});

	it("pins a flat series to the vertical midpoint", () => {
		// An idle proxy's RSS barely moves, so identical values are the normal
		// case. Without the span guard this divides by zero and emits NaN.
		const d = buildSparklinePath([500, 500, 500], 100, 24);

		expect(d).toBe("M0 12 L50 12 L100 12");
		expect(d).not.toContain("NaN");
	});

	it("maps the extremes to the full viewBox height, max at the top", () => {
		const d = buildSparklinePath([100, 200], 100, 24);

		// y is inverted: the minimum sits on the baseline, the maximum at y=0.
		expect(d).toBe("M0 24 L100 0");
	});

	it("spaces points evenly across the width", () => {
		const d = buildSparklinePath([0, 1, 0, 1, 0], 100, 10);

		expect(d).toBe("M0 10 L25 0 L50 10 L75 0 L100 10");
	});

	it("drops non-finite entries instead of emitting NaN", () => {
		const d = buildSparklinePath(
			[100, Number.NaN, 200, Number.POSITIVE_INFINITY],
			100,
			24,
		);

		expect(d).not.toContain("NaN");
		expect(d).not.toContain("Infinity");
		// Only the two finite readings survive, so they span the full width.
		expect(d).toBe("M0 24 L100 0");
	});

	it("still draws when dropping non-finite entries leaves a flat series", () => {
		const d = buildSparklinePath([Number.NaN, 300, 300], 100, 24);

		expect(d).toBe("M0 12 L100 12");
	});

	it("rounds coordinates rather than emitting full float precision", () => {
		const d = buildSparklinePath([0, 1, 2], 10, 3);

		expect(d).toBe("M0 3 L5 1.5 L10 0");
	});
});
