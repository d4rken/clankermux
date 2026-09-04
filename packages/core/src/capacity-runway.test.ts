import { describe, expect, it } from "bun:test";
import type { UsagePrediction } from "@clankermux/types";
import {
	computeCapacityRunway,
	computeCapacityRunwayBand,
	estimateWindowExhaustion,
	RUNWAY_HORIZON_MS,
	type RunwayAccountInput,
	type RunwayResetCreditBank,
	type RunwayWindowInput,
	runwayPaceHeadroom,
} from "./capacity-runway";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function prediction(overrides: Partial<UsagePrediction> = {}): UsagePrediction {
	return {
		state: "rising",
		slopePerHour: 10,
		etaExhaustMs: null,
		predictedAtReset: null,
		resetsAtMs: null,
		willExhaustBeforeReset: false,
		lowConfidence: false,
		...overrides,
	};
}

describe("estimateWindowExhaustion", () => {
	it("reports an already-spent window before looking at the reset", () => {
		const spent = estimateWindowExhaustion(
			{
				utilizationPct: 100,
				resetsAtMs: NOW + 2 * HOUR,
				windowStartMs: NOW - 3 * HOUR,
				prediction: null,
			},
			NOW,
		);

		expect(spent.source).toBe("already-exhausted");
		expect(spent.exhaustsAtMs).toBe(NOW);
		expect(spent.slopePctPerHour).toBeNull();

		// A stale or missing reset does not make a spent window un-spent.
		const spentStale = estimateWindowExhaustion(
			{
				utilizationPct: 104,
				resetsAtMs: null,
				windowStartMs: null,
				prediction: null,
			},
			NOW,
		);
		expect(spentStale.source).toBe("already-exhausted");
		expect(spentStale.exhaustsAtMs).toBe(NOW);
	});

	it("rejects an expired or missing reset as no evidence", () => {
		const expired = estimateWindowExhaustion(
			{
				utilizationPct: 50,
				resetsAtMs: NOW - 1,
				windowStartMs: NOW - 5 * HOUR,
				prediction: null,
			},
			NOW,
		);
		expect(expired.source).toBe("none");
		expect(expired.slopePctPerHour).toBeNull();
		expect(expired.exhaustsAtMs).toBeNull();

		const missing = estimateWindowExhaustion(
			{
				utilizationPct: 50,
				resetsAtMs: null,
				windowStartMs: NOW - 5 * HOUR,
				prediction: null,
			},
			NOW,
		);
		expect(missing.source).toBe("none");
	});

	it("distinguishes an unused window from one with no evidence", () => {
		const unused = estimateWindowExhaustion(
			{
				utilizationPct: 0,
				resetsAtMs: NOW + 2 * HOUR,
				windowStartMs: NOW - 3 * HOUR,
				prediction: null,
			},
			NOW,
		);

		expect(unused.source).toBe("no-usage");
		expect(unused.slopePctPerHour).toBeNull();
		expect(unused.exhaustsAtMs).toBeNull();
		expect(unused.lowConfidence).toBe(false);
	});

	it("lets a usable prediction win at 0% too", () => {
		const resetsAtMs = NOW + 2 * HOUR;
		const result = estimateWindowExhaustion(
			{
				utilizationPct: 0,
				resetsAtMs,
				windowStartMs: NOW - 3 * HOUR,
				prediction: prediction({
					resetsAtMs,
					slopePerHour: 20,
					etaExhaustMs: NOW + HOUR,
				}),
			},
			NOW,
		);

		expect(result.source).toBe("regression");
		expect(result.exhaustsAtMs).toBe(NOW + HOUR);
	});

	it("holds flat on a non-positive regression slope instead of falling back", () => {
		const resetsAtMs = NOW + 2 * HOUR;
		const result = estimateWindowExhaustion(
			{
				utilizationPct: 75,
				resetsAtMs,
				windowStartMs: NOW - 3 * HOUR,
				prediction: prediction({
					resetsAtMs,
					state: "stable",
					slopePerHour: -4,
					etaExhaustMs: NOW + HOUR,
				}),
			},
			NOW,
		);

		expect(result.source).toBe("regression");
		expect(result.slopePctPerHour).toBe(0);
		expect(result.exhaustsAtMs).toBeNull();
		expect(result.lowConfidence).toBe(false);
	});

	// The regression ETA is anchored to the newest SAMPLE inside the server-side
	// fit. Recomputing it as `now + headroom / slope` would push projected
	// exhaustion further away on every UI tick between refetches, so the value is
	// taken verbatim and must not move when only `now` advances.
	it("keeps the regression ETA fixed as now advances", () => {
		const resetsAtMs = NOW + 4 * HOUR;
		const pred = prediction({
			resetsAtMs,
			slopePerHour: 25,
			etaExhaustMs: NOW + 2 * HOUR,
		});
		const input = {
			utilizationPct: 50,
			resetsAtMs,
			windowStartMs: NOW - HOUR,
			prediction: pred,
		};

		const first = estimateWindowExhaustion(input, NOW);
		const later = estimateWindowExhaustion(input, NOW + 30_000);
		const muchLater = estimateWindowExhaustion(input, NOW + 25 * 60_000);

		expect(first.exhaustsAtMs).toBe(NOW + 2 * HOUR);
		expect(later.exhaustsAtMs).toBe(NOW + 2 * HOUR);
		expect(muchLater.exhaustsAtMs).toBe(NOW + 2 * HOUR);
	});

	it("falls back to the now-anchored lifetime average, flagged low confidence", () => {
		// 75% used three hours into a five-hour window: 25 %/h, one hour to go.
		const result = estimateWindowExhaustion(
			{
				utilizationPct: 75,
				resetsAtMs: NOW + 2 * HOUR,
				windowStartMs: NOW - 3 * HOUR,
				prediction: null,
			},
			NOW,
		);

		expect(result.source).toBe("lifetime-average");
		expect(result.slopePctPerHour).toBeCloseTo(25, 9);
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + HOUR, -1);
		expect(result.lowConfidence).toBe(true);
	});

	it("defaults to low confidence when no policy is supplied", () => {
		// The field is optional and its absence must reproduce the old behaviour
		// exactly — every window that was amber-capped before still is.
		const implicit = estimateWindowExhaustion(
			{
				utilizationPct: 75,
				resetsAtMs: NOW + 2 * HOUR,
				windowStartMs: NOW - 3 * HOUR,
				prediction: null,
			},
			NOW,
		);
		const explicit = estimateWindowExhaustion(
			{
				utilizationPct: 75,
				resetsAtMs: NOW + 2 * HOUR,
				windowStartMs: NOW - 3 * HOUR,
				prediction: null,
				lifetimeConfidence: "low",
			},
			NOW,
		);

		expect(implicit).toEqual(explicit);
		expect(implicit.source).toBe("lifetime-average");
		expect(implicit.lowConfidence).toBe(true);

		// An observation time changes nothing on the low path: it is read only by
		// the full-confidence branch, so the historical arithmetic is untouched
		// whether or not the surface happens to know when it sampled.
		const lowWithObservation = estimateWindowExhaustion(
			{
				utilizationPct: 75,
				resetsAtMs: NOW + 2 * HOUR,
				windowStartMs: NOW - 3 * HOUR,
				prediction: null,
				lifetimeConfidence: "low",
				observedAtMs: NOW - 90 * 60_000,
			},
			NOW,
		);
		const implicitWithObservation = estimateWindowExhaustion(
			{
				utilizationPct: 75,
				resetsAtMs: NOW + 2 * HOUR,
				windowStartMs: NOW - 3 * HOUR,
				prediction: null,
				observedAtMs: NOW - 90 * 60_000,
			},
			NOW,
		);
		expect(lowWithObservation).toEqual(explicit);
		expect(implicitWithObservation).toEqual(explicit);
	});

	it("reports the lifetime average as primary when the caller declares it", () => {
		const full = estimateWindowExhaustion(
			{
				utilizationPct: 75,
				resetsAtMs: NOW + 2 * HOUR,
				windowStartMs: NOW - 3 * HOUR,
				prediction: null,
				lifetimeConfidence: "full",
				observedAtMs: NOW,
			},
			NOW,
		);

		expect(full.source).toBe("lifetime-primary");
		expect(full.lowConfidence).toBe(false);
		// 75% three hours in: 25 %/h, so the last 25% takes one more hour. Same
		// arithmetic as the low path — what differs is the anchor it is measured
		// from, which here happens to coincide with `now`.
		expect(full.slopePctPerHour).toBeCloseTo(25, 9);
		expect(full.exhaustsAtMs).toBe(NOW + HOUR);
	});

	// Full confidence is earned by the PAIR (policy and observation time). Without
	// an instant to anchor to, the only estimate available is the now-anchored one
	// — and that one may not reach red, so the request degrades rather than
	// borrowing `now` as a stand-in observation.
	it("degrades a full-confidence request with no usable observation time", () => {
		const base = {
			utilizationPct: 75,
			resetsAtMs: NOW + 2 * HOUR,
			windowStartMs: NOW - 3 * HOUR,
			prediction: null,
		};
		const low = estimateWindowExhaustion(base, NOW);

		const unusableObservations = [
			undefined,
			null,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			// Not after the window opened, so it measures nothing.
			NOW - 3 * HOUR,
			NOW - 4 * HOUR,
		];
		for (const observedAtMs of unusableObservations) {
			const degraded = estimateWindowExhaustion(
				{ ...base, lifetimeConfidence: "full" as const, observedAtMs },
				NOW,
			);
			expect(degraded).toEqual(low);
			expect(degraded.source).toBe("lifetime-average");
			expect(degraded.lowConfidence).toBe(true);
		}
	});

	it("applies the policy only to the lifetime branch", () => {
		const resetsAtMs = NOW + 2 * HOUR;
		const base = {
			resetsAtMs,
			windowStartMs: NOW - 3 * HOUR,
			lifetimeConfidence: "full" as const,
		};

		// A usable regression still owns the slope, and its source name is unchanged.
		expect(
			estimateWindowExhaustion(
				{
					...base,
					utilizationPct: 50,
					prediction: prediction({
						resetsAtMs,
						slopePerHour: 20,
						etaExhaustMs: NOW + HOUR,
					}),
				},
				NOW,
			).source,
		).toBe("regression");
		expect(
			estimateWindowExhaustion(
				{ ...base, utilizationPct: 0, prediction: null },
				NOW,
			).source,
		).toBe("no-usage");
		expect(
			estimateWindowExhaustion(
				{ ...base, utilizationPct: 100, prediction: null },
				NOW,
			).source,
		).toBe("already-exhausted");
		expect(
			estimateWindowExhaustion(
				{ ...base, resetsAtMs: NOW - 1, utilizationPct: 50, prediction: null },
				NOW,
			).source,
		).toBe("none");
	});

	// The full-confidence lifetime estimate can render red, so it has to be a
	// function of the READING and not of when the surface last ticked. Anchored at
	// `now` the ETA slides later by 1 + (100 - pct)/pct per unit of wall clock, so
	// the reset margin shrinks on evidence that never changed — which is what
	// walks a projection sitting near the red threshold across it between two
	// 30-second dashboard ticks.
	it("anchors the full-confidence lifetime estimate at its observation", () => {
		const input = {
			utilizationPct: 80,
			resetsAtMs: NOW + 2 * DAY,
			windowStartMs: NOW - 5 * DAY,
			prediction: null,
			lifetimeConfidence: "full" as const,
			observedAtMs: NOW,
		};

		const first = estimateWindowExhaustion(input, NOW);
		const later = estimateWindowExhaustion(input, NOW + 30_000);
		const muchLater = estimateWindowExhaustion(input, NOW + 25 * 60_000);

		expect(first.source).toBe("lifetime-primary");
		expect(first.lowConfidence).toBe(false);
		// 80% five days in: 16 %/day, so the last 20% takes another 1.25 days.
		expect(first.slopePctPerHour).toBeCloseTo(80 / (5 * 24), 9);
		expect(first.exhaustsAtMs).toBe(NOW + 1.25 * DAY);
		expect(later).toEqual(first);
		expect(muchLater).toEqual(first);
	});

	// The anchor is the OBSERVATION, not the newest of the two: a reading sampled
	// minutes ago projects from where it was sampled, which is also what stops the
	// estimate moving while that reading is what the surface still holds.
	it("projects a full-confidence estimate from an older observation", () => {
		const observedAtMs = NOW - 6 * HOUR;
		const result = estimateWindowExhaustion(
			{
				utilizationPct: 80,
				resetsAtMs: NOW + 2 * DAY,
				windowStartMs: NOW - 5 * DAY,
				prediction: null,
				lifetimeConfidence: "full",
				observedAtMs,
			},
			NOW,
		);

		const elapsed = observedAtMs - (NOW - 5 * DAY);
		expect(result.source).toBe("lifetime-primary");
		expect(result.exhaustsAtMs).toBe(observedAtMs + 0.25 * elapsed);
		expect(result.slopePctPerHour).toBeCloseTo((80 / elapsed) * HOUR, 9);
	});

	it("moves the lifetime-average ETA with now (it is not sample-anchored)", () => {
		const input = {
			utilizationPct: 75,
			resetsAtMs: NOW + 2 * HOUR,
			windowStartMs: NOW - 3 * HOUR,
			prediction: null,
		};

		const first = estimateWindowExhaustion(input, NOW);
		const later = estimateWindowExhaustion(input, NOW + 60_000);

		expect(first.exhaustsAtMs).not.toBeNull();
		expect(later.exhaustsAtMs).not.toBeNull();
		expect(later.exhaustsAtMs as number).toBeGreaterThan(
			first.exhaustsAtMs as number,
		);
	});

	it("treats a window whose start is not before its reset as no evidence", () => {
		const result = estimateWindowExhaustion(
			{
				utilizationPct: 40,
				resetsAtMs: NOW + HOUR,
				windowStartMs: NOW + 2 * HOUR,
				prediction: null,
			},
			NOW,
		);

		expect(result.source).toBe("none");
	});
});

