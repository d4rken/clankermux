import { describe, expect, test } from "bun:test";
import type { PredictionPoint } from "@clankermux/types";
import {
	computeUsagePrediction,
	isFitBoundary,
	isResetBoundary,
	splitSeries,
} from "./usage-prediction";

const HOUR_MS = 3_600_000;

const FIXTURE_T0 = 1_780_000_000_000;
const FIXTURE_RESET_1 = FIXTURE_T0 + 4 * HOUR_MS;
const FIXTURE_RESET_2 = FIXTURE_T0 + 9 * HOUR_MS;
const fixturePoint = (
	minutes: number,
	utilization: number,
	resetsAt: number | null,
): PredictionPoint => ({
	t: FIXTURE_T0 + minutes * 60_000,
	utilization,
	resetsAt,
});

/** Idle -> active -> jitter -> refund drop -> real reset change. */
const MULTI_BOUNDARY_FIXTURE: PredictionPoint[] = [
	fixturePoint(0, 10, null),
	fixturePoint(10, 12, null),
	fixturePoint(20, 20, FIXTURE_RESET_1),
	fixturePoint(30, 26, FIXTURE_RESET_1 + 900),
	fixturePoint(40, 33, FIXTURE_RESET_1 - 800),
	fixturePoint(50, 12, FIXTURE_RESET_1),
	fixturePoint(60, 18, FIXTURE_RESET_1),
	fixturePoint(70, 25, FIXTURE_RESET_1),
	fixturePoint(80, 31, FIXTURE_RESET_1),
	fixturePoint(90, 4, FIXTURE_RESET_2),
	fixturePoint(100, 9, FIXTURE_RESET_2),
	fixturePoint(110, 15, FIXTURE_RESET_2),
	fixturePoint(120, 22, FIXTURE_RESET_2),
];

/**
 * Tests for the pure least-squares usage-exhaustion predictor
 * (ported/adapted from robsonek's tombii/better-ccflare#294).
 */
