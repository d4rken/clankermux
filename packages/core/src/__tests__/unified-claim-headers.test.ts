import { describe, expect, it } from "bun:test";
import {
	getAccountWideClaimHeadroom,
	getScopedClaimRejection,
	hasAccountWideUnifiedRejection,
	isScopedOnlyUnifiedRejection,
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
