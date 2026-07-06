import { describe, expect, test } from "bun:test";
import type { PredictionPoint } from "@clankermux/types";
import { computeUsagePrediction } from "./usage-prediction";

const HOUR_MS = 3_600_000;

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
