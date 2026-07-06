import { describe, expect, it } from "bun:test";
import {
	isUsablePrediction,
	RESET_JITTER_TOLERANCE_MS,
	type UsagePrediction,
} from "./usage-prediction";

function makePrediction(
	overrides: Partial<UsagePrediction> = {},
): UsagePrediction {
	return {
		state: "rising",
		slopePerHour: 5,
		etaExhaustMs: 1_000_000,
		predictedAtReset: 90,
		resetsAtMs: 1_000_000,
		willExhaustBeforeReset: true,
		lowConfidence: false,
		...overrides,
	};
}

describe("isUsablePrediction", () => {
	it("rejects null / undefined", () => {
		expect(isUsablePrediction(null, 1_000_000)).toBe(false);
		expect(isUsablePrediction(undefined, 1_000_000)).toBe(false);
	});

	it("rejects insufficient_data", () => {
		expect(
			isUsablePrediction(
				makePrediction({ state: "insufficient_data" }),
				1_000_000,
			),
		).toBe(false);
	});

	it("rejects lowConfidence", () => {
		expect(
			isUsablePrediction(makePrediction({ lowConfidence: true }), 1_000_000),
		).toBe(false);
	});

	it("rejects when reset differs from live by more than tolerance", () => {
		const pred = makePrediction({ resetsAtMs: 1_000_000 });
		const live = 1_000_000 + RESET_JITTER_TOLERANCE_MS + 1;
		expect(isUsablePrediction(pred, live)).toBe(false);
	});

	it("accepts when reset matches live within tolerance", () => {
		const pred = makePrediction({ resetsAtMs: 1_000_000 });
		const live = 1_000_000 + RESET_JITTER_TOLERANCE_MS;
		expect(isUsablePrediction(pred, live)).toBe(true);
	});

	it("rejects when exactly one side's reset is null (window disagreement)", () => {
		// prediction anchored to a window, but live reset went null (just reset)
		expect(
			isUsablePrediction(makePrediction({ resetsAtMs: 1_000_000 }), null),
		).toBe(false);
		// prediction has no reset but live window is active
		expect(
			isUsablePrediction(makePrediction({ resetsAtMs: null }), 1_000_000),
		).toBe(false);
	});

	it("accepts when both prediction and live reset are null", () => {
		expect(isUsablePrediction(makePrediction({ resetsAtMs: null }), null)).toBe(
			true,
		);
	});
});
