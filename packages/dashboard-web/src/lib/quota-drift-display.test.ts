/**
 * Quota-tab display helpers.
 *
 * These encode the tab's one rule — a null is a stated reason, never a zero —
 * so they are tested directly rather than only through the panels: a formatter
 * that quietly returned "0.00%" for null would pass every panel assertion that
 * merely checks a model's name appears.
 */
import { describe, expect, it } from "bun:test";
import type {
	QuotaDriftCohort,
	QuotaDriftModel,
	QuotaDriftPoint,
	QuotaDriftUnidentifiedReason,
	QuotaDriftWindowResult,
} from "@clankermux/types";
import {
	cohortLabel,
	dominantGap,
	flatWindowNotice,
	formatCapacity,
	formatCoefficient,
	formatInterval,
	formatRelativeChange,
	gapStretchText,
	isReportableVerdict,
	primaryReason,
	quotaWindowLabel,
	summarizeGaps,
	summarizeModelGaps,
	UNIDENTIFIED_COPY,
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

	it("says a model was not in use rather than too small to measure", () => {
		// The two failed the same criterion before this and read identically.
		// Only `low-share` is about measurement; `no-exposure` says the model was
		// not routed here at all, so it wins whenever both are present.
		expect(UNIDENTIFIED_COPY["no-exposure"]).toBe(
			"Not in use during this period",
		);
		expect(primaryReason(["low-share", "no-exposure"])).toBe("no-exposure");
		expect(primaryReason(["no-exposure", "collinear"])).toBe("no-exposure");
		expect(primaryReason(["low-share", "wide-interval"])).toBe("low-share");
		// An empty set stays distinguishable from a known reason so callers fall
		// back to generic wording instead of inventing a cause.
		expect(primaryReason([])).toBeNull();
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

/* ── Gap summaries ──────────────────────────────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;
/**
 * 2026-08-01T12:00:00Z — the grid origin the gap fixtures step from.
 *
 * MIDDAY rather than midnight: the formatter renders in local time, so a
 * midnight-UTC grid would name the previous day in any negative-offset zone
 * and the expected strings below would depend on where the suite runs.
 */
const ORIGIN = Date.UTC(2026, 7, 1, 12, 0, 0, 0);

/** One rolling point on a 2-day grid: `index` 0 is the oldest. */
function point(
	index: number,
	reasons: QuotaDriftUnidentifiedReason[] | null,
): QuotaDriftPoint {
	const windowStartMs = ORIGIN + index * 2 * DAY;
	return {
		windowStartMs,
		windowEndMs: windowStartMs + 14 * DAY,
		pointEstimate: reasons === null ? 2 : null,
		ciLow: reasons === null ? 1.9 : null,
		ciHigh: reasons === null ? 2.1 : null,
		impliedCapacityMtok: reasons === null ? 50 : null,
		identified: reasons === null,
		nSegments: 100,
		unidentifiedReasons: reasons ?? [],
	};
}

function gapModel(
	key: string,
	series: (QuotaDriftUnidentifiedReason[] | null)[],
): QuotaDriftModel {
	return {
		key,
		points: series.map((reasons, index) => point(index, reasons)),
		latest: null,
		changes: [],
		verdict: "insufficient-evidence",
	};
}

describe("summarizeGaps", () => {
	it("collapses a contiguous same-reason stretch into one entry", () => {
		const stretches = summarizeGaps(
			[null, ["no-exposure"], ["no-exposure"], ["no-exposure"]].map(
				(reasons, index) =>
					point(index, reasons as QuotaDriftUnidentifiedReason[] | null),
			),
		);

		expect(stretches).toHaveLength(1);
		expect(stretches[0].reason).toBe("no-exposure");
		expect(stretches[0].nPoints).toBe(3);
		// The window START, not its end: a rolling window with no exposure means
		// the model was already absent when it opened.
		expect(stretches[0].fromMs).toBe(ORIGIN + 2 * DAY);
		expect(stretches[0].ongoing).toBe(true);
		expect(stretches[0].entireSeries).toBe(false);
	});

	it("starts a new stretch when the reason changes", () => {
		// Pooled out first, then out of use entirely. Merging the two would report
		// whichever ran longer as the whole story.
		const stretches = summarizeGaps(
			[["low-share"], ["low-share"], ["no-exposure"]].map((reasons, index) =>
				point(index, reasons as QuotaDriftUnidentifiedReason[]),
			),
		);

		expect(stretches.map((s) => s.reason)).toEqual([
			"low-share",
			"no-exposure",
		]);
		expect(stretches.map((s) => s.nPoints)).toEqual([2, 1]);
		expect(stretches[0].ongoing).toBe(false);
		expect(stretches[1].ongoing).toBe(true);
	});

	it("reduces a point that failed several criteria to its dominant reason", () => {
		const stretches = summarizeGaps([
			point(0, ["wide-interval", "collinear"]),
			point(1, ["collinear"]),
		]);

		expect(stretches).toHaveLength(1);
		expect(stretches[0].reason).toBe("collinear");
	});

	it("produces nothing for a model that was measurable throughout", () => {
		expect(summarizeGaps([point(0, null), point(1, null)])).toEqual([]);
		expect(summarizeGaps([])).toEqual([]);
	});

	it("marks a gap covering the whole series", () => {
		const stretches = summarizeGaps([
			point(0, ["collinear"]),
			point(1, ["collinear"]),
		]);

		expect(stretches[0].entireSeries).toBe(true);
	});

	it("keeps a reasonless point distinguishable from a known reason", () => {
		// A payload written before points carried reasons. The gap is real; the
		// cause is not known, and must not be invented.
		const stretches = summarizeGaps([point(0, [])]);

		expect(stretches[0].reason).toBeNull();
		expect(gapStretchText(stretches[0])).toBe("not measurable on this window");
	});
});

describe("gapStretchText", () => {
	it("names the period only when the gap is not the whole series", () => {
		const retired = summarizeGaps([
			point(0, null),
			point(1, ["no-exposure"]),
			point(2, ["no-exposure"]),
		]);
		expect(gapStretchText(retired[0])).toBe("not in use since 3 Aug");

		const throughout = summarizeGaps([point(0, ["collinear"])]);
		expect(gapStretchText(throughout[0])).toBe(
			"always runs alongside another model, so its own cost cannot be separated",
		);

		const imprecise = summarizeGaps([point(0, ["wide-interval"])]);
		expect(gapStretchText(imprecise[0])).toBe(
			"estimate too imprecise on this window",
		);
	});

	it("gives both ends of a gap that closed again", () => {
		const stretches = summarizeGaps([
			point(0, ["low-share"]),
			point(1, ["low-share"]),
			point(2, null),
		]);

		expect(gapStretchText(stretches[0])).toBe(
			"too little of this window's traffic to measure from 1 Aug to 17 Aug",
		);
	});
});

describe("dominantGap", () => {
	it("picks the longest stretch, and the more recent of equals", () => {
		const stretches = summarizeGaps([
			point(0, ["low-share"]),
			point(1, null),
			point(2, ["no-exposure"]),
			point(3, ["no-exposure"]),
		]);

		expect(dominantGap(stretches)?.reason).toBe("no-exposure");

		const tied = summarizeGaps([
			point(0, ["low-share"]),
			point(1, null),
			point(2, ["no-exposure"]),
		]);
		expect(dominantGap(tied)?.reason).toBe("no-exposure");
		expect(dominantGap([])).toBeNull();
	});
});

describe("summarizeModelGaps", () => {
	it("gives one line per model with an unexplained stretch, and none otherwise", () => {
		const lines = summarizeModelGaps([
			gapModel("claude-opus-4-8", [
				null,
				null,
				["no-exposure"],
				["no-exposure"],
			]),
			gapModel("claude-haiku-4-5", [["collinear"], ["collinear"]]),
			gapModel("claude-sonnet-5", [["wide-interval"], ["wide-interval"]]),
			gapModel("claude-opus-5", [null, null]),
		]);

		expect(lines.map((l) => `${l.key} — ${l.text}`)).toEqual([
			"claude-opus-4-8 — not in use since 5 Aug",
			"claude-haiku-4-5 — always runs alongside another model, so its own cost cannot be separated",
			"claude-sonnet-5 — estimate too imprecise on this window",
		]);
	});
});

/* -- Windows that never moved ------------------------------------------- */

/** 2026-07-12T12:00:00Z, the day the motivating window last moved. */
const FLAT_SINCE = Date.UTC(2026, 6, 12, 12, 0, 0, 0);
/** 2026-08-21T12:00:00Z, the newest reading we have of it. */
const LAST_OBSERVED = Date.UTC(2026, 7, 21, 12, 0, 0, 0);

function flatWindow(
	over: Partial<QuotaDriftWindowResult> = {},
): QuotaDriftWindowResult {
	return {
		window: "five_hour",
		nSegments: 400,
		r2: 0,
		zeroObservedTokenDeltaShare: 0,
		models: [],
		lastMovementMs: null,
		lastObservedMs: LAST_OBSERVED,
		flatValuePct: 0,
		flatSince: FLAT_SINCE,
		...over,
	};
}

describe("flatWindowNotice", () => {
	it("states what was measured, over which period, and nothing more", () => {
		expect(flatWindowNotice("codex", flatWindow())).toBe(
			"OpenAI has reported 0% for this window since 12 Jul 2026, " +
				"through the latest reading on 21 Aug 2026, while this proxy kept " +
				"sending traffic against it. There is nothing here to measure.",
		);
	});

	it("never claims the provider removed or changed a limit", () => {
		const text = flatWindowNotice("codex", flatWindow()) ?? "";

		// The percentage series cannot support any of these, however obvious the
		// inference feels.
		expect(text).not.toContain("removed");
		expect(text).not.toContain("no longer");
		expect(text).not.toContain("retired");
	});

	it("drops the value when the cohort's accounts disagree on it", () => {
		const text = flatWindowNotice(
			"anthropic",
			flatWindow({ flatValuePct: null }),
		);

		expect(text).toContain(
			"has reported an unchanged value for this window on every account",
		);
		expect(text).not.toContain("null");
	});

	it("closes on the LAST READING, so a stalled sampler is visible", () => {
		// A window frozen because nobody looked at it for a month is not a
		// provider fact. The date is the only thing that distinguishes the two.
		const text =
			flatWindowNotice(
				"codex",
				flatWindow({ lastObservedMs: Date.UTC(2026, 6, 20, 12, 0, 0, 0) }),
			) ?? "";

		expect(text).toContain("the latest reading on 20 Jul 2026");
	});

	it("says nothing about a window that moved, or one we cannot vouch for", () => {
		expect(
			flatWindowNotice("codex", flatWindow({ flatSince: null })),
		).toBeNull();
		expect(
			flatWindowNotice("codex", flatWindow({ lastObservedMs: null })),
		).toBeNull();
		// A pre-change cached payload carries none of these fields at all.
		expect(
			flatWindowNotice("codex", {
				window: "five_hour",
				nSegments: 1,
				r2: 0,
				zeroObservedTokenDeltaShare: 0,
				models: [],
			}),
		).toBeNull();
	});
});
