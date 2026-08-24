import { describe, expect, test } from "bun:test";
import type { PredictionPoint } from "@clankermux/types";
import {
	ANCHOR_STABILITY_MAX_GAP,
	aggregateRelation,
	type BinAnchor,
	binIndexOf,
	buildBins,
	type CellScore,
	COLUMN_COUNT,
	CONTROL_MARGIN,
	capabilityMatrix,
	censusBins,
	columnIndex,
	columnLabel,
	concentration,
	conditionalObservability,
	type EraBoundary,
	eraStability,
	excludedGroupReason,
	type FamilyKey,
	familyKeyOf,
	formatFeasibilityReport,
	identifiability,
	type LedgerBin,
	type LedgerRequest,
	MIN_GROUP_EQUIVALENT_BINS,
	MIN_USABLE_BINS,
	noInterceptR2,
	type PermutationControl,
	permuteAccountLabels,
	permutedAccountRelationR2,
	R2_PASS_THRESHOLD,
	selectCell,
	symmetricEigenvalues,
	type TokenClass,
	uncenteredCorrelation,
} from "./ledger-feasibility";

const MIN = 60_000;
const W = 10 * MIN;
/** `T0` is the INCLUSIVE upper edge of bin 99, so bin 100 spans `(T0, T0+W]`. */
const T0 = 100 * W;
const RESET_A = T0 + 5 * 3_600_000;
const RESET_B = RESET_A + 5 * 3_600_000;

function point(
	t: number,
	utilization: number,
	resetsAt: number,
): PredictionPoint {
	return { t, utilization, resetsAt };
}

function request(
	over: Partial<LedgerRequest> & { timestamp: number },
): LedgerRequest {
	return {
		accountId: "acct-1",
		model: "claude-sonnet-4-5",
		responseTimeMs: null,
		billingType: "subscription",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		...over,
	};
}

function build(
	points: readonly PredictionPoint[],
	requests: readonly LedgerRequest[],
	over: Partial<{ widthMs: number; lagMs: number; anchor: BinAnchor }> = {},
) {
	return buildBins(points, requests, {
		widthMs: W,
		lagMs: 0,
		anchor: "terminal",
		accountId: "acct-1",
		...over,
	});
}

function binAt(
	bins: readonly LedgerBin[],
	index: number,
): LedgerBin | undefined {
	return bins.find((b) => b.startMs === index * W);
}

// ---------------------------------------------------------------------------
// Column addressing
// ---------------------------------------------------------------------------

describe("design-matrix columns", () => {
	test("every column index round-trips through its label", () => {
		const seen = new Set<number>();
		for (let i = 0; i < COLUMN_COUNT; i++) {
			const label = columnLabel(i);
			const [family, tokenClass] = label.split("/");
			expect(columnIndex(family as FamilyKey, tokenClass as TokenClass)).toBe(
				i,
			);
			seen.add(i);
		}
		expect(seen.size).toBe(COLUMN_COUNT);
	});

	test("non-Claude and missing models fall into the unresolved bucket", () => {
		expect(familyKeyOf("claude-opus-4-6")).toBe("opus");
		expect(familyKeyOf("claude-mythos-5")).toBe("fable");
		expect(familyKeyOf("gpt-5.6-sol")).toBe("unresolved");
		expect(familyKeyOf(null)).toBe("unresolved");
	});

	test("codex five_hour is excluded outright, with a reason", () => {
		expect(excludedGroupReason("codex", "five_hour")).toContain("2026-07-12");
		expect(excludedGroupReason("codex", "seven_day")).toBeNull();
		expect(excludedGroupReason("anthropic", "five_hour")).toBeNull();
	});

	test("bin indices follow the (start, end] convention", () => {
		expect(binIndexOf(T0, W)).toBe(99);
		expect(binIndexOf(T0 + 1, W)).toBe(100);
		expect(binIndexOf(T0 + W, W)).toBe(100);
		expect(binIndexOf(T0 + W + 1, W)).toBe(101);
	});
});

// ---------------------------------------------------------------------------
// buildBins
// ---------------------------------------------------------------------------

