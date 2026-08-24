import { describe, expect, it } from "bun:test";
import {
	computeExpectedPct,
	computeThrottleResumeAt,
	computeWindowStartMs,
} from "./throttle-utils";

const HOUR_MS = 60 * 60 * 1000;

describe("computeWindowStartMs", () => {
	it("resolves a 7-day duration for the seven_day_scoped window", () => {
		const resetMs = Date.UTC(2026, 5, 10, 12, 0, 0, 0);
		expect(computeWindowStartMs(resetMs, "seven_day_scoped")).toBe(
			resetMs - 7 * 24 * 60 * 60 * 1000,
		);
	});
});

describe("computeExpectedPct", () => {
	const resetMs = Date.UTC(2026, 7, 24, 12, 0, 0, 0);

	it("is proportional to elapsed window time", () => {
		const now = resetMs - 2.5 * HOUR_MS; // halfway through a 5h window
		expect(computeExpectedPct(resetMs, "five_hour", now)).toBe(50);
	});

	it("clamps to 100 once the reset has passed", () => {
		expect(computeExpectedPct(resetMs, "five_hour", resetMs + HOUR_MS)).toBe(
			100,
		);
	});

	it("clamps to 0 before the window start", () => {
		const now = resetMs - 6 * HOUR_MS; // before a 5h window opened
		expect(computeExpectedPct(resetMs, "five_hour", now)).toBe(0);
	});

	it("returns null for an unknown window name", () => {
		expect(computeExpectedPct(resetMs, "time_limit", resetMs - HOUR_MS)).toBe(
			null,
		);
	});

	it("returns null for a non-finite reset", () => {
		expect(computeExpectedPct(Number.NaN, "five_hour", resetMs)).toBe(null);
	});

	it("uses the preceding month's length for monthly windows", () => {
		const monthlyReset = Date.UTC(2026, 7, 1, 0, 0, 0, 0); // July has 31 days
		const now = monthlyReset - 15.5 * 24 * HOUR_MS;
		expect(computeExpectedPct(monthlyReset, "monthly", now)).toBe(50);
	});
});

describe("computeThrottleResumeAt", () => {
	const resetMs = Date.UTC(2026, 7, 24, 12, 0, 0, 0);
	const startMs = resetMs - 5 * HOUR_MS;

	it("returns the pace catch-up instant when utilization is ahead of pace", () => {
		const now = startMs + HOUR_MS; // 20% elapsed
		expect(computeThrottleResumeAt(resetMs, "five_hour", 40, now)).toBe(
			startMs + 2 * HOUR_MS, // 40% of the window
		);
	});

	it("returns null at or behind pace", () => {
		const now = startMs + 2 * HOUR_MS; // 40% elapsed
		expect(computeThrottleResumeAt(resetMs, "five_hour", 40, now)).toBe(null);
		expect(computeThrottleResumeAt(resetMs, "five_hour", 30, now)).toBe(null);
	});

	it("caps the resume instant at the reset for over-100% utilization", () => {
		const now = startMs + HOUR_MS;
		expect(computeThrottleResumeAt(resetMs, "five_hour", 130, now)).toBe(
			resetMs,
		);
	});

	it("returns null once the reset has passed", () => {
		expect(computeThrottleResumeAt(resetMs, "five_hour", 90, resetMs + 1)).toBe(
			null,
		);
	});

	it("returns null before the window has started", () => {
		expect(computeThrottleResumeAt(resetMs, "five_hour", 90, startMs)).toBe(
			null,
		);
	});

	it("returns null for an unknown window name", () => {
		expect(
			computeThrottleResumeAt(resetMs, "time_limit", 90, startMs + HOUR_MS),
		).toBe(null);
	});

	it("returns null for a non-finite reset", () => {
		expect(
			computeThrottleResumeAt(Number.NaN, "five_hour", 90, startMs + HOUR_MS),
		).toBe(null);
	});

	it("returns null when now is exactly the reset instant", () => {
		expect(computeThrottleResumeAt(resetMs, "five_hour", 90, resetMs)).toBe(
			null,
		);
	});

	it("uses the preceding month's length for monthly windows", () => {
		const DAY_MS = 24 * HOUR_MS;
		const monthlyReset = Date.UTC(2026, 7, 1, 0, 0, 0, 0); // July has 31 days
		const monthlyStart = monthlyReset - 31 * DAY_MS;
		const now = monthlyStart + 10 * DAY_MS; // ~32% elapsed
		expect(computeThrottleResumeAt(monthlyReset, "monthly", 50, now)).toBe(
			monthlyStart + 15.5 * DAY_MS,
		);
	});
});