describe("estimateWindowExhaustion with a burn anchor", () => {
	// The motivating case: a provider "gift" reset five days into a weekly
	// window (utilization back to ~0, resets_at unchanged), then 40% burned in
	// the next 12 hours. The structural lifetime average divides 40% by 5.5 days
	// of elapsed window (0.30 %/h, ~8 days of headroom); the true post-gift rate
	// is 40%/12h = 3.33 %/h, which exhausts in 18 hours — well before the reset.
	const WINDOW_START = NOW - 5.5 * DAY;
	const RESET = NOW + 1.5 * DAY;
	const GIFT_AT = NOW - 12 * HOUR;
	const giftAnchor = { anchorMs: GIFT_AT, anchorPct: 0, windowResetMs: RESET };
	const fullInput = {
		utilizationPct: 40,
		resetsAtMs: RESET,
		windowStartMs: WINDOW_START,
		prediction: null,
		lifetimeConfidence: "full" as const,
		observedAtMs: NOW,
	};

	it("re-anchors the full-confidence slope and ETA at the revision", () => {
		const result = estimateWindowExhaustion(
			{ ...fullInput, anchor: giftAnchor },
			NOW,
		);

		expect(result.source).toBe("lifetime-primary");
		expect(result.anchored).toBe(true);
		// (40 - 0) over the 12h since the gift, not over 5.5 days of window.
		expect(result.slopePctPerHour).toBeCloseTo(40 / 12, 9);
		// Observation-anchored: obs + ((100 - 40) / (40 - 0)) * 12h = obs + 18h.
		expect(result.exhaustsAtMs).toBe(NOW + 18 * HOUR);
	});

	it("without the anchor the same reading projects past the reset", () => {
		const result = estimateWindowExhaustion(fullInput, NOW);
		expect(result.anchored ?? false).toBe(false);
		// The un-anchored estimate is the bug being fixed: it must clear the
		// reset so the pair of tests PINS the 11x divergence rather than
		// asserting two arbitrary numbers.
		expect(result.exhaustsAtMs).toBeGreaterThan(RESET);
	});

	it("keeps the anchored estimate observation-stable across ticks", () => {
		const first = estimateWindowExhaustion(
			{ ...fullInput, anchor: giftAnchor },
			NOW,
		);
		const later = estimateWindowExhaustion(
			{ ...fullInput, anchor: giftAnchor },
			NOW + 25 * 60_000,
		);
		expect(later).toEqual(first);
	});

	it("stays amber-capped until an hour of post-anchor evidence exists", () => {
		// Observation 30 minutes after the gift: the arithmetic is corrected
		// immediately, but the tone must not reach red on minutes of evidence.
		const soonAfter = estimateWindowExhaustion(
			{
				...fullInput,
				utilizationPct: 10,
				observedAtMs: GIFT_AT + 30 * 60_000,
				anchor: giftAnchor,
			},
			NOW,
		);
		expect(soonAfter.anchored).toBe(true);
		expect(soonAfter.lowConfidence).toBe(true);
		expect(soonAfter.slopePctPerHour).toBeCloseTo(10 / 0.5, 9);

		const afterAnHour = estimateWindowExhaustion(
			{
				...fullInput,
				utilizationPct: 10,
				observedAtMs: GIFT_AT + 60 * 60_000,
				anchor: giftAnchor,
			},
			NOW,
		);
		expect(afterAnHour.lowConfidence).toBe(false);
	});

	it("re-anchors the low-confidence path too, still now-anchored", () => {
		const result = estimateWindowExhaustion(
			{
				utilizationPct: 40,
				resetsAtMs: RESET,
				windowStartMs: WINDOW_START,
				prediction: null,
				observedAtMs: NOW,
				anchor: giftAnchor,
			},
			NOW,
		);

		expect(result.source).toBe("lifetime-average");
		expect(result.anchored).toBe(true);
		expect(result.lowConfidence).toBe(true);
		expect(result.slopePctPerHour).toBeCloseTo(40 / 12, 9);
		// Now-anchored, like every other low-path estimate.
		expect(result.exhaustsAtMs).toBe(NOW + 18 * HOUR);
	});

	it("handles a gift that reset to a non-zero percentage", () => {
		const result = estimateWindowExhaustion(
			{
				...fullInput,
				anchor: { ...giftAnchor, anchorPct: 15 },
			},
			NOW,
		);
		// Burned 25 points in 12h since the revision.
		expect(result.slopePctPerHour).toBeCloseTo(25 / 12, 9);
		expect(result.exhaustsAtMs).toBe(NOW + (60 / 25) * 12 * HOUR);
	});

	it("ignores an anchor whose window identity does not match", () => {
		const result = estimateWindowExhaustion(
			{
				...fullInput,
				anchor: { ...giftAnchor, windowResetMs: RESET + 2 * HOUR },
			},
			NOW,
		);
		expect(result.anchored ?? false).toBe(false);
		expect(result).toEqual(estimateWindowExhaustion(fullInput, NOW));
	});

	it("tolerates reset jitter on the anchor's window identity", () => {
		const result = estimateWindowExhaustion(
			{
				...fullInput,
				anchor: { ...giftAnchor, windowResetMs: RESET + 30_000 },
			},
			NOW,
		);
		expect(result.anchored).toBe(true);
	});

	it("ignores an anchor lying outside the current window span", () => {
		const before = estimateWindowExhaustion(
			{
				...fullInput,
				anchor: { ...giftAnchor, anchorMs: WINDOW_START - HOUR },
			},
			NOW,
		);
		expect(before.anchored ?? false).toBe(false);

		const after = estimateWindowExhaustion(
			{
				...fullInput,
				anchor: { ...giftAnchor, anchorMs: RESET + HOUR },
			},
			NOW,
		);
		expect(after.anchored ?? false).toBe(false);
	});

	it("holds flat when utilization sits at or below the anchor percentage", () => {
		// A refund landing after the anchor can put the reading below anchorPct.
		// The precedent is the regression's non-positive slope: hold, no ETA,
		// and never fall back to the structural start (which would resurrect
		// the very overestimate the anchor exists to remove).
		const result = estimateWindowExhaustion(
			{
				...fullInput,
				utilizationPct: 10,
				anchor: { ...giftAnchor, anchorPct: 15 },
			},
			NOW,
		);
		expect(result.anchored).toBe(true);
		expect(result.slopePctPerHour).toBe(0);
		expect(result.exhaustsAtMs).toBeNull();
	});

	it("never outranks a usable regression", () => {
		const reg = prediction({
			resetsAtMs: RESET,
			slopePerHour: 2,
			etaExhaustMs: NOW + 5 * HOUR,
		});
		const result = estimateWindowExhaustion(
			{ ...fullInput, prediction: reg, anchor: giftAnchor },
			NOW,
		);
		expect(result.source).toBe("regression");
		expect(result.exhaustsAtMs).toBe(NOW + 5 * HOUR);
	});

	it("treats the reading AT the anchor as anchored, not structural", () => {
		// The first post-revision sample IS the anchor: observedAtMs equals
		// anchorMs and the reading's pct equals anchorPct. Falling through to
		// the structural estimate here would render a confident projection from
		// PRE-revision burn — the exact number the anchor exists to retire.
		const result = estimateWindowExhaustion(
			{
				...fullInput,
				utilizationPct: 30,
				observedAtMs: GIFT_AT,
				anchor: { ...giftAnchor, anchorPct: 30 },
			},
			NOW,
		);
		expect(result.anchored).toBe(true);
		expect(result.slopePctPerHour).toBe(0);
		expect(result.exhaustsAtMs).toBeNull();
		expect(result.lowConfidence).toBe(true);
	});

	it("ignores an anchor newer than the projected reading", () => {
		// A stale reading from BEFORE the revision must not be mixed with the
		// post-revision anchor — the pair spans opposite sides of the event.
		const result = estimateWindowExhaustion(
			{
				...fullInput,
				observedAtMs: GIFT_AT - 2 * HOUR,
				anchor: giftAnchor,
			},
			NOW,
		);
		expect(result.anchored ?? false).toBe(false);
	});

	it("ignores an anchor when the reading's observation time is unknown", () => {
		// Without an observation time the reading cannot be placed relative to
		// the revision; the low path degrades to the structural estimate rather
		// than guessing.
		const withAnchor = estimateWindowExhaustion(
			{
				utilizationPct: 40,
				resetsAtMs: RESET,
				windowStartMs: WINDOW_START,
				prediction: null,
				anchor: giftAnchor,
			},
			NOW,
		);
		const without = estimateWindowExhaustion(
			{
				utilizationPct: 40,
				resetsAtMs: RESET,
				windowStartMs: WINDOW_START,
				prediction: null,
			},
			NOW,
		);
		expect(withAnchor).toEqual(without);
	});

	it("does not disturb the terminal branches", () => {
		const spent = estimateWindowExhaustion(
			{ ...fullInput, utilizationPct: 100, anchor: giftAnchor },
			NOW,
		);
		expect(spent.source).toBe("already-exhausted");

		const idle = estimateWindowExhaustion(
			{ ...fullInput, utilizationPct: 0, anchor: giftAnchor },
			NOW,
		);
		expect(idle.source).toBe("no-usage");
	});
});