describe("computeUsagePrediction", () => {
	test("empty points -> insufficient_data", () => {
		const pred = computeUsagePrediction([]);
		expect(pred.state).toBe("insufficient_data");
		expect(pred.slopePerHour).toBe(0);
		expect(pred.resetsAtMs).toBeNull();
		expect(pred.etaExhaustMs).toBeNull();
		expect(pred.predictedAtReset).toBeNull();
	});

	test("fewer than MIN_POINTS -> insufficient_data", () => {
		const t0 = 1_000_000_000_000;
		const reset = t0 + 3 * HOUR_MS;
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 10, resetsAt: reset },
			{ t: t0 + HOUR_MS, utilization: 20, resetsAt: reset },
		];
		const pred = computeUsagePrediction(points);
		expect(pred.state).toBe("insufficient_data");
		// resetsAtMs still reflects the latest reading's reset.
		expect(pred.resetsAtMs).toBe(reset);
	});

	test("steady rising series -> rising, slope ~10, finite ETA > last.t", () => {
		const t0 = 1_000_000_000_000;
		// reset far in the future so exhaustion happens first
		const reset = t0 + 100 * HOUR_MS;
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 10, resetsAt: reset },
			{ t: t0 + HOUR_MS, utilization: 20, resetsAt: reset },
			{ t: t0 + 2 * HOUR_MS, utilization: 30, resetsAt: reset },
			{ t: t0 + 3 * HOUR_MS, utilization: 40, resetsAt: reset },
		];
		const pred = computeUsagePrediction(points);
		expect(pred.state).toBe("rising");
		expect(pred.slopePerHour).toBeCloseTo(10, 5);
		expect(pred.etaExhaustMs).not.toBeNull();
		const last = points[points.length - 1];
		expect(pred.etaExhaustMs as number).toBeGreaterThan(last.t);
		// from 40% at +10pp/h, 6h to reach 100 -> last.t + 6h
		expect(pred.etaExhaustMs as number).toBeCloseTo(last.t + 6 * HOUR_MS, -3);
		expect(pred.lowConfidence).toBe(false);
	});

	test("rising series that exhausts before reset -> willExhaustBeforeReset true", () => {
		const t0 = 1_000_000_000_000;
		// reset only 4h after last point; at +10pp/h from 40 it hits 100 in 6h > 4h
		// Wait — that means it exhausts AFTER reset. Use a tighter reset window.
		// At 40% + 10pp/h, predictedAtReset for hoursToReset=8 = 120 -> clamped, will exhaust.
		const reset = t0 + 11 * HOUR_MS; // 8h after last point
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 10, resetsAt: reset },
			{ t: t0 + HOUR_MS, utilization: 20, resetsAt: reset },
			{ t: t0 + 2 * HOUR_MS, utilization: 30, resetsAt: reset },
			{ t: t0 + 3 * HOUR_MS, utilization: 40, resetsAt: reset },
		];
		const pred = computeUsagePrediction(points);
		expect(pred.state).toBe("rising");
		expect(pred.willExhaustBeforeReset).toBe(true);
		// predictedAtReset clamped to LIMIT (100)
		expect(pred.predictedAtReset).toBe(100);
	});

	test("flat series -> stable, slope 0, no ETA", () => {
		const t0 = 1_000_000_000_000;
		const reset = t0 + 10 * HOUR_MS;
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 50, resetsAt: reset },
			{ t: t0 + HOUR_MS, utilization: 50, resetsAt: reset },
			{ t: t0 + 2 * HOUR_MS, utilization: 50, resetsAt: reset },
			{ t: t0 + 3 * HOUR_MS, utilization: 50, resetsAt: reset },
		];
		const pred = computeUsagePrediction(points);
		expect(pred.state).toBe("stable");
		expect(pred.slopePerHour).toBeCloseTo(0, 6);
		expect(pred.etaExhaustMs).toBeNull();
		expect(pred.willExhaustBeforeReset).toBe(false);
	});

	test("overage: latest utilization >= 100 -> exhausted", () => {
		const t0 = 1_000_000_000_000;
		const reset = t0 + 10 * HOUR_MS;
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 80, resetsAt: reset },
			{ t: t0 + HOUR_MS, utilization: 90, resetsAt: reset },
			{ t: t0 + 2 * HOUR_MS, utilization: 100, resetsAt: reset },
		];
		const pred = computeUsagePrediction(points);
		const last = points[points.length - 1];
		expect(pred.state).toBe("exhausted");
		expect(pred.willExhaustBeforeReset).toBe(true);
		expect(pred.etaExhaustMs).toBe(last.t);
		expect(pred.predictedAtReset).toBe(100);
	});

	test("resets_at jitter within tolerance -> treated as ONE window", () => {
		const t0 = 1_000_000_000_000;
		const baseReset = t0 + 100 * HOUR_MS;
		// consecutive resets differ by <= RESET_JITTER_TOLERANCE_MS (±1000ms)
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 10, resetsAt: baseReset },
			{ t: t0 + HOUR_MS, utilization: 20, resetsAt: baseReset + 1000 },
			{ t: t0 + 2 * HOUR_MS, utilization: 30, resetsAt: baseReset - 1000 },
			{ t: t0 + 3 * HOUR_MS, utilization: 40, resetsAt: baseReset + 500 },
		];
		const pred = computeUsagePrediction(points);
		// Not segmented: a real rising trend over all four points.
		expect(pred.state).toBe("rising");
		expect(pred.slopePerHour).toBeCloseTo(10, 5);
	});

	test("reset boundary jump -> only post-boundary segment used", () => {
		const t0 = 1_000_000_000_000;
		const oldReset = t0 + 100 * HOUR_MS;
		// Big reset jump (>> tolerance) at index 2. Post-boundary segment has
		// only 2 points -> insufficient_data.
		const newReset = oldReset + 5 * HOUR_MS;
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 60, resetsAt: oldReset },
			{ t: t0 + HOUR_MS, utilization: 70, resetsAt: oldReset },
			{ t: t0 + 2 * HOUR_MS, utilization: 5, resetsAt: newReset },
			{ t: t0 + 3 * HOUR_MS, utilization: 10, resetsAt: newReset },
		];
		const pred = computeUsagePrediction(points);
		expect(pred.state).toBe("insufficient_data");
		expect(pred.resetsAtMs).toBe(newReset);
	});

	test("gift/refund drop > 5pp mid-series -> segment restarts at drop", () => {
		const t0 = 1_000_000_000_000;
		const reset = t0 + 100 * HOUR_MS;
		// Pre-drop points rise steeply; a refund drops utilization by 20pp at
		// index 3; post-drop points rise gently at +5pp/h. If the pre-drop points
		// were included the slope would be much steeper/negative-going.
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 50, resetsAt: reset },
			{ t: t0 + HOUR_MS, utilization: 60, resetsAt: reset },
			{ t: t0 + 2 * HOUR_MS, utilization: 70, resetsAt: reset },
			{ t: t0 + 3 * HOUR_MS, utilization: 50, resetsAt: reset }, // drop 20pp
			{ t: t0 + 4 * HOUR_MS, utilization: 55, resetsAt: reset },
			{ t: t0 + 5 * HOUR_MS, utilization: 60, resetsAt: reset },
		];
		const pred = computeUsagePrediction(points);
		// Only the post-drop segment (50,55,60) -> +5pp/h, rising.
		expect(pred.state).toBe("rising");
		expect(pred.slopePerHour).toBeCloseTo(5, 5);
	});

	test("exactly 5pp drop is NOT a reset (strictly-greater rule)", () => {
		const t0 = 1_000_000_000_000;
		const reset = t0 + 100 * HOUR_MS;
		// prev->cur drops EXACTLY 5.0pp -> must stay in one segment.
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 30, resetsAt: reset },
			{ t: t0 + HOUR_MS, utilization: 40, resetsAt: reset },
			{ t: t0 + 2 * HOUR_MS, utilization: 35, resetsAt: reset }, // exactly -5
			{ t: t0 + 3 * HOUR_MS, utilization: 45, resetsAt: reset },
		];
		const pred = computeUsagePrediction(points);
		// All four points remain one segment -> a real regression over them,
		// not a restart at index 2 (which would leave only 2 points).
		expect(pred.state).not.toBe("insufficient_data");
	});

	test("lowConfidence: MIN_POINTS spanning < 5min", () => {
		const t0 = 1_000_000_000_000;
		const reset = t0 + 100 * HOUR_MS;
		const MIN = 60_000;
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 10, resetsAt: reset },
			{ t: t0 + MIN, utilization: 20, resetsAt: reset },
			{ t: t0 + 2 * MIN, utilization: 30, resetsAt: reset }, // 2min span < 5min
		];
		const pred = computeUsagePrediction(points);
		expect(pred.lowConfidence).toBe(true);
		expect(pred.etaExhaustMs).toBeNull();
		expect(pred.predictedAtReset).toBeNull();
	});

	test("multi-boundary fixture: refactor is behaviour-identical", () => {
		// Frozen expectations captured from the pre-refactor implementation. The
		// fixture crosses every boundary kind: idle (null reset) points, a
		// null->value transition, sub-tolerance jitter, a refund drop inside one
		// window, and a real reset change.
		const pred = computeUsagePrediction(MULTI_BOUNDARY_FIXTURE);
		expect(pred).toEqual({
			slopePerHour: 36,
			etaExhaustMs: 1780015000000,
			predictedAtReset: 100,
			resetsAtMs: 1780032400000,
			willExhaustBeforeReset: true,
			lowConfidence: false,
			state: "rising",
		});
		expect(computeUsagePrediction(MULTI_BOUNDARY_FIXTURE.slice(0, 9))).toEqual({
			slopePerHour: 38.39999999999999,
			etaExhaustMs: 1780011268750,
			predictedAtReset: 100,
			resetsAtMs: 1780014400000,
			willExhaustBeforeReset: true,
			lowConfidence: false,
			state: "rising",
		});
		expect(computeUsagePrediction(MULTI_BOUNDARY_FIXTURE.slice(0, 5))).toEqual({
			slopePerHour: 38.99999999999999,
			etaExhaustMs: 1780008584615,
			predictedAtReset: 100,
			resetsAtMs: 1780014399200,
			willExhaustBeforeReset: true,
			lowConfidence: false,
			state: "rising",
		});
	});

	test("idle filtering: null-reset points excluded when latest reset known", () => {
		const t0 = 1_000_000_000_000;
		const reset = t0 + 100 * HOUR_MS;
		// Three idle (null reset) points that are flat, then three active points
		// rising steeply. Including the idle points would flatten the slope.
		const points: PredictionPoint[] = [
			{ t: t0, utilization: 5, resetsAt: null },
			{ t: t0 + HOUR_MS, utilization: 5, resetsAt: null },
			{ t: t0 + 2 * HOUR_MS, utilization: 5, resetsAt: null },
			{ t: t0 + 3 * HOUR_MS, utilization: 20, resetsAt: reset },
			{ t: t0 + 4 * HOUR_MS, utilization: 40, resetsAt: reset },
			{ t: t0 + 5 * HOUR_MS, utilization: 60, resetsAt: reset },
		];
		const pred = computeUsagePrediction(points);
		expect(pred.state).toBe("rising");
		// Active-only slope is +20pp/h; if idle points were mixed in it would be
		// far shallower.
		expect(pred.slopePerHour).toBeCloseTo(20, 5);
	});
});

