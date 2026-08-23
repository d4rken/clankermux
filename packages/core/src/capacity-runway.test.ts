import { describe, expect, it } from "bun:test";
import type { UsagePrediction } from "@clankermux/types";
import {
	computeCapacityRunway,
	estimateWindowExhaustion,
	RUNWAY_HORIZON_MS,
	type RunwayAccountInput,
	type RunwayWindowInput,
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
		const observedAtMs = NOW - 6 * HOUR;
		const anchoredAtNow = computeCapacityRunway(
			[account("a", windows("full", observedAtMs))],
			NOW,
		);
		const anchoredLater = computeCapacityRunway(
			[account("a", windows("full", observedAtMs))],
			NOW + 30_000,
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
