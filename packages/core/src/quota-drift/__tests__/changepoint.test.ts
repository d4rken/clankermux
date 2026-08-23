import { describe, expect, it } from "bun:test";
import { detectChanges } from "../changepoint";
import { DAY_MS, makeSyntheticSegments } from "./synthetic";

const HOUR = 60 * 60 * 1000;
const START = 1_760_000_000_000;

/**
 * `segmentsPerRun` hourly segments per run means one run per day, so `days` runs
 * spans `days` days — the shape the real series has (one monotone run per 5h
 * window instance, several a day, tiled across the history).
 */
function series(opts: {
	days: number;
	weights: Record<string, number>;
	stepAtMs?: number;
	stepWeights?: Record<string, number>;
	seed: number;
	accountIds?: readonly string[];
}) {
	return makeSyntheticSegments({
		weights: opts.weights,
		stepAtMs: opts.stepAtMs,
		stepWeights: opts.stepWeights,
		runs: opts.days,
		segmentsPerRun: 23, // 23h of segments + a 1h inter-run gap == one day
		segmentMs: HOUR,
		meanTokens: 2_000_000,
		startMs: START,
		seed: opts.seed,
		accountIds: opts.accountIds,
	});
}

describe("changepoint detection", () => {
	it("reports no change on a flat series (the over-firing guard)", () => {
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			seed: 2024,
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["flat"],
			maxDepth: 1,
		});

		expect(result.changes).toEqual([]);
		expect(result.verdict).toBe("stable");
	});

	it("finds exactly one change on a stepped series", () => {
		const boundary = START + 40 * DAY_MS;
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			stepAtMs: boundary,
			stepWeights: { "claude-opus-5": 1.2, "claude-sonnet-5": 0.9 },
			seed: 4711,
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["stepped"],
			maxDepth: 1,
		});

		expect(result.verdict).toBe("changed");
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].direction).toBe("cheaper");
		expect(
			Math.abs(result.changes[0].boundaryMs - boundary),
		).toBeLessThanOrEqual(3 * DAY_MS);
	});

	it("produces a usable verdict on ~82 days of history, not a structural insufficiency", () => {
		// Regression for the design this replaced: comparing non-overlapping 14-day
		// blocks with four required per side needs 112 days, so it could never fire
		// on the ~82 days that exist. An unfireable test reports "no change"
		// forever and is indistinguishable from a working one.
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			seed: 8282,
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 100,
			seedParts: ["82d"],
			maxDepth: 1,
		});

		expect(result.verdict).not.toBe("insufficient-evidence");
		expect(result.nCandidates).toBeGreaterThan(0);
	});

	it("reports insufficient-evidence, never stable, when there is too little history", () => {
		// `stable` is a claim that the test ran and found nothing. An underpowered
		// scan has established no such thing.
		const segments = series({
			days: 6,
			weights: { "claude-opus-5": 2.4 },
			seed: 606,
		});

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 50,
			seedParts: ["short"],
			maxDepth: 1,
		});

		expect(result.verdict).toBe("insufficient-evidence");
		expect(result.changes).toEqual([]);
	});

	it("does not fire on pure noise across many seeds", () => {
		// The Bonferroni adjustment is what stops a ~70-candidate scan from
		// manufacturing a finding at a nominal 5%.
		let fired = 0;
		for (let seed = 0; seed < 8; seed++) {
			const segments = series({
				days: 82,
				weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
				seed: 90_000 + seed * 131,
			});
			const result = detectChanges(segments, "claude-opus-5", {
				bootstrapB: 100,
				seedParts: ["noise", seed],
				maxDepth: 1,
			});
			if (result.verdict === "changed") fired += 1;
		}
		expect(fired).toBe(0);
	});

	it("refuses to attribute a difference when the account set changed across the split", () => {
		// A cohort that gained an account at the boundary changed composition; the
		// difference is not the provider's doing.
		const boundary = START + 40 * DAY_MS;
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			stepAtMs: boundary,
			stepWeights: { "claude-opus-5": 1.2, "claude-sonnet-5": 0.9 },
			seed: 4711,
		}).map((s) =>
			// Everything after the boundary comes from a second account only.
			s.t0 >= boundary ? { ...s, accountId: "acct-b" } : s,
		);

		const result = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 100,
			seedParts: ["composition"],
			maxDepth: 1,
		});

		expect(result.changes).toEqual([]);
		expect(result.verdict).toBe("insufficient-evidence");
	});

	it("records the adjusted level it cleared", () => {
		const boundary = START + 40 * DAY_MS;
		const segments = series({
			days: 82,
			weights: { "claude-opus-5": 2.4, "claude-sonnet-5": 0.9 },
			stepAtMs: boundary,
			stepWeights: { "claude-opus-5": 1.2, "claude-sonnet-5": 0.9 },
			seed: 4711,
		});

		const change = detectChanges(segments, "claude-opus-5", {
			bootstrapB: 200,
			seedParts: ["stepped"],
			maxDepth: 1,
		}).changes[0];

		expect(change.nCandidates).toBeGreaterThan(1);
		expect(change.adjustedLevel).toBeCloseTo(0.05 / change.nCandidates, 12);
	});
});
