import { describe, expect, it } from "bun:test";
import {
	ALIGNMENT_RULE,
	type AlignmentObservation,
	type AlignmentRequest,
	type AlignmentScore,
	type AlignmentUnit,
	buildPermutation,
	buildUnits,
	COUNT_ONLY_CONTROL,
	evaluateAlignment,
	fitNonNegative,
	formatAlignmentReport,
	INTERVAL_MS,
	MANDATORY_CONTROL,
	MIN_BOOTSTRAP_CLUSTERS,
	MIN_EVALUATION_UNITS,
	type PairedDifference,
	pairedDifference,
	REAL_ALIGNMENT,
	RequestIndex,
	type SyntheticCheck,
	scoreCohort,
	syntheticChecks,
	unitKey,
} from "./alignment-study";

const T0 = Date.UTC(2026, 8, 1);
const RESET = T0 + 5 * 60 * 60_000;

function obs(
	over: Partial<AlignmentObservation> & {
		observedAt: number;
		utilization: number;
	},
): AlignmentObservation {
	return {
		accountId: "A",
		claim: "5h",
		resetAt: RESET,
		...over,
	};
}

function req(
	over: Partial<AlignmentRequest> & { finalizedAt: number },
): AlignmentRequest {
	return {
		accountId: "A",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		...over,
	};
}

describe("buildUnits", () => {
	it("states one change per interval, from its first and last reading", () => {
		const built = buildUnits(
			[
				obs({ observedAt: T0 + 1_000, utilization: 0.1 }),
				obs({ observedAt: T0 + 2_000, utilization: 0.11 }),
				obs({ observedAt: T0 + 3_000, utilization: 0.13 }),
			],
			"5h",
		);
		expect(built.units).toHaveLength(1);
		expect(built.units[0].deltaPct).toBeCloseTo(3, 9);
		expect(built.units[0].readings).toBe(3);
		expect(built.units[0].fromMs).toBe(
			Math.floor(T0 / INTERVAL_MS) * INTERVAL_MS,
		);
	});

	it("keeps an interval whose reading did not move", () => {
		// The flat intervals are the point: without them the target has almost no
		// variance and the study would be conditioning on its own outcome.
		const built = buildUnits(
			[
				obs({ observedAt: T0 + 1_000, utilization: 0.4 }),
				obs({ observedAt: T0 + 2_000, utilization: 0.4 }),
			],
			"5h",
		);
		expect(built.units).toHaveLength(1);
		expect(built.units[0].deltaPct).toBe(0);
	});

	it("never lets an interval span two window instances", () => {
		const built = buildUnits(
			[
				obs({ observedAt: T0 + 1_000, utilization: 0.9, resetAt: RESET }),
				// Same 10-minute slot, next window: a fall to 0 is a reset, not a refund.
				obs({
					observedAt: T0 + 2_000,
					utilization: 0.0,
					resetAt: RESET + 5 * 60 * 60_000,
				}),
			],
			"5h",
		);
		// Both groups are dropped as a straddled slot, before the single-reading
		// test: the slot holds two window instances, and either unit would have
		// read the same ten minutes of requests as the other.
		expect(built.units).toHaveLength(0);
		expect(built.droppedStraddlingReset).toBe(2);
		expect(built.droppedSingleReading).toBe(0);
		expect(built.droppedNegative).toBe(0);
	});

	it("counts what it drops rather than absorbing it", () => {
		const built = buildUnits(
			[
				obs({ observedAt: T0 + 1_000, utilization: 0.5 }),
				obs({ observedAt: T0 + 2_000, utilization: 0.3 }),
				obs({ observedAt: T0 + INTERVAL_MS + 1_000, utilization: 0.6 }),
				obs({
					observedAt: T0 + 2 * INTERVAL_MS,
					utilization: 0.7,
					resetAt: null,
				}),
			],
			"5h",
		);
		expect(built.units).toHaveLength(0);
		expect(built.droppedNegative).toBe(1);
		expect(built.droppedSingleReading).toBe(1);
		expect(built.droppedUnplaceable).toBe(1);
	});

	it("scores one claim at a time", () => {
		const built = buildUnits(
			[
				obs({ observedAt: T0 + 1_000, utilization: 0.1 }),
				obs({ observedAt: T0 + 2_000, utilization: 0.2 }),
				obs({ observedAt: T0 + 3_000, utilization: 0.9, claim: "7d" }),
				obs({ observedAt: T0 + 4_000, utilization: 0.95, claim: "7d" }),
			],
			"5h",
		);
		expect(built.units).toHaveLength(1);
		expect(built.units[0].deltaPct).toBeCloseTo(10, 9);
	});
});

