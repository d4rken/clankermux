import { describe, expect, it } from "bun:test";
import { weeklyLifetimeConfidence } from "./lifetime-confidence";

describe("weeklyLifetimeConfidence", () => {
	it("declares the account-wide weekly window's lifetime average primary", () => {
		expect(weeklyLifetimeConfidence("seven_day")).toBe("full");
	});

	it("leaves every other window on the default low confidence", () => {
		// `undefined` rather than `"low"`: absent IS the default, and passing it
		// explicitly would suggest a decision was made about windows nobody
		// measured.
		for (const kind of [
			"five_hour",
			"seven_day_opus",
			"seven_day_sonnet",
			"seven_day_scoped",
			"weekly",
			"monthly",
			"tokens_limit",
			null,
		]) {
			expect(weeklyLifetimeConfidence(kind)).toBeUndefined();
		}
	});
});