describe("isResetBoundary / isFitBoundary", () => {
	const p = (
		utilization: number,
		resetsAt: number | null,
	): PredictionPoint => ({
		t: FIXTURE_T0,
		utilization,
		resetsAt,
	});

	test("both resets null -> not a boundary", () => {
		expect(isResetBoundary(p(10, null), p(20, null))).toBe(false);
	});

	test("null <-> value transition counts as changed, both directions", () => {
		expect(isResetBoundary(p(10, null), p(20, FIXTURE_RESET_1))).toBe(true);
		expect(isResetBoundary(p(10, FIXTURE_RESET_1), p(20, null))).toBe(true);
	});

	test("reset jitter within tolerance -> not a boundary", () => {
		expect(
			isResetBoundary(p(10, FIXTURE_RESET_1), p(20, FIXTURE_RESET_1 + 60_000)),
		).toBe(false);
		expect(
			isResetBoundary(p(10, FIXTURE_RESET_1), p(20, FIXTURE_RESET_1 - 60_000)),
		).toBe(false);
	});

	test("reset change beyond tolerance -> boundary", () => {
		expect(
			isResetBoundary(p(10, FIXTURE_RESET_1), p(20, FIXTURE_RESET_1 + 60_001)),
		).toBe(true);
	});

	test("a refund drop is a FIT boundary but NOT a window boundary", () => {
		const prev = p(70, FIXTURE_RESET_1);
		const cur = p(50, FIXTURE_RESET_1);
		expect(isResetBoundary(prev, cur)).toBe(false);
		expect(isFitBoundary(prev, cur)).toBe(true);
	});

	test("a drop of exactly the threshold is neither (strictly-greater rule)", () => {
		expect(isFitBoundary(p(40, FIXTURE_RESET_1), p(35, FIXTURE_RESET_1))).toBe(
			false,
		);
	});

	test("isFitBoundary inherits every reset boundary", () => {
		expect(isFitBoundary(p(10, null), p(20, FIXTURE_RESET_1))).toBe(true);
	});
});

