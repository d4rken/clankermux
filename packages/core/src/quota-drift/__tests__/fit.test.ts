import { describe, expect, it } from "bun:test";
import {
	fitRolling,
	fitWithIntervals,
	MIN_SEGMENTS_FOR_FIT,
	selectKeys,
	shareByKey,
	zeroTokenDeltaShare,
} from "../fit";
import type { QuotaSegment } from "../types";
import { DAY_MS, makeSyntheticSegments } from "./synthetic";

const HOUR = 60 * 60 * 1000;
const START = 1_760_000_000_000;

function segment(over: Partial<QuotaSegment>): QuotaSegment {
	return {
		runId: "r1",
		accountId: "acct-a",
		t0: START,
		t1: START + HOUR,
		dpct: 1,
		eqTokensByModel: {},
		...over,
	};
}

describe("selectKeys", () => {
	it("pools models below the share floor into `other` rather than dropping them", () => {
		// Dropping the tail would remove exposure that really did consume the
		// window, and the fit would push that consumption onto whatever co-occurred
		// with it.
		const segments = [
			segment({
				eqTokensByModel: { big: 1_000_000, tiny: 5_000 },
			}),
		];

		expect(selectKeys(segments)).toEqual(["big", "other"]);
	});

	it("returns no keys when nothing was observed", () => {
		expect(selectKeys([segment({})])).toEqual([]);
	});
});

describe("shareByKey", () => {
	it("folds unselected models into the `other` share", () => {
		const segments = [
			segment({ eqTokensByModel: { big: 900_000, tiny: 100_000 } }),
		];

		const shares = shareByKey(segments, ["big", "other"]);

		expect(shares.get("big")).toBeCloseTo(0.9, 9);
		expect(shares.get("other")).toBeCloseTo(0.1, 9);
	});
});

describe("zeroTokenDeltaShare", () => {
	it("is the share of positive Δpct that landed in zero-token segments", () => {
		const segments = [
			segment({ dpct: 3, eqTokensByModel: { m: 1_000_000 } }),
			segment({ dpct: 1, eqTokensByModel: {} }),
		];

		expect(zeroTokenDeltaShare(segments)).toBeCloseTo(0.25, 9);
	});

	it("is 0 when nothing moved, rather than NaN", () => {
		expect(zeroTokenDeltaShare([segment({ dpct: 0 })])).toBe(0);
	});
});

describe("fitWithIntervals gate", () => {
	it("refuses to identify anything below the segment floor", () => {
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 2,
			segmentsPerRun: 5, // 10 segments, under the floor
			meanTokens: 2_000_000,
			seed: 11,
		});
		expect(segments.length).toBeLessThan(MIN_SEGMENTS_FOR_FIT);

		const result = fitWithIntervals(segments, { bootstrapB: 50 });

		for (const coef of result.coefficients) {
			expect(coef.identified).toBe(false);
			expect(coef.unidentifiedReasons).toContain("few-segments");
			expect(coef.pointEstimate).toBeNull();
		}
	});

	it("marks a coefficient pinned at zero as unidentified, never as free", () => {
		// A model that never ran has no exposure, so the fit pins it at 0. That is
		// "we cannot tell", not "this model costs nothing".
		const base = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 25,
			segmentsPerRun: 10,
			meanTokens: 2_000_000,
			seed: 22,
		});
		// Give a second model exposure only in segments with zero Δpct, so the fit
		// has no reason to attribute any cost to it.
		const withIdle = base.map((s, i) =>
			i % 3 === 0
				? {
						...s,
						dpct: 0,
						eqTokensByModel: { ...s.eqTokensByModel, idle: 3_000_000 },
					}
				: s,
		);

		const result = fitWithIntervals(withIdle, { bootstrapB: 100 });

		const idle = result.coefficients.find((c) => c.key === "idle");
		expect(idle).toBeDefined();
		expect(idle?.identified).toBe(false);
		expect(idle?.pointEstimate).toBeNull();
	});

	it("carries the tier provenance through to the result", () => {
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 25,
			segmentsPerRun: 10,
			meanTokens: 2_000_000,
			seed: 33,
		});

		expect(
			fitWithIntervals(segments, { bootstrapB: 20, tierProvenance: "recorded" })
				.tierProvenance,
		).toBe("recorded");
		// Defaults to `assumed`: silence must not read as a recorded tier.
		expect(fitWithIntervals(segments, { bootstrapB: 20 }).tierProvenance).toBe(
			"assumed",
		);
	});

	it("lists every contributing account", () => {
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 25,
			segmentsPerRun: 10,
			meanTokens: 2_000_000,
			accountIds: ["acct-b", "acct-a"],
			seed: 44,
		});

		expect(
			fitWithIntervals(segments, { bootstrapB: 20 }).contributingAccountIds,
		).toEqual(["acct-a", "acct-b"]);
	});
});

describe("fitRolling", () => {
	it("emits one point per model per window, stepped by stepMs", () => {
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 60,
			segmentsPerRun: 23,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			startMs: START,
			seed: 55,
		});

		const series = fitRolling(segments, {
			windowMs: 14 * DAY_MS,
			stepMs: 2 * DAY_MS,
			bootstrapB: 30,
		});

		const points = series.get("claude-opus-5") ?? [];
		expect(points.length).toBeGreaterThan(5);
		for (let i = 0; i + 1 < points.length; i++) {
			expect(points[i + 1].windowStartMs - points[i].windowStartMs).toBe(
				2 * DAY_MS,
			);
			expect(points[i].windowEndMs - points[i].windowStartMs).toBe(14 * DAY_MS);
		}
	});

	it("emits a null-valued point for an unidentified window rather than omitting it", () => {
		// The panel needs a GAP. Omitting the point lets the line join across a
		// stretch where nothing was measured.
		const segments = makeSyntheticSegments({
			weights: { a: 1, b: 1 },
			runs: 60,
			segmentsPerRun: 23,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			fixedRatios: { a: 1, b: 1 }, // perfectly collinear throughout
			startMs: START,
			seed: 66,
		});

		const series = fitRolling(segments, {
			windowMs: 14 * DAY_MS,
			stepMs: 2 * DAY_MS,
			bootstrapB: 30,
		});

		const points = series.get("a") ?? [];
		expect(points.length).toBeGreaterThan(0);
		expect(points.every((p) => !p.identified)).toBe(true);
		expect(points.every((p) => p.pointEstimate === null)).toBe(true);
	});

	it("returns an empty series for no segments", () => {
		expect(fitRolling([]).size).toBe(0);
	});
});
