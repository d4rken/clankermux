import { describe, expect, it } from "bun:test";
import type { CapacitySignal } from "@clankermux/types";
import {
	getWeeklyBurnSlope,
	recordWeeklyBurnSlope,
	resolveEffectiveWeeklySlope,
	WEEKLY_SLOPE_MAX_AGE_MS,
	WEEKLY_SLOPE_RESET_MATCH_TOLERANCE_MS,
} from "./weekly-burn-slope";

const NOW = 1_700_000_000_000;
const WEEKLY_RESET = NOW + 3 * 24 * 3_600_000;

// The store is MODULE-LEVEL state shared by every test file in one Bun process,
// so each test uses a unique account id rather than resetting the map.
let seq = 0;
const uniqueId = (label: string) => `wbs-${label}-${seq++}`;

const capacity = (overrides: Partial<CapacitySignal> = {}): CapacitySignal => ({
	minHeadroom: 100,
	sessionHeadroom: 100,
	soonestResetMs: null,
	bindingUtilization: 0,
	weeklyResetMs: null,
	bindingWeeklyResetMs: WEEKLY_RESET,
	weeklyHeadroom: 100,
	sessionResetMs: null,
	extraUsageUtilization: null,
	...overrides,
});

describe("recordWeeklyBurnSlope / getWeeklyBurnSlope", () => {
	it("round-trips a fresh, confident slope", () => {
		const id = uniqueId("roundtrip");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1.13,
			lowConfidence: false,
			observedAt: NOW - 60_000,
			windowResetMs: WEEKLY_RESET,
		});

		expect(getWeeklyBurnSlope(id, NOW)).toEqual({
			slopePctPerHour: 1.13,
			windowResetMs: WEEKLY_RESET,
		});
	});

	it("returns null for an account that was never recorded", () => {
		expect(getWeeklyBurnSlope(uniqueId("absent"), NOW)).toBeNull();
	});

	it("returns null once the EVIDENCE is older than the max age", () => {
		const id = uniqueId("stale");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1.13,
			lowConfidence: false,
			observedAt: NOW - WEEKLY_SLOPE_MAX_AGE_MS - 1,
			windowResetMs: WEEKLY_RESET,
		});

		expect(getWeeklyBurnSlope(id, NOW)).toBeNull();
		// Exactly at the boundary is still fresh.
		expect(getWeeklyBurnSlope(id, NOW - 1)).not.toBeNull();
	});

	it("returns null for a lowConfidence fit (the store filters on READ)", () => {
		const id = uniqueId("lowconf");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 4,
			lowConfidence: true,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET,
		});

		expect(getWeeklyBurnSlope(id, NOW)).toBeNull();
	});

	it("returns null for a non-finite slope", () => {
		const nan = uniqueId("nan");
		recordWeeklyBurnSlope(nan, {
			slopePctPerHour: Number.NaN,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET,
		});
		expect(getWeeklyBurnSlope(nan, NOW)).toBeNull();

		const inf = uniqueId("inf");
		recordWeeklyBurnSlope(inf, {
			slopePctPerHour: Number.POSITIVE_INFINITY,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET,
		});
		expect(getWeeklyBurnSlope(inf, NOW)).toBeNull();
	});

	it("does NOT filter the sign — a flat/negative slope is returned as recorded", () => {
		const id = uniqueId("negative");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: -0.4,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET,
		});

		expect(getWeeklyBurnSlope(id, NOW)?.slopePctPerHour).toBe(-0.4);
	});

	it("overwrites an earlier record for the same account", () => {
		const id = uniqueId("overwrite");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1,
			lowConfidence: false,
			observedAt: NOW - 120_000,
			windowResetMs: WEEKLY_RESET,
		});
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 2.5,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET,
		});

		expect(getWeeklyBurnSlope(id, NOW)?.slopePctPerHour).toBe(2.5);
	});

	it("keys freshness on the EVIDENCE timestamp, not the recording time", () => {
		// A refit over unchanged history must not make a stale slope look fresh:
		// `observedAt` is the newest contributing sample, so re-recording the same
		// evidence leaves the entry exactly as stale as it was.
		const id = uniqueId("evidence-age");
		const observedAt = NOW - WEEKLY_SLOPE_MAX_AGE_MS - 60_000;
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1.13,
			lowConfidence: false,
			observedAt,
			windowResetMs: WEEKLY_RESET,
		});
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1.13,
			lowConfidence: false,
			observedAt,
			windowResetMs: WEEKLY_RESET,
		});

		expect(getWeeklyBurnSlope(id, NOW)).toBeNull();
	});
});

