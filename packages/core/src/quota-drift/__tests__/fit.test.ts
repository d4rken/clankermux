import { describe, expect, it } from "bun:test";
import {
	actualModelKeys,
	exposureSupport,
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

	it("refuses to identify anything from a single run, however many segments", () => {
		// The bootstrap resamples whole RUNS, so with one unique run every
		// resample is the original sample and the interval collapses onto the
		// point estimate. All four criteria then pass and a number with zero
		// uncertainty gets reported as measured. One account's single complete
		// weekly run really does look like this: ~28 segments at 6h anchors.
		const segments = makeSyntheticSegments({
			weights: { "claude-opus-5": 0.19 },
			runs: 1,
			segmentsPerRun: 28,
			segmentMs: 6 * HOUR,
			meanTokens: 20_000_000,
			seed: 128,
		});
		expect(segments).toHaveLength(28);
		expect(new Set(segments.map((s) => s.runId)).size).toBe(1);
		expect(segments.length).toBeGreaterThanOrEqual(MIN_SEGMENTS_FOR_FIT);

		const result = fitWithIntervals(segments, { bootstrapB: 100 });

		const coef = result.coefficients.find((c) => c.key === "claude-opus-5");
		expect(coef?.identified).toBe(false);
		expect(coef?.unidentifiedReasons).toContain("wide-interval");
		expect(coef?.pointEstimate).toBeNull();
		expect(coef?.ciLow).toBeNull();
		expect(coef?.ciHigh).toBeNull();
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

	it("emits a point for every grid window, including an inactivity gap", () => {
		// A window with no segments must still produce a point. Skipping it lets
		// the chart join two fits straight across unmeasured time, and it leaves
		// "latest" pointing at whatever window last happened to fit.
		const early = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 20,
			segmentsPerRun: 23,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			startMs: START,
			seed: 77,
		});
		const late = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 20,
			segmentsPerRun: 23,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			// 20 idle days between the two stretches.
			startMs: START + 40 * DAY_MS,
			seed: 88,
		});
		const segments = [...early, ...late];

		const points =
			fitRolling(segments, {
				windowMs: 14 * DAY_MS,
				stepMs: 2 * DAY_MS,
				bootstrapB: 20,
			}).get("claude-opus-5") ?? [];

		expect(points.length).toBeGreaterThan(5);
		for (let i = 0; i + 1 < points.length; i++) {
			expect(points[i + 1].windowStartMs - points[i].windowStartMs).toBe(
				2 * DAY_MS,
			);
		}
		// The gap is represented, not skipped.
		const empty = points.filter((p) => p.nSegments === 0);
		expect(empty.length).toBeGreaterThan(0);
		for (const point of empty) {
			expect(point.identified).toBe(false);
			expect(point.pointEstimate).toBeNull();
			expect(point.ciLow).toBeNull();
			expect(point.ciHigh).toBeNull();
			expect(point.impliedCapacityMtok).toBeNull();
		}
		// The series runs to the end of the history: the last point is the last
		// GRID window, so a caller reading "latest" off it can only be behind by
		// the grid step, never by however long the newest quiet stretch ran.
		const last = points[points.length - 1];
		const historyEnd = Math.max(...segments.map((s) => s.t1));
		expect(historyEnd - last.windowEndMs).toBeLessThan(2 * DAY_MS);
	});

	it("emits a series for a pooled model, and never one for `other`", () => {
		// A model below the share floor has no column of its own in the fit, but
		// it is still a real model: it gets a series of unidentified points. The
		// pooled `other` column is not a model at all and must not get one.
		const base = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 30,
			segmentsPerRun: 23,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			startMs: START,
			seed: 99,
		});
		const segments = base.map((s) => ({
			...s,
			eqTokensByModel: { ...s.eqTokensByModel, "claude-haiku-4-5": 500 },
		}));
		expect(selectKeys(segments)).toContain("other");

		const series = fitRolling(segments, {
			windowMs: 14 * DAY_MS,
			stepMs: 2 * DAY_MS,
			bootstrapB: 20,
		});

		expect([...series.keys()].sort()).toEqual([
			"claude-haiku-4-5",
			"claude-opus-5",
		]);
		const rare = series.get("claude-haiku-4-5") ?? [];
		expect(rare.length).toBe(series.get("claude-opus-5")?.length);
		expect(rare.every((p) => !p.identified)).toBe(true);
		expect(rare.every((p) => p.pointEstimate === null)).toBe(true);
	});

	it("returns an empty series for no segments", () => {
		expect(fitRolling([]).size).toBe(0);
	});

	it("calls a window with zero exposure `no-exposure`, never `low-share`", () => {
		// The largest empty stretches on the live chart are models that simply
		// stopped being routed. Reporting those as "too little of this window's
		// traffic to measure" states a measurement problem where there was
		// nothing to measure at all.
		const early = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			runs: 20,
			segmentsPerRun: 23,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			startMs: START,
			seed: 101,
		});
		// The later stretch drops claude-sonnet-5 entirely: same shape as a model
		// falling out of routing.
		const late = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 20,
			segmentsPerRun: 23,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			startMs: START + 40 * DAY_MS,
			seed: 102,
		});

		const points =
			fitRolling([...early, ...late], {
				windowMs: 14 * DAY_MS,
				stepMs: 2 * DAY_MS,
				bootstrapB: 20,
			}).get("claude-sonnet-5") ?? [];

		const retired = points.filter(
			(p) => p.windowStartMs >= START + 40 * DAY_MS,
		);
		expect(retired.length).toBeGreaterThan(0);
		for (const point of retired) {
			expect(point.identified).toBe(false);
			expect(point.unidentifiedReasons).toContain("no-exposure");
			expect(point.unidentifiedReasons).not.toContain("low-share");
		}
	});

	it("still calls exposure just under the share floor `low-share`", () => {
		// The other side of the same distinction: this model DID run, there is
		// just too little of it to separate. That is a statement about
		// measurement and must keep saying so.
		const base = makeSyntheticSegments({
			weights: { "claude-opus-5": 2.4 },
			runs: 30,
			segmentsPerRun: 23,
			segmentMs: HOUR,
			meanTokens: 2_000_000,
			startMs: START,
			seed: 103,
		});
		// Exactly 1.9% of EVERY segment's eq-tokens: positive, and just under
		// MIN_MODEL_SHARE. Scaling per segment rather than adding a flat amount
		// holds the share at 1.9% inside every rolling sub-window too, so the
		// case under test cannot drift above the floor in one of them.
		const RARE_SHARE = 0.019;
		const segments = base.map((s) => {
			const total = Object.values(s.eqTokensByModel).reduce((a, b) => a + b, 0);
			return {
				...s,
				eqTokensByModel: {
					...s.eqTokensByModel,
					"claude-haiku-4-5": (total * RARE_SHARE) / (1 - RARE_SHARE),
				},
			};
		});
		expect(selectKeys(segments)).not.toContain("claude-haiku-4-5");
		expect(
			shareByKey(segments, ["claude-haiku-4-5"]).get("claude-haiku-4-5"),
		).toBeCloseTo(RARE_SHARE, 6);

		const points =
			fitRolling(segments, {
				windowMs: 14 * DAY_MS,
				stepMs: 2 * DAY_MS,
				bootstrapB: 20,
			}).get("claude-haiku-4-5") ?? [];

		const withTraffic = points.filter((p) => p.nSegments > 0);
		expect(withTraffic.length).toBeGreaterThan(0);
		for (const point of withTraffic) {
			expect(point.unidentifiedReasons).toContain("low-share");
			expect(point.unidentifiedReasons).not.toContain("no-exposure");
		}
	});
});