function window(overrides: Partial<RunwayWindowInput> = {}): RunwayWindowInput {
	return {
		windowKind: "five_hour",
		utilizationPct: 50,
		resetsAtMs: NOW + 2 * HOUR,
		windowStartMs: NOW - 3 * HOUR,
		prediction: null,
		...overrides,
	};
}

function account(
	accountId: string,
	windows: RunwayWindowInput[],
	unmetered = false,
): RunwayAccountInput {
	return { accountId, unmetered, windows };
}

/**
 * A window driven purely by a regression slope, so the test controls the dead
 * fraction of every cycle directly: `timeToFullHours` in a `durationHours`
 * cycle leaves the cycle's tail dead. `etaExhaustMs` is placed past the reset so
 * the CURRENT cycle contributes nothing and only the projected later cycles do.
 */
function cyclicWindow(
	windowKind: string,
	resetsAtMs: number,
	durationHours: number,
	timeToFullHours: number,
): RunwayWindowInput {
	return {
		windowKind,
		utilizationPct: 50,
		resetsAtMs,
		windowStartMs: resetsAtMs - durationHours * HOUR,
		prediction: prediction({
			resetsAtMs,
			slopePerHour: 100 / timeToFullHours,
			etaExhaustMs: resetsAtMs + HOUR,
		}),
	};
}