describe("resolveEffectiveWeeklySlope", () => {
	it("applies the slope when the fitted window matches the binding weekly reset", () => {
		const id = uniqueId("match");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1.13,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET,
		});

		expect(resolveEffectiveWeeklySlope(id, capacity(), NOW)).toBe(1.13);
	});

	it("applies the slope when the reset differs within the match tolerance", () => {
		const id = uniqueId("tolerance");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 0.9,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET + WEEKLY_SLOPE_RESET_MATCH_TOLERANCE_MS,
		});

		expect(resolveEffectiveWeeklySlope(id, capacity(), NOW)).toBe(0.9);
	});

	it("returns null when the fitted window is a DIFFERENT weekly window", () => {
		// A slope fitted on the account-wide `seven_day` series must not steer a
		// gate bound by `seven_day_oauth_apps` (or a rolled window).
		const id = uniqueId("mismatch");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1.13,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET + WEEKLY_SLOPE_RESET_MATCH_TOLERANCE_MS + 1,
		});

		expect(resolveEffectiveWeeklySlope(id, capacity(), NOW)).toBeNull();
	});

	it("returns null when the binding weekly reset is unknown", () => {
		const id = uniqueId("no-binding");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1.13,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET,
		});

		expect(
			resolveEffectiveWeeklySlope(
				id,
				capacity({ bindingWeeklyResetMs: null }),
				NOW,
			),
		).toBeNull();
		expect(
			resolveEffectiveWeeklySlope(
				id,
				capacity({ bindingWeeklyResetMs: Number.NaN }),
				NOW,
			),
		).toBeNull();
	});

	it("returns null when capacity is null (stale/unknown)", () => {
		const id = uniqueId("null-capacity");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1.13,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET,
		});

		expect(resolveEffectiveWeeklySlope(id, null, NOW)).toBeNull();
	});

	it("returns null when the stored entry itself is not usable (stale evidence)", () => {
		const id = uniqueId("stale-effective");
		recordWeeklyBurnSlope(id, {
			slopePctPerHour: 1.13,
			lowConfidence: false,
			observedAt: NOW - WEEKLY_SLOPE_MAX_AGE_MS - 1,
			windowResetMs: WEEKLY_RESET,
		});

		expect(resolveEffectiveWeeklySlope(id, capacity(), NOW)).toBeNull();
	});

	it("exposes the documented constant values", () => {
		expect(WEEKLY_SLOPE_MAX_AGE_MS).toBe(900_000);
		expect(WEEKLY_SLOPE_RESET_MATCH_TOLERANCE_MS).toBe(300_000);
	});
});

describe("store identity", () => {
	it("is ONE singleton across the package export and the module path", async () => {
		// apps/server writes through `@clankermux/proxy`; the routing gates read
		// through the relative path. If the bundler/resolver ever gave those two a
		// separate module instance the feed would silently write to a store nobody
		// reads — this test is the guard.
		const pkg = await import("@clankermux/proxy");
		const id = uniqueId("singleton");
		pkg.recordWeeklyBurnSlope(id, {
			slopePctPerHour: 2.2,
			lowConfidence: false,
			observedAt: NOW,
			windowResetMs: WEEKLY_RESET,
		});

		expect(getWeeklyBurnSlope(id, NOW)?.slopePctPerHour).toBe(2.2);
	});
});
