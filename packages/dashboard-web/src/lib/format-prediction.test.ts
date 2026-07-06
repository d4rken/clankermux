import { describe, expect, it } from "bun:test";
import type { UsagePrediction } from "@clankermux/types";
import { formatDuration, formatPredictionMessage } from "./format-prediction";

const HOUR = 60 * 60 * 1000;

function pred(overrides: Partial<UsagePrediction> = {}): UsagePrediction {
	return {
		state: "rising",
		slopePerHour: 10,
		etaExhaustMs: null,
		predictedAtReset: null,
		resetsAtMs: null,
		willExhaustBeforeReset: false,
		lowConfidence: false,
		...overrides,
	};
}

describe("formatDuration", () => {
	it("formats hours and minutes", () => {
		expect(formatDuration(2 * HOUR + 15 * 60 * 1000)).toBe("2h 15m");
	});

	it("formats minutes only under an hour", () => {
		expect(formatDuration(45 * 60 * 1000)).toBe("45m");
	});
});

describe("formatPredictionMessage", () => {
	const now = 1_000_000_000_000;

	it("returns 'Quota exhausted' for the exhausted state", () => {
		expect(
			formatPredictionMessage(pred({ state: "exhausted" }), null, now),
		).toBe("Quota exhausted");
	});

	it("returns null for the stable state", () => {
		expect(
			formatPredictionMessage(
				pred({ state: "stable", slopePerHour: 0 }),
				now + HOUR,
				now,
			),
		).toBeNull();
	});

	it("returns null for a rising state with a non-positive slope", () => {
		expect(
			formatPredictionMessage(
				pred({ slopePerHour: -1, etaExhaustMs: now + HOUR }),
				now + 2 * HOUR,
				now,
			),
		).toBeNull();
	});

	it("says how long before reset when exhaustion precedes reset", () => {
		const eta = now + 2 * HOUR;
		const reset = now + 4 * HOUR + 15 * 60 * 1000;
		expect(
			formatPredictionMessage(pred({ etaExhaustMs: eta }), reset, now),
		).toBe("Runs out 2h 15m before reset");
	});

	it("says how long the reset precedes exhaustion when reset comes first", () => {
		const eta = now + 4 * HOUR;
		const reset = now + 2 * HOUR + 30 * 60 * 1000;
		expect(
			formatPredictionMessage(pred({ etaExhaustMs: eta }), reset, now),
		).toBe("Resets 1h 30m before exhaustion");
	});

	it("says time-to-exhaustion from now when there is no reset time", () => {
		const eta = now + 90 * 60 * 1000;
		expect(
			formatPredictionMessage(pred({ etaExhaustMs: eta }), null, now),
		).toBe("Runs out in 1h 30m");
	});

	it("returns null for a rising state with no ETA", () => {
		expect(
			formatPredictionMessage(pred({ etaExhaustMs: null }), now + HOUR, now),
		).toBeNull();
	});
});
