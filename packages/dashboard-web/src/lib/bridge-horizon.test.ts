import { describe, expect, it } from "bun:test";
import {
	clampBridgeHours,
	hoursToRiskFactor,
	keepalivesForHours,
} from "./bridge-horizon";

// Server-supplied conversion constants for the 1h-promoted bridge.
const HOURS_PER_RISK_UNIT = 15.8333; // ((2-0.1)/0.1) × (50/60)
const MAX_BRIDGE_HOURS = 15.8333;
const REFRESH_MINUTES = 50;

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
		expect(hoursToRiskFactor(6.3333, HOURS_PER_RISK_UNIT)).toBeCloseTo(0.4, 3);
		expect(hoursToRiskFactor(9.5, HOURS_PER_RISK_UNIT)).toBeCloseTo(0.6, 2);
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
		// 6.33h at a 50-min cadence ≈ 7.6 keepalives.
		expect(keepalivesForHours(6.3333, REFRESH_MINUTES)).toBeCloseTo(7.6, 1);
		expect(keepalivesForHours(9.5, REFRESH_MINUTES)).toBeCloseTo(11.4, 1);
	});

	it("returns 0 for non-positive inputs", () => {
		expect(keepalivesForHours(0, REFRESH_MINUTES)).toBe(0);
		expect(keepalivesForHours(9, 0)).toBe(0);
	});
});
