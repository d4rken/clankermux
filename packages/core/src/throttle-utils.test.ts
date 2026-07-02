import { describe, expect, it } from "bun:test";
import { computeWindowStartMs } from "./throttle-utils";

describe("computeWindowStartMs", () => {
	it("resolves a 7-day duration for the seven_day_scoped window", () => {
		const resetMs = Date.UTC(2026, 5, 10, 12, 0, 0, 0);
		expect(computeWindowStartMs(resetMs, "seven_day_scoped")).toBe(
			resetMs - 7 * 24 * 60 * 60 * 1000,
		);
	});
});