describe("computeCapacityRunway", () => {
	it("reports no accounts for an empty pool", () => {
		expect(computeCapacityRunway([], NOW)).toEqual({ kind: "no-accounts" });
	});

	it("reports unknown when no account has a readable window", () => {
		const result = computeCapacityRunway(
			[
				account("a", [window({ resetsAtMs: null })]),
				account("b", []),
				account("c", [window({ resetsAtMs: NOW - HOUR })]),
			],
			NOW,
		);

		expect(result).toEqual({ kind: "unknown" });
	});

	it("threads the lifetime-confidence policy and its observation time verbatim", () => {
		// Both fields are carried straight to the estimator, and the pair is what
		// decides the answer. Declaring the weekly window's lifetime average primary
		// with no observation time to anchor it degrades to the amber-capped
		// now-anchored estimate, so the runway is exactly the low path's.
		const windows = (
			lifetimeConfidence?: "low" | "full",
			observedAtMs?: number,
		) => [
			window({
				windowKind: "seven_day",
				utilizationPct: 80,
				resetsAtMs: NOW + 2 * DAY,
				windowStartMs: NOW - 5 * DAY,
				lifetimeConfidence,
				observedAtMs,
			}),
		];

		expect(computeCapacityRunway([account("a", windows("full"))], NOW)).toEqual(
			computeCapacityRunway([account("a", windows())], NOW),
		);

		// Given one, the window runs out where the READING says it does — 80% over
		// the 114 hours to the observation leaves 28.5 more — and stays there while
		// `now` walks on, so the runway does not drift between polls.
		// `probePaceMargin: false` on both: this test is about WHERE the runway
		// lands and that it does not drift, and the exact-shape assertion below
		// would otherwise have to pin the pace-deficit multiplier the probe
		// happens to find — a number with no bearing on lifetime-confidence
		// threading, which would break this test if the probe's floor or grid ever
		// changed. The probe has its own describe block.
		const observedAtMs = NOW - 6 * HOUR;
		const anchoredAtNow = computeCapacityRunway(
			[account("a", windows("full", observedAtMs))],
			NOW,
			RUNWAY_HORIZON_MS,
			{ probePaceMargin: false },
		);
		const anchoredLater = computeCapacityRunway(
			[account("a", windows("full", observedAtMs))],
			NOW + 30_000,
			RUNWAY_HORIZON_MS,
			{ probePaceMargin: false },
		);

		expect(anchoredAtNow).toEqual({
			kind: "runway",
			exhaustsAtMs: NOW + 22.5 * HOUR,
			durationMs: 22.5 * HOUR,
			causes: [{ accountId: "a", windowKind: "seven_day" }],
			unprojectableAccountIds: [],
		});
		expect(
			anchoredLater.kind === "runway" ? anchoredLater.exhaustsAtMs : null,
		).toBe(NOW + 22.5 * HOUR);
	});

	it("keeps an unmetered account alive for the whole horizon", () => {
		const result = computeCapacityRunway(
			[
				account("spent", [window({ utilizationPct: 100 })]),
				account("ollama", [], true),
			],
			NOW,
		);

		expect(result.kind).toBe("beyond-horizon");
		if (result.kind !== "beyond-horizon") throw new Error("unreachable");
		expect(result.horizonMs).toBe(RUNWAY_HORIZON_MS);
		expect(result.unprojectableAccountIds).toEqual([]);
	});

	it("reports out-now when every account is already spent", () => {
		const result = computeCapacityRunway(
			[
				account("with-reset", [
					window({ utilizationPct: 100, resetsAtMs: NOW + 2 * HOUR }),
				]),
				account("no-reset", [
					window({
						utilizationPct: 100,
						resetsAtMs: null,
						windowStartMs: null,
						windowKind: "seven_day",
					}),
				]),
			],
			NOW,
		);

		expect(result.kind).toBe("out-now");
		if (result.kind !== "out-now") throw new Error("unreachable");
		expect(result.causes).toEqual([
			{ accountId: "with-reset", windowKind: "five_hour" },
			{ accountId: "no-reset", windowKind: "seven_day" },
		]);
	});

	it("ends a spent account's dead span at its reset", () => {
		// `spent` is out until NOW + 2h; `burner` only runs out at NOW + 3h, so the
		// two never coincide.
		const result = computeCapacityRunway(
			[
				account("spent", [
					window({ utilizationPct: 100, resetsAtMs: NOW + 2 * HOUR }),
				]),
				account("burner", [
					// 25% used one hour in: 25 %/h, hits 100% three hours from now.
					window({
						utilizationPct: 25,
						resetsAtMs: NOW + 4 * HOUR,
						windowStartMs: NOW - HOUR,
					}),
				]),
			],
			NOW,
		);

		expect(result.kind).toBe("beyond-horizon");
	});

	it("holds a spent account with no reset dead for the whole horizon", () => {
		const result = computeCapacityRunway(
			[
				account("spent", [
					window({
						utilizationPct: 100,
						resetsAtMs: null,
						windowStartMs: null,
					}),
				]),
				account("burner", [
					window({
						utilizationPct: 25,
						resetsAtMs: NOW + 4 * HOUR,
						windowStartMs: NOW - HOUR,
					}),
				]),
			],
			NOW,
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.durationMs).toBeCloseTo(3 * HOUR, -1);
		expect(result.causes).toEqual([
			{ accountId: "spent", windowKind: "five_hour" },
			{ accountId: "burner", windowKind: "five_hour" },
		]);
	});

	it("finds the first instant two current-cycle projections overlap", () => {
		const result = computeCapacityRunway(
			[
				// 75% three hours in: runs out at NOW + 1h, dead until NOW + 2h.
				account("a", [
					window({
						utilizationPct: 75,
						resetsAtMs: NOW + 2 * HOUR,
						windowStartMs: NOW - 3 * HOUR,
					}),
				]),
				// 80% two hours in: runs out at NOW + 0.5h, dead until NOW + 3h.
				account("b", [
					window({
						utilizationPct: 80,
						resetsAtMs: NOW + 3 * HOUR,
						windowStartMs: NOW - 2 * HOUR,
					}),
				]),
			],
			NOW,
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.durationMs).toBeCloseTo(HOUR, -1);
		expect(result.exhaustsAtMs).toBeCloseTo(NOW + HOUR, -1);
		expect(result.causes).toEqual([
			{ accountId: "a", windowKind: "five_hour" },
			{ accountId: "b", windowKind: "five_hour" },
		]);
	});

	it("attributes every window responsible at the limiting instant", () => {
		const result = computeCapacityRunway(
			[
				// Both of this account's windows are spent right now.
				account("double", [
					window({ utilizationPct: 100, resetsAtMs: NOW + 6 * HOUR }),
					window({
						windowKind: "seven_day",
						utilizationPct: 100,
						resetsAtMs: NOW + 3 * DAY,
						windowStartMs: NOW + 3 * DAY - 7 * DAY,
					}),
				]),
				account("single", [window({ utilizationPct: 100 })]),
			],
			NOW,
		);

		expect(result.kind).toBe("out-now");
		if (result.kind !== "out-now") throw new Error("unreachable");
		expect(result.causes).toEqual([
			{ accountId: "double", windowKind: "five_hour" },
			{ accountId: "double", windowKind: "seven_day" },
			{ accountId: "single", windowKind: "five_hour" },
		]);
	});

	// Two windows on one account produce overlapping dead spans. The scan reads
	// the union, so the five-hour span that starts while the account is already
	// out on its weekly window contributes no candidate of its own and cannot be
	// reported as the moment the pool ran out.
	it("unions an account's own overlapping windows before scanning", () => {
		const result = computeCapacityRunway(
			[
				account("multi", [
					// 75% three hours in: dead from NOW + 1h to NOW + 2h.
					window({
						utilizationPct: 75,
						resetsAtMs: NOW + 2 * HOUR,
						windowStartMs: NOW - 3 * HOUR,
					}),
					// 99% 49.5 hours into a seven-day window: dead from NOW + 0.5h all
					// the way to its reset.
					window({
						windowKind: "seven_day",
						utilizationPct: 99,
						resetsAtMs: NOW + 118.5 * HOUR,
						windowStartMs: NOW - 49.5 * HOUR,
					}),
				]),
				// 80% two hours in: dead from NOW + 0.5h to NOW + 3h.
				account("other", [
					window({
						utilizationPct: 80,
						resetsAtMs: NOW + 3 * HOUR,
						windowStartMs: NOW - 2 * HOUR,
					}),
				]),
			],
			NOW,
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.durationMs).toBeCloseTo(0.5 * HOUR, -1);
		// Only the weekly window is responsible at that instant; the five-hour one
		// has not run out yet.
		expect(result.causes).toEqual([
			{ accountId: "multi", windowKind: "seven_day" },
			{ accountId: "other", windowKind: "five_hour" },
		]);
	});

	it("projects later cycles so staggered windows can still coincide", () => {
		// Both windows reset a second from now, so their cycles are in phase at the
		// start. A five-hour window dead for its last hour and a daily window dead
		// for its last hour first coincide 119 hours out: 5 * 23 + 4 === 24 * 4 + 23.
		const resetsAtMs = NOW + 1000;
		const result = computeCapacityRunway(
			[
				account("fivehour", [cyclicWindow("five_hour", resetsAtMs, 5, 4)]),
				account("daily", [cyclicWindow("daily", resetsAtMs, 24, 23)]),
			],
			NOW,
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.durationMs).toBeCloseTo(1000 + 119 * HOUR, -3);
		expect(result.causes).toEqual([
			{ accountId: "fivehour", windowKind: "five_hour" },
			{ accountId: "daily", windowKind: "daily" },
		]);
	});

	// The horizon is a stated modelling limit, not a proof of "never". A weekly
	// window dead for its last 0.9 h and a five-hour window dead for its last
	// 0.1 h first coincide 839.9 hours out (5 * 167 + 4.9 === 168 * 4 + 167.1),
	// because the 5-hour and 7-day cycles only realign every 35 days. Two weeks
	// of modelling therefore reports "beyond horizon" for a pool that does run
	// out — which is exactly why `beyond-horizon` carries the horizon it checked.
	it("reports beyond-horizon for a run-out past the modelled window", () => {
		const resetsAtMs = NOW + 1000;
		const accounts = [
			account("weekly", [cyclicWindow("seven_day", resetsAtMs, 168, 167.1)]),
			account("fivehour", [cyclicWindow("five_hour", resetsAtMs, 5, 4.9)]),
		];

		const defaultHorizon = computeCapacityRunway(accounts, NOW);
		expect(defaultHorizon.kind).toBe("beyond-horizon");
		if (defaultHorizon.kind !== "beyond-horizon") {
			throw new Error("unreachable");
		}
		expect(defaultHorizon.horizonMs).toBe(RUNWAY_HORIZON_MS);

		const fiveWeeks = computeCapacityRunway(accounts, NOW, 35 * DAY);
		expect(fiveWeeks.kind).toBe("runway");
		if (fiveWeeks.kind !== "runway") throw new Error("unreachable");
		expect(fiveWeeks.durationMs).toBeCloseTo(1000 + 839.9 * HOUR, -3);
	});

	it("excludes unreadable accounts and reports them as a lower bound", () => {
		const result = computeCapacityRunway(
			[
				account("a", [
					window({
						utilizationPct: 75,
						resetsAtMs: NOW + 2 * HOUR,
						windowStartMs: NOW - 3 * HOUR,
					}),
				]),
				account("b", [
					window({
						utilizationPct: 80,
						resetsAtMs: NOW + 3 * HOUR,
						windowStartMs: NOW - 2 * HOUR,
					}),
				]),
				account("mystery", [window({ resetsAtMs: null })]),
			],
			NOW,
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.unprojectableAccountIds).toEqual(["mystery"]);
	});

	it("does not treat a readable but healthy window as unknown", () => {
		// 10% one hour into a five-hour window: never runs out before it resets,
		// and cannot be spent within a cycle either. It emits no dead interval, but
		// it is positively known to be available — not unprojectable.
		const result = computeCapacityRunway(
			[
				account("healthy", [
					window({
						utilizationPct: 10,
						resetsAtMs: NOW + 4 * HOUR,
						windowStartMs: NOW - HOUR,
					}),
				]),
			],
			NOW,
		);

		expect(result.kind).toBe("beyond-horizon");
		if (result.kind !== "beyond-horizon") throw new Error("unreachable");
		expect(result.unprojectableAccountIds).toEqual([]);
	});
});