describe("RequestIndex", () => {
	it("sums a half-open interval and counts its requests", () => {
		const index = new RequestIndex([
			req({ finalizedAt: T0 - 1, inputTokens: 100 }),
			req({ finalizedAt: T0, inputTokens: 1, outputTokens: 2 }),
			req({ finalizedAt: T0 + 5, cacheReadInputTokens: 3 }),
			req({ finalizedAt: T0 + 10, cacheCreationInputTokens: 4 }),
		]);
		const spend = index.sum("A", T0, T0 + 10);
		expect(spend.tokens).toEqual([1, 2, 3, 0]);
		expect(spend.requests).toBe(2);
		expect(index.sum("B", T0, T0 + 10).requests).toBe(0);
	});
});

describe("buildPermutation", () => {
	it("gives every unit a different unit of the same account", () => {
		const units: AlignmentUnit[] = [0, 1, 2, 3, 4].map((i) => ({
			accountId: i % 2 === 0 ? "A" : "B",
			fromMs: T0 + i * INTERVAL_MS,
			toMs: T0 + (i + 1) * INTERVAL_MS,
			deltaPct: 1,
			readings: 2,
			peakUtilization: 0.5,
		}));
		const permutation = buildPermutation(units);
		for (const unit of units) {
			const other = permutation.get(unitKey(unit));
			expect(other).toBeDefined();
			expect(other?.accountId).toBe(unit.accountId);
			expect(unitKey(other as AlignmentUnit)).not.toBe(unitKey(unit));
		}
	});

	it("leaves a lone unit unpaired rather than pairing it with itself", () => {
		const permutation = buildPermutation([
			{
				accountId: "A",
				resetAt: RESET,
				fromMs: T0,
				toMs: T0 + INTERVAL_MS,
				deltaPct: 1,
				readings: 2,
				peakUtilization: 0.5,
			},
		]);
		expect(permutation.size).toBe(0);
	});
});

describe("fitNonNegative", () => {
	it("recovers planted weights", () => {
		const rows: number[][] = [];
		const targets: number[] = [];
		for (let i = 1; i <= 60; i++) {
			const a = i * 1000;
			const b = (61 - i) * 500;
			rows.push([a, b]);
			targets.push(a * 2e-5 + b * 5e-5);
		}
		const fit = fitNonNegative(rows, targets);
		expect(fit.converged).toBe(true);
		expect(fit.weights[0]).toBeCloseTo(2e-5, 6);
		expect(fit.weights[1]).toBeCloseTo(5e-5, 6);
	});

	it("says so rather than pretending, when the budget runs out first", () => {
		const rows: number[][] = [];
		const targets: number[] = [];
		for (let i = 1; i <= 60; i++) {
			rows.push([i * 1000, i * 1000 + 1]);
			targets.push(i * 1000 * 2e-5);
		}
		// One iteration cannot reach the optimum of anything.
		const fit = fitNonNegative(rows, targets, 1);
		expect(fit.converged).toBe(false);
		expect(fit.iterations).toBe(1);
	});

	it("reports a class as weightless rather than fitting it a negative price", () => {
		const rows: number[][] = [];
		const targets: number[] = [];
		for (let i = 1; i <= 60; i++) {
			rows.push([i * 100, i * 100]);
			// The only fit with a negative coefficient would be the exact one.
			targets.push(-i * 100 * 1e-5);
		}
		for (const weight of fitNonNegative(rows, targets).weights) {
			expect(weight).toBeGreaterThanOrEqual(0);
		}
	});
});

/** A cohort where the target follows the tokens, for the scoring tests. */
function drivenFixture(accounts = 1): {
	units: AlignmentUnit[];
	index: RequestIndex;
	splitAtMs: number;
} {
	const units: AlignmentUnit[] = [];
	const requests: AlignmentRequest[] = [];
	for (let a = 0; a < accounts; a++)
		for (let i = 0; i < 120; i++) {
			const fromMs = T0 + i * INTERVAL_MS;
			// Deliberately not periodic in the permutation's rotation. A pattern that
			// repeats every k units, with a derangement that rotates by a multiple of
			// k, hands every unit a twin holding the SAME tokens — the control then
			// equals the real alignment and the fixture proves nothing.
			const tokens = 5_000 + ((i * 7919) % 97) * 1_200;
			units.push({
				accountId: `A${a}`,
				resetAt: RESET,
				fromMs,
				toMs: fromMs + INTERVAL_MS,
				deltaPct: Math.round(tokens * 5e-5),
				readings: 2,
				peakUtilization: 0.5,
			});
			requests.push(
				req({
					accountId: `A${a}`,
					finalizedAt: fromMs + 1,
					outputTokens: tokens,
				}),
			);
		}
	return {
		units,
		index: new RequestIndex(requests),
		splitAtMs: T0 + 60 * INTERVAL_MS,
	};
}

