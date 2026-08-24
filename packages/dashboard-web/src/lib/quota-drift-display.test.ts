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
	flatWindowNotice,
	formatCapacity,
	formatCoefficient,
	formatInterval,
	formatRelativeChange,
	gapStretchText,
	isReportableVerdict,
	lastObservedValueNotice,
	notReportedNotice,
	primaryReason,
	quotaWindowLabel,
	summarizeCurrentGaps,
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

		// 15 Aug, not 1 Aug: a sub-floor share is a fact about the FIT plotted at
		// the window's end, and the first failing fit ended on the 15th.
		expect(gapStretchText(stretches[0])).toBe(
			"too little of this window's traffic to measure from 15 Aug to 17 Aug",
		);
	});

	it("names ONE failed fit rather than printing the same date twice", () => {
		const stretches = summarizeGaps([
			point(0, null),
			point(1, ["wide-interval"]),
			point(2, null),
		]);

		expect(stretches[0].fromMs).toBe(stretches[0].toMs);
		expect(gapStretchText(stretches[0])).toBe(
			"estimate too imprecise in the fit ending 17 Aug",
		);
	});
});

describe("gap boundaries", () => {
	it("dates a no-exposure gap from the window it opened in", () => {
		// Zero eq-tokens across a whole rolling window means the model was already
		// absent when that window opened, so the claim reaches back to its start.
		const stretches = summarizeGaps([
			point(0, null),
			point(1, ["no-exposure"]),
		]);

		expect(stretches[0].fromMs).toBe(ORIGIN + 2 * DAY);
		expect(gapStretchText(stretches[0])).toBe("not in use since 3 Aug");
	});

	it("dates every other reason from the fit that actually failed", () => {
		// The ONLY established fact is that the fit plotted at the window's END
		// could not identify the model. Dating it at the start would state the
		// failure 14 days before the evidence supports.
		for (const reason of [
			"collinear",
			"low-share",
			"few-segments",
			"wide-interval",
			"zero-estimate",
		] as const) {
			const stretches = summarizeGaps([point(0, null), point(1, [reason])]);
			expect(stretches[0].fromMs).toBe(ORIGIN + 2 * DAY + 14 * DAY);
		}
	});

	it("dates a reasonless legacy point from the fit's end too", () => {
		// No reason recorded means no basis for the wider claim either.
		const stretches = summarizeGaps([point(0, null), point(1, [])]);

		expect(stretches[0].reason).toBeNull();
		expect(stretches[0].fromMs).toBe(ORIGIN + 2 * DAY + 14 * DAY);
	});

	it("closes both kinds of gap on the last window's end", () => {
		const exposure = summarizeGaps([
			point(0, ["no-exposure"]),
			point(1, ["no-exposure"]),
			point(2, null),
		]);
		const quality = summarizeGaps([
			point(0, ["collinear"]),
			point(1, ["collinear"]),
			point(2, null),
		]);

		expect(exposure[0].toMs).toBe(ORIGIN + 2 * DAY + 14 * DAY);
		expect(quality[0].toMs).toBe(ORIGIN + 2 * DAY + 14 * DAY);
	});
});

