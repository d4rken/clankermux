import { describe, expect, it } from "bun:test";
import type { UsagePrediction } from "@clankermux/types";
import {
	formatDuration,
	formatDurationDhm,
	formatPredictionMessage,
	RESETS_BEFORE_EXHAUSTION_MESSAGE,
} from "./format-prediction";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIVE_HOUR = 5 * HOUR;
const SEVEN_DAY = 7 * 24 * HOUR;

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

describe("formatDurationDhm", () => {
	it("drops minutes once a span reaches a day", () => {
		expect(formatDurationDhm(3 * DAY + 4 * HOUR + 30 * 60 * 1000)).toBe(
			"3d 4h",
		);
	});

	it("keeps hours and minutes below a day", () => {
		expect(formatDurationDhm(HOUR + 30 * 60 * 1000)).toBe("1h 30m");
	});

	it("keeps minutes only under an hour", () => {
		expect(formatDurationDhm(20 * 60 * 1000)).toBe("20m");
	});

	it("never reports a zero span", () => {
		expect(formatDurationDhm(0)).toBe("1m");
		expect(formatDurationDhm(1)).toBe("1m");
	});

	it("omits an empty hours part on a whole number of days", () => {
		expect(formatDurationDhm(2 * DAY)).toBe("2d");
	});
});

describe("formatPredictionMessage", () => {
	const now = 1_000_000_000_000;

	it("returns 'Quota exhausted' (danger) for the exhausted state", () => {
		expect(
			formatPredictionMessage(pred({ state: "exhausted" }), null, now, null),
		).toEqual({ message: "Quota exhausted", tone: "danger" });
	});

	it("returns null for the stable state", () => {
		expect(
			formatPredictionMessage(
				pred({ state: "stable", slopePerHour: 0 }),
				now + HOUR,
				now,
				FIVE_HOUR,
			),
		).toBeNull();
	});

	it("returns null for a rising state with a non-positive slope", () => {
		expect(
			formatPredictionMessage(
				pred({ slopePerHour: -1, etaExhaustMs: now + HOUR }),
				now + 2 * HOUR,
				now,
				FIVE_HOUR,
			),
		).toBeNull();
	});

	it("says how long before reset (danger) when exhaustion precedes reset", () => {
		const eta = now + 2 * HOUR;
		const reset = now + 4 * HOUR + 15 * 60 * 1000;
		expect(
			formatPredictionMessage(
				pred({ etaExhaustMs: eta }),
				reset,
				now,
				FIVE_HOUR,
			),
		).toEqual({ message: "Runs out 2h 15m before reset", tone: "danger" });
	});

	// The two early-exhaustion tiers. A margin wide relative to the window is a
	// claim the extrapolation's own error cannot flip; a narrower one sits inside
	// that error and stays amber.
	it("downgrades a thin margin to 'warning'", () => {
		// 20m of margin on a five-hour window is under the 30m threshold.
		const reset = now + 3 * HOUR;
		const eta = reset - 20 * 60 * 1000;
		expect(
			formatPredictionMessage(
				pred({ etaExhaustMs: eta }),
				reset,
				now,
				FIVE_HOUR,
			),
		).toEqual({ message: "Runs out 20m before reset", tone: "warning" });
	});

	it("keeps a margin past the threshold at 'danger'", () => {
		const reset = now + 3 * HOUR;
		const eta = reset - 31 * 60 * 1000;
		expect(
			formatPredictionMessage(
				pred({ etaExhaustMs: eta }),
				reset,
				now,
				FIVE_HOUR,
			),
		).toMatchObject({ tone: "danger" });
	});

	// Pins the comparison as strictly-greater. A margin landing exactly on the
	// threshold is the last amber one; `>=` would pass every other test here.
	it("treats a margin exactly at the threshold as 'warning'", () => {
		const reset = now + 3 * HOUR;
		const eta = reset - 0.1 * FIVE_HOUR;
		expect(
			formatPredictionMessage(
				pred({ etaExhaustMs: eta }),
				reset,
				now,
				FIVE_HOUR,
			),
		).toMatchObject({ tone: "warning" });
	});

	it("scales the threshold with the window length", () => {
		const reset = now + 3 * 24 * HOUR;
		// Ten hours early is decisive on a five-hour window and noise on a weekly
		// one, where the extrapolation reaches across seven days.
		const eta = reset - 10 * HOUR;
		expect(
			formatPredictionMessage(
				pred({ etaExhaustMs: eta }),
				reset,
				now,
				SEVEN_DAY,
			),
		).toMatchObject({ tone: "warning" });
		expect(
			formatPredictionMessage(
				pred({ etaExhaustMs: eta }),
				reset,
				now,
				FIVE_HOUR,
			),
		).toMatchObject({ tone: "danger" });
	});

	it("stays at 'warning' when the window duration is unknown", () => {
		const reset = now + 3 * HOUR;
		const eta = reset - 2 * HOUR;
		expect(
			formatPredictionMessage(pred({ etaExhaustMs: eta }), reset, now, null),
		).toMatchObject({ tone: "warning" });
	});

	it("gives a qualitative safe message (no unbounded number) when reset comes first", () => {
		const eta = now + 4 * HOUR;
		const reset = now + 2 * HOUR + 30 * 60 * 1000;
		expect(
			formatPredictionMessage(
				pred({ etaExhaustMs: eta }),
				reset,
				now,
				FIVE_HOUR,
			),
		).toEqual({
			message: RESETS_BEFORE_EXHAUSTION_MESSAGE,
			tone: "safe",
		});
	});

	// With no reset there is no margin to measure, so the tier rule cannot reach
	// red however alarming the ETA reads.
	it("says time-to-exhaustion from now (warning) when there is no reset time", () => {
		const eta = now + 90 * 60 * 1000;
		expect(
			formatPredictionMessage(
				pred({ etaExhaustMs: eta }),
				null,
				now,
				FIVE_HOUR,
			),
		).toEqual({ message: "Runs out in 1h 30m", tone: "warning" });
	});

	it("returns null for a rising state with no ETA", () => {
		expect(
			formatPredictionMessage(
				pred({ etaExhaustMs: null }),
				now + HOUR,
				now,
				FIVE_HOUR,
			),
		).toBeNull();
	});
});
