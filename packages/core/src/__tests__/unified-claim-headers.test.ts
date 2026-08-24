import { describe, expect, it } from "bun:test";
import {
	type ExtractedClaimReading,
	extractUnifiedClaimReadings,
	getAccountWideClaimHeadroom,
	getScopedClaimRejection,
	hasAccountWideUnifiedRejection,
	isScopedOnlyUnifiedRejection,
	parseStrictDecimal,
} from "../unified-claim-headers";

// The production 429 headers of 2026-08-02T15:36:28Z, verbatim (same fixture
// as family-weekly-gate.test.ts — the incident both prior fixes were built
// from: `7d_oi` rejected at 1.0 while the account-wide 5h/7d pair showed
// headroom, with the SUMMARY headers asserting account-wide rejection).
const INCIDENT_NOW = 1_785_684_988_613;
const INCIDENT_5H_RESET_MS = 1_785_685_200_000;
const INCIDENT_WEEKLY_RESET_MS = 1_785_736_800_000;

function incidentHeaders(): Record<string, string> {
	return {
		"anthropic-ratelimit-unified-5h-reset": "1785685200",
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-5h-utilization": "0.0",
		"anthropic-ratelimit-unified-7d-reset": "1785736800",
		"anthropic-ratelimit-unified-7d-status": "allowed_warning",
		"anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
		"anthropic-ratelimit-unified-7d-utilization": "0.94",
		"anthropic-ratelimit-unified-7d_oi-reset": "1785736800",
		"anthropic-ratelimit-unified-7d_oi-status": "rejected",
		"anthropic-ratelimit-unified-7d_oi-surpassed-threshold": "1.0",
		"anthropic-ratelimit-unified-7d_oi-utilization": "1.0",
		"anthropic-ratelimit-unified-fallback-percentage": "0.5",
		"anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
		"anthropic-ratelimit-unified-overage-status": "rejected",
		"anthropic-ratelimit-unified-representative-claim":
			"seven_day_overage_included",
		"anthropic-ratelimit-unified-reset": "1785736800",
		"anthropic-ratelimit-unified-status": "rejected",
		"retry-after": "51811",
		"x-should-retry": "true",
	};
}

const h = (headers: Record<string, string>): Headers => new Headers(headers);

describe("hasAccountWideUnifiedRejection", () => {
	it("is false for the incident shape (only the scoped claim rejects)", () => {
		expect(hasAccountWideUnifiedRejection(h(incidentHeaders()))).toBe(false);
	});

	it("is true when the account-wide 7d claim itself rejects", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d-status"] = "rejected";
		expect(hasAccountWideUnifiedRejection(h(headers))).toBe(true);
	});

	it("is true when the account-wide 5h claim itself rejects", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-5h-status"] = "rejected";
		expect(hasAccountWideUnifiedRejection(h(headers))).toBe(true);
	});

	it("is false for a burst shape (no unified headers at all)", () => {
		expect(hasAccountWideUnifiedRejection(h({ "retry-after": "5" }))).toBe(
			false,
		);
	});
});

describe("getAccountWideClaimHeadroom", () => {
	it("reads both account-wide claims from the incident shape", () => {
		const headroom = getAccountWideClaimHeadroom(h(incidentHeaders()));
		expect(headroom).toEqual({
			fiveHour: {
				status: "allowed",
				utilization: 0,
				resetMs: INCIDENT_5H_RESET_MS,
			},
			sevenDay: {
				status: "allowed_warning",
				utilization: 0.94,
				resetMs: INCIDENT_WEEKLY_RESET_MS,
			},
		});
	});

	it("returns null when either account-wide claim is missing", () => {
		const headers = incidentHeaders();
		delete headers["anthropic-ratelimit-unified-5h-status"];
		expect(getAccountWideClaimHeadroom(h(headers))).toBeNull();
	});

	it("returns null when an account-wide claim rejects", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d-status"] = "rejected";
		expect(getAccountWideClaimHeadroom(h(headers))).toBeNull();
	});

	it("returns null on an unknown status value (whitelist, not !== rejected)", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d-status"] = "banana";
		expect(getAccountWideClaimHeadroom(h(headers))).toBeNull();
	});

	it("returns null when a utilization is >= 1 (contradicts the status)", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d-utilization"] = "1.0";
		expect(getAccountWideClaimHeadroom(h(headers))).toBeNull();
	});

	it("returns null on a non-strict-decimal utilization (no manufactured headroom)", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d-utilization"] = "0.94x";
		expect(getAccountWideClaimHeadroom(h(headers))).toBeNull();
	});

	it("keeps the claim but nulls resetMs when the reset is unparseable", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-5h-reset"] = "soon";
		const headroom = getAccountWideClaimHeadroom(h(headers));
		expect(headroom?.fiveHour.resetMs).toBeNull();
		expect(headroom?.sevenDay.resetMs).toBe(INCIDENT_WEEKLY_RESET_MS);
	});

	it("returns null for a burst shape", () => {
		expect(getAccountWideClaimHeadroom(h({}))).toBeNull();
	});
});

