import { describe, expect, it } from "bun:test";
import {
	clampBridgeHours,
	FALLBACK_BRIDGE_HOURS,
	FALLBACK_HOURS_PER_RISK_UNIT,
	FALLBACK_MAX_BRIDGE_HOURS,
	FALLBACK_REFRESH_MINUTES,
	hoursToRiskFactor,
	keepalivesForHours,
} from "./bridge-horizon";

// Server-supplied conversion constants for the 1h-promoted bridge.
const HOURS_PER_RISK_UNIT = 9.5833; // ((1.25-0.1)/0.1) × (50/60)
const MAX_BRIDGE_HOURS = 9.5833;
const REFRESH_MINUTES = 50;

describe("pre-load fallbacks", () => {
	// The server (bridge-policy) owns these numbers; the fallbacks only have to
	// agree with it until the first cache-warming query resolves.
	it("match the server's derivation for the 1h-promoted bridge", () => {
		expect(FALLBACK_HOURS_PER_RISK_UNIT).toBeCloseTo(HOURS_PER_RISK_UNIT, 3);
		expect(FALLBACK_MAX_BRIDGE_HOURS).toBeCloseTo(MAX_BRIDGE_HOURS, 3);
		expect(FALLBACK_REFRESH_MINUTES).toBe(REFRESH_MINUTES);
	});

	it("default horizon is the server's default risk factor (0.4) in hours", () => {
		expect(FALLBACK_BRIDGE_HOURS).toBeCloseTo(0.4 * HOURS_PER_RISK_UNIT, 3);
		expect(
			hoursToRiskFactor(FALLBACK_BRIDGE_HOURS, FALLBACK_HOURS_PER_RISK_UNIT),
		).toBeCloseTo(0.4, 6);
	});
});

describe("clampBridgeHours", () => {
	it("clamps into [0, maxBridgeHours]", () => {
		expect(clampBridgeHours(-1, MAX_BRIDGE_HOURS)).toBe(0);
		expect(clampBridgeHours(9, MAX_BRIDGE_HOURS)).toBe(9);
		expect(clampBridgeHours(1000, MAX_BRIDGE_HOURS)).toBe(MAX_BRIDGE_HOURS);
	});

	it("returns 0 on non-finite", () => {
		expect(clampBridgeHours(Number.NaN, MAX_BRIDGE_HOURS)).toBe(0);
	});
});

describe("hoursToRiskFactor", () => {
	it("inverts the server conversion and clamps to [0,1]", () => {
		expect(hoursToRiskFactor(3.8333, HOURS_PER_RISK_UNIT)).toBeCloseTo(0.4, 3);
		expect(hoursToRiskFactor(5.75, HOURS_PER_RISK_UNIT)).toBeCloseTo(0.6, 2);
		expect(
			hoursToRiskFactor(MAX_BRIDGE_HOURS, HOURS_PER_RISK_UNIT),
		).toBeCloseTo(1, 3);
		// Beyond the max horizon caps at 1.0.
		expect(hoursToRiskFactor(100, HOURS_PER_RISK_UNIT)).toBe(1);
	});

	it("is defensive against a zero/invalid conversion unit", () => {
		expect(hoursToRiskFactor(9, 0)).toBe(0);
		expect(hoursToRiskFactor(Number.NaN, HOURS_PER_RISK_UNIT)).toBe(0);
	});
});

describe("keepalivesForHours", () => {
	it("counts refreshes across the horizon", () => {
		// 3.83h at a 50-min cadence ≈ 4.6 keepalives.
		expect(keepalivesForHours(3.8333, REFRESH_MINUTES)).toBeCloseTo(4.6, 1);
		expect(keepalivesForHours(9.5, REFRESH_MINUTES)).toBeCloseTo(11.4, 1);
	});

	it("returns 0 for non-positive inputs", () => {
		expect(keepalivesForHours(0, REFRESH_MINUTES)).toBe(0);
		expect(keepalivesForHours(9, 0)).toBe(0);
	});
});
