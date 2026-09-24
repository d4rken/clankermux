import { describe, expect, it } from "bun:test";
import {
	canonicalWindowKind,
	usageObservedAtMs,
	usageWindowObservedAtMs,
	WEEKLY_RED_MIN_WINDOW_AGE_MS,
	weeklyLifetimeConfidence,
	weeklyRedEligible,
	windowBurnAnchor,
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

const HOUR_MS = 60 * 60_000;

describe("usageWindowObservedAtMs", () => {
	const account = {
		usageAsOfIso: "2026-09-24T10:00:00.000Z",
		usageWindowAsOfIso: { five_hour: "2026-09-24T10:08:00.000Z" },
	};

	it("takes a header-fed window's own stamp", () => {
		expect(usageWindowObservedAtMs(account, "five_hour")).toBe(
			Date.parse("2026-09-24T10:08:00.000Z"),
		);
	});

	it("falls back to the reading's stamp for every other window", () => {
		const polled = Date.parse("2026-09-24T10:00:00.000Z");
		expect(usageWindowObservedAtMs(account, "seven_day")).toBe(polled);
		expect(usageWindowObservedAtMs(account, "seven_day_oauth_apps")).toBe(
			polled,
		);
		expect(usageWindowObservedAtMs(account, null)).toBe(polled);
		expect(
			usageWindowObservedAtMs(
				{ usageAsOfIso: account.usageAsOfIso },
				"five_hour",
			),
		).toBe(polled);
	});

	it("is null when neither stamp exists", () => {
		expect(usageWindowObservedAtMs({}, "five_hour")).toBeNull();
	});
});

describe("canonicalWindowKind", () => {
	it("maps Zai's render-loop names onto the account-wide window kinds", () => {
		expect(canonicalWindowKind("tokens_limit")).toBe("five_hour");
		expect(canonicalWindowKind("tokens_limit_weekly")).toBe("seven_day");
	});

	it("leaves every other name, and null, exactly as given", () => {
		for (const kind of [
			"five_hour",
			"seven_day",
			"seven_day_opus",
			"weekly_scoped:fable",
			"time_limit",
			"weekly",
			"monthly",
			null,
		]) {
			expect(canonicalWindowKind(kind)).toBe(kind);
		}
	});
});

/**
 * Zai reports the same two account-wide windows Anthropic does, under its own
 * names. Each policy below keys on the canonical kind, so the projection an
 * account gets does not depend on which provider's vocabulary named the window.
 */
describe("Zai window kinds reach the account-wide policies", () => {
	it("gives the Zai weekly window the same full-confidence lifetime average", () => {
		expect(weeklyLifetimeConfidence("tokens_limit_weekly")).toBe("full");
		// The five-hour window keeps the regression and the amber cap, under
		// either name.
		expect(weeklyLifetimeConfidence("tokens_limit")).toBeUndefined();
	});

	it("resolves a burn anchor for both Zai windows", () => {
		const anchors = {
			fiveHour: { anchorMs: 1, anchorPct: 3, windowResetMs: 2 },
			sevenDay: { anchorMs: 4, anchorPct: 5, windowResetMs: 6 },
		};
		expect(windowBurnAnchor(anchors, "tokens_limit")).toBe(anchors.fiveHour);
		expect(windowBurnAnchor(anchors, "tokens_limit_weekly")).toBe(
			anchors.sevenDay,
		);
	});

	it("holds the Zai weekly window to the same 72-hour red floor", () => {
		expect(weeklyRedEligible("tokens_limit_weekly", 71 * HOUR_MS)).toBe(false);
		expect(
			weeklyRedEligible("tokens_limit_weekly", WEEKLY_RED_MIN_WINDOW_AGE_MS),
		).toBe(true);
		expect(weeklyRedEligible("tokens_limit_weekly", null)).toBe(false);
		// The five-hour window is not this rule's business under either name.
		expect(weeklyRedEligible("tokens_limit", 2 * HOUR_MS)).toBe(true);
	});
});
