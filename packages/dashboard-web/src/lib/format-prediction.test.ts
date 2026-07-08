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

	it("returns 'Quota exhausted' (danger) for the exhausted state", () => {
		expect(
			formatPredictionMessage(pred({ state: "exhausted" }), null, now),
		).toEqual({ message: "Quota exhausted", tone: "danger" });
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

	it("says how long before reset (danger) when exhaustion precedes reset", () => {
		const eta = now + 2 * HOUR;
		const reset = now + 4 * HOUR + 15 * 60 * 1000;
		expect(
			formatPredictionMessage(pred({ etaExhaustMs: eta }), reset, now),
		).toEqual({ message: "Runs out 2h 15m before reset", tone: "danger" });
	});

	it("says the reset precedes exhaustion (safe) when reset comes first", () => {
		const eta = now + 4 * HOUR;
		const reset = now + 2 * HOUR + 30 * 60 * 1000;
		expect(
			formatPredictionMessage(pred({ etaExhaustMs: eta }), reset, now),
		).toEqual({ message: "Resets 1h 30m before exhaustion", tone: "safe" });
	});

	it("says time-to-exhaustion from now (danger) when there is no reset time", () => {
		const eta = now + 90 * 60 * 1000;
		expect(
			formatPredictionMessage(pred({ etaExhaustMs: eta }), null, now),
		).toEqual({ message: "Runs out in 1h 30m", tone: "danger" });
	});

	it("returns null for a rising state with no ETA", () => {
		expect(
			formatPredictionMessage(pred({ etaExhaustMs: null }), now + HOUR, now),
		).toBeNull();
	});
});