describe("scoreCohort", () => {
	it("answers every alignment on the same units and splits chronologically", () => {
		const { units, index, splitAtMs } = drivenFixture();
		const cohort = scoreCohort("c", "d", units, index, splitAtMs);
		const counts = new Set(cohort.scores.map((s) => s.units));
		expect(counts.size).toBe(1);
		expect(cohort.trainingUnits + cohort.evaluationUnits).toBeLessThanOrEqual(
			units.length,
		);
		// The real alignment must beat the permutation on a fixture where the
		// target was generated from the tokens.
		const real = cohort.scores.find(
			(s) => s.name === REAL_ALIGNMENT,
		) as AlignmentScore;
		const permuted = cohort.scores.find(
			(s) => s.name === MANDATORY_CONTROL,
		) as AlignmentScore;
		expect(real.medianAbsErrorPct as number).toBeLessThan(
			permuted.medianAbsErrorPct as number,
		);
		expect(real.inBandShare as number).toBeGreaterThan(
			permuted.inBandShare as number,
		);
	});

	it("drops a unit whose shifted source has no traffic", () => {
		const { units, splitAtMs } = drivenFixture();
		// An index with requests in only one slot: every unit's ±10 and ±30 min
		// sources are then idle, so nothing is eligible and the cohort is empty
		// rather than quietly scoring the real alignment against zeros.
		const index = new RequestIndex([
			{
				accountId: "A",
				finalizedAt: T0 + 1,
				inputTokens: 10,
				outputTokens: 10,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
		]);
		const cohort = scoreCohort("c", "d", units, index, splitAtMs);
		expect(cohort.trainingUnits).toBe(0);
		expect(cohort.evaluationUnits).toBe(0);
		for (const score of cohort.scores) expect(score.units).toBe(0);
	});

	it("never pairs a unit across the train/evaluate boundary", () => {
		// The control has to be a control on PAIRING. Pairing a training interval
		// with an evaluation one would turn any workload change between the halves
		// into the control losing, which the verdict would read as alignment.
		const { units, index, splitAtMs } = drivenFixture();
		const cohort = scoreCohort("c", "d", units, index, splitAtMs);
		const permuted = cohort.scores.find(
			(s) => s.name === MANDATORY_CONTROL,
		) as AlignmentScore;
		expect(permuted.units).toBe(cohort.evaluationUnits);
		// Both halves permute internally, so both are scorable.
		expect(cohort.trainingUnits).toBeGreaterThan(0);
		expect(cohort.evaluationUnits).toBeGreaterThan(0);
	});
});

describe("pairedDifference", () => {
	it("pairs per unit and clusters the resample by account-day", () => {
		const { units, index, splitAtMs } = drivenFixture();
		const cohort = scoreCohort("c", "d", units, index, splitAtMs);
		const evaluation = units.filter((u) => u.fromMs >= splitAtMs);
		const difference = pairedDifference(cohort, MANDATORY_CONTROL, evaluation);
		expect(difference.n).toBeGreaterThan(0);
		expect(difference.medianDeltaPct as number).toBeLessThan(0);
		// The fixture is one account over less than two days, so it sits below the
		// cluster floor: the difference is reported and the interval is withheld
		// rather than printed from resamples that are all the same draw.
		expect(difference.clusters).toBeLessThan(MIN_BOOTSTRAP_CLUSTERS);
		expect(difference.p2_5).toBeNull();
		expect(difference.p97_5).toBeNull();
	});

	it("states an interval once there are enough independent clusters", () => {
		const { units, index, splitAtMs } = drivenFixture(6);
		const cohort = scoreCohort("c", "d", units, index, splitAtMs);
		const evaluation = units.filter((u) => u.fromMs >= splitAtMs);
		const difference = pairedDifference(cohort, MANDATORY_CONTROL, evaluation);
		expect(difference.clusters).toBeGreaterThanOrEqual(MIN_BOOTSTRAP_CLUSTERS);
		expect(difference.p97_5 as number).toBeLessThan(0);
	});

	it("states nothing rather than zero when a control was never scored", () => {
		const { units, index, splitAtMs } = drivenFixture();
		const cohort = scoreCohort("c", "d", units, index, splitAtMs);
		const difference = pairedDifference(cohort, "not-a-control", units);
		expect(difference).toMatchObject({
			n: 0,
			medianDeltaPct: null,
			p2_5: null,
			p97_5: null,
		});
	});
});

describe("syntheticChecks", () => {
	// Both fixtures run the whole pipeline — construction, eligibility, the
	// per-half permutation and the fits — so they cost seconds rather than
	// milliseconds. That is the point of them.
	it("finds a planted alignment and does not find an absent one", () => {
		const checks = syntheticChecks();
		const positive = checks.find((c) => c.label === "synthetic positive");
		const negative = checks.find((c) => c.label === "synthetic null");
		expect(positive?.detected).toBe(true);
		expect(positive?.passed).toBe(true);
		expect(negative?.detected).toBe(false);
		expect(negative?.passed).toBe(true);
	}, 120_000);

	it("is deterministic", () => {
		expect(syntheticChecks(7)).toEqual(syntheticChecks(7));
	}, 120_000);
});

const score = (
	name: string,
	medianAbsErrorPct: number | null,
	inBandShare: number | null,
): AlignmentScore => ({
	name,
	description: name,
	control: name !== REAL_ALIGNMENT,
	mandatory: name === MANDATORY_CONTROL,
	units: 500,
	medianAbsErrorPct,
	inBandShare,
	medianAbsErrorMovedPct: medianAbsErrorPct,
	weights: [1],
	converged: true,
	fitIterations: 10,
	errorsByUnit: new Map(),
});

const cohortOf = (scores: AlignmentScore[], evaluationUnits = 500) => ({
	label: "c",
	description: "d",
	trainingUnits: 500,
	evaluationUnits,
	scores,
});

const difference = (
	over: Partial<PairedDifference> = {},
): PairedDifference => ({
	control: MANDATORY_CONTROL,
	n: 500,
	medianDeltaPct: -0.8,
	p2_5: -1.4,
	p97_5: -0.5,
	clusters: 30,
	...over,
});

const syntheticOk: SyntheticCheck[] = [
	{
		label: "synthetic positive",
		expectation: "e",
		medianDeltaPct: -0.9,
		detected: true,
		passed: true,
	},
	{
		label: "synthetic null",
		expectation: "e",
		medianDeltaPct: 0.01,
		detected: false,
		passed: true,
	},
];

describe("evaluateAlignment", () => {
	const passing = () =>
		cohortOf([
			score(REAL_ALIGNMENT, 1.3, 0.42),
			score(COUNT_ONLY_CONTROL, 1.8, 0.33),
			score(MANDATORY_CONTROL, 2.5, 0.3),
		]);

	it("passes only when both controls lose and the statistic is valid", () => {
		const verdict = evaluateAlignment(passing(), difference(), syntheticOk);
		expect(verdict.verdict).toBe("pass");
		expect(verdict.criteria.map((c) => c.passed)).toEqual([true, true, true]);
	});

	it("fails on a measured loss to the mandatory control", () => {
		const cohort = cohortOf([
			score(REAL_ALIGNMENT, 2.6, 0.28),
			score(COUNT_ONLY_CONTROL, 1.8, 0.33),
			score(MANDATORY_CONTROL, 2.5, 0.3),
		]);
		expect(evaluateAlignment(cohort, difference(), syntheticOk).verdict).toBe(
			"fail",
		);
	});

	it("fails when token composition adds nothing over counting requests", () => {
		const cohort = cohortOf([
			score(REAL_ALIGNMENT, 1.9, 0.32),
			score(COUNT_ONLY_CONTROL, 1.8, 0.33),
			score(MANDATORY_CONTROL, 2.5, 0.3),
		]);
		expect(evaluateAlignment(cohort, difference(), syntheticOk).verdict).toBe(
			"fail",
		);
	});

	it("is not a pass when the interval touches zero", () => {
		// Beating the control on both statistics is not enough: the paired
		// difference has to be distinguishable from no difference at all.
		const verdict = evaluateAlignment(
			passing(),
			difference({ p97_5: 0.2 }),
			syntheticOk,
		);
		expect(verdict.criteria[0].passed).toBe(false);
		expect(verdict.verdict).toBe("fail");
	});

	it("calls the experiment invalid when the statistic misbehaves on synthetic data", () => {
		const broken: SyntheticCheck[] = [
			{ ...syntheticOk[0], detected: false, passed: false },
			syntheticOk[1],
		];
		expect(evaluateAlignment(passing(), difference(), broken).verdict).toBe(
			"invalid",
		);
		// A statistic that finds an alignment in the null fixture is equally invalid.
		const hallucinating: SyntheticCheck[] = [
			syntheticOk[0],
			{ ...syntheticOk[1], detected: true, passed: false },
		];
		expect(
			evaluateAlignment(passing(), difference(), hallucinating).verdict,
		).toBe("invalid");
	});

	it("states insufficient evidence rather than a verdict on too few units", () => {
		expect(
			evaluateAlignment(
				cohortOf(
					[
						score(REAL_ALIGNMENT, 1.3, 0.42),
						score(COUNT_ONLY_CONTROL, 1.8, 0.33),
						score(MANDATORY_CONTROL, 2.5, 0.3),
					],
					MIN_EVALUATION_UNITS - 1,
				),
				difference(),
				syntheticOk,
			).verdict,
		).toBe("insufficient-evidence");
	});

	it("states nothing rather than a verdict when a fit did not converge", () => {
		const unconverged = score(MANDATORY_CONTROL, 2.5, 0.3);
		unconverged.converged = false;
		const cohort = cohortOf([
			score(REAL_ALIGNMENT, 1.3, 0.42),
			score(COUNT_ONLY_CONTROL, 1.8, 0.33),
			unconverged,
		]);
		const verdict = evaluateAlignment(cohort, difference(), syntheticOk);
		expect(verdict.criteria[0].passed).toBeNull();
		expect(verdict.verdict).toBe("insufficient-evidence");
	});

	it("states nothing rather than a verdict when the synthetic checks are absent", () => {
		expect(evaluateAlignment(passing(), difference(), []).verdict).toBe(
			"insufficient-evidence",
		);
		// One of the two is not both of them.
		expect(
			evaluateAlignment(passing(), difference(), [syntheticOk[0]]).verdict,
		).toBe("insufficient-evidence");
	});

	it("states insufficient evidence when a control could not be measured", () => {
		const cohort = cohortOf([
			score(REAL_ALIGNMENT, 1.3, 0.42),
			score(COUNT_ONLY_CONTROL, 1.8, 0.33),
			score(MANDATORY_CONTROL, null, null),
		]);
		const verdict = evaluateAlignment(
			cohort,
			difference({ n: 0, medianDeltaPct: null, p2_5: null, p97_5: null }),
			syntheticOk,
		);
		expect(verdict.criteria[0].passed).toBeNull();
		expect(verdict.verdict).toBe("insufficient-evidence");
	});
});

describe("formatAlignmentReport", () => {
	it("prints the rule, every cohort, the controls and the verdict, with no holes", () => {
		const { units, index, splitAtMs } = drivenFixture();
		const cohort = scoreCohort(
			"Primary cohort",
			"the cohort the verdict is taken on",
			units,
			index,
			splitAtMs,
		);
		const evaluation = units.filter((u) => u.fromMs >= splitAtMs);
		const differences = [
			pairedDifference(cohort, MANDATORY_CONTROL, evaluation),
			pairedDifference(cohort, COUNT_ONLY_CONTROL, evaluation),
		];
		const synthetic = syntheticChecks();
		const markdown = formatAlignmentReport({
			title: "t",
			generatedAtIso: new Date(T0).toISOString(),
			command: "bun scripts/alignment-study.ts",
			dataset: {
				claim: "5h",
				observations: 10,
				requests: 10,
				accounts: 1,
				firstObservationIso: new Date(T0).toISOString(),
				lastObservationIso: new Date(T0 + 1).toISOString(),
				splitAtIso: new Date(splitAtMs).toISOString(),
				finalizedCoverage: 0.99,
				finalizedTokenCoverage: 0.98,
			},
			build: {
				units,
				droppedNegative: 1,
				droppedSingleReading: 2,
				droppedUnplaceable: 3,
				droppedStraddlingReset: 4,
			},
			cohorts: [cohort],
			differences,
			synthetic,
			verdict: evaluateAlignment(cohort, differences[0], synthetic),
			unmeasurable: [{ name: "donor", reason: "no paired units" }],
			notes: ["a note"],
		});
		expect(markdown).toContain("REQUEST-LAG ALIGNMENT GATE");
		expect(markdown).toContain("## Primary cohort");
		expect(markdown).toContain(
			"## Paired differences against the real alignment",
		);
		expect(markdown).toContain("## Synthetic validation");
		expect(markdown).toContain("## Controls that could not be measured");
		expect(markdown).toContain("**Verdict:");
		expect(markdown).toContain("a note");
		expect(markdown).not.toContain("undefined");
		expect(markdown).not.toContain("NaN");
		expect(ALIGNMENT_RULE).toContain("permuted-within-account");
	});
});