describe("splitSeries", () => {
	test("empty input -> no segments", () => {
		expect(splitSeries([], isResetBoundary)).toEqual([]);
	});

	test("single point -> one segment", () => {
		expect(
			splitSeries([fixturePoint(0, 5, null)], isResetBoundary),
		).toHaveLength(1);
	});

	test("window split keeps a refunded window whole; fit split does not", () => {
		const windows = splitSeries(MULTI_BOUNDARY_FIXTURE, isResetBoundary);
		// idle pair | reset-1 window (including the refund drop) | reset-2 window
		expect(windows.map((w) => w.length)).toEqual([2, 7, 4]);
		expect(windows[1][0].utilization).toBe(20);
		expect(windows[1][3].utilization).toBe(12); // the refund stayed inside

		const fits = splitSeries(MULTI_BOUNDARY_FIXTURE, isFitBoundary);
		expect(fits.map((f) => f.length)).toEqual([2, 3, 4, 4]);
	});

	test("no idle filtering: null-reset points are kept in their segment", () => {
		const series: PredictionPoint[] = [
			fixturePoint(0, 5, null),
			fixturePoint(10, 6, null),
			fixturePoint(20, 7, null),
		];
		expect(splitSeries(series, isResetBoundary)).toEqual([series]);
	});
});