describe("computeCapacityRunway with a reset-credit bank", () => {
	const DAY = 24 * HOUR;

	function bank(
		credits: Array<{ expiresAtMs: number | null }>,
		flags: { weekly?: boolean; expiry?: boolean } = {},
	): RunwayResetCreditBank {
		return {
			onWeeklyLimitEnabled: flags.weekly ?? true,
			onExpiryEnabled: flags.expiry ?? false,
			credits,
		};
	}

	/** Weekly window already at 100%, reset 2d out, structural start known. */
	function exhaustedWeekly(): RunwayWindowInput {
		return window({
			windowKind: "seven_day",
			utilizationPct: 100,
			resetsAtMs: NOW + 2 * DAY,
			windowStartMs: NOW + 2 * DAY - 7 * DAY,
		});
	}

	/**
	 * Weekly window projected (via regression) to exhaust at NOW+12h, burning
	 * 100% per 24h — so a revived window re-exhausts 24h after each revival.
	 */
	function burningWeekly(): RunwayWindowInput {
		return window({
			windowKind: "seven_day",
			utilizationPct: 50,
			resetsAtMs: NOW + 2 * DAY,
			windowStartMs: NOW + 2 * DAY - 7 * DAY,
			prediction: prediction({
				resetsAtMs: NOW + 2 * DAY,
				slopePerHour: 100 / 24,
				etaExhaustMs: NOW + 12 * HOUR,
			}),
		});
	}

	it("revives an exhausted-now weekly window instead of reporting out-now", () => {
		const result = computeCapacityRunway(
			[
				{
					accountId: "codex-1",
					unmetered: false,
					windows: [exhaustedWeekly()],
					codexResetCredits: bank([{ expiresAtMs: null }]),
				},
			],
			NOW,
		);

		// Revived at NOW; it took 5d to burn the window, so the re-exhaustion
		// lands past the 2d reset — nothing dead remains.
		expect(result.kind).toBe("beyond-horizon");
		if (result.kind !== "beyond-horizon") throw new Error("unreachable");
		expect(result.assumedResetCredits).toEqual([
			{ accountId: "codex-1", count: 1 },
		]);
	});

	it("without the bank the same pool is out now (baseline)", () => {
		const result = computeCapacityRunway(
			[
				{
					accountId: "codex-1",
					unmetered: false,
					windows: [exhaustedWeekly()],
				},
			],
			NOW,
		);
		expect(result.kind).toBe("out-now");
		if (result.kind !== "out-now") throw new Error("unreachable");
		expect(result.assumedResetCredits).toBeUndefined();
	});

	it("consumes one credit per exhaustion and re-exhausts at the modeled pace", () => {
		const result = computeCapacityRunway(
			[
				{
					accountId: "codex-1",
					unmetered: false,
					windows: [burningWeekly()],
					codexResetCredits: bank([{ expiresAtMs: null }]),
				},
			],
			NOW,
		);

		// Exhausts at +12h, credit revives it, 24h to burn again → dead from
		// +36h to the +48h reset. The single credit is spent, so that tail (and
		// the later cycles) stand.
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBe(NOW + 36 * HOUR);
		expect(result.assumedResetCredits).toEqual([
			{ accountId: "codex-1", count: 1 },
		]);
	});

	it("drains the bank chronologically and then the dead tail stands", () => {
		const result = computeCapacityRunway(
			[
				{
					accountId: "codex-1",
					unmetered: false,
					windows: [burningWeekly()],
					codexResetCredits: bank([
						{ expiresAtMs: null },
						{ expiresAtMs: null },
					]),
				},
			],
			NOW,
		);

		// Two revivals: +12h and +36h; the second re-exhaustion lands at +60h,
		// past the +48h reset, so the current window survives. The NEXT cycle
		// (starting +48h, dead from +72h) finds an empty bank.
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBe(NOW + 72 * HOUR);
		expect(result.assumedResetCredits).toEqual([
			{ accountId: "codex-1", count: 2 },
		]);
	});

	it("never consumes a credit that expired before the exhaustion instant", () => {
		const result = computeCapacityRunway(
			[
				{
					accountId: "codex-1",
					unmetered: false,
					windows: [burningWeekly()],
					codexResetCredits: bank([{ expiresAtMs: NOW + 6 * HOUR }]),
				},
			],
			NOW,
		);

		// The only credit expires at +6h; exhaustion is at +12h. No assumption.
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBe(NOW + 12 * HOUR);
		expect(result.assumedResetCredits).toBeUndefined();
	});

	it("expiry trigger revives a dead window at the credit's expiry instant", () => {
		const result = computeCapacityRunway(
			[
				{
					accountId: "codex-1",
					unmetered: false,
					windows: [exhaustedWeekly()],
					codexResetCredits: bank([{ expiresAtMs: NOW + 6 * HOUR }], {
						weekly: false,
						expiry: true,
					}),
				},
			],
			NOW,
		);

		// Weekly-limit auto-apply is OFF, so the window stays dead from NOW —
		// the pool is out now — but the near-expiry auto-apply redeems the
		// credit at +6h, so the modeled outage ends there instead of at the
		// reset, and the assumption is disclosed.
		expect(result.kind).toBe("out-now");
		if (result.kind !== "out-now") throw new Error("unreachable");
		expect(result.assumedResetCredits).toEqual([
			{ accountId: "codex-1", count: 1 },
		]);
	});

	it("expiry truncation actually shortens the dead span (pool-visible)", () => {
		// Account A is weekly-dead from NOW; its credit's expiry at +6h truncates
		// that span. Account B is 5h-dead over [+7h, +20h). Without the
		// truncation the pool's first all-dead instant is +7h (a 7h runway);
		// with it, A is alive again by +6h and the pool never goes all-dead.
		const a: RunwayAccountInput = {
			accountId: "codex-1",
			unmetered: false,
			windows: [exhaustedWeekly()],
			codexResetCredits: bank([{ expiresAtMs: NOW + 6 * HOUR }], {
				weekly: false,
				expiry: true,
			}),
		};
		const b: RunwayAccountInput = {
			accountId: "other",
			unmetered: false,
			windows: [
				window({
					windowKind: "five_hour",
					utilizationPct: 50,
					resetsAtMs: NOW + 20 * HOUR,
					windowStartMs: NOW + 15 * HOUR,
					prediction: prediction({
						resetsAtMs: NOW + 20 * HOUR,
						slopePerHour: 100 / 24,
						etaExhaustMs: NOW + 7 * HOUR,
					}),
				}),
			],
		};

		const withCredit = computeCapacityRunway([a, b], NOW);
		expect(withCredit.kind).toBe("beyond-horizon");

		const withoutCredit = computeCapacityRunway(
			[{ ...a, codexResetCredits: undefined }, b],
			NOW,
		);
		expect(withoutCredit.kind).toBe("runway");
		if (withoutCredit.kind === "runway") {
			expect(withoutCredit.exhaustsAtMs).toBe(NOW + 7 * HOUR);
		}
	});

	it("expiry-only flags consume nothing at an exhaustion instant", () => {
		const result = computeCapacityRunway(
			[
				{
					accountId: "codex-1",
					unmetered: false,
					windows: [burningWeekly()],
					codexResetCredits: bank([{ expiresAtMs: null }], {
						weekly: false,
						expiry: true,
					}),
				},
			],
			NOW,
		);

		// A never-expiring credit has no expiry instant inside the dead span,
		// and the weekly-limit trigger is off — behaviour identical to no bank.
		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") throw new Error("unreachable");
		expect(result.exhaustsAtMs).toBe(NOW + 12 * HOUR);
		expect(result.assumedResetCredits).toBeUndefined();
	});

	it("suppresses once with no modeled re-exhaustion when the pace is unknowable", () => {
		const result = computeCapacityRunway(
			[
				{
					accountId: "codex-1",
					unmetered: false,
					windows: [
						window({
							windowKind: "seven_day",
							utilizationPct: 100,
							resetsAtMs: NOW + 2 * DAY,
							// No structural start: the re-exhaustion pace cannot be
							// modeled, so the credit suppresses the interval once.
							windowStartMs: null,
						}),
					],
					codexResetCredits: bank([{ expiresAtMs: null }]),
				},
			],
			NOW,
		);

		expect(result.kind).toBe("beyond-horizon");
		if (result.kind !== "beyond-horizon") throw new Error("unreachable");
		expect(result.assumedResetCredits).toEqual([
			{ accountId: "codex-1", count: 1 },
		]);
	});

	it("leaves non-weekly windows untouched by the bank", () => {
		const result = computeCapacityRunway(
			[
				{
					accountId: "codex-1",
					unmetered: false,
					windows: [
						window({
							windowKind: "five_hour",
							utilizationPct: 100,
							resetsAtMs: NOW + 2 * HOUR,
							windowStartMs: NOW - 3 * HOUR,
						}),
					],
					codexResetCredits: bank([{ expiresAtMs: null }]),
				},
			],
			NOW,
		);

		// A credit resets USAGE LIMITS on the weekly model only (deliberate
		// scope): the spent 5h window stays dead.
		expect(result.kind).toBe("out-now");
		if (result.kind !== "out-now") throw new Error("unreachable");
		expect(result.assumedResetCredits).toBeUndefined();
	});

	it("an untouched bank produces byte-identical output to no bank", () => {
		const healthy = () =>
			window({
				windowKind: "seven_day",
				utilizationPct: 5,
				resetsAtMs: NOW + 6 * DAY,
				windowStartMs: NOW - DAY,
			});
		const withBank = computeCapacityRunway(
			[
				{
					accountId: "a",
					unmetered: false,
					windows: [healthy()],
					codexResetCredits: bank([{ expiresAtMs: null }]),
				},
			],
			NOW,
		);
		const without = computeCapacityRunway(
			[{ accountId: "a", unmetered: false, windows: [healthy()] }],
			NOW,
		);
		expect(withBank).toEqual(without);
	});
});