describe("summarizeModelGaps", () => {
	it("groups every model with an unexplained stretch, and skips the rest", () => {
		const gaps = summarizeModelGaps([
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

		expect(
			gaps.map((m) => `${m.key} — ${m.lines.map((l) => l.text).join(" | ")}`),
		).toEqual([
			"claude-opus-4-8 — not in use since 5 Aug",
			"claude-haiku-4-5 — always runs alongside another model, so its own cost cannot be separated",
			"claude-sonnet-5 — estimate too imprecise on this window",
		]);
	});

	it("keeps every stretch of a model whose reason changed over time", () => {
		// Below the share floor early, measurable in the middle, out of use at the
		// end. Reducing this to the longest stretch would answer a question the
		// reader did not ask and hide the reason the line stops NOW.
		const gaps = summarizeModelGaps([
			gapModel("claude-opus-4-8", [
				["low-share"],
				["low-share"],
				["low-share"],
				null,
				["no-exposure"],
			]),
		]);

		expect(gaps).toHaveLength(1);
		expect(gaps[0].lines.map((l) => l.text)).toEqual([
			"too little of this window's traffic to measure from 15 Aug to 19 Aug",
			"not in use since 9 Aug",
		]);
		// The ongoing stretch is the SHORTER one, and it survives.
		expect(gaps[0].lines.at(-1)?.stretch.ongoing).toBe(true);
		expect(gaps[0].lines.at(-1)?.stretch.nPoints).toBe(1);
	});

	it("gives each stretch of one model a distinct render key", () => {
		const gaps = summarizeModelGaps([
			gapModel("claude-opus-4-8", [
				["low-share"],
				null,
				["collinear"],
				null,
				["no-exposure"],
			]),
		]);

		const ids = gaps[0].lines.map((l) => l.id);
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
		for (const id of ids) expect(id.startsWith("claude-opus-4-8@")).toBe(true);
	});
});

describe("summarizeCurrentGaps", () => {
	it("lists only models whose newest fit could not measure them", () => {
		const gaps = summarizeCurrentGaps([
			// Gap in the middle, measurable again by the end: history only.
			gapModel("claude-opus-5", [null, ["low-share"], null]),
			// Still out of use at the newest fit: current.
			gapModel("claude-opus-4-8", [null, ["no-exposure"], ["no-exposure"]]),
			// Never gapped at all.
			gapModel("claude-fable-5", [null, null, null]),
		]);

		expect(gaps.map((g) => `${g.key} — ${g.text}`)).toEqual([
			"claude-opus-4-8 — not in use since 3 Aug",
		]);
	});

	it("speaks with the ongoing stretch's reason, not an older one", () => {
		// The older stretch is longer; the CURRENT answer is still "not in use".
		const gaps = summarizeCurrentGaps([
			gapModel("claude-sonnet-5", [
				["low-share"],
				["low-share"],
				["low-share"],
				null,
				["no-exposure"],
			]),
		]);

		expect(gaps).toHaveLength(1);
		expect(gaps[0].text).toBe("not in use since 9 Aug");
	});

	it("keeps the throughout wording for a never-measurable model", () => {
		const gaps = summarizeCurrentGaps([
			gapModel("claude-haiku-4-5", [["collinear"], ["collinear"]]),
		]);

		expect(gaps[0].text).toBe(
			"always runs alongside another model, so its own cost cannot be separated",
		);
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
		flatScope: "all-accounts",
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

	it("qualifies a claim that only covers the accounts still reporting", () => {
		// A cohort where one live account's readings no longer carry this window.
		// The remaining accounts cannot speak for it, and an unqualified sentence
		// would state a cohort-wide provider fact established on a subset.
		const text =
			flatWindowNotice(
				"codex",
				flatWindow({ flatScope: "reporting-subset" }),
			) ?? "";

		expect(text).toContain(
			"has reported 0% for this window on the accounts still reporting it since",
		);
	});

	it("qualifies the differing-value wording too", () => {
		// The branch where a dropped member does the most damage: this wording
		// asserts agreement ACROSS accounts, so it must never say "every account"
		// when one was excluded from the decision.
		const text =
			flatWindowNotice(
				"anthropic",
				flatWindow({ flatValuePct: null, flatScope: "reporting-subset" }),
			) ?? "";

		expect(text).toContain(
			"on every account still reporting it since 12 Jul 2026",
		);
	});

	it("reads a payload with no scope as the qualified claim", () => {
		// A cached blob written before the field existed cannot vouch for who its
		// flat claim covered. The narrower sentence is true either way; the wider
		// one is the overclaim the field was added to prevent.
		const text =
			flatWindowNotice("codex", flatWindow({ flatScope: undefined })) ?? "";

		expect(text).toContain("on the accounts still reporting it");
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

/* -- Windows our readings no longer include ------------------------------ */

/** 2026-08-21T12:00:00Z, the first reading that carried no 5-hour value. */
const NOT_REPORTED_SINCE = Date.UTC(2026, 7, 21, 12, 0, 0, 0);

function absentWindow(
	over: Partial<QuotaDriftWindowResult> = {},
): QuotaDriftWindowResult {
	return flatWindow({
		flatSince: null,
		flatValuePct: null,
		flatScope: null,
		notReportedSince: NOT_REPORTED_SINCE,
		notReportedScope: "all-accounts",
		...over,
	});
}

describe("notReportedNotice", () => {
	it("states what our readings did not include, and nothing more", () => {
		expect(notReportedNotice("codex", absentWindow())).toBe(
			"No OpenAI usage reading since 21 Aug 2026 has included a 5-hour " +
				"value. There is nothing after that date for this chart to measure.",
		);
	});

	it("never says the provider retired, removed or stopped anything", () => {
		// A null percentage proves absence from OUR normalized reading. A
		// normalizer bug and a provider change are indistinguishable from here,
		// so every one of these words would claim more than the payload contains.
		const text = notReportedNotice("codex", absentWindow()) ?? "";

		expect(text).not.toContain("retired");
		expect(text).not.toContain("removed");
		expect(text).not.toContain("no longer");
		expect(text).not.toContain("stopped");
	});

	it("names the weekly window's value correctly", () => {
		const text =
			notReportedNotice("anthropic", absentWindow({ window: "seven_day" })) ??
			"";

		expect(text).toContain("has included a weekly value");
	});

	it("calls a partial rollout what it is", () => {
		// Some accounts still report the window. An unqualified sentence would
		// state a cohort-wide observation none of the readings support.
		const text =
			notReportedNotice(
				"codex",
				absentWindow({ notReportedScope: "reporting-subset" }),
			) ?? "";

		expect(text).toBe(
			"Some OpenAI accounts have included a 5-hour value in no reading " +
				"since 21 Aug 2026, while others still report one.",
		);
	});

	it("never claims the rest of the cohort still reports the window", () => {
		// Both accounts stopped carrying it; only one absence is old enough to
		// report. "While others still report one" would be a false statement
		// about an account whose newest readings are null.
		const text =
			notReportedNotice(
				"codex",
				absentWindow({ notReportedScope: "partial-cohort" }),
			) ?? "";

		expect(text).toBe(
			"Some OpenAI accounts have included a 5-hour value in no reading " +
				"since 21 Aug 2026. Whether the cohort's other accounts still " +
				"report one was not established.",
		);
		expect(text).not.toContain("while others still report one");
	});

	it("reads a payload with no scope as the claim that asserts least", () => {
		// A cached blob written before the field existed cannot vouch for whether
		// every account stopped carrying the window - and just as importantly, it
		// cannot vouch for the ones it does not cover still reporting it.
		const text =
			notReportedNotice(
				"codex",
				absentWindow({ notReportedScope: undefined }),
			) ?? "";

		expect(text).toContain("Some OpenAI accounts");
		expect(text).not.toContain("while others still report one");
	});

	it("says nothing while readings still carry the value", () => {
		expect(
			notReportedNotice("codex", absentWindow({ notReportedSince: null })),
		).toBeNull();
		// A pre-change cached payload carries neither field at all.
		expect(
			notReportedNotice("codex", {
				window: "five_hour",
				nSegments: 1,
				r2: 0,
				zeroObservedTokenDeltaShare: 0,
				models: [],
			}),
		).toBeNull();
	});

	it("stands alongside the value the window last showed", () => {
		// The absence sentence dates the disappearance; this one says how full the
		// window was when it went. Two claims, each about something recorded.
		const window = absentWindow({ lastObservedValuePct: 0 });

		expect(lastObservedValueNotice(window)).toBe(
			"The most recent reading in this cohort that included a 5-hour value, " +
				"on 21 Aug 2026, showed 0%.",
		);
	});

	it("stands alongside the flat notice on a cohort that is split", () => {
		// Two facts about two sets of accounts, each already qualified by its own
		// scope. Merging them into one history would describe an account that
		// does not exist.
		const window = absentWindow({
			flatSince: FLAT_SINCE,
			flatValuePct: 0,
			flatScope: "reporting-subset",
			notReportedScope: "reporting-subset",
		});

		expect(notReportedNotice("codex", window)).toContain(
			"Some OpenAI accounts",
		);
		expect(flatWindowNotice("codex", window)).toContain(
			"on the accounts still reporting it",
		);
	});
});

describe("lastObservedValueNotice", () => {
	it("quotes one recorded reading, and claims nothing beyond it", () => {
		const text = lastObservedValueNotice(
			absentWindow({ lastObservedValuePct: 43.5 }),
		);

		expect(text).toBe(
			"The most recent reading in this cohort that included a 5-hour value, " +
				"on 21 Aug 2026, showed 43.5%.",
		);
		// Never a claim about a period, a trend, or the present.
		expect(text).not.toContain("since");
		expect(text).not.toContain("still");
	});

	it("names the weekly window's value correctly", () => {
		const text =
			lastObservedValueNotice(
				absentWindow({ window: "seven_day", lastObservedValuePct: 12 }),
			) ?? "";

		expect(text).toContain("that included a weekly value");
	});

	it("says nothing when the cohort had no single reading to quote", () => {
		// Two accounts share the newest observation at different percentages, so
		// the server sends null. Rendering an empty or substituted value here
		// would be worst in exactly the case the sentence exists for.
		expect(
			lastObservedValueNotice(absentWindow({ lastObservedValuePct: null })),
		).toBeNull();
		expect(
			lastObservedValueNotice(
				absentWindow({ lastObservedValuePct: 0, lastObservedMs: null }),
			),
		).toBeNull();
	});

	it("is not sourced from the flat value, which is null in this case", () => {
		// The live shape: the flat gate failed, so `flatValuePct` is null while the
		// window plainly showed something the last time a reading carried it.
		const text = lastObservedValueNotice(
			absentWindow({ flatValuePct: null, lastObservedValuePct: 0 }),
		);

		expect(text).toContain("showed 0%");
	});

	it("says nothing while the readings still carry the window", () => {
		// A cohort still reporting the window has current usage on the dashboard
		// already, in a form that keeps up with it.
		expect(
			lastObservedValueNotice(
				absentWindow({ notReportedSince: null, lastObservedValuePct: 0 }),
			),
		).toBeNull();
	});

	it("renders nothing from a payload written before the field existed", () => {
		expect(
			lastObservedValueNotice({
				window: "five_hour",
				nSegments: 1,
				r2: 0,
				zeroObservedTokenDeltaShare: 0,
				models: [],
			}),
		).toBeNull();
	});
});