describe("actualModelKeys", () => {
	it("is the sorted union of every model with positive exposure", () => {
		const segments = [
			segment({ eqTokensByModel: { b: 10, a: 5 } }),
			segment({ eqTokensByModel: { c: 1, a: 0 } }),
		];

		expect(actualModelKeys(segments)).toEqual(["a", "b", "c"]);
	});

	it("never returns the pooled `other` column", () => {
		const segments = [segment({ eqTokensByModel: { real: 10, other: 5 } })];

		expect(actualModelKeys(segments)).toEqual(["real"]);
	});
});

describe("exposureSupport", () => {
	it("counts only the clusters that carried THIS model", () => {
		// The fit-wide totals here are 3 runs and 2 accounts. Quoting those as one
		// model's support credits it with clusters that never ran it.
		const segments = [
			segment({ runId: "r1", accountId: "a", eqTokensByModel: { opus: 10 } }),
			segment({ runId: "r1", accountId: "a", eqTokensByModel: { opus: 5 } }),
			segment({ runId: "r2", accountId: "b", eqTokensByModel: { sonnet: 10 } }),
			segment({ runId: "r3", accountId: "b", eqTokensByModel: { sonnet: 7 } }),
		];

		expect(exposureSupport(segments, "opus")).toEqual({
			nRuns: 1,
			nAccounts: 1,
		});
		expect(exposureSupport(segments, "sonnet")).toEqual({
			nRuns: 2,
			nAccounts: 1,
		});
	});

	it("counts runs and accounts independently of each other", () => {
		const segments = [
			segment({ runId: "r1", accountId: "a", eqTokensByModel: { m: 1 } }),
			segment({ runId: "r2", accountId: "a", eqTokensByModel: { m: 1 } }),
			segment({ runId: "r3", accountId: "b", eqTokensByModel: { m: 1 } }),
		];

		expect(exposureSupport(segments, "m")).toEqual({ nRuns: 3, nAccounts: 2 });
	});

	it("ignores a zero-token appearance — presence in the map is not exposure", () => {
		const segments = [
			segment({ runId: "r1", accountId: "a", eqTokensByModel: { m: 0 } }),
		];

		expect(exposureSupport(segments, "m")).toEqual({ nRuns: 0, nAccounts: 0 });
	});

	it("reports nothing for the pooled column, which segments never carry", () => {
		const segments = [
			segment({ runId: "r1", accountId: "a", eqTokensByModel: { tiny: 1 } }),
		];

		expect(exposureSupport(segments, "other")).toEqual({
			nRuns: 0,
			nAccounts: 0,
		});
	});
});