describe("computeCapacityRunway pace-margin probe", () => {
	// A weekly window burning at ~90% of sustainable pace: timeToFull 186.7h in
	// a 168h cycle, with the current cycle's ETA far past its reset so only the
	// projected later cycles can go dead. The overnight-flip case: no cycle is
	// ever dead at the measured pace, but a ~+12% pace makes every cycle
	// exhaust.
	const marginalWeekly = () =>
		window({
			windowKind: "seven_day",
			utilizationPct: 50,
			resetsAtMs: NOW + 84 * HOUR,
			windowStartMs: NOW - 84 * HOUR,
			prediction: prediction({
				resetsAtMs: NOW + 84 * HOUR,
				slopePerHour: 100 / 186.7,
				etaExhaustMs: NOW + 200 * HOUR,
			}),
		});

	it("annotates a knife-edge beyond-horizon with the flip multiplier", () => {
		const result = computeCapacityRunway(
			[account("a", [marginalWeekly()])],
			NOW,
		);

		expect(result.kind).toBe("beyond-horizon");
		if (result.kind !== "beyond-horizon") return;
		const margin = result.paceMargin;
		expect(margin).toBeDefined();
		if (!margin) return;
		// The flip is at timeToFull/duration = 186.7/168 ≈ 1.111; the probe
		// reports the smallest flipping multiplier to its stated precision.
		expect(margin.multiplier).toBeGreaterThan(1.111);
		expect(margin.multiplier).toBeLessThanOrEqual(1.13);
		// At the flip the first dead instant is the first later cycle's projected
		// exhaustion: resetsAt + timeToFull/multiplier ≈ NOW + 250h.
		expect(margin.exhaustsAtMs).toBeGreaterThan(NOW + 245 * HOUR);
		expect(margin.exhaustsAtMs).toBeLessThan(NOW + 255 * HOUR);
	});

	it("stays silent when the beyond-horizon is robust to the probe cap", () => {
		// timeToFull 300h: even at the 1.5x probe cap the scaled 200h cannot be
		// spent inside a 168h cycle, and the current ETA stays past its reset.
		const result = computeCapacityRunway(
			[
				account("a", [
					window({
						windowKind: "seven_day",
						utilizationPct: 30,
						resetsAtMs: NOW + 84 * HOUR,
						windowStartMs: NOW - 84 * HOUR,
						prediction: prediction({
							resetsAtMs: NOW + 84 * HOUR,
							slopePerHour: 100 / 300,
							etaExhaustMs: NOW + 500 * HOUR,
						}),
					}),
				]),
			],
			NOW,
		);

		// Exact equality: a robust beyond-horizon carries NO paceMargin key.
		expect(result).toEqual({
			kind: "beyond-horizon",
			horizonMs: RUNWAY_HORIZON_MS,
			unprojectableAccountIds: [],
		});
	});

	it("probes the POOL, not each account alone", () => {
		// Account a is dead for half of every 5h cycle already; alone it never
		// makes the pool all-dead because b is never dead at measured pace. The
		// probe must find the multiplier at which b's weekly cycles start dying
		// and OVERLAP a's dead spans.
		const result = computeCapacityRunway(
			[
				account("a", [cyclicWindow("five_hour", NOW + HOUR, 5, 2.5)]),
				account("b", [marginalWeekly()]),
			],
			NOW,
		);

		expect(result.kind).toBe("beyond-horizon");
		if (result.kind !== "beyond-horizon") return;
		const margin = result.paceMargin;
		expect(margin).toBeDefined();
		if (!margin) return;
		// b's cycles start dying just above 1.111; a's dead spans recur every 5h,
		// so an overlap exists almost immediately after.
		expect(margin.multiplier).toBeGreaterThan(1.111);
		expect(margin.multiplier).toBeLessThanOrEqual(1.15);
		expect(margin.exhaustsAtMs).toBeGreaterThan(NOW);
		expect(margin.exhaustsAtMs).toBeLessThan(NOW + RUNWAY_HORIZON_MS);
	});

	it("finds a flip that credit timing hides from the probe cap", () => {
		// One banked weekly-limit credit expiring at NOW+245h, weekly fill time
		// 180h in a 168h cycle (flip at 180/168 ≈ 1.0714). At a small pace-up the
		// projected exhaustion (NOW + 84h + 180h/1.08 ≈ NOW+250.7h) lands AFTER
		// the credit's expiry, nothing revives the window, and the scan is
		// finite. At the probe cap the exhaustion moves BEFORE the expiry, the
		// credit revives the window, and the scan is beyond-horizon AGAIN —
		// "finite at pace m" is not monotone in m. A bisection seeded at the cap
		// would call this pool robust; the grid walk must find the low flip.
		const result = computeCapacityRunway(
			[
				{
					accountId: "a",
					unmetered: false,
					windows: [
						window({
							windowKind: "seven_day",
							utilizationPct: 50,
							resetsAtMs: NOW + 84 * HOUR,
							windowStartMs: NOW - 84 * HOUR,
							prediction: prediction({
								resetsAtMs: NOW + 84 * HOUR,
								slopePerHour: 100 / 180,
								etaExhaustMs: NOW + 500 * HOUR,
							}),
						}),
					],
					codexResetCredits: {
						onWeeklyLimitEnabled: true,
						onExpiryEnabled: false,
						credits: [{ expiresAtMs: NOW + 245 * HOUR }],
					},
				},
			],
			NOW,
		);

		expect(result.kind).toBe("beyond-horizon");
		if (result.kind !== "beyond-horizon") return;
		const margin = result.paceMargin;
		expect(margin).toBeDefined();
		if (!margin) return;
		// First grid point past 1.0714.
		expect(margin.multiplier).toBeCloseTo(1.08, 5);
		expect(margin.exhaustsAtMs).toBeGreaterThan(NOW + 249 * HOUR);
		expect(margin.exhaustsAtMs).toBeLessThan(NOW + 252 * HOUR);
	});

	it("never annotates a finite outcome, and the probe respects the horizon", () => {
		// Dead every cycle already: finite runway, no paceMargin field exists on
		// that variant at the type level — assert the shape stays exact.
		const finite = computeCapacityRunway(
			[account("a", [cyclicWindow("seven_day", NOW + 84 * HOUR, 168, 100)])],
			NOW,
		);
		expect(finite.kind).toBe("runway");

		// With a 4-day horizon the marginal account's first scaled dead instant
		// (~NOW+250h) lies OUTSIDE the horizon, so the probe must not claim a
		// flip it cannot see.
		const shortHorizon = computeCapacityRunway(
			[account("a", [marginalWeekly()])],
			NOW,
			4 * DAY,
		);
		expect(shortHorizon).toEqual({
			kind: "beyond-horizon",
			horizonMs: 4 * DAY,
			unprojectableAccountIds: [],
		});
	});
});

