import { expect, it } from "bun:test";
import {
	earlyEvidencePrediction,
	type ObservedPoint,
} from "./forecast-confidence-backtest";

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const points: ObservedPoint[] = Array.from({ length: 9 }, (_, i) => ({
	t: NOW - (8 - i) * 3 * MINUTE,
	observedAt: NOW - (8 - i) * 3 * MINUTE,
	utilization: i * 2,
	resetsAt: NOW + 4 * 3_600_000,
}));

it("accepts sustained growth in distinct provider observations", () => {
	expect(earlyEvidencePrediction(points, NOW)?.state).toBe("rising");
});

it("does not count repeated cached readings or untimed snapshots as evidence", () => {
	expect(
		earlyEvidencePrediction(
			points.map((point) => ({ ...point, observedAt: NOW - 30 * MINUTE })),
			NOW,
		),
	).toBeNull();
	expect(
		earlyEvidencePrediction(
			points.map((point) => ({ ...point, observedAt: null })),
			NOW,
		),
	).toBeNull();
});

it("requires fresh, stable growth and restarts evidence after a credit", () => {
	expect(earlyEvidencePrediction(points, NOW + 11 * MINUTE)).toBeNull();
	expect(
		earlyEvidencePrediction(
			points.map((point, i) => ({ ...point, utilization: i < 5 ? i * 2 : 8 })),
			NOW,
		),
	).toBeNull();
	expect(
		earlyEvidencePrediction(
			[
				...points,
				{
					...points[8],
					t: NOW + MINUTE,
					observedAt: NOW + MINUTE,
					utilization: 3,
				},
			],
			NOW + MINUTE,
		),
	).toBeNull();
});

it("cannot see a future observation", () => {
	expect(
		earlyEvidencePrediction(
			points.map((point) => ({ ...point, observedAt: NOW + MINUTE })),
			NOW,
		),
	).toBeNull();
});