describe("getScopedClaimRejection", () => {
	it("finds the rejected 7d_oi claim and its future reset", () => {
		const rejection = getScopedClaimRejection(
			h(incidentHeaders()),
			INCIDENT_NOW,
		);
		expect(rejection).toEqual({ soonestResetMs: INCIDENT_WEEKLY_RESET_MS });
	});

	it("returns the soonest future reset across several rejected scoped claims", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-5h_oi-status"] = "rejected";
		headers["anthropic-ratelimit-unified-5h_oi-reset"] = "1785700000";
		const rejection = getScopedClaimRejection(h(headers), INCIDENT_NOW);
		expect(rejection).toEqual({ soonestResetMs: 1_785_700_000_000 });
	});

	it("reports the rejection with a null reset when the reset is past or garbled", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d_oi-reset"] = "1";
		expect(getScopedClaimRejection(h(headers), INCIDENT_NOW)).toEqual({
			soonestResetMs: null,
		});
	});

	it("ignores the overage axis (billing, not a window)", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d_oi-status"] = "allowed";
		// overage-status is still "rejected" in the fixture — must not count.
		expect(getScopedClaimRejection(h(headers), INCIDENT_NOW)).toBeNull();
	});

	it("returns null when no scoped claim rejects", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d_oi-status"] = "allowed_warning";
		expect(getScopedClaimRejection(h(headers), INCIDENT_NOW)).toBeNull();
	});
});

describe("isScopedOnlyUnifiedRejection", () => {
	it("is true for the incident shape", () => {
		expect(isScopedOnlyUnifiedRejection(h(incidentHeaders()))).toBe(true);
	});

	it("is false when the summary status is not rejected", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-status"] = "allowed_warning";
		expect(isScopedOnlyUnifiedRejection(h(headers))).toBe(false);
	});

	it("is false when an account-wide claim rejects too", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d-status"] = "rejected";
		expect(isScopedOnlyUnifiedRejection(h(headers))).toBe(false);
	});

	it("is false without account-wide headroom evidence", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-5h-utilization"] = "not-a-number";
		expect(isScopedOnlyUnifiedRejection(h(headers))).toBe(false);
	});

	it("is false without a rejected scoped claim", () => {
		const headers = incidentHeaders();
		headers["anthropic-ratelimit-unified-7d_oi-status"] = "allowed";
		expect(isScopedOnlyUnifiedRejection(h(headers))).toBe(false);
	});

	it("is false for a burst shape (no unified headers)", () => {
		expect(isScopedOnlyUnifiedRejection(h({}))).toBe(false);
	});
});

describe("parseStrictDecimal", () => {
	it("parses a plain decimal", () => {
		expect(parseStrictDecimal("0.94")).toBe(0.94);
	});

	it("parses a zero as 0, not null (a reading of zero is a reading)", () => {
		expect(parseStrictDecimal("0")).toBe(0);
		expect(parseStrictDecimal("0.0")).toBe(0);
	});

	it("rejects a prefix-parseable value", () => {
		expect(parseStrictDecimal("0.94x")).toBeNull();
		expect(parseStrictDecimal("0x1")).toBeNull();
	});

	it("rejects null and the empty string", () => {
		expect(parseStrictDecimal(null)).toBeNull();
		expect(parseStrictDecimal("")).toBeNull();
	});

	// Regression: the strict-decimal SHAPE alone admits a digit string long
	// enough to overflow to Infinity, which then reads as a finite utilization
	// (or reset) everywhere downstream.
	it("rejects a digit string that overflows to Infinity", () => {
		const huge = `1${"0".repeat(400)}`;
		expect(Number.parseFloat(huge)).toBe(Number.POSITIVE_INFINITY);
		expect(parseStrictDecimal(huge)).toBeNull();
	});
});