describe("computeCapacityRunway pace-deficit probe", () => {
	/**
	 * The mirror of `marginalWeekly`: a weekly window filling in 150h inside a
	 * 168h cycle, so every projected later cycle goes dead and the scan is
	 * FINITE at the measured pace. The current cycle's ETA sits past its own
	 * reset, so only the later cycles contribute.
	 *
	 * Slowing by a multiplier m stretches the fill to 150/m, and the cycles stop
	 * dying once that reaches the 168h cycle length — at m = 150/168 ≈ 0.8929.
	 * The probe must report 0.89, the first grid step at or below that: the
	 * LEAST slowdown that clears the horizon.
	 */
	const overspentWeekly = () =>
		window({
			windowKind: "seven_day",
			utilizationPct: 50,
			resetsAtMs: NOW + 84 * HOUR,
			windowStartMs: NOW - 84 * HOUR,
			prediction: prediction({
				resetsAtMs: NOW + 84 * HOUR,
				slopePerHour: 100 / 150,
				etaExhaustMs: NOW + 200 * HOUR,
			}),
		});

	it("reports the least slowdown that clears the horizon", () => {
		const result = computeCapacityRunway(
			[account("a", [overspentWeekly()])],
			NOW,
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") return;
		const deficit = result.paceDeficit;
		expect(deficit).toBeDefined();
		if (!deficit) return;
		// Largest qualifying grid point, not merely SOME qualifying one: 0.90
		// still leaves the cycles dying (150/0.90 = 166.7h < 168h), so anything
		// above 0.89 is wrong, and anything below it overstates the cut needed.
		expect(deficit.multiplier).toBeCloseTo(0.89, 5);
	});

	it("signs the headroom as a deficit, rounding the cut up", () => {
		// Rounding direction is the point: 1 - 0.89 = 0.10999999999999999, and a
		// figure rounded DOWN to 10% would advise a cut the 0.90 grid step was
		// just shown to fail at.
		const result = computeCapacityRunway(
			[account("a", [overspentWeekly()])],
			NOW,
		);
		expect(runwayPaceHeadroom(result)).toEqual({
			pct: 11,
			direction: "deficit",
		});
	});

	it("stays silent when no slowdown in range can clear the horizon", () => {
		// Fill time 80h in a 168h cycle: burning so far above sustainable that even
		// at the 0.5 probe FLOOR the stretched 160h still fits inside the cycle, so
		// every cycle keeps going dead and no probed multiplier clears the horizon.
		//
		// The absent key is the claim, and it is the BAD end of the scale — "no
		// pace in range saves this pool", strictly worse than any number the probe
		// could have returned. A renderer showing it as a zero-percent deficit
		// would invert the message completely.
		const result = computeCapacityRunway(
			[account("a", [cyclicWindow("seven_day", NOW + 84 * HOUR, 168, 80)])],
			NOW,
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") return;
		expect(result.paceDeficit).toBeUndefined();
		expect(runwayPaceHeadroom(result)).toBeNull();
	});

	it("clears a pool that is only modestly over, at the grid step that works", () => {
		// The contrast case for the one above, and the reason the floor is not just
		// a safety rail: fill time 100h in the same 168h cycle needs 100/168, so
		// 0.59 is the largest grid step that stretches the fill past the cycle.
		// Slower pools get a number; hopeless ones get nothing.
		const result = computeCapacityRunway(
			[account("a", [cyclicWindow("seven_day", NOW + 84 * HOUR, 168, 100)])],
			NOW,
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") return;
		expect(result.paceDeficit?.multiplier).toBeCloseTo(0.59, 5);
	});

	it("annotates neither an out-now nor an unreadable pool", () => {
		// An instant that has already arrived is not a projection with a pace
		// assumption to vary, so `out-now` carries no probe of either sign.
		const outNow = computeCapacityRunway(
			[account("a", [cyclicWindow("five_hour", NOW + HOUR, 5, 100)])],
			NOW,
		);
		if (outNow.kind === "out-now") {
			expect(runwayPaceHeadroom(outNow)).toBeNull();
		}
		expect(runwayPaceHeadroom({ kind: "unknown" })).toBeNull();
		expect(runwayPaceHeadroom({ kind: "no-accounts" })).toBeNull();
	});

	it("is suppressed by the same flag that suppresses the margin probe", () => {
		// The band runs the whole scan twice and discards both figures; paying 50
		// pool rebuilds per perturbation for a field nobody reads is what the flag
		// exists to prevent.
		const result = computeCapacityRunway(
			[account("a", [overspentWeekly()])],
			NOW,
			RUNWAY_HORIZON_MS,
			{ probePaceMargin: false },
		);

		expect(result.kind).toBe("runway");
		if (result.kind !== "runway") return;
		expect(result.paceDeficit).toBeUndefined();
	});

	it("never annotates a beyond-horizon with a deficit", () => {
		// The two probes are exclusive by construction; this pins that the finite
		// branch is the only one that can carry a deficit, so a reader can key on
		// `kind` to know which sign an absent field means. Fill time 186.7h in a
		// 168h cycle — the same under-pace shape the margin probe's fixture uses,
		// restated here rather than shared so the two blocks stay independent.
		const result = computeCapacityRunway(
			[
				account("a", [
					window({
						windowKind: "seven_day",
						utilizationPct: 50,
						resetsAtMs: NOW + 84 * HOUR,
						windowStartMs: NOW - 84 * HOUR,
						prediction: prediction({
							resetsAtMs: NOW + 84 * HOUR,
							slopePerHour: 100 / 186.7,
							etaExhaustMs: NOW + 200 * HOUR,
						}),
					}),
				]),
			],
			NOW,
		);
		expect(result.kind).toBe("beyond-horizon");
		expect(runwayPaceHeadroom(result)?.direction).toBe("margin");
	});
});

describe("computeCapacityRunwayBand", () => {
	/**
	 * One weekly window, `pct` used, one day in. With no prediction the
	 * estimator takes its lifetime-average branch, so the projected run-out is
	 * `elapsed * (100 / pct)` from the window start — which is exactly the
	 * formula the width assertion below re-derives at each perturbation.
	 */
	function weeklyAt(
		pct: number,
		alsoCarrying: RunwayWindowInput[] = [],
		accountId = "a",
	): RunwayAccountInput {
		return account(accountId, [
			window({
				windowKind: "seven_day",
				utilizationPct: pct,
				resetsAtMs: NOW + 6 * DAY,
				windowStartMs: NOW - DAY,
				prediction: null,
			}),
			...alsoCarrying,
		]);
	}

	function bandFor(accounts: RunwayAccountInput[]) {
		const baseline = computeCapacityRunway(accounts, NOW);
		return {
			baseline,
			band: computeCapacityRunwayBand(accounts, NOW, baseline),
		};
	}

	it("brackets the run-out by exactly the quantisation the reading carries", () => {
		const { baseline, band } = bandFor([weeklyAt(20)]);
		expect(baseline.kind).toBe("runway");
		expect(band).not.toBeNull();
		expect(band?.halfWidthPct).toBe(0.5);

		// The lifetime formula: run-out lands `elapsed * 100 / pct` after the
		// window start, so half a percent of reading error is worth
		// `elapsed * 100 * (1/19.5 - 1/20.5)` of run-out — about six hours here.
		const elapsedMs = DAY;
		const expectedWidthMs = elapsedMs * 100 * (1 / (20 - 0.5) - 1 / (20 + 0.5));
		const actualWidthMs =
			(band?.latestExhaustsAtMs ?? 0) - (band?.earliestExhaustsAtMs ?? 0);
		expect(actualWidthMs).toBeGreaterThan(expectedWidthMs * 0.9);
		expect(actualWidthMs).toBeLessThan(expectedWidthMs * 1.1);
	});

	it("states no band when every reading is already fractional", () => {
		// A fractional percentage came from somewhere that knows better than a
		// whole percent; nudging it would invent an uncertainty it does not have.
		const { band } = bandFor([weeklyAt(20.25)]);
		expect(band).toBeNull();
	});

	it("states no band for an account with only a five-hour window", () => {
		// A whole-percent 5-hour reading is NOT perturbed, so there is nothing to
		// bracket even though the scan does project a run-out from it. The 5-hour
		// fallback is `now`-anchored and drifts between polls, so the interval a
		// probe on it traces is not the quantisation interval a band claims.
		const fiveHourOnly = [
			account("a", [
				window({
					windowKind: "five_hour",
					utilizationPct: 90,
					resetsAtMs: NOW + HOUR,
					windowStartMs: NOW - 4 * HOUR,
					prediction: null,
				}),
			]),
		];
		const { baseline, band } = bandFor(fiveHourOnly);

		expect(baseline.kind).toBe("runway");
		expect(band).toBeNull();
	});

	it("perturbs the weekly window and leaves the five-hour one alone", () => {
		// Same weekly reading, once on its own and once beside a whole-percent
		// 5-hour window that contributes no dead span of its own. The band has to
		// be the same one: it reports what the WEEKLY reading's precision leaves
		// open, and the 5-hour window's presence is not part of that claim.
		const idleFiveHour = window({
			windowKind: "five_hour",
			utilizationPct: 10,
			resetsAtMs: NOW + 4 * HOUR,
			windowStartMs: NOW - HOUR,
			prediction: null,
		});
		const weeklyOnly = bandFor([weeklyAt(20)]);
		const withFiveHour = bandFor([weeklyAt(20, [idleFiveHour])]);

		expect(withFiveHour.band).not.toBeNull();
		expect(withFiveHour.band).toEqual(weeklyOnly.band);
	});

	it("returns equal ends for a regression-backed window", () => {
		// The regression branch projects from the server's slope and never reads
		// the percentage, so perturbing the reading moves nothing. Disclosed as
		// equal ends — which the display renders as no band — rather than faked.
		const accounts = [
			account("a", [
				cyclicWindow("seven_day", NOW + 2 * HOUR, 5, 1),
				cyclicWindow("five_hour", NOW + 2 * HOUR, 5, 1),
			]),
		];
		const { band } = bandFor(accounts);
		expect(band).not.toBeNull();
		expect(band?.earliestExhaustsAtMs).toBe(band?.latestExhaustsAtMs ?? -1);
	});

	it("states no band when the baseline assumed reset credits", () => {
		// Burn under modeled credits is non-monotonic: a faster burn can move a
		// dead span back inside a credit's expiry and revive the window, so two
		// probes do not straddle the baseline.
		const baseline = {
			kind: "runway" as const,
			exhaustsAtMs: NOW + DAY,
			durationMs: DAY,
			causes: [],
			unprojectableAccountIds: [],
			assumedResetCredits: [{ accountId: "a", count: 1 }],
		};
		expect(computeCapacityRunwayBand([weeklyAt(20)], NOW, baseline)).toBeNull();
	});

	it("states no band when the pool is already out", () => {
		// A reading of exactly 100 is a state the provider reports, not a figure
		// rounded to the nearest percent, so it is not perturbed: dropping it to
		// 99.5 would un-exhaust a spent window and hand the low probe a run-out
		// half an hour from now, under a headline that says the pool is out. An
		// instant that has already arrived is not a projection with an error bar.
		const { baseline, band } = bandFor([weeklyAt(100)]);

		expect(baseline.kind).toBe("out-now");
		expect(band).toBeNull();
	});

	it("takes no perturbation from a pool member that is already spent", () => {
		// One account out of quota, one at 40% and still burning. The pool runs
		// out when the second one does, and the band around that instant is the
		// one the 40% reading's precision leaves open — the spent account states
		// no uncertainty to add to it.
		const stillBurning = weeklyAt(40, [], "burning");
		const withSpentPeer = bandFor([weeklyAt(100, [], "spent"), stillBurning]);
		const alone = bandFor([stillBurning]);

		expect(withSpentPeer.baseline.kind).toBe("runway");
		expect(alone.band).not.toBeNull();
		expect(withSpentPeer.band).toEqual(alone.band);
	});

	it("skips the pace-margin walk when the caller opts out", () => {
		// The walk costs up to 50 pool rebuilds, and the band runs the whole scan
		// twice per call. Same knife-edge fixture the probe's own suite uses, so
		// the default DOES find a margin and the opt-out is observably skipping
		// work rather than finding nothing.
		const accounts = [
			account("a", [
				window({
					windowKind: "seven_day",
					utilizationPct: 50,
					resetsAtMs: NOW + 84 * HOUR,
					windowStartMs: NOW - 84 * HOUR,
					prediction: prediction({
						resetsAtMs: NOW + 84 * HOUR,
						slopePerHour: 100 / 186.7,
						etaExhaustMs: NOW + 200 * HOUR,
					}),
				}),
			]),
		];
		const withProbe = computeCapacityRunway(accounts, NOW);
		const withoutProbe = computeCapacityRunway(accounts, NOW, undefined, {
			probePaceMargin: false,
		});

		expect(withProbe.kind).toBe("beyond-horizon");
		expect(
			withProbe.kind === "beyond-horizon" ? withProbe.paceMargin : undefined,
		).toBeDefined();
		expect(withoutProbe).toEqual({
			kind: "beyond-horizon",
			horizonMs: RUNWAY_HORIZON_MS,
			unprojectableAccountIds: [],
		});
	});

	it("leaves the default probe behaviour untouched", () => {
		const accounts = [weeklyAt(20)];
		expect(computeCapacityRunway(accounts, NOW)).toEqual(
			computeCapacityRunway(accounts, NOW, RUNWAY_HORIZON_MS, {
				probePaceMargin: true,
			}),
		);
	});
});