describe("buildBins", () => {
	/** Five 2-minute deltas rising one point each, all inside bin 100. */
	const steadySeries: PredictionPoint[] = [
		point(T0, 0, RESET_A),
		point(T0 + 2 * MIN, 1, RESET_A),
		point(T0 + 4 * MIN, 2, RESET_A),
		point(T0 + 6 * MIN, 3, RESET_A),
		point(T0 + 8 * MIN, 4, RESET_A),
		point(T0 + 10 * MIN, 5, RESET_A),
	];

	test("a fully observed bin has coverage 1 and the summed percent change", () => {
		const { bins } = build(steadySeries, []);
		expect(bins).toHaveLength(1);
		const bin = bins[0];
		expect(bin.startMs).toBe(100 * W);
		expect(bin.endMs).toBe(101 * W);
		expect(bin.observedMs).toBe(10 * MIN);
		expect(bin.coverage).toBe(1);
		expect(bin.dPct).toBeCloseTo(5, 10);
		expect(bin.usable).toBe(true);
	});

	test("coverage is the observed fraction of the bin, not of the samples", () => {
		// Only the first two deltas: 4 minutes of a 10-minute bin.
		const { bins } = build(steadySeries.slice(0, 3), []);
		expect(bins).toHaveLength(1);
		expect(bins[0].observedMs).toBe(4 * MIN);
		expect(bins[0].coverage).toBeCloseTo(0.4, 10);
		// Below the 0.5 floor, so it is reported but NOT usable.
		expect(bins[0].usable).toBe(false);
		expect(censusBins(bins).lowCoverage).toBe(1);
	});

	test("tokens land in the bin by the half-open (from, to] rule", () => {
		const { bins, drops } = build(steadySeries, [
			// Exactly ON the first delta's OPEN endpoint: outside every interval.
			request({ timestamp: T0, inputTokens: 1_000 }),
			// Exactly ON the last delta's CLOSED endpoint: inside, and in bin 100.
			request({ timestamp: T0 + 10 * MIN, inputTokens: 7 }),
		]);
		expect(drops.outsideObservedInterval).toBe(1);
		const bin = bins[0];
		expect(bin.requestCount).toBe(1);
		expect(bin.grossTokens).toBe(7);
		expect(bin.tokens[columnIndex("sonnet", "input")]).toBe(7);
	});

	test("token mass is split by family and class", () => {
		const { bins } = build(steadySeries, [
			request({
				timestamp: T0 + 1 * MIN,
				model: "claude-opus-4-6",
				inputTokens: 10,
				outputTokens: 20,
				cacheReadInputTokens: 30,
				cacheCreationInputTokens: 40,
			}),
			request({
				timestamp: T0 + 3 * MIN,
				model: "gpt-5.6-sol",
				inputTokens: 5,
			}),
		]);
		const bin = bins[0];
		expect(bin.tokens[columnIndex("opus", "input")]).toBe(10);
		expect(bin.tokens[columnIndex("opus", "output")]).toBe(20);
		expect(bin.tokens[columnIndex("opus", "cache_read")]).toBe(30);
		expect(bin.tokens[columnIndex("opus", "cache_creation")]).toBe(40);
		expect(bin.tokens[columnIndex("unresolved", "input")]).toBe(5);
		expect(bin.grossTokens).toBe(105);
		expect(bin.requestCount).toBe(2);
	});

	test("a delta straddling a bin boundary is pro-rated linearly", () => {
		// One accepted 6-minute delta of +6 points from T0+8min to T0+14min:
		// 2 minutes of it in bin 100, 4 minutes in bin 101.
		const series = [
			point(T0 + 6 * MIN, 0, RESET_A),
			point(T0 + 8 * MIN, 1, RESET_A),
			point(T0 + 14 * MIN, 7, RESET_A),
		];
		const { bins } = build(series, []);
		const first = binAt(bins, 100);
		const second = binAt(bins, 101);
		expect(first?.observedMs).toBe(4 * MIN);
		expect(second?.observedMs).toBe(4 * MIN);
		// bin 100 = the whole first delta (+1) plus 2/6 of the second (+2).
		expect(first?.dPct).toBeCloseTo(3, 10);
		// bin 101 = 4/6 of the second delta.
		expect(second?.dPct).toBeCloseTo(4, 10);
	});

	test("a rejected gap takes its tokens out with it", () => {
		// An 18-minute hole: wider than MAX_DELTA_GAP_MS, so nothing between the
		// two samples counts as observed.
		const series = [
			point(T0 + 2 * MIN, 1, RESET_A),
			point(T0 + 20 * MIN, 9, RESET_A),
		];
		const { bins, drops } = build(series, [
			request({ timestamp: T0 + 10 * MIN, inputTokens: 5_000 }),
		]);
		expect(bins).toHaveLength(0);
		expect(drops.outsideObservedInterval).toBe(1);
	});

	test("a lag that carries a request across a reset discards it", () => {
		const series = [
			point(T0 + 4 * MIN, 90, RESET_A),
			point(T0 + 6 * MIN, 92, RESET_A),
			// A different window: resets_at moves, so this is a lifecycle boundary.
			// It starts in the NEXT bin, so no bin is reset-crossing and the only
			// thing under test is the lag.
			point(T0 + 12 * MIN, 1, RESET_B),
			point(T0 + 14 * MIN, 2, RESET_B),
		];
		const shifted = build(
			series,
			[request({ timestamp: T0 + 6 * MIN, inputTokens: 1_000 })],
			{ lagMs: 7 * MIN },
		);
		expect(shifted.drops.outsideObservedInterval).toBe(1);
		expect(shifted.drops.inDiscardedBin).toBe(0);
		// Without the lag the same request is attributed normally.
		const unshifted = build(series, [
			request({ timestamp: T0 + 6 * MIN, inputTokens: 1_000 }),
		]);
		expect(binAt(unshifted.bins, 100)?.grossTokens).toBe(1_000);
	});

	test("a lag cannot import tokens spent inside a REJECTED sampling gap", () => {
		// Two accepted 2-minute deltas with an 18-minute hole between them: wider
		// than MAX_DELTA_GAP_MS, so the hole is not observed at all.
		const series = [
			point(T0 + 2 * MIN, 1, RESET_A),
			point(T0 + 4 * MIN, 2, RESET_A),
			point(T0 + 22 * MIN, 9, RESET_A),
			point(T0 + 24 * MIN, 10, RESET_A),
		];
		// This request was physically spent INSIDE the hole. A +3 minute lag puts
		// its shifted time at T0+23min, inside the accepted (22, 24] interval, so
		// checking only the shifted time would import quota the study threw away
		// together with the gap.
		const inGap = request({ timestamp: T0 + 20 * MIN, inputTokens: 5_000 });
		const { bins, drops } = build(series, [inGap], { lagMs: 3 * MIN });
		expect(drops.outsideObservedInterval).toBe(1);
		for (const bin of bins) expect(bin.grossTokens).toBe(0);

		// A request whose anchor IS observed still moves normally under the lag:
		// T0+3min is in (2, 4] and T0+6min... is not observed, so use the far side.
		const observed = request({ timestamp: T0 + 23 * MIN, inputTokens: 11 });
		const moved = build(series, [observed], { lagMs: MIN });
		expect(moved.drops.outsideObservedInterval).toBe(0);
		expect(moved.bins.reduce((sum, b) => sum + b.grossTokens, 0)).toBe(11);
	});

	test("a bin touched by two reset lifecycles is discarded with its requests", () => {
		const series = [
			point(T0 + 2 * MIN, 90, RESET_A),
			point(T0 + 4 * MIN, 92, RESET_A),
			point(T0 + 6 * MIN, 1, RESET_B),
			point(T0 + 8 * MIN, 2, RESET_B),
		];
		const { bins, resetCrossingBins, drops } = build(series, [
			request({ timestamp: T0 + 3 * MIN, inputTokens: 100 }),
		]);
		expect(resetCrossingBins).toBe(1);
		expect(bins).toHaveLength(0);
		expect(drops.inDiscardedBin).toBe(1);
	});

	test("the start anchor shifts a request back by its response time", () => {
		const requests = [
			request({
				timestamp: T0 + 11 * MIN,
				responseTimeMs: 3 * MIN,
				inputTokens: 42,
			}),
		];
		const series = [
			point(T0 + 6 * MIN, 0, RESET_A),
			point(T0 + 8 * MIN, 1, RESET_A),
			point(T0 + 10 * MIN, 2, RESET_A),
			point(T0 + 12 * MIN, 3, RESET_A),
		];
		const terminal = build(series, requests, { anchor: "terminal" });
		expect(binAt(terminal.bins, 101)?.grossTokens).toBe(42);
		expect(binAt(terminal.bins, 100)?.grossTokens).toBe(0);
		const start = build(series, requests, { anchor: "start" });
		expect(binAt(start.bins, 100)?.grossTokens).toBe(42);
		expect(binAt(start.bins, 101)?.grossTokens).toBe(0);
	});

	test("a null response time falls back to the terminal stamp", () => {
		const series = [
			point(T0 + 6 * MIN, 0, RESET_A),
			point(T0 + 8 * MIN, 1, RESET_A),
			point(T0 + 10 * MIN, 2, RESET_A),
			point(T0 + 12 * MIN, 3, RESET_A),
		];
		const requests = [
			request({
				timestamp: T0 + 11 * MIN,
				responseTimeMs: null,
				inputTokens: 9,
			}),
		];
		expect(
			binAt(build(series, requests, { anchor: "start" }).bins, 101)
				?.grossTokens,
		).toBe(9);
	});

	test("contamination flags are set and reported, never dropped", () => {
		const refundSeries = [
			point(T0 + 2 * MIN, 40, RESET_A),
			point(T0 + 4 * MIN, 30, RESET_A),
			point(T0 + 6 * MIN, 31, RESET_A),
		];
		const refund = build(refundSeries, []).bins[0];
		expect(refund.hasRefund).toBe(true);
		expect(refund.usable).toBe(false);

		const saturatedSeries = [
			point(T0 + 2 * MIN, 99, RESET_A),
			point(T0 + 4 * MIN, 100, RESET_A),
			point(T0 + 6 * MIN, 100, RESET_A),
			point(T0 + 8 * MIN, 100, RESET_A),
			point(T0 + 10 * MIN, 100, RESET_A),
			point(T0 + 12 * MIN, 100, RESET_A),
		];
		const saturated = binAt(build(saturatedSeries, []).bins, 100);
		expect(saturated?.saturated).toBe(true);
		expect(saturated?.usable).toBe(false);

		const overage = build(
			[
				point(T0, 0, RESET_A),
				point(T0 + 2 * MIN, 1, RESET_A),
				point(T0 + 4 * MIN, 2, RESET_A),
				point(T0 + 6 * MIN, 3, RESET_A),
				point(T0 + 8 * MIN, 4, RESET_A),
				point(T0 + 10 * MIN, 5, RESET_A),
			],
			[
				request({
					timestamp: T0 + 1 * MIN,
					billingType: "overage",
					inputTokens: 3,
				}),
			],
		).bins[0];
		expect(overage.overage).toBe(true);
		expect(overage.usable).toBe(false);
		// Its tokens are still recorded; the bin is excluded, not emptied.
		expect(overage.grossTokens).toBe(3);
	});

	test("keepalive-active periods are marked on the bins they overlap", () => {
		const { bins } = buildBins(
			[
				point(T0, 0, RESET_A),
				point(T0 + 2 * MIN, 1, RESET_A),
				point(T0 + 4 * MIN, 2, RESET_A),
				point(T0 + 6 * MIN, 3, RESET_A),
				point(T0 + 8 * MIN, 4, RESET_A),
				point(T0 + 10 * MIN, 5, RESET_A),
			],
			[],
			{
				widthMs: W,
				lagMs: 0,
				anchor: "terminal",
				accountId: "acct-1",
				keepaliveActivePeriods: [{ fromMs: T0 + 5 * MIN, toMs: T0 + 6 * MIN }],
			},
		);
		expect(bins[0].keepaliveActive).toBe(true);
		// It is informational, not a contamination flag.
		expect(bins[0].usable).toBe(true);
	});

	/** A long, fully observed 2-minute sampling run over one lifecycle. */
	function observedRun(ticks: number): PredictionPoint[] {
		const series: PredictionPoint[] = [];
		for (let i = 0; i <= ticks; i++) {
			series.push(point(T0 + i * 2 * MIN, i, RESET_A));
		}
		return series;
	}

	test("a future-token control lag places tokens WHOLLY after the bin they land in", () => {
		const series = observedRun(60);
		for (const widthMinutes of [2, 5, 10]) {
			const widthMs = widthMinutes * MIN;
			for (const offsetMinutes of [2, 4]) {
				const offsetMs = offsetMinutes * MIN;
				// The control construction under test: -(width + offset).
				const lagMs = -(widthMs + offsetMs);
				for (let m = 40; m < 60; m++) {
					const anchorMs = T0 + m * MIN;
					const { bins } = buildBins(
						series,
						[request({ timestamp: anchorMs, inputTokens: 1_000 })],
						{ widthMs, lagMs, anchor: "terminal", accountId: "acct-1" },
					);
					const carrier = bins.find((b) => b.grossTokens > 0);
					if (carrier == null) continue;
					// The bin closes STRICTLY before the tokens were spent, with the
					// offset to spare: not one of its own milliseconds overlaps the
					// request it was charged for.
					expect(carrier.endMs).toBeLessThanOrEqual(anchorMs - offsetMs);
					expect(carrier.endMs).toBeLessThan(anchorMs);
					// And it is never the bin the request would have landed in itself.
					const natural = buildBins(
						series,
						[request({ timestamp: anchorMs, inputTokens: 1_000 })],
						{ widthMs, lagMs: 0, anchor: "terminal", accountId: "acct-1" },
					).bins.find((b) => b.grossTokens > 0);
					expect(natural).toBeDefined();
					expect(carrier.startMs).not.toBe(natural?.startMs);
				}
			}
		}
	});

	test("a fixed small negative lag does NOT achieve that: it is mostly the bin's own present", () => {
		// The defect this construction replaces. At W=10min a lag of -2min shifts
		// a request into a bin that still covers 8 of its own 10 minutes, so the
		// "future-token" control is scored on largely the same interval as the
		// real cell and any margin over it is manufactured, not measured.
		const series = observedRun(60);
		const anchorMs = T0 + 49 * MIN;
		const { bins } = buildBins(
			series,
			[request({ timestamp: anchorMs, inputTokens: 1_000 })],
			{ widthMs: W, lagMs: -2 * MIN, anchor: "terminal", accountId: "acct-1" },
		);
		const carrier = bins.find((b) => b.grossTokens > 0);
		expect(carrier).toBeDefined();
		// The bin has NOT closed before the request happened.
		expect(carrier?.endMs as number).toBeGreaterThan(anchorMs);
		// It is in fact the very bin the unshifted request belongs to.
		const natural = buildBins(
			series,
			[request({ timestamp: anchorMs, inputTokens: 1_000 })],
			{ widthMs: W, lagMs: 0, anchor: "terminal", accountId: "acct-1" },
		).bins.find((b) => b.grossTokens > 0);
		expect(carrier?.startMs).toBe(natural?.startMs);
	});

	test("is deterministic and refuses a non-positive width", () => {
		const a = build(steadySeries, [
			request({ timestamp: T0 + MIN, inputTokens: 5 }),
		]);
		const b = build(steadySeries, [
			request({ timestamp: T0 + MIN, inputTokens: 5 }),
		]);
		expect(JSON.stringify(a.bins)).toBe(JSON.stringify(b.bins));
		expect(() => build(steadySeries, [], { widthMs: 0 })).toThrow(/positive/);
	});
});

// ---------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------