describe("extractUnifiedClaimReadings", () => {
	const byClaim = (readings: ExtractedClaimReading[]) =>
		Object.fromEntries(readings.map((r) => [r.claim, r]));

	it("extracts the account-wide and scoped claims of the incident shape", () => {
		const readings = extractUnifiedClaimReadings(h(incidentHeaders()));
		expect(readings.map((r) => r.claim).sort()).toEqual(["5h", "7d", "7d_oi"]);
		const claims = byClaim(readings);
		expect(claims["5h"]).toEqual({
			claim: "5h",
			status: "allowed",
			utilization: 0,
			resetMs: INCIDENT_5H_RESET_MS,
		});
		expect(claims["7d"]).toEqual({
			claim: "7d",
			status: "allowed_warning",
			utilization: 0.94,
			resetMs: INCIDENT_WEEKLY_RESET_MS,
		});
		expect(claims["7d_oi"]).toEqual({
			claim: "7d_oi",
			status: "rejected",
			utilization: 1,
			resetMs: INCIDENT_WEEKLY_RESET_MS,
		});
	});

	it("excludes the overage axis (a billing state, not a window)", () => {
		const readings = extractUnifiedClaimReadings(h(incidentHeaders()));
		expect(readings.some((r) => r.claim === "overage")).toBe(false);
	});

	it("ignores the summary status line (it carries no claim token)", () => {
		const readings = extractUnifiedClaimReadings(
			h({
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": "1785736800",
			}),
		);
		expect(readings).toEqual([]);
	});

	it("returns [] for a burst shape (no unified headers at all)", () => {
		expect(extractUnifiedClaimReadings(h({ "retry-after": "5" }))).toEqual([]);
	});

	it("keeps a status verbatim, including an unknown vocabulary entry", () => {
		const readings = extractUnifiedClaimReadings(
			h({ "anthropic-ratelimit-unified-5h-status": "banana" }),
		);
		expect(readings).toEqual([
			{ claim: "5h", status: "banana", utilization: null, resetMs: null },
		]);
	});

	it("records a zero utilization as 0, never as null", () => {
		const readings = extractUnifiedClaimReadings(
			h({
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": "0",
			}),
		);
		expect(readings[0].utilization).toBe(0);
	});

	it("nulls a missing or unparseable utilization", () => {
		const readings = extractUnifiedClaimReadings(
			h({
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-7d-status": "allowed",
				"anthropic-ratelimit-unified-7d-utilization": "0.94x",
			}),
		);
		const claims = byClaim(readings);
		expect(claims["5h"].utilization).toBeNull();
		expect(claims["7d"].utilization).toBeNull();
	});

	it("nulls a utilization that overflows to Infinity", () => {
		const readings = extractUnifiedClaimReadings(
			h({
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": `1${"0".repeat(400)}`,
			}),
		);
		expect(readings[0].utilization).toBeNull();
	});

	it("nulls a reset that is fractional, absurd, or unparseable", () => {
		const readings = extractUnifiedClaimReadings(
			h({
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-reset": "1785685200.1234",
				"anthropic-ratelimit-unified-7d-status": "allowed",
				"anthropic-ratelimit-unified-7d-reset": "99999999999999999999",
				"anthropic-ratelimit-unified-7d_oi-status": "allowed",
				"anthropic-ratelimit-unified-7d_oi-reset": "later",
			}),
		);
		const claims = byClaim(readings);
		expect(claims["5h"].resetMs).toBeNull();
		expect(claims["7d"].resetMs).toBeNull();
		expect(claims["7d_oi"].resetMs).toBeNull();
	});

	it("accepts any scoped-window token shape, not just 7d_oi", () => {
		const readings = extractUnifiedClaimReadings(
			h({
				"anthropic-ratelimit-unified-5h_oi-status": "allowed",
				"anthropic-ratelimit-unified-5h_oi-utilization": "0.25",
				"anthropic-ratelimit-unified-5h_oi-reset": "1785685200",
			}),
		);
		expect(readings).toEqual([
			{
				claim: "5h_oi",
				status: "allowed",
				utilization: 0.25,
				resetMs: INCIDENT_5H_RESET_MS,
			},
		]);
	});

	it("yields nothing for a claim with no status line of its own", () => {
		const readings = extractUnifiedClaimReadings(
			h({
				"anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
				"anthropic-ratelimit-unified-7d-utilization": "0.94",
			}),
		);
		expect(readings).toEqual([]);
	});
});
