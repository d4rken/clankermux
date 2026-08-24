/**
 * Quota-tab display helpers.
 *
 * These encode the tab's one rule — a null is a stated reason, never a zero —
 * so they are tested directly rather than only through the panels: a formatter
 * that quietly returned "0.00%" for null would pass every panel assertion that
 * merely checks a model's name appears.
 */
import { describe, expect, it } from "bun:test";
import type { QuotaDriftCohort, QuotaDriftModel } from "@clankermux/types";
import {
	cohortLabel,
	formatCapacity,
	formatCoefficient,
	formatInterval,
	formatRelativeChange,
	isReportableVerdict,
	quotaWindowLabel,
	unidentifiedReasonText,
} from "./quota-drift-display";

function model(overrides: Partial<QuotaDriftModel> = {}): QuotaDriftModel {
	return {
		key: "claude-opus-5",
		points: [],
		latest: {
			pointEstimate: 2.2,
			ciLow: 2.0,
			ciHigh: 2.4,
			impliedCapacityMtok: 45,
			shareOfWindow: 0.6,
			identified: true,
			unidentifiedReasons: [],
		},
		changes: [],
		verdict: "stable",
		...overrides,
	};
}

describe("formatters", () => {
	it("returns null rather than a number for an absent value", () => {
		expect(formatCoefficient(null)).toBeNull();
		expect(formatCoefficient(Number.NaN)).toBeNull();
		expect(formatCapacity(null)).toBeNull();
		expect(formatInterval(null, 2)).toBeNull();
		expect(formatInterval(2, null)).toBeNull();
	});

	it("formats a coefficient, interval and capacity", () => {
		expect(formatCoefficient(2.2222)).toBe("2.22%");
		expect(formatInterval(2.041, 2.4)).toBe("2.04 – 2.40%");
		expect(formatCapacity(900)).toBe("900M");
		expect(formatCapacity(45)).toBe("45.0M");
		expect(formatCapacity(4.5)).toBe("4.50M");
	});

	it("signs a relative change so a rise is unmistakable", () => {
		expect(formatRelativeChange(0.383)).toBe("+38%");
		expect(formatRelativeChange(-0.18)).toBe("-18%");
	});

	it("labels windows and cohorts", () => {
		expect(quotaWindowLabel("five_hour")).toBe("5-hour window");
		expect(quotaWindowLabel("seven_day")).toBe("Weekly window");

		const cohort = {
			provider: "anthropic",
			planTier: "max",
			rateLimitTier: "20x",
		} as QuotaDriftCohort;
		expect(cohortLabel(cohort)).toBe("anthropic · max · 20x");
		expect(
			cohortLabel({ ...cohort, rateLimitTier: null } as QuotaDriftCohort),
		).toBe("anthropic · max");
		// No tier at all says so rather than rendering a bare provider name that
		// looks like a complete label.
		expect(
			cohortLabel({
				...cohort,
				planTier: null,
				rateLimitTier: null,
			} as QuotaDriftCohort),
		).toBe("anthropic (tier unknown)");
	});
});

describe("unidentifiedReasonText", () => {
	it("returns null for an identified model", () => {
		expect(unidentifiedReasonText(model())).toBeNull();
	});

	it("prefers collinearity over the wide interval it causes", () => {
		const text = unidentifiedReasonText(
			model({
				latest: {
					pointEstimate: null,
					ciLow: null,
					ciHigh: null,
					impliedCapacityMtok: null,
					shareOfWindow: 0.1,
					identified: false,
					unidentifiedReasons: ["wide-interval", "collinear"],
				},
			}),
		);
		expect(text).toBe(
			"Not enough independent traffic (always runs alongside another model)",
		);
	});

	it("still explains itself when the wire lists no reason", () => {
		expect(
			unidentifiedReasonText(
				model({
					latest: {
						pointEstimate: null,
						ciLow: null,
						ciHigh: null,
						impliedCapacityMtok: null,
						shareOfWindow: 0,
						identified: false,
						unidentifiedReasons: [],
					},
				}),
			),
		).toBe("Not enough independent traffic");
	});

	it("treats a missing latest fit as unidentified", () => {
		expect(unidentifiedReasonText(model({ latest: null }))).toBe(
			"Not enough independent traffic",
		);
	});
});

describe("isReportableVerdict", () => {
	it("reports stable only for an identified coefficient", () => {
		expect(isReportableVerdict(model({ verdict: "stable" }))).toBe(true);
		expect(
			isReportableVerdict(
				model({
					verdict: "stable",
					latest: {
						pointEstimate: null,
						ciLow: null,
						ciHigh: null,
						impliedCapacityMtok: null,
						shareOfWindow: 0.1,
						identified: false,
						unidentifiedReasons: ["collinear"],
					},
				}),
			),
		).toBe(false);
	});

	it("never reports insufficient-evidence as a verdict", () => {
		expect(
			isReportableVerdict(model({ verdict: "insufficient-evidence" })),
		).toBe(false);
	});

	it("requires a change to actually be listed before reporting one", () => {
		expect(isReportableVerdict(model({ verdict: "changed" }))).toBe(false);
		expect(
			isReportableVerdict(
				model({
					verdict: "changed",
					changes: [
						{
							boundaryMs: 1,
							before: 1,
							after: 2,
							relativeChange: 1,
							direction: "more-expensive",
							adjustedLevel: 0.001,
							nCandidates: 10,
							nSegmentsBefore: 60,
							nSegmentsAfter: 60,
						},
					],
				}),
			),
		).toBe(true);
	});
});