describe("numerics", () => {
	test("noInterceptR2 recovers an exact proportional relation", () => {
		const xs = [1, 2, 3, 4];
		const ys = [2, 4, 6, 8];
		const { r2, slope } = noInterceptR2(xs, ys);
		expect(slope).toBeCloseTo(2, 12);
		expect(r2).toBeCloseTo(1, 12);
	});

	test("noInterceptR2 is uncentered: a constant y is not a perfect fit", () => {
		// b = sum(xy)/sum(xx) = (1+2+3)/(1+4+9) = 6/14; residuals are non-zero.
		const { r2 } = noInterceptR2([1, 2, 3], [1, 1, 1]);
		expect(r2).not.toBeNull();
		expect(r2 as number).toBeLessThan(1);
		expect(r2 as number).toBeGreaterThan(0);
	});

	test("noInterceptR2 returns null rather than 0 with nothing to explain", () => {
		expect(noInterceptR2([0, 0], [1, 2]).r2).toBeNull();
		expect(noInterceptR2([1, 2], [0, 0]).r2).toBeNull();
		expect(noInterceptR2([], []).r2).toBeNull();
	});

	test("symmetricEigenvalues matches a hand-computed spectrum", () => {
		// [[2,1],[1,2]] has eigenvalues 3 and 1.
		const values = symmetricEigenvalues([
			[2, 1],
			[1, 2],
		]);
		expect(values[0]).toBeCloseTo(3, 10);
		expect(values[1]).toBeCloseTo(1, 10);
		// A diagonal matrix is returned untouched, descending.
		expect(
			symmetricEigenvalues([
				[1, 0, 0],
				[0, 5, 0],
				[0, 0, 3],
			]),
		).toEqual([5, 3, 1]);
	});

	test("uncenteredCorrelation is the cosine, not Pearson", () => {
		// Proportional columns are interchangeable: cosine 1.
		expect(uncenteredCorrelation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
		// Columns that never co-occur are separable, so the cosine is 0 — Pearson
		// would call this pair perfectly anti-correlated at -1.
		expect(uncenteredCorrelation([1, 0, 1, 0], [0, 1, 0, 1])).toBe(0);
		expect(uncenteredCorrelation([0, 0], [1, 2])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Synthetic bins for the analysis functions
// ---------------------------------------------------------------------------

interface BinSpec {
	accountId?: string;
	index: number;
	dPct: number;
	tokens?: Partial<Record<string, number>>;
	coverage?: number;
	hasRefund?: boolean;
	saturated?: boolean;
	overage?: boolean;
}

function makeBin(spec: BinSpec): LedgerBin {
	const tokens = new Float64Array(COLUMN_COUNT);
	let gross = 0;
	for (const [label, amount] of Object.entries(spec.tokens ?? {})) {
		const [family, tokenClass] = label.split("/");
		tokens[columnIndex(family as FamilyKey, tokenClass as TokenClass)] =
			amount ?? 0;
		gross += amount ?? 0;
	}
	const coverage = spec.coverage ?? 1;
	const hasRefund = spec.hasRefund ?? false;
	const saturated = spec.saturated ?? false;
	const overage = spec.overage ?? false;
	return {
		accountId: spec.accountId ?? "acct-1",
		startMs: spec.index * W,
		endMs: (spec.index + 1) * W,
		widthMs: W,
		observedMs: coverage * W,
		coverage,
		dPct: spec.dPct,
		tokens,
		grossTokens: gross,
		requestCount: gross > 0 ? 1 : 0,
		hasRefund,
		saturated,
		overage,
		keepaliveActive: false,
		usable: coverage >= 0.5 && !hasRefund && !saturated && !overage,
	};
}

/** `n` clean bins on an exact 2 percent-per-million-tokens relation. */
function proportionalBins(n: number, accountId = "acct-1"): LedgerBin[] {
	const bins: LedgerBin[] = [];
	for (let i = 0; i < n; i++) {
		const tokens = 100_000 * (1 + (i % 7));
		bins.push(
			makeBin({
				accountId,
				index: i,
				dPct: tokens * 2e-6,
				tokens: { "sonnet/input": tokens },
			}),
		);
	}
	return bins;
}

// ---------------------------------------------------------------------------
// aggregateRelation
// ---------------------------------------------------------------------------

describe("aggregateRelation", () => {
	test("recovers an exact relation over the clean cohort", () => {
		const relation = aggregateRelation(proportionalBins(60));
		expect(relation.insufficient).toBe(false);
		expect(relation.usableBins).toBe(60);
		expect(relation.positiveSignalBins).toBe(60);
		expect(relation.r2).toBeCloseTo(1, 10);
		expect(relation.slopePctPerMillionTokens).toBeCloseTo(2, 10);
	});

	test("returns null, never 0, below the usable-bin minimum", () => {
		const relation = aggregateRelation(proportionalBins(MIN_USABLE_BINS - 1));
		expect(relation.insufficient).toBe(true);
		expect(relation.r2).toBeNull();
		expect(relation.slopePctPerMillionTokens).toBeNull();
		expect(relation.usableBins).toBe(MIN_USABLE_BINS - 1);
	});

	test("returns null below the positive-signal minimum even with many bins", () => {
		const bins: LedgerBin[] = [];
		for (let i = 0; i < 80; i++) {
			// Plenty of usable bins, but only 10 of them carry both tokens and a rise.
			bins.push(
				i < 10
					? makeBin({
							index: i,
							dPct: 0.2,
							tokens: { "sonnet/input": 100_000 },
						})
					: makeBin({ index: i, dPct: 0, tokens: { "sonnet/input": 100_000 } }),
			);
		}
		const relation = aggregateRelation(bins);
		expect(relation.usableBins).toBe(80);
		expect(relation.positiveSignalBins).toBe(10);
		expect(relation.insufficient).toBe(true);
		expect(relation.r2).toBeNull();
	});

	test("contaminated bins are excluded from the fit but stay in the census", () => {
		const bins = [
			...proportionalBins(60),
			makeBin({
				index: 900,
				dPct: 40,
				tokens: { "sonnet/input": 10 },
				overage: true,
			}),
			makeBin({
				index: 901,
				dPct: -30,
				tokens: { "sonnet/input": 10 },
				hasRefund: true,
			}),
			makeBin({
				index: 902,
				dPct: 40,
				tokens: { "sonnet/input": 10 },
				saturated: true,
			}),
			makeBin({
				index: 903,
				dPct: 40,
				tokens: { "sonnet/input": 10 },
				coverage: 0.2,
			}),
		];
		expect(aggregateRelation(bins).r2).toBeCloseTo(1, 10);
		const census = censusBins(bins);
		expect(census.total).toBe(64);
		expect(census.usable).toBe(60);
		expect(census.overage).toBe(1);
		expect(census.refund).toBe(1);
		expect(census.saturated).toBe(1);
		expect(census.lowCoverage).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// conditionalObservability
// ---------------------------------------------------------------------------

describe("conditionalObservability", () => {
	test("counts both directions of disagreement with their denominators", () => {
		const bins: LedgerBin[] = [];
		// 40 bins with tokens AND a rise.
		for (let i = 0; i < 40; i++) {
			bins.push(
				makeBin({ index: i, dPct: 1, tokens: { "sonnet/input": 500_000 } }),
			);
		}
		// 10 bins with tokens and NO rise (the quantisation floor).
		for (let i = 40; i < 50; i++) {
			bins.push(
				makeBin({ index: i, dPct: 0, tokens: { "sonnet/input": 1_000 } }),
			);
		}
		// 10 bins with a rise and NO tokens (a completeness hole).
		for (let i = 50; i < 60; i++) {
			bins.push(makeBin({ index: i, dPct: 1 }));
		}
		const o = conditionalObservability(bins);
		expect(o.insufficient).toBe(false);
		expect(o.tokenBearingBins).toBe(50);
		expect(o.silentBurnCount).toBe(10);
		expect(o.silentBurnRate).toBeCloseTo(0.2, 12);
		expect(o.risingBins).toBe(50);
		expect(o.unexplainedRiseCount).toBe(10);
		expect(o.unexplainedRiseRate).toBeCloseTo(0.2, 12);
	});

	test("rates are null below the minimums", () => {
		const o = conditionalObservability(proportionalBins(10));
		expect(o.insufficient).toBe(true);
		expect(o.silentBurnRate).toBeNull();
		expect(o.unexplainedRiseRate).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// identifiability
// ---------------------------------------------------------------------------

describe("identifiability", () => {
	test("orthogonal columns are identifiable with condition number 1", () => {
		const bins: LedgerBin[] = [];
		for (let i = 0; i < 60; i++) {
			bins.push(
				makeBin({
					index: i,
					dPct: 1,
					tokens:
						i % 2 === 0
							? { "sonnet/input": 100_000 }
							: { "opus/input": 100_000 },
				}),
			);
		}
		const ident = identifiability(bins);
		expect(ident.insufficient).toBe(false);
		expect(ident.activeColumns).toBe(2);
		expect(ident.rank).toBe(2);
		expect(ident.conditionNumber).toBeCloseTo(1, 6);
		expect(ident.identifiable).toBe(true);
		// Columns that never co-occur are orthogonal, so nothing is collinear.
		expect(ident.collinearPairs).toHaveLength(0);
	});

	test("a column that is a multiple of another is rank-deficient", () => {
		const bins: LedgerBin[] = [];
		for (let i = 0; i < 60; i++) {
			const base = 10_000 * (1 + (i % 5));
			bins.push(
				makeBin({
					index: i,
					dPct: 1,
					// cache_read is always exactly twice input: the two columns cannot
					// be told apart no matter how many bins there are.
					tokens: { "sonnet/input": base, "sonnet/cache_read": 2 * base },
				}),
			);
		}
		const ident = identifiability(bins);
		expect(ident.activeColumns).toBe(2);
		expect(ident.rank).toBe(1);
		expect(ident.identifiable).toBe(false);
		expect(ident.collinearPairs).toHaveLength(1);
		expect(ident.collinearPairs[0].correlation).toBeCloseTo(1, 8);
	});

	test("a nearly-collinear pair fails on the condition number, not the rank", () => {
		const bins: LedgerBin[] = [];
		for (let i = 0; i < 60; i++) {
			const base = 100_000;
			bins.push(
				makeBin({
					index: i,
					dPct: 1,
					tokens: {
						"sonnet/input": base,
						"sonnet/cache_read": base + (i % 2 === 0 ? 1 : 0),
					},
				}),
			);
		}
		const ident = identifiability(bins);
		expect(ident.rank).toBe(2);
		expect(ident.conditionNumber as number).toBeGreaterThan(1e4);
		expect(ident.identifiable).toBe(false);
	});

	test("is insufficient rather than false when there are too few bins", () => {
		const ident = identifiability(proportionalBins(10));
		expect(ident.insufficient).toBe(true);
		expect(ident.rank).toBeNull();
		expect(ident.conditionNumber).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// concentration
// ---------------------------------------------------------------------------

describe("concentration", () => {
	test("two evenly-matched accounts pass", () => {
		const bins = [
			...proportionalBins(60, "acct-1"),
			...proportionalBins(60, "acct-2").map((b) => ({
				...b,
				startMs: b.startMs + 100 * W,
				endMs: b.endMs + 100 * W,
			})),
		];
		const conc = concentration(bins, (b) => b.accountId);
		expect(conc.insufficient).toBe(false);
		expect(conc.accounts).toHaveLength(2);
		expect(conc.effectiveAccounts).toBeCloseTo(2, 6);
		expect(conc.maxAccountShare).toBeCloseTo(0.5, 6);
		expect(conc.pass).toBe(true);
		for (const account of conc.accounts) {
			expect(account.leaveOneOutR2).toBeCloseTo(1, 8);
		}
	});

	test("one account carrying the token mass fails", () => {
		const bins: LedgerBin[] = [];
		for (let i = 0; i < 60; i++) {
			bins.push(
				makeBin({
					accountId: "whale",
					index: i,
					dPct: 2,
					tokens: { "sonnet/input": 1_000_000 },
				}),
			);
		}
		for (let i = 60; i < 120; i++) {
			bins.push(
				makeBin({
					accountId: "minnow",
					index: i,
					dPct: 0.002,
					tokens: { "sonnet/input": 1_000 },
				}),
			);
		}
		const conc = concentration(bins, (b) => b.accountId);
		expect(conc.maxAccountShare as number).toBeGreaterThan(0.6);
		expect(conc.effectiveAccounts as number).toBeLessThan(2);
		expect(conc.pass).toBe(false);
		// Removing the whale still leaves enough bins to score the rest.
		const minnow = conc.accounts.find((a) => a.accountId === "minnow");
		expect(minnow?.leaveOneOutR2).not.toBeNull();
	});

	test("the label permutation is seeded, deterministic and fixed-point free", () => {
		const bins = [
			...proportionalBins(3, "a"),
			...proportionalBins(3, "b"),
			...proportionalBins(3, "c"),
		];
		const first = permuteAccountLabels(bins, 7);
		const second = permuteAccountLabels(bins, 7);
		expect([...first.entries()]).toEqual([...second.entries()]);
		expect([...first.values()].sort()).toEqual(["a", "b", "c"]);
		// A derangement: no account is ever handed its own series back, for any
		// seed. An identity "permutation" would let a real relation beat itself.
		for (let seed = 1; seed <= 200; seed++) {
			for (const [from, to] of permuteAccountLabels(bins, seed)) {
				expect(to).not.toBe(from);
			}
		}
		const two = [...proportionalBins(3, "a"), ...proportionalBins(3, "b")];
		expect([...permuteAccountLabels(two, 3).entries()]).toEqual([
			["a", "b"],
			["b", "a"],
		]);
	});
});

// ---------------------------------------------------------------------------
// permutedAccountRelationR2 — the placebo
// ---------------------------------------------------------------------------

/**
 * One account's clean series on an exact `ratio` percent-per-token relation.
 * Each account gets its own token PATTERN — a different multiplier and modulus
 * — so one account's token series is not a function of another's.
 *
 * The accounts SHARE their bin indices unless a test says otherwise, because
 * that is what concurrent polling produces and it is the only case the matched
 * join can pair at all.
 */
function accountBins(
	accountId: string,
	firstIndex: number,
	count: number,
	pattern: { mult: number; mod: number },
	ratio = 2e-6,
): LedgerBin[] {
	const bins: LedgerBin[] = [];
	for (let i = 0; i < count; i++) {
		const tokens = 10_000 * (1 + ((i * pattern.mult) % pattern.mod));
		bins.push(
			makeBin({
				accountId,
				index: firstIndex + i,
				dPct: tokens * ratio,
				tokens: { "sonnet/input": tokens },
			}),
		);
	}
	return bins;
}

const THREE_ACCOUNTS = [
	...accountBins("acct-a", 0, 60, { mult: 37, mod: 50 }),
	...accountBins("acct-b", 0, 60, { mult: 13, mod: 47 }),
	...accountBins("acct-c", 0, 60, { mult: 29, mod: 41 }),
];

/**
 * Two accounts that take turns being busy.
 *
 * `acct-even` spends and rises on even bins, `acct-odd` on odd ones, and both
 * carry a bin at every edge, so the edge join keeps all of them. From
 * `alsoRisingFrom` onward BOTH accounts rise in every bin whoever spent, which
 * is the only stretch where a donor is moving while a recipient spends — the
 * coincidences a placebo needs before it can be wrong about anything.
 */
function alternatingActivity(
	count: number,
	alsoRisingFrom = Number.POSITIVE_INFINITY,
): LedgerBin[] {
	const bins: LedgerBin[] = [];
	for (let i = 0; i < count; i++) {
		const spender = i % 2 === 0 ? "acct-even" : "acct-odd";
		const tokens = 10_000 * (1 + (i % 7));
		for (const accountId of ["acct-even", "acct-odd"]) {
			const spends = accountId === spender;
			bins.push(
				makeBin({
					accountId,
					index: i,
					dPct: spends || i >= alsoRisingFrom ? tokens * 2e-6 : 0,
					tokens: spends ? { "sonnet/input": tokens } : {},
				}),
			);
		}
	}
	return bins;
}

describe("permutedAccountRelationR2", () => {
	test("pairs each account's tokens with ANOTHER account's percent series", () => {
		const real = aggregateRelation(THREE_ACCOUNTS).r2 as number;
		expect(real).toBeCloseTo(1, 10);
		const control = permutedAccountRelationR2(THREE_ACCOUNTS, 20260823);
		expect(control.insufficient).toBe(false);
		expect(control.accounts).toBe(3);
		expect(control.pairedBins).toBe(180);
		// The UNCENTERED R-squared has a high floor: permuted tokens still share
		// the real ones' scale, so a placebo of ~0.6 is normal and "beats zero" is
		// not a meaningful test. That floor is exactly why the criterion is a
		// MARGIN over the control rather than a bare comparison.
		expect(control.r2 as number).toBeLessThan(real - CONTROL_MARGIN);
		// The margin the caller uses is carried by the control itself, both terms
		// over the matched cohort — here the whole group, so the treatment is the
		// same exact relation.
		expect(control.treatmentR2 as number).toBeCloseTo(1, 10);
		// Deterministic for a fixed seed.
		expect(permutedAccountRelationR2(THREE_ACCOUNTS, 20260823).r2).toBe(
			control.r2,
		);
	});

	test("a single-account group cannot be permuted at all", () => {
		const control = permutedAccountRelationR2(
			accountBins("solo", 0, 200, { mult: 37, mod: 50 }),
			20260823,
		);
		expect(control.r2).toBeNull();
		expect(control.treatmentR2).toBeNull();
		expect(control.insufficient).toBe(true);
		expect(control.accounts).toBe(1);
		expect(control.detail).toContain("at least two accounts");
	});

	test("too few matched bins is null, never 0", () => {
		const control = permutedAccountRelationR2(
			[
				...accountBins("acct-a", 0, 10, { mult: 37, mod: 50 }),
				...accountBins("acct-b", 0, 10, { mult: 13, mod: 47 }),
			],
			20260823,
		);
		expect(control.r2).toBeNull();
		expect(control.treatmentR2).toBeNull();
		expect(control.insufficient).toBe(true);
		expect(control.pairedBins).toBe(20);
	});

	test("two accounts that never share a bin edge cannot be compared at all", () => {
		// Disjoint in TIME: there is no interval where both series exist, so there
		// is no pairing to break and no placebo to measure. Aligning them by
		// ordinal position would invent one out of two unrelated stretches of
		// history.
		const control = permutedAccountRelationR2(
			[
				...accountBins("acct-a", 0, 200, { mult: 37, mod: 50 }),
				...accountBins("acct-b", 1_000, 200, { mult: 13, mod: 47 }),
			],
			20260823,
		);
		expect(control.r2).toBeNull();
		expect(control.insufficient).toBe(true);
		expect(control.pairedBins).toBe(0);
		expect(control.detail).toContain("matched on identical edges");
	});

	test("unequal-length accounts are joined on bin edges, not ordinal position", () => {
		// `acct-b` starts 20 bins later and ends with the other. Only the overlap
		// can be paired, and a bin outside it may not influence the result: the
		// truncated fixture must produce the IDENTICAL control. Under ordinal
		// alignment it does not — there `acct-a`'s first bin is paired with
		// `acct-b`'s first, twenty bins apart in wall-clock time.
		const overlapping = [
			...accountBins("acct-a", 0, 60, { mult: 37, mod: 50 }),
			...accountBins("acct-b", 20, 40, { mult: 13, mod: 47 }),
		];
		const restricted = overlapping.filter((b) => b.startMs >= 20 * W);
		const control = permutedAccountRelationR2(overlapping, 20260823);
		const sameCohort = permutedAccountRelationR2(restricted, 20260823);
		expect(control.insufficient).toBe(false);
		expect(control.pairedBins).toBe(80);
		expect(sameCohort.pairedBins).toBe(80);
		expect(control.r2).toBe(sameCohort.r2);
		expect(control.treatmentR2).toBe(sameCohort.treatmentR2);
	});

	test("a hole in one account's series removes those edges from the pairing", () => {
		// `acct-b` is missing ten bins in the middle — an outage, a saturated
		// stretch, any reason a bin is not clean. The pairs that would have used
		// them are gone from BOTH directions, and nothing shifts up to fill the
		// hole.
		const hole = (b: LedgerBin) =>
			b.accountId === "acct-b" && b.startMs >= 25 * W && b.startMs < 35 * W;
		const withHole = [
			...accountBins("acct-a", 0, 60, { mult: 37, mod: 50 }),
			...accountBins("acct-b", 0, 60, { mult: 13, mod: 47 }),
		].filter((b) => !hole(b));
		const withoutThoseEdges = withHole.filter(
			(b) => !(b.startMs >= 25 * W && b.startMs < 35 * W),
		);
		const control = permutedAccountRelationR2(withHole, 20260823);
		const sameCohort = permutedAccountRelationR2(withoutThoseEdges, 20260823);
		expect(control.pairedBins).toBe(100);
		expect(sameCohort.pairedBins).toBe(100);
		expect(control.r2).toBe(sameCohort.r2);
		expect(control.treatmentR2).toBe(sameCohort.treatmentR2);
	});

	test("treatment and placebo are fitted over the SAME matched cohort", () => {
		// The two accounts burn at different prices and overlap only in part, so
		// the matched cohort's own relation is NOT the whole group's. The control's
		// treatment score must be the matched cohort's, or the margin would
		// compare two different sets of bins and call the difference a placebo
		// effect.
		const bins = [
			...accountBins("acct-a", 0, 60, { mult: 37, mod: 50 }, 2e-6),
			...accountBins("acct-b", 20, 40, { mult: 13, mod: 47 }, 8e-6),
		];
		const matched = bins.filter((b) => b.startMs >= 20 * W);
		const control = permutedAccountRelationR2(bins, 20260823);
		expect(control.pairedBins).toBe(matched.length);
		expect(control.treatmentR2 as number).toBeCloseTo(
			aggregateRelation(matched).r2 as number,
			12,
		);
		expect(control.treatmentR2 as number).not.toBeCloseTo(
			aggregateRelation(bins).r2 as number,
			3,
		);
	});

	test("a placebo with no coincidences to score on is unmeasurable, not a beaten control", () => {
		// Two accounts that are never busy at the same time. Every bin edge is
		// matched, so the join keeps all 240 recipient bins, and the TREATMENT has
		// 120 positive-signal bins — comfortably over the floor. The PLACEBO has
		// none at all: every bin where the recipient spent tokens is a bin where
		// its donor sat still.
		const bins = alternatingActivity(120);

		// What the one-sided floor accepted: the matched cohort's own treatment fit
		// against its own placebo fit, a margin manufactured entirely by the two
		// accounts' non-overlapping activity.
		const xs: number[] = [];
		const treatmentYs: number[] = [];
		const placeboYs: number[] = [];
		for (const accountId of ["acct-even", "acct-odd"]) {
			const donorId = accountId === "acct-even" ? "acct-odd" : "acct-even";
			for (let i = 0; i < 120; i++) {
				const mine = bins.find(
					(b) => b.accountId === accountId && b.startMs === i * W,
				) as LedgerBin;
				const theirs = bins.find(
					(b) => b.accountId === donorId && b.startMs === i * W,
				) as LedgerBin;
				xs.push(mine.grossTokens);
				treatmentYs.push(mine.dPct);
				placeboYs.push(theirs.dPct);
			}
		}
		const fakeMargin =
			(noInterceptR2(xs, treatmentYs).r2 as number) -
			(noInterceptR2(xs, placeboYs).r2 as number);
		expect(fakeMargin).toBeGreaterThan(CONTROL_MARGIN);

		const control = permutedAccountRelationR2(bins, 20260823);
		expect(control.r2).toBeNull();
		expect(control.treatmentR2).toBeNull();
		expect(control.insufficient).toBe(true);
		expect(control.pairedBins).toBe(240);
		expect(control.detail).toContain(
			"(120 positive-signal for the treatment, 0 for the placebo)",
		);
		expect(control.detail).toContain("on EACH side");
	});

	test("the symmetric floor is a floor on each side, not on the pair", () => {
		// Enough overlap for the placebo to reach the minimum: the accounts alternate
		// as above, except that every account also rises on the LAST 60 bins, so the
		// donor is moving while the recipient spends.
		const overlapFrom = 60;
		const bins = alternatingActivity(120, overlapFrom);
		const control = permutedAccountRelationR2(bins, 20260823);
		expect(control.insufficient).toBe(false);
		expect(control.detail).toContain("for the placebo");
		expect(control.r2).not.toBeNull();
		expect(control.treatmentR2).not.toBeNull();
	});

	test("both sides' positive-signal counts are reported when the control IS measured", () => {
		const control = permutedAccountRelationR2(THREE_ACCOUNTS, 20260823);
		expect(control.insufficient).toBe(false);
		expect(control.detail).toContain(
			"(180 positive-signal for the treatment, 180 for the placebo)",
		);
	});

	test("contaminated bins never enter the placebo", () => {
		const dirty = THREE_ACCOUNTS.map((b) =>
			b.accountId === "acct-c" ? { ...b, saturated: true, usable: false } : b,
		);
		const control = permutedAccountRelationR2(dirty, 20260823);
		expect(control.accounts).toBe(2);
		expect(control.pairedBins).toBe(120);
	});
});

// ---------------------------------------------------------------------------
// selectCell
// ---------------------------------------------------------------------------

function score(r2: number | null): {
	r2: number | null;
	usableBins: number;
	positiveSignalBins: number;
} {
	return { r2, usableBins: 500, positiveSignalBins: 200 };
}

function cell(
	lagMinutes: number,
	widthMinutes: number,
	anchor: BinAnchor,
	selectionR2: number | null,
	evaluationR2: number | null,
	control = false,
): CellScore {
	return {
		cell: { lagMs: lagMinutes * MIN, widthMs: widthMinutes * MIN, anchor },
		selection: score(selectionR2),
		evaluation: score(evaluationR2),
		control,
	};
}

/**
 * A measured permutation control, so tests can vary just its score.
 *
 * `treatmentR2` is the control's OWN matched-cohort treatment score, which is
 * what the margin is taken against — 0.8 matches the healthy grid's selected
 * cell, so a placebo score is read the same way a reader would read it.
 */
function perm(
	r2: number | null,
	{ treatmentR2 = 0.8, seed = 20260823 } = {},
): PermutationControl {
	return {
		seed,
		r2,
		treatmentR2: r2 == null ? null : treatmentR2,
		accounts: r2 == null ? 0 : 3,
		pairedBins: r2 == null ? 0 : 180,
		insufficient: r2 == null,
		detail:
			r2 == null ? "not measurable in this fixture" : "3 accounts deranged",
	};
}

/**
 * A grid that passes everything, so each test can break exactly one thing.
 *
 * The controls sit at `-(width + offset)` for offsets of 2 and 4 minutes, which
 * at a 10-minute width is -12 and -14: the real construction, so the width and
 * anchor gating below is exercised against real cell keys.
 */
function healthyGrid(): CellScore[] {
	const cells: CellScore[] = [];
	for (const lag of [0, 2, 4]) {
		for (const anchor of ["terminal", "start"] as const) {
			const r2 = lag === 2 ? 0.8 : 0.7;
			cells.push(cell(lag, 10, anchor, r2, r2));
		}
	}
	for (const anchor of ["terminal", "start"] as const) {
		cells.push(cell(-12, 10, anchor, 0.1, 0.1, true));
		cells.push(cell(-14, 10, anchor, 0.05, 0.05, true));
	}
	return cells;
}

describe("selectCell", () => {
	test("a healthy grid selects the best selection-block cell and passes", () => {
		const selection = selectCell(healthyGrid(), perm(0.05));
		expect(selection.selected).toEqual({
			lagMs: 2 * MIN,
			widthMs: 10 * MIN,
			anchor: "terminal",
		});
		expect(selection.selectionR2).toBe(0.8);
		expect(selection.evaluationR2).toBe(0.8);
		expect(selection.stabilityPass).toBe(true);
		expect(selection.controlsPass).toBe(true);
		expect(selection.verdict).toBe("pass");
	});

	test("ties break by widest width, then smallest lag, then the terminal anchor", () => {
		const cells: CellScore[] = [
			cell(4, 5, "terminal", 0.6, 0.6),
			cell(4, 10, "terminal", 0.6, 0.6),
			cell(2, 10, "terminal", 0.6, 0.6),
			cell(2, 10, "start", 0.6, 0.6),
			cell(0, 10, "terminal", 0.6, 0.6),
			cell(0, 10, "start", 0.6, 0.6),
			cell(-12, 10, "terminal", 0.1, 0.1, true),
		];
		const selection = selectCell(cells, perm(0.1));
		// Widest first (10 over 5), then the smallest absolute lag (0 over 2 and
		// 4), then the terminal anchor.
		expect(selection.selected).toEqual({
			lagMs: 0,
			widthMs: 10 * MIN,
			anchor: "terminal",
		});
	});

	test("a control that is not beaten by the margin invalidates the cell", () => {
		const cells = healthyGrid().map((c) =>
			c.control && c.cell.lagMs === -12 * MIN
				? { ...c, evaluation: score(0.8 - CONTROL_MARGIN / 2) }
				: c,
		);
		const selection = selectCell(cells, perm(0.05));
		expect(selection.controlsPass).toBe(false);
		expect(selection.controlsMeasurable).toBe(true);
		expect(selection.verdict).toBe("fail");
		expect(selection.verdictDetail).toContain("INVALID");
	});

	test("a permutation control scoring as well as the cell invalidates it", () => {
		const selection = selectCell(healthyGrid(), perm(0.79));
		expect(selection.controlsPass).toBe(false);
		expect(selection.verdict).toBe("fail");
	});

	test("a grid without any control cannot pass", () => {
		const cells = healthyGrid().filter((c) => !c.control);
		const selection = selectCell(cells, perm(0.05));
		expect(selection.controlsPass).toBe(false);
		expect(selection.controlsMeasurable).toBe(false);
		expect(selection.verdict).toBe("insufficient-evidence");
		expect(selection.controlDetails.join(" ")).toContain(
			"without a like-for-like placebo",
		);
	});

	test("only controls at the selected cell's width and anchor gate it", () => {
		const cells = [
			...healthyGrid(),
			// Controls at OTHER widths that score as well as the selected cell. They
			// bin the same history at a different quantisation, so they are not the
			// same experiment and must not touch the verdict.
			cell(-4, 2, "terminal", 0.05, 0.79, true),
			cell(-6, 2, "terminal", 0.05, 0.79, true),
			cell(-4, 2, "start", 0.05, 0.79, true),
			cell(-7, 5, "terminal", 0.05, 0.79, true),
		];
		const selection = selectCell(cells, perm(0.05));
		expect(selection.selected?.widthMs).toBe(10 * MIN);
		expect(selection.controlsPass).toBe(true);
		expect(selection.verdict).toBe("pass");
		expect(selection.controlDetails.join(" ")).not.toContain("W=2min");
		expect(selection.controlDetails.join(" ")).not.toContain("W=5min");
	});

	test("an anchor with NO evaluation score leaves stability unmeasurable, not failed", () => {
		// The other anchor at the selected cell scored nothing at all, so neither
		// "both anchors clear the threshold" nor the gap between them was ever
		// measured. Everything else holds. Reporting that as a stability FAILURE
		// would state a result no number backs.
		const cells = healthyGrid().map((c) =>
			!c.control && c.cell.lagMs === 2 * MIN && c.cell.anchor === "start"
				? { ...c, evaluation: score(null) }
				: c,
		);
		const selection = selectCell(cells, perm(0.05));
		expect(selection.selected?.anchor).toBe("terminal");
		expect(selection.stabilityMeasuredFailure).toBe(false);
		expect(selection.stabilityMeasurable).toBe(false);
		expect(selection.stabilityPass).toBe(false);
		expect(selection.controlsMeasurable).toBe(true);
		expect(selection.verdict).toBe("insufficient-evidence");
		expect(selection.verdictDetail).toContain("stability sub-check");
		expect(selection.verdictDetail).toContain(
			"both anchors clearing the threshold",
		);
		expect(selection.verdictDetail).toContain("the anchor gap");
		expect(selection.stabilityDetails.join(" ")).toContain("UNMEASURABLE");
	});

	test("an unmeasurable stability check cannot un-refute a measured control failure", () => {
		// One adjacent lag scored nothing and the other is below the threshold, so
		// the plateau is short by a lag nobody measured — and a control that DID
		// produce a number was not beaten by it. The measured refutation stands.
		const cells = healthyGrid().map((c) => {
			if (!c.control && c.cell.lagMs === 0) {
				return { ...c, evaluation: score(null) };
			}
			if (!c.control && c.cell.lagMs === 4 * MIN) {
				return { ...c, evaluation: score(0.2) };
			}
			if (c.control && c.cell.lagMs === -12 * MIN) {
				return { ...c, evaluation: score(0.8 - CONTROL_MARGIN / 2) };
			}
			return c;
		});
		const selection = selectCell(cells, perm(0.05));
		expect(selection.stabilityMeasurable).toBe(false);
		expect(selection.stabilityMeasuredFailure).toBe(false);
		expect(selection.controlsMeasurable).toBe(true);
		expect(selection.verdict).toBe("fail");
		expect(selection.verdictDetail).toContain("INVALID");
		expect(selection.stabilityDetails.join(" ")).toContain(
			"produced no evaluation score — UNMEASURABLE",
		);
	});

	test("a fully measured plateau failure is a FAIL, with no null anywhere near it", () => {
		// Every lag at the selected width has a number and the neighbours are below
		// the threshold: the shortfall was measured, so it refutes the cell.
		const cells: CellScore[] = [
			cell(0, 10, "terminal", 0.2, 0.2),
			cell(0, 10, "start", 0.2, 0.2),
			cell(2, 10, "terminal", 0.9, 0.9),
			cell(2, 10, "start", 0.9, 0.9),
			cell(4, 10, "terminal", 0.2, 0.2),
			cell(4, 10, "start", 0.2, 0.2),
			cell(-12, 10, "terminal", 0.05, 0.05, true),
			cell(-12, 10, "start", 0.05, 0.05, true),
		];
		const selection = selectCell(cells, perm(0.05));
		expect(selection.stabilityMeasurable).toBe(true);
		expect(selection.stabilityMeasuredFailure).toBe(true);
		expect(selection.stabilityPass).toBe(false);
		expect(selection.verdict).toBe("fail");
		expect(selection.verdictDetail).toContain(
			"did not hold across both anchors",
		);
		expect(selection.stabilityDetails.join(" ")).not.toContain("UNMEASURABLE");
	});

	test("with every input present, stability reads exactly as it did before", () => {
		// The shape of the live report: all four scores at the selected cell, both
		// neighbours scored, nothing null. A measured pass stays a pass and a
		// measured anchor failure stays a failure.
		const healthy = selectCell(healthyGrid(), perm(0.05));
		expect(healthy.stabilityPass).toBe(true);
		expect(healthy.stabilityMeasurable).toBe(true);
		expect(healthy.stabilityMeasuredFailure).toBe(false);
		expect(healthy.verdict).toBe("pass");

		const belowThreshold = selectCell(
			healthyGrid().map((c) =>
				!c.control && c.cell.lagMs === 2 * MIN && c.cell.anchor === "start"
					? { ...c, evaluation: score(0.3) }
					: c,
			),
			perm(0.05),
		);
		expect(belowThreshold.stabilityMeasurable).toBe(true);
		expect(belowThreshold.stabilityMeasuredFailure).toBe(true);
		expect(belowThreshold.verdict).toBe("fail");
	});

	test("one anchor measurably below the threshold refutes stability whatever the other did", () => {
		// The mirror-image error: a missing score beside a MEASURED violation must
		// not launder that violation into "we do not know".
		const cells = healthyGrid().map((c) => {
			if (!c.control && c.cell.lagMs === 2 * MIN) {
				return {
					...c,
					evaluation: score(c.cell.anchor === "start" ? null : 0.2),
				};
			}
			return c;
		});
		const selection = selectCell(cells, perm(0.05));
		expect(selection.stabilityMeasuredFailure).toBe(true);
		expect(selection.verdict).toBe("fail");
	});

	test("a control at the OTHER anchor does not gate the selected cell either", () => {
		const cells = healthyGrid().map((c) =>
			c.control && c.cell.anchor === "start"
				? { ...c, evaluation: score(0.79) }
				: c,
		);
		const selection = selectCell(cells, perm(0.05));
		expect(selection.selected?.anchor).toBe("terminal");
		expect(selection.controlsPass).toBe(true);
		expect(selection.verdict).toBe("pass");
	});

	test("a mandatory control with NO number is insufficient evidence, not a pass or a fail", () => {
		// The permutation could not be run at all, and every MEASURED check holds.
		const noPermutation = selectCell(healthyGrid(), perm(null));
		expect(noPermutation.controlsPass).toBe(false);
		expect(noPermutation.controlsMeasurable).toBe(false);
		expect(noPermutation.stabilityPass).toBe(true);
		expect(noPermutation.verdict).toBe("insufficient-evidence");
		expect(noPermutation.controlDetails.join(" ")).toContain("not measurable");

		// A future-token control at the selected width and anchor that scored null.
		const cells = healthyGrid().map((c) =>
			c.control && c.cell.anchor === "terminal" && c.cell.lagMs === -12 * MIN
				? { ...c, evaluation: score(null) }
				: c,
		);
		const noFutureControl = selectCell(cells, perm(0.05));
		expect(noFutureControl.controlsMeasurable).toBe(false);
		expect(noFutureControl.verdict).toBe("insufficient-evidence");
		expect(noFutureControl.controlDetails.join(" ")).toContain("UNMEASURABLE");
	});

	test("a MEASURED control failure outranks an unmeasurable one: FAIL, not unknown", () => {
		// One control has a number and was not beaten by it; the permutation has no
		// number at all. The refutation stands: an experiment that could not be run
		// cannot un-refute the one that was.
		const cells = healthyGrid().map((c) =>
			c.control && c.cell.lagMs === -12 * MIN
				? { ...c, evaluation: score(0.8 - CONTROL_MARGIN / 2) }
				: c,
		);
		const selection = selectCell(cells, perm(null));
		expect(selection.controlsMeasurable).toBe(false);
		expect(selection.verdict).toBe("fail");
		expect(selection.verdictDetail).toContain("INVALID");
		expect(selection.verdictDetail).toContain("measured failure is decisive");
	});

	test("a threshold failure alongside an unmeasurable control is still a FAIL", () => {
		const cells: CellScore[] = [
			cell(0, 10, "terminal", 0.3, 0.3),
			cell(0, 10, "start", 0.3, 0.3),
			cell(2, 10, "terminal", 0.28, 0.28),
			cell(2, 10, "start", 0.28, 0.28),
			cell(-12, 10, "terminal", 0.01, 0.01, true),
			cell(-12, 10, "start", 0.01, 0.01, true),
		];
		const selection = selectCell(cells, perm(null));
		expect(selection.controlsMeasurable).toBe(false);
		expect(selection.verdict).toBe("fail");
		expect(selection.verdictDetail).toContain("below the threshold");
	});

	test("a stability failure alongside an unmeasurable control is still a FAIL", () => {
		// One isolated lag clears the threshold; its neighbours do not.
		const cells: CellScore[] = [
			cell(0, 10, "terminal", 0.2, 0.2),
			cell(0, 10, "start", 0.2, 0.2),
			cell(2, 10, "terminal", 0.9, 0.9),
			cell(2, 10, "start", 0.9, 0.9),
			cell(4, 10, "terminal", 0.2, 0.2),
			cell(4, 10, "start", 0.2, 0.2),
			cell(-12, 10, "terminal", 0.05, 0.05, true),
			cell(-12, 10, "start", 0.05, 0.05, true),
		];
		const selection = selectCell(cells, perm(null));
		expect(selection.stabilityPass).toBe(false);
		expect(selection.controlsMeasurable).toBe(false);
		expect(selection.verdict).toBe("fail");
	});

	test("the permutation margin is the control's own, not the cell's full-cohort score", () => {
		// The selected cell scores 0.8 over its whole cohort, but the matched
		// cohort the placebo could be measured on scores 0.2 — and the placebo
		// itself 0.19. Taking the margin against the cell's 0.8 would report a
		// comfortable 0.61 for a placebo that in fact matched its treatment.
		const selection = selectCell(
			healthyGrid(),
			perm(0.19, { treatmentR2: 0.2 }),
		);
		expect(selection.controlsPass).toBe(false);
		expect(selection.controlsMeasurable).toBe(true);
		expect(selection.verdict).toBe("fail");
		expect(selection.controlDetails.join(" ")).toContain(
			"matched-cohort treatment R2 0.200 against placebo R2 0.190",
		);
	});

	test("anchors that disagree by more than the tolerance fail stability", () => {
		const cells = healthyGrid().map((c) =>
			!c.control && c.cell.lagMs === 2 * MIN && c.cell.anchor === "start"
				? { ...c, evaluation: score(0.8 - ANCHOR_STABILITY_MAX_GAP - 0.05) }
				: c,
		);
		const selection = selectCell(cells, perm(0.05));
		expect(selection.stabilityPass).toBe(false);
		expect(selection.verdict).toBe("fail");
	});

	test("an isolated lag spike fails the adjacent-lag requirement", () => {
		const cells: CellScore[] = [
			cell(0, 10, "terminal", 0.2, 0.2),
			cell(0, 10, "start", 0.2, 0.2),
			cell(2, 10, "terminal", 0.9, 0.9),
			cell(2, 10, "start", 0.9, 0.9),
			cell(4, 10, "terminal", 0.2, 0.2),
			cell(4, 10, "start", 0.2, 0.2),
			cell(-12, 10, "terminal", 0.05, 0.05, true),
			cell(-12, 10, "start", 0.05, 0.05, true),
		];
		const selection = selectCell(cells, perm(0.05));
		expect(selection.selected?.lagMs).toBe(2 * MIN);
		expect(selection.stabilityPass).toBe(false);
		expect(selection.stabilityDetails.join(" ")).toContain("contiguous lags");
	});

	test("a cell below the threshold fails even with clean controls", () => {
		const cells: CellScore[] = [
			cell(0, 10, "terminal", 0.3, 0.3),
			cell(0, 10, "start", 0.3, 0.3),
			cell(2, 10, "terminal", 0.28, 0.28),
			cell(2, 10, "start", 0.28, 0.28),
			cell(-12, 10, "terminal", 0.01, 0.01, true),
			cell(-12, 10, "start", 0.01, 0.01, true),
		];
		const selection = selectCell(cells, perm(0.01));
		expect(selection.evaluationR2 as number).toBeLessThan(R2_PASS_THRESHOLD);
		expect(selection.verdict).toBe("fail");
	});

	test("no scorable cell is insufficient evidence, not a failure", () => {
		const selection = selectCell(
			[
				cell(0, 10, "terminal", null, null),
				cell(-12, 10, "terminal", null, null, true),
			],
			perm(null),
		);
		expect(selection.selected).toBeNull();
		expect(selection.verdict).toBe("insufficient-evidence");
	});

	test("a control cell is never itself selected", () => {
		const cells: CellScore[] = [
			cell(-12, 10, "terminal", 0.99, 0.99, true),
			cell(0, 10, "terminal", 0.6, 0.6),
			cell(0, 10, "start", 0.6, 0.6),
			cell(2, 10, "terminal", 0.6, 0.6),
			cell(2, 10, "start", 0.6, 0.6),
		];
		expect(selectCell(cells, perm(0.1)).selected?.lagMs).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// eraStability
// ---------------------------------------------------------------------------

const BOUNDARY: EraBoundary = {
	label: "test boundary",
	atMs: 200 * W,
	provenance: "fixed constant",
};

/** Pure single-column bins for one account, on one side of the boundary. */
function pureBins(
	accountId: string,
	firstIndex: number,
	count: number,
	ratio: number,
): LedgerBin[] {
	const bins: LedgerBin[] = [];
	for (let i = 0; i < count; i++) {
		const tokens = 100_000 * (1 + (i % 3));
		bins.push(
			makeBin({
				accountId,
				index: firstIndex + i,
				dPct: tokens * ratio,
				tokens: { "sonnet/input": tokens },
			}),
		);
	}
	return bins;
}

describe("eraStability", () => {
	test("no stratum with enough pure bins is insufficient evidence", () => {
		const bins = [
			...pureBins("acct-1", 100, 5, 2e-6),
			...pureBins("acct-1", 300, 5, 2e-6),
		];
		const era = eraStability(bins, [BOUNDARY], { seed: 1, iterations: 50 });
		expect(era.verdict).toBe("insufficient-evidence");
		expect(era.boundaries[0].qualifyingStrata).toBe(0);
	});

	test("an unchanged ratio passes with a measured relative change of zero", () => {
		const bins = [
			...pureBins("acct-1", 100, 40, 2e-6),
			...pureBins("acct-1", 300, 40, 2e-6),
			...pureBins("acct-2", 140, 40, 2e-6),
			...pureBins("acct-2", 340, 40, 2e-6),
		];
		const era = eraStability(bins, [BOUNDARY], { seed: 1, iterations: 200 });
		expect(era.boundaries[0].qualifyingStrata).toBe(2);
		expect(era.boundaries[0].relativeChange).toBeCloseTo(0, 12);
		expect(era.boundaries[0].materialShift).toBe(false);
		expect(era.verdict).toBe("pass");
	});

	test("a doubled ratio with disjoint intervals is a material shift", () => {
		const bins = [
			...pureBins("acct-1", 100, 40, 2e-6),
			...pureBins("acct-1", 300, 40, 4e-6),
			...pureBins("acct-2", 140, 40, 2e-6),
			...pureBins("acct-2", 340, 40, 4e-6),
		];
		const era = eraStability(bins, [BOUNDARY], { seed: 1, iterations: 200 });
		expect(era.boundaries[0].relativeChange).toBeCloseTo(1, 6);
		expect(era.boundaries[0].ciDisjoint).toBe(true);
		expect(era.boundaries[0].materialShift).toBe(true);
		expect(era.verdict).toBe("fail");
	});

	test("mixed-column bins never qualify: a mixed bin cannot be attributed", () => {
		const bins: LedgerBin[] = [];
		for (let i = 0; i < 80; i++) {
			bins.push(
				makeBin({
					index: 100 + i * 3,
					dPct: 1,
					tokens: { "sonnet/input": 100_000, "opus/input": 100_000 },
				}),
			);
		}
		const era = eraStability(bins, [BOUNDARY], { seed: 1, iterations: 50 });
		expect(era.boundaries[0].qualifyingStrata).toBe(0);
		expect(era.verdict).toBe("insufficient-evidence");
	});

	test("is deterministic for a fixed seed", () => {
		const bins = [
			...pureBins("acct-1", 100, 40, 2e-6),
			...pureBins("acct-1", 300, 40, 2.2e-6),
			...pureBins("acct-2", 140, 40, 2e-6),
			...pureBins("acct-2", 340, 40, 2.4e-6),
		];
		const a = eraStability(bins, [BOUNDARY], { seed: 99, iterations: 200 });
		const b = eraStability(bins, [BOUNDARY], { seed: 99, iterations: 200 });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	/** A boundary past every bin: nothing on its far side, so nothing is known. */
	const UNMEASURABLE: EraBoundary = {
		label: "unmeasurable boundary",
		atMs: 5_000 * W,
		provenance: "fixed constant",
	};

	test("ONE unmeasurable boundary makes the whole entry insufficient evidence", () => {
		const bins = [
			...pureBins("acct-1", 100, 40, 2e-6),
			...pureBins("acct-1", 300, 40, 2e-6),
			...pureBins("acct-2", 140, 40, 2e-6),
			...pureBins("acct-2", 340, 40, 2e-6),
		];
		const era = eraStability(bins, [BOUNDARY, UNMEASURABLE], {
			seed: 1,
			iterations: 200,
		});
		expect(era.boundaries[0].verdict).toBe("pass");
		expect(era.boundaries[1].verdict).toBe("insufficient-evidence");
		// The measurable boundary held, but a ratio that held across the boundary
		// the study could look at says nothing about the one it could not.
		expect(era.verdict).toBe("insufficient-evidence");
		expect(era.detail).toContain("1 of 2 boundaries");
	});

	test("a material shift still FAILS even alongside an unmeasurable boundary", () => {
		const bins = [
			...pureBins("acct-1", 100, 40, 2e-6),
			...pureBins("acct-1", 300, 40, 4e-6),
			...pureBins("acct-2", 140, 40, 2e-6),
			...pureBins("acct-2", 340, 40, 4e-6),
		];
		const era = eraStability(bins, [BOUNDARY, UNMEASURABLE], {
			seed: 1,
			iterations: 200,
		});
		expect(era.verdict).toBe("fail");
	});
});

// ---------------------------------------------------------------------------
// capabilityMatrix and the report
// ---------------------------------------------------------------------------

function matrixInput(
	overrides: Partial<Parameters<typeof capabilityMatrix>[0]> = {},
) {
	const bins = [
		...proportionalBins(400, "acct-1"),
		...proportionalBins(400, "acct-2").map((b) => ({
			...b,
			startMs: b.startMs + 1_000 * W,
			endMs: b.endMs + 1_000 * W,
		})),
	];
	return {
		provider: "anthropic",
		windowKind: "seven_day" as const,
		evaluationBins: bins,
		selectionBins: bins,
		cellScores: healthyGrid(),
		permutation: perm(0.05),
		eraBoundaries: [BOUNDARY],
		seed: 20260823,
		...overrides,
	};
}

describe("tier provenance", () => {
	test("is the same fixed text for every group, whatever the group is", () => {
		// The entry is a constant, so no identity refresh of a live `accounts` row
		// can move a byte of it, and no group can report a different one.
		const detailOf = (group: ReturnType<typeof capabilityMatrix>) =>
			group.entries.find((e) => e.name === "tier provenance")?.detail;
		const anthropic = detailOf(capabilityMatrix(matrixInput()));
		const codex = detailOf(
			capabilityMatrix(
				matrixInput({ provider: "codex", windowKind: "seven_day" as const }),
			),
		);
		expect(anthropic).toBeDefined();
		expect(codex).toBe(anthropic as string);
	});

	test("states the schema constraint and no live tier at all", () => {
		const entry = capabilityMatrix(matrixInput()).entries.find(
			(e) => e.name === "tier provenance",
		);
		expect(entry?.detail).toContain("No account has in-range tier provenance");
		expect(entry?.detail).toContain("usage_snapshots");
		expect(entry?.detail).toContain("requests");
		// No tier VALUE, no count of the accounts carrying one, no capture
		// relation: all three come from a mutable live column.
		expect(entry?.detail).not.toMatch(/\d/);
		expect(entry?.detail).not.toContain("20x");
		expect(entry?.detail).not.toContain("study range");
	});
});

describe("capabilityMatrix", () => {
	test("an excluded group is insufficient evidence with the exclusion reason", () => {
		const group = capabilityMatrix(
			matrixInput({ provider: "codex", windowKind: "five_hour" }),
		);
		expect(group.verdict).toBe("insufficient-evidence");
		expect(group.excludedReason).toContain("2026-07-12");
		expect(group.eligible).toBe(false);
		expect(group.relation).toBeNull();
	});

	test("a group below the exposure floor is insufficient evidence", () => {
		const group = capabilityMatrix(
			matrixInput({ evaluationBins: proportionalBins(3), selectionBins: [] }),
		);
		expect(group.eligible).toBe(false);
		expect(group.verdict).toBe("insufficient-evidence");
		expect(group.eligibilityDetail).toContain("equivalent 2-minute bins");
	});

	test("the exposure floor counts CLEAN-cohort milliseconds only", () => {
		// Far more than the floor's worth of observed time, every millisecond of
		// it in a bin the primary metrics then discard.
		const dirty = proportionalBins(400).map((b) => ({
			...b,
			saturated: true,
			usable: false,
		}));
		const group = capabilityMatrix(
			matrixInput({ evaluationBins: dirty, selectionBins: dirty }),
		);
		expect(group.census.equivalentBins).toBeGreaterThan(
			MIN_GROUP_EQUIVALENT_BINS,
		);
		expect(group.census.usableEquivalentBins).toBe(0);
		expect(group.eligible).toBe(false);
		expect(group.verdict).toBe("insufficient-evidence");
		expect(group.eligibilityDetail).toContain("CLEAN-cohort");
	});

	test("an unselectable group is insufficient evidence with the stated reason", () => {
		const group = capabilityMatrix(
			matrixInput({
				evaluationBins: [],
				selectionBins: [],
				permutation: perm(null),
				analysisUnavailable:
					"No cell reached the minimum usable and positive-signal bin counts on the selection block, so no cell was selected and no bins were analysed.",
			}),
		);
		expect(group.eligible).toBe(false);
		expect(group.verdict).toBe("insufficient-evidence");
		// NOT the exposure message, which would be true of the empty input and
		// false about the group.
		expect(group.eligibilityDetail).toContain("no cell was selected");
		expect(group.eligibilityDetail).not.toContain("exposure");
		expect(group.relation).toBeNull();
	});

	test("an unmeasurable control makes the relation insufficient, not failed", () => {
		const group = capabilityMatrix(matrixInput({ permutation: perm(null) }));
		expect(group.selection.controlsMeasurable).toBe(false);
		expect(group.selection.verdict).toBe("insufficient-evidence");
		expect(
			group.entries.find((e) => e.name === "aggregate relation")?.verdict,
		).toBe("insufficient-evidence");
		expect(group.verdict).toBe("insufficient-evidence");
	});

	test("a synthetic group that satisfies every criterion passes", () => {
		const group = capabilityMatrix(matrixInput());
		expect(group.eligible).toBe(true);
		const byName = new Map(group.entries.map((e) => [e.name, e.verdict]));
		expect(byName.get("aggregate relation")).toBe("pass");
		expect(byName.get("family resolution")).toBe("pass");
		expect(byName.get("completeness bound")).toBe("pass");
		expect(byName.get("account concentration")).toBe("pass");
		expect(group.verdict).toBe("pass");
	});

	test("an unresolved-family group fails family resolution and the group", () => {
		const bins = [
			...proportionalBins(400, "acct-1"),
			...proportionalBins(400, "acct-2").map((b) => ({
				...b,
				startMs: b.startMs + 1_000 * W,
				endMs: b.endMs + 1_000 * W,
			})),
		].map((b) => {
			const tokens = new Float64Array(COLUMN_COUNT);
			tokens[columnIndex("unresolved", "input")] = b.grossTokens;
			return { ...b, tokens };
		});
		const group = capabilityMatrix(
			matrixInput({ evaluationBins: bins, selectionBins: bins }),
		);
		const entry = group.entries.find((e) => e.name === "family resolution");
		expect(entry?.verdict).toBe("fail");
		expect(group.verdict).toBe("fail");
	});

	test("tier provenance is insufficient evidence and never decides the verdict", () => {
		// Every other criterion passes here, and the group still passes: an
		// informational entry that can never be anything but insufficient evidence
		// must not drag a group down with it.
		const group = capabilityMatrix(matrixInput());
		const entry = group.entries.find((e) => e.name === "tier provenance");
		expect(entry?.informational).toBe(true);
		expect(entry?.verdict).toBe("insufficient-evidence");
		expect(group.verdict).toBe("pass");
	});

	test("one failing criterion makes the whole group fail", () => {
		const group = capabilityMatrix(matrixInput({ permutation: perm(0.79) }));
		expect(group.selection.verdict).toBe("fail");
		expect(
			group.entries.find((e) => e.name === "aggregate relation")?.verdict,
		).toBe("fail");
		expect(group.verdict).toBe("fail");
	});
});

describe("formatFeasibilityReport", () => {
	const reportInput = () => ({
		title: "Ledger burn feasibility",
		command: "bun scripts/ledger-feasibility.ts --out=docs/x.md",
		config: { seed: 20260823, widths: "2,5,10" },
		dataset: {
			snapshotRows: 154_262,
			requestRows: 581_714,
			accounts: 7,
			providers: ["anthropic", "codex"],
			firstSnapshotIso: "2026-06-02T00:00:00.000Z",
			lastSnapshotIso: "2026-08-23T00:00:00.000Z",
			firstRequestIso: "2026-05-13T00:00:00.000Z",
			lastRequestIso: "2026-08-23T00:00:00.000Z",
			keepaliveActivePeriods: 12,
		},
		selectionBlock: {
			fromIso: "2026-06-02T00:00:00.000Z",
			toIso: "2026-07-15T00:00:00.000Z",
		},
		evaluationBlock: {
			fromIso: "2026-07-15T00:00:00.000Z",
			toIso: "2026-08-23T00:00:00.000Z",
		},
		eraBoundaries: [BOUNDARY],
		groups: [
			capabilityMatrix(matrixInput()),
			capabilityMatrix(
				matrixInput({ provider: "codex", windowKind: "five_hour" as const }),
			),
		],
		cellScoresByGroup: [
			{
				provider: "anthropic",
				windowKind: "seven_day" as const,
				cells: healthyGrid(),
			},
		],
		notes: ["a note"],
	});

	test("is deterministic and reads no clock", () => {
		expect(formatFeasibilityReport(reportInput())).toBe(
			formatFeasibilityReport(reportInput()),
		);
	});

	test("carries no generation timestamp and no run durations", () => {
		const markdown = formatFeasibilityReport(reportInput());
		expect(markdown).not.toContain("Generated:");
		expect(markdown).not.toMatch(/took [\d.]+ s/);
		// The only header timestamp is the frozen study range itself.
		expect(markdown).toContain(
			"Study range: `[2026-06-02T00:00:00.000Z, 2026-08-23T00:00:00.000Z)`",
		);
	});

	test("carries the command, the blocks, the matrix and the exclusion", () => {
		const markdown = formatFeasibilityReport(reportInput());
		expect(markdown).toContain("# Ledger burn feasibility");
		expect(markdown).toContain("bun scripts/ledger-feasibility.ts");
		expect(markdown).toContain("## Capability matrix");
		expect(markdown).toContain("Selection block:");
		expect(markdown).toContain("Evaluation block:");
		expect(markdown).toContain("anthropic / seven_day");
		expect(markdown).toContain("codex / five_hour");
		expect(markdown).toContain("EXCLUDED.");
		expect(markdown).toContain("Cell sweep");
		expect(markdown).toContain("## Notes");
		expect(markdown.endsWith("\n")).toBe(true);
	});

	test("dataset figures are declared to be in-range", () => {
		const markdown = formatFeasibilityReport(reportInput());
		expect(markdown).toContain("| field (within the study range) | value |");
		expect(markdown).toContain("Every figure below counts only rows inside");
	});

	test("the tier-provenance section states the schema constraint and nothing live", () => {
		const markdown = formatFeasibilityReport(reportInput());
		expect(markdown).toContain("Tier provenance (informational):");
		expect(markdown).toContain("The schema records no historical tier");
		expect(markdown).toContain(
			"wait for schema work that records tier history",
		);
		// Nothing read from the live `accounts` row: no tier value, no per-account
		// table, no capture instant and no capture relation. Any of them would
		// rewrite this artifact on the running deployment's next identity refresh.
		expect(markdown).not.toContain("| tier captured |");
		expect(markdown).not.toContain("identity_rate_limit_tier");
		expect(markdown).not.toContain("no in-range provenance");
		expect(markdown).not.toContain("after the study range");
		expect(markdown).not.toContain("2026-07-21T16:11:22.000Z");
	});

	test("renders every unmeasurable statistic as an em-dash, never as 0", () => {
		const input = reportInput();
		input.groups = [
			capabilityMatrix(
				matrixInput({ evaluationBins: proportionalBins(3), selectionBins: [] }),
			),
		];
		const markdown = formatFeasibilityReport(input);
		expect(markdown).toContain("INSUFFICIENT EVIDENCE");
	});
});
