import { describe, expect, it } from "bun:test";
import {
	usageObservedAtMs,
	weeklyLifetimeConfidence,
} from "../lifetime-confidence";

/**
 * The projection-TONE half of this suite stayed behind in the dashboard
 * (`lib/lifetime-confidence.tone.test.ts`): it drives `earlyExhaustionTone`
 * from `lib/format-prediction.ts`, which is display formatting and did not move
 * with the module. What lives here is the part with no rendering in it.
 */

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

describe("usageObservedAtMs", () => {
	it("parses the server's sample stamp", () => {
		const sampledAt = Date.UTC(2026, 7, 22, 11, 47, 13);
		expect(usageObservedAtMs(new Date(sampledAt).toISOString())).toBe(
			sampledAt,
		);
	});

	it("reports null rather than a substitute when nothing was stamped", () => {
		// Null is a real answer — the reading came from somewhere that cannot say
		// when it was observed — and the estimator degrades that window to the
		// amber-capped now-anchored projection. Anything invented here (render
		// time, say) is exactly the drift the anchor exists to remove.
		expect(usageObservedAtMs(null)).toBeNull();
		expect(usageObservedAtMs(undefined)).toBeNull();
		expect(usageObservedAtMs("")).toBeNull();
		expect(usageObservedAtMs("not a date")).toBeNull();
	});
});
