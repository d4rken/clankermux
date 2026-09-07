import { describe, expect, test } from "bun:test";
import { proportionalShareRule } from "./capacity-runway-scenario";
import type { BacktestMetrics } from "./prediction-backtest";
import { SEGMENT_COVERAGE_SLACK_MS, scoreRecords } from "./prediction-backtest";
import {
	ABSORPTION_EXCLUSION_REASONS,
	ABSORPTION_POPULATION_LABELS,
	type AbsorptionChecks,
	type AbsorptionInput,
	type AccountSeries,
	type AvailabilityTimeline,
	absorptionChecks,
	availabilityAt,
	BESIDE_BASIS_MODELS,
	type BesideBasisScores,
	basisIdentityCheck,
	buildAvailabilityTimelines,
	buildRosterAtInstant,
	CONTROL_MODELS,
	type CohortScores,
	type CohortSet,
	churnRows,
	detectTransitions,
	evaluateBesideBasis,
	evaluateVerdict,
	formatRedistributionReport,
	headroomShareRule,
	knownLimitsFor,
	lifecycleBalanced,
	nearestAvailabilityChangeMs,
	OBSERVATION_AGE_BUCKETS,
	OVERALL_BOOTSTRAP_LABEL,
	observationLagChecks,
	type PairedAbsDelta,
	type PairedBias,
	PEER_LOSS_PREFIX_MS,
	PRIOR_BASIS_CONTROL_MODEL,
	PRIOR_BASIS_MODEL,
	pairedAbsMedian,
	pairedSignedMedian,
	prepareSeries,
	READING_STALE_MS,
	REPLAY_MODELS,
	REQUEST_BUCKET_MS,
	type RedistributionRecord,
	type ReplayModel,
	type ReplayRange,
	type ReplayResult,
	type RequestBucket,
	type RosterAccount,
	type RosterSnapshotRow,
	redistributionRecordToJson,
	replayInstant,
	replayRange,
	SCENARIO_MODEL_IDS,
	SCENARIO_MODELS,
	type ScenarioModel,
	SINCE_DEATH_BUCKETS,
	scoreCohorts,
	survivorSlopeTrajectory,
	TRANSITION_BOOTSTRAP_LABEL,
	type TransitionEvent,
	tallyWindowFills,
	transitionsAt,
	VERDICT_BASIS_CONTROL_MODEL,
	VERDICT_BASIS_MODEL,
	VERDICT_RULE,
	type Verdict,
	type WindowFill,
	type WindowFillRow,
	type WindowFillTally,
	windowFillMetrics,
} from "./redistribution-backtest";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 6, 1, 0, 0, 0);

interface RowSpec {
	accountId: string;
	provider?: string;
	from: number;
	to: number;
	stepMs?: number;
	planTier?: string | null;
	rateLimitTier?: string | null;
	fiveHour?: (t: number) => { pct: number | null; reset: number | null };
	sevenDay?: (t: number) => { pct: number | null; reset: number | null };
	/** Instants to leave a hole at (a sampler gap). */
	skip?: (t: number) => boolean;
	observed?: boolean;
	/** How far `observed_at` sits BEFORE the sample time. Default 0. */
	observedOffsetMs?: number;
}

function rows(spec: RowSpec): RosterSnapshotRow[] {
	const step = spec.stepMs ?? 10 * MIN;
	const out: RosterSnapshotRow[] = [];
	for (let t = spec.from; t <= spec.to; t += step) {
		if (spec.skip?.(t)) continue;
		const five = spec.fiveHour?.(t) ?? { pct: null, reset: null };
		const seven = spec.sevenDay?.(t) ?? { pct: null, reset: null };
		out.push({
			accountId: spec.accountId,
			provider: spec.provider ?? "anthropic",
			sampledAt: t,
			observedAt:
				spec.observed === false ? null : t - (spec.observedOffsetMs ?? 0),
			fiveHourPct: five.pct,
			fiveHourReset: five.reset,
			sevenDayPct: seven.pct,
			sevenDayReset: seven.reset,
			planTier: spec.planTier === undefined ? "max" : spec.planTier,
			rateLimitTier:
				spec.rateLimitTier === undefined ? "20x" : spec.rateLimitTier,
		});
	}
	return out;
}

/** A weekly window that starts at `start`, burns `pctPerDay`, and resets at +7d. */
function weekly(start: number, pctPerDay: number, cap = 100) {
	return (t: number) => ({
		pct: Math.min(cap, Math.max(0, ((t - start) / DAY) * pctPerDay)),
		reset: start + 7 * DAY,
	});
}

function account(
	accountId: string,
	overrides: Partial<RosterAccount> = {},
): RosterAccount {
	return {
		accountId,
		name: accountId,
		provider: "anthropic",
		createdAtMs: T0 - 30 * DAY,
		currentPlanTier: "max",
		currentRateLimitTier: "20x",
		...overrides,
	};
}

const RANGE: ReplayRange = { label: "test", fromMs: T0, toMs: T0 + 8 * DAY };

/** Two anthropic accounts, one weekly window each, 20 %/d and 90 %/d. */
function pairFixture(): {
	rows: RosterSnapshotRow[];
	accounts: RosterAccount[];
} {
	const start = T0 - DAY;
	return {
		rows: [
			...rows({
				accountId: "A",
				from: start,
				to: T0 + 6 * DAY,
				sevenDay: weekly(start, 20),
			}),
			...rows({
				accountId: "B",
				from: start,
				to: T0 + 6 * DAY,
				sevenDay: weekly(start, 90),
			}),
		],
		accounts: [account("A"), account("B")],
	};
}

describe("prepareSeries", () => {
	test("splits lifecycles on a reset move and carries the label reset", () => {
		const first = T0 - DAY;
		const second = T0 + 6 * DAY;
		const series = prepareSeries(
			[
				...rows({
					accountId: "A",
					from: first,
					to: second - 10 * MIN,
					sevenDay: weekly(first, 20),
				}),
				...rows({
					accountId: "A",
					from: second,
					to: second + DAY,
					sevenDay: weekly(second, 20),
				}),
			],
			[account("A")],
		);
		const window = series.get("A")?.windows.seven_day;
		expect(window?.lifecycles).toHaveLength(2);
		expect(window?.lifecycles[0].labelResetAtMs).toBe(first + 7 * DAY);
		expect(window?.lifecycles[0].nextWindowStartsMs).toBe(second);
		expect(window?.lifecycles[1].nextWindowStartsMs).toBeNull();
		expect(window?.lifecycles[0].placeholder).toBe(false);
	});

	test("flags a one-sample 0% window as a placeholder", () => {
		const series = prepareSeries(
			rows({
				accountId: "C",
				provider: "codex",
				from: T0,
				to: T0,
				fiveHour: (t) => ({ pct: 0, reset: t + 5 * HOUR }),
			}),
			[account("C", { provider: "codex" })],
		);
		expect(series.get("C")?.windows.five_hour.lifecycles[0].placeholder).toBe(
			true,
		);
	});

	test("the running anchor is point-in-time: a later drop never reaches back", () => {
		const start = T0 - DAY;
		const dropAt = T0 + 2 * HOUR;
		const base = rows({
			accountId: "A",
			from: start,
			to: T0 + 4 * HOUR,
			stepMs: HOUR,
			sevenDay: (t) => ({
				pct: t < dropAt ? 40 : 10,
				reset: start + 7 * DAY,
			}),
		});
		const truncated = base.filter((row) => row.sampledAt < dropAt);

		const full = prepareSeries(base, [account("A")]);
		const partial = prepareSeries(truncated, [account("A")]);
		const fullWindow = full.get("A")?.windows.seven_day;
		const partialWindow = partial.get("A")?.windows.seven_day;
		const lastCommon = (partialWindow?.points.length ?? 0) - 1;

		expect(partialWindow?.anchorAtIndex[lastCommon]).toBeNull();
		expect(fullWindow?.anchorAtIndex[lastCommon]).toBeNull();
		// The drop itself anchors, and only from its own index onwards.
		const dropIndex = fullWindow?.points.findIndex(
			(point) => point.t === dropAt,
		) as number;
		expect(fullWindow?.anchorAtIndex[dropIndex]).toEqual({
			anchorMs: dropAt,
			anchorPct: 10,
			windowResetMs: start + 7 * DAY,
		});
	});
});

describe("detectTransitions", () => {
	test("finds an add, an upgrade, a gift reset and a peer exhaustion", () => {
		const start = T0 - DAY;
		const upgradeAt = T0 + 2 * HOUR;
		const giftAt = T0 + 5 * HOUR;
		const snapshotRows = [
			// A: upgrades at +2h, then a mid-window gift drop at +5h.
			...rows({
				accountId: "A",
				from: start,
				to: T0 + 8 * HOUR,
				stepMs: HOUR,
				sevenDay: (t) => ({
					pct: t < giftAt ? 40 : 10,
					reset: start + 7 * DAY,
				}),
			}).map((row) =>
				row.sampledAt >= upgradeAt
					? { ...row, planTier: "max", rateLimitTier: "5x" }
					: row,
			),
			// B: hits 100% at +3h.
			...rows({
				accountId: "B",
				from: start,
				to: T0 + 8 * HOUR,
				stepMs: HOUR,
				sevenDay: (t) => ({
					pct: t >= T0 + 3 * HOUR ? 100 : 50,
					reset: T0 + 10 * HOUR,
				}),
			}),
		];
		const accounts = [
			account("A"),
			account("B"),
			account("N", { createdAtMs: T0 + HOUR, name: "Claude-N" }),
		];
		const series = prepareSeries(snapshotRows, accounts);
		const events = detectTransitions(series, accounts, RANGE);

		expect(events.map((event) => event.id)).toEqual([1, 2, 3, 4]);
		expect(events.map((event) => event.atMs)).toEqual([
			T0 + HOUR,
			T0 + 2 * HOUR,
			T0 + 3 * HOUR,
			T0 + 5 * HOUR,
		]);
		expect(events.map((event) => event.kind)).toEqual([
			"add",
			"upgrade",
			"peer-exhaustion",
			"gift-reset",
		]);
		expect(events[0].accountName).toBe("Claude-N");
		expect(events[1].detail).toBe("max/20x → max/5x");
		expect(events[3].detail).toBe("drop 40 → 10 pp");
		// The dead span ends at the dying window's own reset, not 24 h later.
		expect(events[2].endsAtMs).toBe(T0 + 10 * HOUR);
		expect(events[2].windowKind).toBe("seven_day");
		expect(events[0].endsAtMs).toBe(T0 + HOUR + 24 * HOUR);
		expect(events.every((event) => event.demandClass === "anthropic")).toBe(
			true,
		);
	});

	test("ignores the tier column's introduction and out-of-range events", () => {
		const start = T0 - DAY;
		const stamped = T0 + 3 * HOUR;
		const snapshotRows = rows({
			accountId: "A",
			from: start,
			to: T0 + 6 * HOUR,
			stepMs: HOUR,
			sevenDay: weekly(start, 20),
		}).map((row) =>
			row.sampledAt < stamped
				? { ...row, planTier: null, rateLimitTier: null }
				: row,
		);
		const accounts = [account("A", { createdAtMs: T0 - 30 * DAY })];
		const series = prepareSeries(snapshotRows, accounts);
		// The account was created before the range, and null -> max/20x is the
		// column arriving rather than an upgrade.
		expect(detectTransitions(series, accounts, RANGE)).toEqual([]);
	});

	test("a drop that comes with a reset move is not a gift", () => {
		const first = T0 - DAY;
		const snapshotRows = [
			...rows({
				accountId: "A",
				from: first,
				to: T0 + HOUR,
				stepMs: HOUR,
				sevenDay: () => ({ pct: 80, reset: first + 7 * DAY }),
			}),
			...rows({
				accountId: "A",
				from: T0 + 2 * HOUR,
				to: T0 + 3 * HOUR,
				stepMs: HOUR,
				sevenDay: (t) => ({ pct: 2, reset: t + 7 * DAY }),
			}),
		];
		const accounts = [account("A")];
		const series = prepareSeries(snapshotRows, accounts);
		expect(detectTransitions(series, accounts, RANGE)).toEqual([]);
	});

	test("falls back to the account id when the account row is gone", () => {
		const start = T0 - DAY;
		const snapshotRows = rows({
			accountId: "B",
			from: start,
			to: T0 + 8 * HOUR,
			stepMs: HOUR,
			sevenDay: (t) => ({
				pct: t >= T0 + 3 * HOUR ? 100 : 50,
				reset: T0 + 10 * HOUR,
			}),
		});
		// Snapshots without an `accounts` row: the id is all the history has.
		const series = prepareSeries(snapshotRows, []);
		const events = detectTransitions(series, [], RANGE);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("peer-exhaustion");
		expect(events[0].accountName).toBe("B");
	});

	test("a placeholder lifecycle never reports a peer exhaustion", () => {
		const snapshotRows = rows({
			accountId: "C",
			provider: "codex",
			from: T0,
			to: T0 + 20 * MIN,
			stepMs: 10 * MIN,
			fiveHour: (t) => ({ pct: 0, reset: t + 5 * HOUR }),
		});
		const accounts = [account("C", { provider: "codex" })];
		const series = prepareSeries(snapshotRows, accounts);
		expect(detectTransitions(series, accounts, RANGE)).toEqual([]);
	});
});

describe("transitionsAt", () => {
	const events: TransitionEvent[] = [
		{
			id: 1,
			kind: "peer-exhaustion",
			atMs: T0 + HOUR,
			endsAtMs: T0 + 5 * HOUR,
			demandClass: "anthropic",
			accountId: "B",
			accountName: "Claude-B",
			windowKind: "seven_day",
			detail: "",
		},
		{
			id: 2,
			kind: "add",
			atMs: T0 + 2 * HOUR,
			endsAtMs: T0 + 26 * HOUR,
			demandClass: "anthropic",
			accountId: "N",
			accountName: "Claude-N",
			windowKind: null,
			detail: "",
		},
		{
			id: 3,
			kind: "add",
			atMs: T0 + 2 * HOUR,
			endsAtMs: T0 + 26 * HOUR,
			demandClass: "codex",
			accountId: "X",
			accountName: "Codex-X",
			windowKind: null,
			detail: "",
		},
	];

	test("tags the survivors of a class, in kind order, with the event ids", () => {
		const context = transitionsAt(events, T0 + 3 * HOUR, "A", "anthropic");
		expect(context.tags).toEqual(["peer-exhaustion", "add"]);
		expect(context.eventIds).toEqual([1, 2]);
		expect(context.sinceDeathMs).toBe(2 * HOUR);
	});

	test("excludes the dying account from its own death", () => {
		const context = transitionsAt(events, T0 + 3 * HOUR, "B", "anthropic");
		expect(context.tags).toEqual(["add"]);
		expect(context.eventIds).toEqual([2]);
		expect(context.sinceDeathMs).toBeNull();
	});

	test("does not leak across servable classes or past the shadow", () => {
		expect(transitionsAt(events, T0 + 3 * HOUR, "X", "codex").eventIds).toEqual(
			[3],
		);
		expect(transitionsAt(events, T0 + 6 * HOUR, "A", "anthropic").tags).toEqual(
			["add"],
		);
		expect(
			transitionsAt(events, T0 + 30 * HOUR, "A", "anthropic").tags,
		).toEqual([]);
		// At the event instant itself nothing is active yet: the shadow is (at, ends].
		expect(transitionsAt(events, T0 + HOUR, "A", "anthropic").tags).toEqual([]);
	});
});

describe("headroomShareRule", () => {
	test("weights remaining headroom in capacity units", () => {
		const weights = headroomShareRule([
			{
				accountId: "A",
				demandClass: "anthropic",
				capacityUnits: 20,
				windows: [
					{ windowKind: "seven_day", utilizationPct: 50 },
					{ windowKind: "five_hour", utilizationPct: 10 },
				],
			},
			{
				accountId: "B",
				demandClass: "anthropic",
				capacityUnits: 5,
				windows: [{ windowKind: "seven_day", utilizationPct: 20 }],
			},
		]);
		expect(weights).toEqual([1000, 400]);
	});

	test("falls back to the equal split when nothing is left to weight by", () => {
		const weights = headroomShareRule([
			{
				accountId: "A",
				demandClass: "anthropic",
				capacityUnits: 20,
				windows: [{ windowKind: "seven_day", utilizationPct: 100 }],
			},
			{
				accountId: "B",
				demandClass: "anthropic",
				capacityUnits: null,
				windows: [],
			},
		]);
		expect(weights).toEqual([1, 1]);
	});
});

describe("buildRosterAtInstant", () => {
	const start = T0 - DAY;

	test("reconstructs the readings, tiers and window starts a deployment had", () => {
		const series = prepareSeries(
			[
				...rows({
					accountId: "A",
					from: start,
					to: T0,
					sevenDay: weekly(start, 20),
					fiveHour: (t) => ({
						pct: ((t - (T0 - 2 * HOUR)) / HOUR) * 10,
						reset: T0 + 3 * HOUR,
					}),
				}).filter(
					(row) => row.sampledAt >= T0 - 2 * HOUR || row.sevenDayPct != null,
				),
			],
			[account("A")],
		);
		const roster = buildRosterAtInstant(T0, series, [account("A")]);
		expect(roster.accounts).toHaveLength(1);
		const entry = roster.accounts[0];
		expect(entry.demandClass).toBe("anthropic");
		expect(entry.unmetered).toBe(false);
		expect(entry.tier).toEqual({
			provider: "anthropic",
			planTier: "max",
			rateLimitTier: "20x",
			provenance: "recorded",
		});

		const seven = entry.windows.find((window) => window.kind === "seven_day");
		expect(seven?.input.utilizationPct).toBeCloseTo(20, 6);
		expect(seven?.input.windowStartMs).toBe(start);
		// Production emits no weekly regression, so neither does the replay.
		expect(seven?.input.prediction).toBeNull();
		expect(seven?.input.lifetimeConfidence).toBe("full");

		const five = entry.windows.find((window) => window.kind === "five_hour");
		expect(five?.input.prediction).not.toBeNull();
		expect(five?.input.prediction?.slopePerHour).toBeCloseTo(10, 3);
		expect(five?.input.windowStartMs).toBe(T0 + 3 * HOUR - 5 * HOUR);
	});

	test("drops an account whose newest reading is stale", () => {
		const series = prepareSeries(
			rows({
				accountId: "A",
				from: T0 - 11 * MIN - 3 * HOUR,
				to: T0 - 11 * MIN,
				stepMs: MIN,
				sevenDay: weekly(start, 20),
			}),
			[account("A")],
		);
		expect(buildRosterAtInstant(T0, series, [account("A")]).accounts).toEqual(
			[],
		);
		// One minute younger and the same reading is projectable.
		expect(
			buildRosterAtInstant(T0 - MIN, series, [account("A")]).accounts,
		).toHaveLength(1);
		expect(READING_STALE_MS).toBe(10 * MIN);
	});

	test("drops a window whose recorded reset has already passed", () => {
		const series = prepareSeries(
			rows({
				accountId: "A",
				from: start,
				to: T0,
				sevenDay: () => ({ pct: 90, reset: T0 - HOUR }),
			}),
			[account("A")],
		);
		expect(
			buildRosterAtInstant(T0, series, [account("A")]).accounts[0].windows,
		).toEqual([]);
	});

	test("keeps a window that reads 100%, because its fill is demand", () => {
		const series = prepareSeries(
			rows({
				accountId: "A",
				from: start,
				to: T0,
				sevenDay: () => ({ pct: 100, reset: start + 7 * DAY }),
			}),
			[account("A")],
		);
		const entry = buildRosterAtInstant(T0, series, [account("A")]).accounts[0];
		expect(entry.windows).toHaveLength(1);
		expect(entry.windows[0].input.utilizationPct).toBe(100);
	});

	test("assumes today's tier for an unstamped row, and says so", () => {
		const unstamped = rows({
			accountId: "A",
			from: start,
			to: T0,
			sevenDay: weekly(start, 20),
			planTier: null,
			rateLimitTier: null,
		});
		const withAccount = prepareSeries(unstamped, [account("A")]);
		expect(
			buildRosterAtInstant(T0, withAccount, [account("A")]).accounts[0].tier,
		).toEqual({
			provider: "anthropic",
			planTier: "max",
			rateLimitTier: "20x",
			provenance: "assumed",
		});

		// A removed account has no `accounts` row to borrow a tier from.
		const orphan = prepareSeries(unstamped, []);
		expect(buildRosterAtInstant(T0, orphan, []).accounts[0].tier).toBeNull();
	});
});

describe("replayInstant", () => {
	const start = T0 - DAY;
	const build = (
		snapshotRows: RosterSnapshotRow[],
		accounts: RosterAccount[],
		options?: Parameters<typeof replayInstant>[4],
	) => {
		const series = prepareSeries(snapshotRows, accounts);
		const roster = buildRosterAtInstant(T0, series, accounts);
		return replayInstant(T0, roster, [], RANGE, options);
	};
	const recordFor = (
		replay: ReturnType<typeof replayInstant>,
		accountId: string,
		model: ReplayModel,
	): RedistributionRecord | undefined =>
		replay.records.find(
			(record) => record.accountId === accountId && record.model === model,
		);

	test("the scenario pulls a survivor's ETA in, and a peer's demand is what moves it", () => {
		const fixture = pairFixture();
		const replay = build(fixture.rows, fixture.accounts);
		const current = recordFor(replay, "A", "current");
		const scenario = recordFor(replay, "A", "scenario-equal");
		expect(current?.predictedEtaMs).toBeCloseTo(T0 + 4 * DAY, -4);
		expect(scenario?.predictedEtaMs).not.toBeNull();
		expect(scenario?.predictedEtaMs as number).toBeLessThan(
			current?.predictedEtaMs as number,
		);

		// Drop B from the roster: A's own burn is then the whole class demand, so
		// the scenario says exactly what the current model says.
		const alone = build(
			fixture.rows.filter((row) => row.accountId === "A"),
			[fixture.accounts[0]],
		);
		expect(
			recordFor(alone, "A", "scenario-equal")?.predictedEtaMs as number,
		).toBeCloseTo(T0 + 4 * DAY, -4);
	});

	test("emits no record for a window that is already spent", () => {
		const fixture = pairFixture();
		const spent = fixture.rows.map((row) =>
			row.accountId === "B" ? { ...row, sevenDayPct: 100 } : row,
		);
		const replay = build(spent, fixture.accounts);
		expect(replay.records.some((record) => record.accountId === "B")).toBe(
			false,
		);
		expect(recordFor(replay, "A", "scenario-equal")).toBeDefined();
	});

	test("a beyond-reset ETA is recorded as no prediction at all", () => {
		// 2 %/d against a reset six days out: the window cannot fill this cycle.
		const slow = rows({
			accountId: "A",
			from: start,
			to: T0,
			sevenDay: weekly(start, 2),
		});
		const replay = build(slow, [account("A")]);
		const current = recordFor(replay, "A", "current");
		expect(current?.usable).toBe(true);
		expect(current?.predictsExhaust).toBe(false);
		expect(current?.predictedEtaMs).toBeNull();
	});

	test("one learning window makes the whole account unusable for the current model", () => {
		const learner = [
			...rows({
				accountId: "A",
				from: start,
				to: T0,
				sevenDay: weekly(start, 20),
				fiveHour: (t) => ({
					// A 20-minute-old 5h window: inside the one-hour evidence floor.
					pct: t <= T0 - 20 * MIN ? 0 : 5,
					reset: T0 + 4 * HOUR + 40 * MIN,
				}),
			}),
			...rows({
				accountId: "B",
				from: start,
				to: T0,
				sevenDay: weekly(start, 90),
				fiveHour: () => ({ pct: 40, reset: T0 + 2 * HOUR }),
			}),
		];
		const replay = build(learner, [account("A"), account("B")]);
		const weeklyRecord = replay.records.find(
			(record) =>
				record.accountId === "A" &&
				record.windowKind === "seven_day" &&
				record.model === "current",
		);
		expect(weeklyRecord?.learningAtT).toBe(true);
		expect(weeklyRecord?.usable).toBe(false);
		expect(weeklyRecord?.unusableReason).toBe("low_confidence");
	});

	test("classes are scanned apart: a codex reset cannot re-time an anthropic account", () => {
		const fixture = pairFixture();
		const withCodex = [
			...fixture.rows,
			...rows({
				accountId: "C",
				provider: "codex",
				from: start,
				to: T0,
				planTier: "pro",
				rateLimitTier: null,
				sevenDay: (t) => ({
					pct: ((t - (T0 - 3 * HOUR)) / DAY) * 40 + 10,
					reset: T0 + 6 * HOUR,
				}),
			}),
		];
		const withoutCodex = build(fixture.rows, fixture.accounts);
		const withCodexReplay = build(withCodex, [
			...fixture.accounts,
			account("C", { provider: "codex", currentPlanTier: "pro" }),
		]);
		expect(
			recordFor(withCodexReplay, "A", "scenario-equal")?.predictedEtaMs,
		).toBe(recordFor(withoutCodex, "A", "scenario-equal")?.predictedEtaMs);
		expect(
			withCodexReplay.classes.map((entry) => entry.demandClass).sort(),
		).toEqual(["anthropic", "codex"]);
	});

	test("counts a tagged weekly window the label horizon dropped as pending", () => {
		const fixture = pairFixture();
		const series = prepareSeries(fixture.rows, fixture.accounts);
		const roster = buildRosterAtInstant(T0, series, fixture.accounts);
		// A fills at T0+4d, past this range's end, so its weekly truth is still
		// unfolding and nothing scores it. B fills at T0+2.7h and is scored.
		const short: ReplayRange = {
			label: "short",
			fromMs: T0,
			toMs: T0 + 3 * DAY,
		};
		const events: TransitionEvent[] = [
			{
				id: 1,
				kind: "peer-exhaustion",
				atMs: T0 - HOUR,
				endsAtMs: T0 + HOUR,
				demandClass: "anthropic",
				accountId: "B",
				accountName: "B",
				windowKind: "seven_day",
				detail: "hit 100 with 2 h to reset",
			},
		];
		const replay = replayInstant(T0, roster, events, short);
		expect(replay.records.some((entry) => entry.accountId === "A")).toBe(false);
		expect(replay.records.some((entry) => entry.accountId === "B")).toBe(true);
		// Only A's dropped window is pending: B is excluded from its own event, so
		// it carries no tag to be pending FOR.
		expect([...replay.pendingWeeklyByTagClass]).toEqual([
			["peer-exhaustion::anthropic", 1],
		]);
	});

	test("a dead account's sibling window is still projected at an out-now instant", () => {
		// A's weekly is spent and resets at T0+1h, so the class is out AT T0. Its
		// five-hour window is at 60 % on a 60 %/h burn and resets at T0+4h: once
		// the weekly reset revives A it takes the whole class demand back and
		// fills the last 40 pp 40 min later, inside the cycle the reading is from.
		const cycleStart = (t: number) =>
			T0 - HOUR + Math.floor((t - (T0 - HOUR)) / (5 * HOUR)) * 5 * HOUR;
		const snapshotRows = rows({
			accountId: "A",
			from: T0 - DAY,
			to: T0,
			sevenDay: () => ({ pct: 100, reset: T0 + HOUR }),
			fiveHour: (t) => ({
				pct: Math.min(100, ((t - cycleStart(t)) / HOUR) * 60),
				reset: cycleStart(t) + 5 * HOUR,
			}),
		});
		const replay = build(snapshotRows, [account("A")]);
		expect(replay.classes[0].scenarioOutcomes.get("scenario-equal")?.kind).toBe(
			"out-now",
		);
		const scenario = recordFor(replay, "A", "scenario-equal");
		expect(scenario?.windowKind).toBe("five_hour");
		expect(scenario?.usable).toBe(true);
		expect(scenario?.predictsExhaust).toBe(true);
		expect(scenario?.predictedEtaMs as number).toBeCloseTo(
			T0 + HOUR + (40 / 60) * HOUR,
			-3,
		);
	});

	test("an incomplete projection list makes the scenario records unusable", () => {
		const fixture = pairFixture();
		// Two events reach the pool-out (B fills, then A does); the third is the
		// walk past it, and the budget stops the scan there.
		const replay = build(fixture.rows, fixture.accounts, { maxEvents: 2 });
		const scenario = replay.classes[0].scenarioOutcomes.get("scenario-equal");
		expect(scenario?.eventBudgetExhausted).toBe("projection");
		expect(recordFor(replay, "A", "scenario-equal")?.usable).toBe(false);
		expect(recordFor(replay, "A", "scenario-equal")?.unusableReason).toBe(
			"insufficient_data",
		);
		// The current model is untouched by the scenario's budget.
		expect(recordFor(replay, "A", "current")?.usable).toBe(true);
	});
});

describe("replayRange", () => {
	test("replays the grid, tags the transitions and calibrates the pool claim", () => {
		const start = T0 - DAY;
		// 12-hour grid over 16 days: long enough for a 14-day horizon to fit
		// inside the range for the earliest instants.
		const step = 12 * HOUR;
		const range: ReplayRange = {
			label: "grid",
			fromMs: T0,
			toMs: T0 + 16 * DAY,
		};
		const outAt = T0 + 5 * DAY;
		const both = (accountId: string, pctPerDay: number) =>
			rows({
				accountId,
				from: start,
				to: T0 + 16 * DAY,
				stepMs: step,
				sevenDay: (t) =>
					t >= outAt && t < outAt + DAY
						? { pct: 100, reset: outAt + 2 * DAY }
						: {
								pct: Math.min(95, ((t - start) / DAY) * pctPerDay),
								reset: start + 7 * DAY,
							},
			});
		const snapshotRows = [...both("A", 8), ...both("B", 9)];
		const accounts = [account("A"), account("B")];
		const result = replayRange(snapshotRows, accounts, range, step / MIN, 7);

		expect(result.instants).toBe(32);
		expect(result.records.length).toBeGreaterThan(0);
		// Both accounts read 100% together, so the class was observed all-out.
		const anthropic = result.calibration.filter(
			(row) => row.demandClass === "anthropic",
		);
		expect(anthropic).toHaveLength(REPLAY_MODELS.length);
		expect(anthropic[0].observedOut).toBeGreaterThan(0);
		expect(anthropic.every((row) => row.instants > 0)).toBe(true);
		// A peer exhaustion is detected and its shadow tags instants.
		expect(
			result.events.some((event) => event.kind === "peer-exhaustion"),
		).toBe(true);
		const peerCoverage = result.tagCoverage.find(
			(row) => row.tag === "peer-exhaustion",
		);
		expect(peerCoverage?.events).toBeGreaterThan(0);
		expect(peerCoverage?.instantFraction as number).toBeGreaterThan(0);
	});

	test("reports each contiguous all-out run, and members join only where they have rows", () => {
		const start = T0 - DAY;
		const step = 12 * HOUR;
		const range: ReplayRange = {
			label: "grid",
			fromMs: T0,
			toMs: T0 + 4 * DAY,
		};
		const outFrom = T0 + DAY;
		const outTo = T0 + 2 * DAY;
		const member = (accountId: string, from: number) =>
			rows({
				accountId,
				from,
				to: T0 + 4 * DAY,
				stepMs: step,
				sevenDay: (t) =>
					t >= outFrom && t < outTo
						? { pct: 100, reset: outTo + DAY }
						: { pct: 50, reset: T0 + 6 * DAY },
			});
		const snapshotRows = [
			...member("A", start),
			...member("B", start),
			// C has no row anywhere near the all-out ticks: absent, not a survivor.
			...member("C", T0 + 3 * DAY),
		];
		const accounts = [account("A"), account("B"), account("C")];
		const result = replayRange(snapshotRows, accounts, range, step / MIN, 7);

		expect(result.allOutIntervals).toEqual([
			{
				demandClass: "anthropic",
				fromMs: outFrom,
				toMs: outTo,
				ticks: 2,
			},
		]);
	});

	test("reports no interval for a class the grid never saw all-out", () => {
		const start = T0 - DAY;
		const step = 12 * HOUR;
		const range: ReplayRange = {
			label: "grid",
			fromMs: T0,
			toMs: T0 + 4 * DAY,
		};
		const snapshotRows = [
			...rows({
				accountId: "A",
				from: start,
				to: T0 + 4 * DAY,
				stepMs: step,
				sevenDay: weekly(start, 8, 95),
			}),
			...rows({
				accountId: "B",
				from: start,
				to: T0 + 4 * DAY,
				stepMs: step,
				sevenDay: weekly(start, 9, 95),
			}),
		];
		const accounts = [account("A"), account("B")];
		const result = replayRange(snapshotRows, accounts, range, step / MIN, 7);
		expect(result.allOutIntervals).toEqual([]);
	});

	test("a stale member censors the tick, and censored horizons never enter the false-alarm rate", () => {
		const start = T0 - DAY;
		const step = 12 * HOUR;
		const range: ReplayRange = {
			label: "grid",
			fromMs: T0,
			toMs: T0 + 16 * DAY,
		};
		const gapAt = T0 + 2 * DAY;
		const snapshotRows = [
			...rows({
				accountId: "A",
				from: start,
				to: T0 + 16 * DAY,
				stepMs: step,
				sevenDay: weekly(start, 8, 95),
			}),
			...rows({
				accountId: "B",
				from: start,
				to: T0 + 16 * DAY,
				stepMs: step,
				sevenDay: weekly(start, 9, 95),
				// One missing sample: that tick has no fresh reading for B.
				skip: (t) => t >= gapAt && t < gapAt + step,
			}),
		];
		const accounts = [account("A"), account("B")];
		const result = replayRange(snapshotRows, accounts, range, step / MIN, 7);
		const anthropic = result.calibration.filter(
			(row) => row.demandClass === "anthropic",
		);
		// Nothing was ever all-out, and one tick is censored: with a 28-tick
		// horizon a single censored tick is under the 5% tolerance, so the
		// horizons stay determinate rather than being thrown away.
		expect(anthropic.every((row) => row.observedOut === 0)).toBe(true);
		expect(anthropic.every((row) => row.censored === 0)).toBe(true);
		for (const row of anthropic) {
			if (row.predictedOut > 0) {
				expect(row.falseAlarmRate).not.toBeNull();
			} else {
				expect(row.falseAlarmRate).toBeNull();
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function record(
	overrides: Partial<RedistributionRecord> & {
		model: ReplayModel;
		accountId: string;
		T: number;
	},
): RedistributionRecord {
	return {
		windowKind: "seven_day",
		provider: "anthropic",
		usable: true,
		unusableReason: null,
		predictsExhaust: true,
		predictedEtaMs: overrides.T + DAY,
		outcome: { kind: "exhausted", atMs: overrides.T + DAY },
		knownResetAtMs: overrides.T + 3 * DAY,
		labelResetAtMs: overrides.T + 3 * DAY,
		windowMs: 7 * DAY,
		lifecycleId: `${overrides.accountId}::seven_day::0`,
		tags: [],
		eventIds: [],
		learningAtT: false,
		sinceDeathMs: null,
		slopePctPerHour: null,
		observationAgeMs: null,
		sampleAgeMs: 0,
		lagMs: 0,
		estimatorSource: "lifetime-primary",
		classLagFree: true,
		pooledInClass: 1,
		firstEvent: false,
		peerDiedInLag: false,
		exactShiftEligible: false,
		basisFirstAssignment: false,
		lagAnchorKnown: true,
		...overrides,
	};
}

/** One record per model at each of `instants`, for one account. */
function perModel(
	accountId: string,
	instants: number[],
	overrides: Partial<
		Record<ReplayModel, (T: number) => Partial<RedistributionRecord>>
	> = {},
): RedistributionRecord[] {
	const out: RedistributionRecord[] = [];
	for (const T of instants) {
		for (const model of REPLAY_MODELS) {
			out.push(
				record({ model, accountId, T, ...(overrides[model]?.(T) ?? {}) }),
			);
		}
	}
	return out;
}

const replayOf = (
	records: RedistributionRecord[],
	events: TransitionEvent[] = [],
	pendingWeekly: Record<string, number> = {},
): ReplayResult => ({
	range: RANGE,
	stepMinutes: 10,
	seed: 7,
	instants: new Set(records.map((entry) => entry.T)).size,
	records,
	events,
	calibration: [],
	allOutIntervals: [],
	placeholderWindowsSkipped: 0,
	pendingWeeklyByTagClass: new Map(Object.entries(pendingWeekly)),
	tagCoverage: [],
	fills: [],
	placeholderLifecyclesSkipped: 0,
});

/**
 * How many of {@link BOOTSTRAP_LIFECYCLES} truly-exhausted lifecycles each model
 * dates in {@link bootstrapFixture}, abstaining on the rest.
 *
 * Deliberately different per model. A fixture that fed every model the same
 * records would score them all identically, and every bootstrap pair would then
 * read zero however its records were labelled — so a producer that handed a
 * control's records to the pair labelled for the current model, or swapped the
 * two bases, would pass unnoticed.
 */
const BOOTSTRAP_DATED: Record<ReplayModel, number> = {
	current: 4,
	[VERDICT_BASIS_MODEL]: 8,
	[VERDICT_BASIS_CONTROL_MODEL]: 2,
	[PRIOR_BASIS_MODEL]: 3,
	[PRIOR_BASIS_CONTROL_MODEL]: 6,
	"scenario-headroom": 5,
};

const BOOTSTRAP_LIFECYCLES = 8;

/**
 * F1 of a model that dates `k` of `BOOTSTRAP_LIFECYCLES` exhaustions and
 * abstains on the rest: no false positive, `k` true positives and the remainder
 * false negatives, so `2k / (k + n)`.
 */
const f1OfDated = (dated: number): number =>
	(2 * dated) / (dated + BOOTSTRAP_LIFECYCLES);

const F1_OF = Object.fromEntries(
	Object.entries(BOOTSTRAP_DATED).map(([model, dated]) => [
		model,
		f1OfDated(dated),
	]),
) as Record<ReplayModel, number>;

/** One lifecycle per account, one instant each, every outcome an exhaustion. */
function bootstrapFixture(): RedistributionRecord[] {
	const out: RedistributionRecord[] = [];
	for (let index = 0; index < BOOTSTRAP_LIFECYCLES; index++) {
		const accountId = `acct-${index}`;
		for (const model of REPLAY_MODELS) {
			const dates = index < BOOTSTRAP_DATED[model];
			out.push(
				record({
					model,
					accountId,
					T: T0,
					...(dates ? {} : { predictsExhaust: false, predictedEtaMs: null }),
				}),
			);
		}
	}
	return out;
}

describe("scoreCohorts", () => {
	test("keeps one record per lifecycle, at the group's median instant", () => {
		const instants = [T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR];
		const balanced = lifecycleBalanced(perModel("A", instants));
		expect(balanced).toHaveLength(REPLAY_MODELS.length);
		// Four instants -> the LOWER median, so the pick is deterministic.
		expect(new Set(balanced.map((entry) => entry.T))).toEqual(
			new Set([T0 + HOUR]),
		);
	});

	test("the common cohort drops an instant one model could not answer", () => {
		const records = [
			...perModel("A", [T0, T0 + HOUR]),
			...perModel("B", [T0], {
				"scenario-headroom": () => ({
					usable: false,
					unusableReason: "insufficient_data",
				}),
			}),
		];
		const cohorts = scoreCohorts(replayOf(records));
		expect(cohorts.common.some((entry) => entry.accountId === "B")).toBe(false);
		expect(cohorts.overall.records).toBe(2);
	});

	test("pairs the bias only where both models committed to a date", () => {
		const records = perModel("A", [T0, T0 + HOUR], {
			"scenario-equal": (T) => ({ predictedEtaMs: T + DAY + 30 * MIN }),
		});
		records.push(
			...perModel("B", [T0], {
				current: () => ({ predictsExhaust: false, predictedEtaMs: null }),
			}),
		);
		const bias = pairedSignedMedian(records, "scenario-equal", "current");
		expect(bias.n).toBe(2);
		expect(bias.medianA).toBeCloseTo(30, 6);
		expect(bias.medianB).toBeCloseTo(0, 6);
	});

	test("scores the instants the current model withholds as a cohort of their own", () => {
		const records = perModel("A", [T0, T0 + HOUR], {
			current: () => ({
				learningAtT: true,
				usable: false,
				unusableReason: "low_confidence",
			}),
		});
		const cohorts = scoreCohorts(replayOf(records));
		expect(cohorts.overall.records).toBe(0);
		expect(cohorts.scenarioExtra.records).toBe(2);
		const current = cohorts.scenarioExtra.balanced.find(
			(row) => row.estimator === "current",
		);
		expect(current?.metrics.coverage.usable).toBe(0);
		const scenario = cohorts.scenarioExtra.balanced.find(
			(row) => row.estimator === "scenario-equal",
		);
		expect(scenario?.metrics.coverage.usable).toBeGreaterThan(0);
	});

	test("bootstraps by block without touching the records it scores", () => {
		const records = bootstrapFixture();
		const cohorts = scoreCohorts(replayOf(records));
		expect(records.every((entry) => entry.accountId.startsWith("acct-"))).toBe(
			true,
		);
		// Three statistics, two cohorts, and four (scenario, baseline) pairs: the
		// verdict basis against the current model and against its OWN
		// pre-correction scan, and the prior basis against the same two of its
		// own. The headroom rule carries no pair.
		expect(cohorts.bootstrap).toHaveLength(24);
		expect(
			cohorts.bootstrap.filter(
				(entry) => entry.label === OVERALL_BOOTSTRAP_LABEL,
			),
		).toHaveLength(12);
		expect(
			new Set(
				cohorts.bootstrap.map(
					(entry) => `${entry.scenario}::${entry.baseline}`,
				),
			),
		).toEqual(
			new Set([
				`${VERDICT_BASIS_MODEL}::current`,
				`${VERDICT_BASIS_MODEL}::${VERDICT_BASIS_CONTROL_MODEL}`,
				`${PRIOR_BASIS_MODEL}::current`,
				`${PRIOR_BASIS_MODEL}::${PRIOR_BASIS_CONTROL_MODEL}`,
			]),
		);
		expect(
			cohorts.bootstrap.some((entry) => entry.scenario === "scenario-headroom"),
		).toBe(false);
		expect(cohorts.bootstrap.map((entry) => entry.statistic)).toContain(
			"medianSignedErrorMinutes",
		);
	});

	test("labels each pair with the baseline whose records it actually resampled", () => {
		const cohorts = scoreCohorts(replayOf(bootstrapFixture()));
		const f1Delta = (
			scenario: ScenarioModel,
			baseline: ReplayModel,
		): number => {
			const entry = cohorts.bootstrap.find(
				(row) =>
					row.label === OVERALL_BOOTSTRAP_LABEL &&
					row.statistic === "f1" &&
					row.scenario === scenario &&
					row.baseline === baseline,
			);
			if (entry?.p50 == null) {
				throw new Error(`no f1 CI for ${scenario} against ${baseline}`);
			}
			return entry.p50;
		};

		// The four deltas the fixture's F1s imply, each with a sign and a size of
		// its own. Were a control's records handed to the pair labelled for the
		// current model — or either basis's to the other's — the number here would
		// land on one of the other three.
		expect(f1Delta(VERDICT_BASIS_MODEL, "current")).toBeCloseTo(
			F1_OF[VERDICT_BASIS_MODEL] - F1_OF.current,
			1,
		);
		expect(
			f1Delta(VERDICT_BASIS_MODEL, VERDICT_BASIS_CONTROL_MODEL),
		).toBeCloseTo(
			F1_OF[VERDICT_BASIS_MODEL] - F1_OF[VERDICT_BASIS_CONTROL_MODEL],
			1,
		);
		expect(f1Delta(PRIOR_BASIS_MODEL, "current")).toBeCloseTo(
			F1_OF[PRIOR_BASIS_MODEL] - F1_OF.current,
			1,
		);
		expect(f1Delta(PRIOR_BASIS_MODEL, PRIOR_BASIS_CONTROL_MODEL)).toBeCloseTo(
			F1_OF[PRIOR_BASIS_MODEL] - F1_OF[PRIOR_BASIS_CONTROL_MODEL],
			1,
		);

		// The signs, stated separately from the magnitudes: the basis beats both
		// of its baselines here and the prior basis loses to both of its own, so
		// no pair can be swapped for another without flipping one of them.
		expect(f1Delta(VERDICT_BASIS_MODEL, "current")).toBeGreaterThan(0.2);
		expect(
			f1Delta(VERDICT_BASIS_MODEL, VERDICT_BASIS_CONTROL_MODEL),
		).toBeGreaterThan(0.45);
		expect(f1Delta(PRIOR_BASIS_MODEL, "current")).toBeLessThan(-0.05);
		expect(f1Delta(PRIOR_BASIS_MODEL, PRIOR_BASIS_CONTROL_MODEL)).toBeLessThan(
			-0.2,
		);
	});
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const emptyMetrics = scoreRecords([]);
const metrics = (over: Partial<BacktestMetrics>): BacktestMetrics => ({
	...emptyMetrics,
	...over,
});

const NO_BIAS: PairedBias = { n: 0, medianA: null, medianB: null };
const _NO_ABS: PairedAbsDelta = { n: 0, medianDeltaMinutes: null };

/** One cohort's scores, from the pairs a test cares about. */
const cohort = (
	label: string,
	rows: Array<[ReplayModel, Partial<BacktestMetrics>]>,
	pairs: {
		biasVsCurrent?: Partial<Record<ScenarioModel, PairedBias>>;
		biasVsControl?: Partial<Record<ScenarioModel, PairedBias>>;
		absVsControl?: Partial<Record<ScenarioModel, PairedAbsDelta>>;
	} = {},
): CohortScores => {
	const biasVsCurrent = {} as Record<ScenarioModel, PairedBias>;
	for (const model of SCENARIO_MODEL_IDS) {
		biasVsCurrent[model] = pairs.biasVsCurrent?.[model] ?? NO_BIAS;
	}
	return {
		label,
		records: 10,
		lifecycles: 5,
		episodes: 2,
		balanced: rows.map(([model, over]) => ({
			estimator: model,
			metrics: metrics(over),
		})),
		perRecord: rows.map(([model, over]) => ({
			estimator: model,
			metrics: metrics(over),
		})),
		biasVsCurrent,
		biasVsControl: pairs.biasVsControl ?? {},
		absVsControl: pairs.absVsControl ?? {},
	};
};

function verdictFixture(options: {
	/** The VERDICT BASIS's numbers: `scenario-proportional`. */
	scenarioBias: number | null;
	currentBias: number | null;
	scenarioRecall: number | null;
	currentRecall: number | null;
	scenarioF1: number | null;
	currentF1: number | null;
	/** F1 of the basis's OWN pre-correction scan, criterion D's comparison. */
	originalF1?: number | null;
	originalRecall?: number | null;
	/** Paired median of |err basis| - |err basis control|, in minutes. */
	pairedAbsVsOriginal?: number | null;
	p97_5: number | null;
	/** p97.5 of the entry whose baseline is the basis's own control. */
	p97_5Original?: number | null;
	/** Drop the current-baseline bootstrap entry, leaving only the control one. */
	originalBaselineOnly?: boolean;
	unlabelled?: boolean;
	/** What the codex account's own event (and its record) is tagged with. */
	codexEvent?: "add" | "peer-exhaustion";
	/** Weekly windows the label horizon dropped, per `${tag}::${class}`. */
	pendingWeekly?: Record<string, number>;
	/**
	 * The codex weekly record exists and is tagged, but one model could not use
	 * it, so it never reaches the common cohort. Implies `unlabelled`.
	 */
	codexWithheld?: boolean;
	/** The PRIOR basis's numbers, which no criterion of the verdict reads. */
	priorBias?: number | null;
	priorF1?: number | null;
	priorAbsVsOriginal?: number | null;
	priorP97_5?: number | null;
	/** The prior basis's own pre-correction scan, its criterion D benchmark. */
	priorOriginalF1?: number | null;
}): { cohorts: CohortSet; replay: ReplayResult } {
	const transition = cohort(
		"Any transition",
		[
			["current", { recall: options.currentRecall, f1: options.currentF1 }],
			[
				PRIOR_BASIS_MODEL,
				{
					recall: options.scenarioRecall,
					f1: options.priorF1 === undefined ? 0.65 : options.priorF1,
				},
			],
			[
				PRIOR_BASIS_CONTROL_MODEL,
				{
					recall: options.originalRecall ?? 0.75,
					f1:
						options.priorOriginalF1 === undefined
							? 0.6
							: options.priorOriginalF1,
				},
			],
			["scenario-headroom", {}],
			[
				VERDICT_BASIS_MODEL,
				{ recall: options.scenarioRecall, f1: options.scenarioF1 },
			],
			[
				VERDICT_BASIS_CONTROL_MODEL,
				{
					recall: options.originalRecall ?? 0.75,
					f1: options.originalF1 === undefined ? 0.6 : options.originalF1,
				},
			],
		],
		{
			biasVsCurrent: {
				[VERDICT_BASIS_MODEL]: {
					n: 4,
					medianA: options.scenarioBias,
					medianB: options.currentBias,
				},
				[PRIOR_BASIS_MODEL]: {
					n: 4,
					medianA: options.priorBias === undefined ? -10 : options.priorBias,
					medianB: options.currentBias,
				},
			},
			biasVsControl: {
				[VERDICT_BASIS_MODEL]: {
					n: 4,
					medianA: options.scenarioBias,
					medianB: options.scenarioBias,
				},
			},
			absVsControl: {
				[VERDICT_BASIS_MODEL]: {
					n: 4,
					medianDeltaMinutes:
						options.pairedAbsVsOriginal === undefined
							? -3
							: options.pairedAbsVsOriginal,
				},
				[PRIOR_BASIS_MODEL]: {
					n: 4,
					medianDeltaMinutes:
						options.priorAbsVsOriginal === undefined
							? -2
							: options.priorAbsVsOriginal,
				},
			},
		},
	);
	const overall = cohort("Overall", []);
	// One `add` per servable class: the anthropic half is always labelled, the
	// codex half only when the fixture says so.
	const codexEvent = options.codexEvent ?? "add";
	const events: TransitionEvent[] = [
		{
			id: 1,
			kind: "add",
			atMs: T0,
			endsAtMs: T0 + DAY,
			demandClass: "anthropic",
			accountId: "N",
			accountName: "Claude-N",
			windowKind: null,
			detail: "created",
		},
		{
			id: 2,
			kind: codexEvent,
			atMs: T0,
			endsAtMs: T0 + DAY,
			demandClass: "codex",
			accountId: "X",
			accountName: "Codex-X",
			windowKind: codexEvent === "add" ? null : "seven_day",
			detail: codexEvent === "add" ? "created" : "hit 100",
		},
	];
	const weeklyRecord = record({
		model: "current",
		accountId: "A",
		T: T0,
		tags: ["add"],
	});
	const codexWeeklyRecord = record({
		model: "current",
		accountId: "X",
		T: T0,
		provider: "codex",
		tags: [codexEvent],
	});
	const cohorts: CohortSet = {
		overall,
		anyTransition: transition,
		byTag: [cohort("add", [])],
		peerExhaustionBySinceDeath: [],
		slopeTrajectory: [],
		churn: [],
		byClassAndKind: [],
		scenarioExtra: cohort("Scenario-only", []),
		bootstrap: [
			...(options.originalBaselineOnly
				? []
				: [
						{
							label: OVERALL_BOOTSTRAP_LABEL,
							statistic: "f1",
							scenario: VERDICT_BASIS_MODEL,
							baseline: "current" as const,
							p2_5: -0.1,
							p50: 0.01,
							p97_5: options.p97_5,
							samples: 1000,
						},
					]),
			{
				label: OVERALL_BOOTSTRAP_LABEL,
				statistic: "f1",
				scenario: VERDICT_BASIS_MODEL,
				baseline: VERDICT_BASIS_CONTROL_MODEL,
				p2_5: -0.4,
				p50: -0.3,
				p97_5:
					options.p97_5Original === undefined ? -0.2 : options.p97_5Original,
				samples: 1000,
			},
			{
				label: OVERALL_BOOTSTRAP_LABEL,
				statistic: "f1",
				scenario: PRIOR_BASIS_MODEL,
				baseline: "current" as const,
				p2_5: -0.15,
				p50: 0.02,
				p97_5: options.priorP97_5 === undefined ? 0.18 : options.priorP97_5,
				samples: 1000,
			},
		],
		common:
			options.unlabelled || options.codexWithheld
				? [weeklyRecord]
				: [weeklyRecord, codexWeeklyRecord],
	};
	// When the record is withheld it is still replayed by every model; one of
	// them just cannot score it, which is why it drops out of the common cohort.
	const withheldRecords = [
		codexWeeklyRecord,
		record({
			model: VERDICT_BASIS_MODEL,
			accountId: "X",
			T: T0,
			provider: "codex",
			tags: [codexEvent],
			usable: false,
			unusableReason: "low_confidence",
			predictsExhaust: false,
			predictedEtaMs: null,
		}),
		record({
			model: "scenario-headroom",
			accountId: "X",
			T: T0,
			provider: "codex",
			tags: [codexEvent],
		}),
	];
	return {
		cohorts,
		replay: replayOf(
			options.codexWithheld
				? [weeklyRecord, ...withheldRecords]
				: [weeklyRecord, codexWeeklyRecord],
			events,
			options.pendingWeekly,
		),
	};
}

const VERDICT_BASE = {
	scenarioBias: -20,
	currentBias: 40,
	scenarioRecall: 0.8,
	currentRecall: 0.6,
	scenarioF1: 0.7,
	currentF1: 0.5,
	p97_5: 0.2,
};

describe("evaluateVerdict", () => {
	const base = VERDICT_BASE;

	test("replace when every criterion passes", () => {
		const { cohorts, replay } = verdictFixture(base);
		const verdict = evaluateVerdict(cohorts, replay);
		expect(verdict.verdict).toBe("replace");
		expect(verdict.criteria.map((entry) => entry.id)).toEqual([
			"A",
			"B",
			"C",
			"D",
		]);
		expect(verdict.criteria.map((entry) => entry.pass)).toEqual([
			true,
			true,
			true,
			true,
		]);
		expect(verdict.provisional).toBe(false);
	});

	test("keeps the scenario when it is the more optimistic one", () => {
		const { cohorts, replay } = verdictFixture({
			...base,
			scenarioBias: 90,
			currentBias: 40,
		});
		const verdict = evaluateVerdict(cohorts, replay);
		expect(verdict.criteria[0].pass).toBe(false);
		expect(verdict.verdict).toBe("keep-scenario");
	});

	test("keeps the scenario when it recalls fewer real run-outs", () => {
		const { cohorts, replay } = verdictFixture({
			...base,
			scenarioRecall: 0.4,
		});
		expect(evaluateVerdict(cohorts, replay).criteria[0].pass).toBe(false);
	});

	test("keeps the scenario when its transition F1 is worse", () => {
		const { cohorts, replay } = verdictFixture({ ...base, scenarioF1: 0.2 });
		const verdict = evaluateVerdict(cohorts, replay);
		expect(verdict.criteria[1].pass).toBe(false);
		expect(verdict.verdict).toBe("keep-scenario");
	});

	test("keeps the scenario when the overall CI is entirely below zero", () => {
		const { cohorts, replay } = verdictFixture({ ...base, p97_5: -0.05 });
		const verdict = evaluateVerdict(cohorts, replay);
		expect(verdict.criteria[2].pass).toBe(false);
		expect(verdict.verdict).toBe("keep-scenario");
	});

	test("insufficient evidence when a number is missing and none fails", () => {
		const { cohorts, replay } = verdictFixture({ ...base, p97_5: null });
		const verdict = evaluateVerdict(cohorts, replay);
		expect(verdict.criteria[2].pass).toBeNull();
		expect(verdict.verdict).toBe("insufficient-evidence");
	});

	test("flags a cohort whose tagged weekly windows are still unfolding as provisional", () => {
		const { cohorts, replay } = verdictFixture({
			...base,
			unlabelled: true,
			// Two tagged codex weekly windows were dropped by the label horizon, so
			// a later `--to` is exactly what labels this pair.
			pendingWeekly: { "add::codex": 2 },
		});
		const verdict = evaluateVerdict(cohorts, replay);
		expect(verdict.provisional).toBe(true);
		// Per (tag, class): the labelled anthropic half must not cover for the
		// codex half of the same tag.
		expect(verdict.pendingCohorts).toEqual(["add (codex)"]);
		expect(verdict.unlabelledCohorts).toEqual([]);
	});

	test("a lone account's peer exhaustion is unlabelled, not pending", () => {
		// The Codex-1 case: the dying account is excluded from its own event and
		// there is no sibling to carry the tag, so nothing was ever dropped for a
		// later run to pick up.
		const { cohorts, replay } = verdictFixture({
			...base,
			unlabelled: true,
			codexEvent: "peer-exhaustion",
		});
		const verdict = evaluateVerdict(cohorts, replay);
		expect(verdict.unlabelledCohorts).toEqual(["peer-exhaustion (codex)"]);
		expect(verdict.pendingCohorts).toEqual([]);
		expect(verdict.provisional).toBe(false);
	});

	test("keeps the scenario when the correction scores worse than the original", () => {
		const worseF1 = verdictFixture({
			...base,
			scenarioF1: 0.5,
			originalF1: 0.6,
		});
		const byF1 = evaluateVerdict(worseF1.cohorts, worseF1.replay);
		expect(byF1.criteria[3].pass).toBe(false);
		expect(byF1.verdict).toBe("keep-scenario");

		// Same F1, but the corrected ETAs are further from the truth.
		const worseError = verdictFixture({
			...base,
			originalF1: base.scenarioF1,
			pairedAbsVsOriginal: 4,
		});
		const byError = evaluateVerdict(worseError.cohorts, worseError.replay);
		expect(byError.criteria[3].pass).toBe(false);
		expect(byError.verdict).toBe("keep-scenario");
	});

	test("criterion D is indeterminate when a number is missing", () => {
		const { cohorts, replay } = verdictFixture({
			...base,
			pairedAbsVsOriginal: null,
		});
		const verdict = evaluateVerdict(cohorts, replay);
		expect(verdict.criteria[3].pass).toBeNull();
		expect(verdict.verdict).toBe("insufficient-evidence");
	});

	test("criterion D prints both recalls without deciding on them", () => {
		const { cohorts, replay } = verdictFixture({
			...base,
			scenarioRecall: 0.8,
			originalRecall: 0.9,
		});
		const verdict = evaluateVerdict(cohorts, replay);
		const names = verdict.criteria[3].values.map((value) => value.name);
		expect(names).toContain(`recall, ${VERDICT_BASIS_MODEL}`);
		expect(names).toContain(`recall, ${VERDICT_BASIS_CONTROL_MODEL}`);
		// A worse recall than the original does not fail D: an ETA moved earlier
		// never leaves the before-reset set.
		expect(verdict.criteria[3].pass).toBe(true);
	});

	test("the verdict is computed on the proportional basis, not the equal split", () => {
		// The two scans differ everywhere they can: the basis is pessimistic by 20
		// minutes on transitions, the prior basis optimistic by 90, and the prior
		// basis's own F1 and CI would fail B and C if the verdict read them.
		const { cohorts, replay } = verdictFixture({
			...base,
			scenarioBias: -20,
			priorBias: 90,
			priorF1: 0.1,
			priorP97_5: -0.5,
		});
		const verdict = evaluateVerdict(cohorts, replay);
		const criterionA = verdict.criteria[0];
		expect(criterionA.values[0].name).toBe(
			`paired median signed error, ${VERDICT_BASIS_MODEL} (min)`,
		);
		expect(criterionA.values[0].value).toBe(-20);
		expect(criterionA.values.map((value) => value.value)).not.toContain(90);
		expect(verdict.criteria.map((entry) => entry.pass)).toEqual([
			true,
			true,
			true,
			true,
		]);
		expect(verdict.verdict).toBe("replace");

		// And criterion D reads the basis's OWN control: worsening the prior
		// basis's control changes nothing, worsening the basis's own fails it.
		const priorControl = verdictFixture({ ...base, priorOriginalF1: 0.99 });
		expect(
			evaluateVerdict(priorControl.cohorts, priorControl.replay).criteria[3]
				.pass,
		).toBe(true);
		const ownControl = verdictFixture({ ...base, originalF1: 0.99 });
		expect(
			evaluateVerdict(ownControl.cohorts, ownControl.replay).criteria[3].pass,
		).toBe(false);
	});

	test("criterion C reads the CURRENT-baseline bootstrap entry only", () => {
		// The control-baseline entry is entirely below zero; C must not see it.
		const { cohorts, replay } = verdictFixture({
			...base,
			p97_5Original: -0.2,
		});
		expect(evaluateVerdict(cohorts, replay).criteria[2].pass).toBe(true);

		const originalOnly = verdictFixture({
			...base,
			originalBaselineOnly: true,
		});
		const verdict = evaluateVerdict(originalOnly.cohorts, originalOnly.replay);
		expect(verdict.criteria[2].pass).toBeNull();
		expect(verdict.verdict).toBe("insufficient-evidence");
	});

	test("a tag labelled in every class it has events in is not provisional", () => {
		const { cohorts, replay } = verdictFixture(base);
		const verdict = evaluateVerdict(cohorts, replay);
		expect(verdict.pendingCohorts).toEqual([]);
		expect(verdict.unlabelledCohorts).toEqual([]);
		expect(verdict.provisional).toBe(false);
	});
});

describe("knownLimitsFor", () => {
	test("states a dominant class with its measured share", () => {
		// `unlabelled` drops the codex record, leaving the common cohort entirely
		// anthropic.
		const { cohorts, replay } = verdictFixture({
			...VERDICT_BASE,
			unlabelled: true,
		});
		const limits = knownLimitsFor(
			replay,
			cohorts,
			evaluateVerdict(cohorts, replay),
		);
		expect(limits).toContain(
			"`anthropic` supplies 100.0 % of the overall common-cohort records.",
		);
	});

	test("says nothing about dominance when the classes are balanced", () => {
		const { cohorts, replay } = verdictFixture(VERDICT_BASE);
		const limits = knownLimitsFor(
			replay,
			cohorts,
			evaluateVerdict(cohorts, replay),
		);
		expect(
			limits.some((limit) => limit.includes("of the overall common-cohort")),
		).toBe(false);
	});

	test("states what a learning window withholds, not what it lacks", () => {
		// A learning window can carry a positive fitted slope; what the scenario
		// does with it is refuse the contribution, and that is the policy to
		// state.
		const { cohorts, replay } = verdictFixture(VERDICT_BASE);
		const limits = knownLimitsFor(
			replay,
			cohorts,
			evaluateVerdict(cohorts, replay),
		);
		const basisLimit = limits.find((limit) =>
			limit.startsWith("The verdict basis weights each account"),
		);
		expect(basisLimit).toContain(
			"has no accepted measured-demand contribution",
		);
		expect(basisLimit).not.toContain("has no slope");
		// The rule's own declaration: the survivors are the denominator.
		expect(basisLimit).toContain(
			"The denominator is the survivors, not the class",
		);
		expect(basisLimit).not.toContain(
			"over the class's measured demand for that kind",
		);
		const headroomLimit = limits.find((limit) =>
			limit.startsWith("The headroom share rule"),
		);
		expect(headroomLimit).toContain(
			"The verdict basis is the proportional share rule, re-declared on 2026-09-07",
		);
		expect(headroomLimit).toContain("the basis through v2026.9.19");
	});
});

/** One report, from parts the caller controls. */
function reportOf(
	result: ReplayResult,
	cohorts: CohortSet,
	verdict: Verdict,
	rows: number,
	absorption: AbsorptionChecks | null = null,
): string {
	return formatRedistributionReport({
		title: "Redistribution backtest",
		generatedAtIso: new Date(T0).toISOString(),
		command: "bun scripts/redistribution-backtest.ts",
		config: { stepMinutes: result.stepMinutes, seed: result.seed },
		dataset: {
			rows,
			accounts: 2,
			providers: ["anthropic"],
			firstSampleIso: new Date(T0 - DAY).toISOString(),
			lastSampleIso: new Date(T0 + 6 * DAY).toISOString(),
		},
		replay: result,
		cohorts,
		verdict,
		absorption,
		knownLimits: ["a limit"],
		notes: ["a note"],
	});
}

/** The report for a replay, with the verdict it was rendered from. */
function reportFor(
	result: ReplayResult,
	snapshotRows: RosterSnapshotRow[],
): { markdown: string; verdict: Verdict } {
	const cohorts = scoreCohorts(result);
	const verdict = evaluateVerdict(cohorts, result);
	return {
		verdict,
		markdown: reportOf(result, cohorts, verdict, snapshotRows.length),
	};
}

/** The claim the section used to make unconditionally, whatever the grid said. */
const OLD_FIXED_SENTENCE = "no multi-account class was ever observed all-out";

describe("formatRedistributionReport", () => {
	test("writes every section, states the verdict, and never prints a hole", () => {
		const fixture = pairFixture();
		const range: ReplayRange = {
			label: "test",
			fromMs: T0,
			toMs: T0 + 8 * DAY,
		};
		const named = fixture.accounts.map((entry) => ({
			...entry,
			name: `Claude-${entry.accountId}`,
		}));
		const result = replayRange(fixture.rows, named, range, 6 * 60, 20260823);
		const { markdown, verdict } = reportFor(result, fixture.rows);

		const headings = [
			"# Redistribution backtest",
			"## Dataset",
			"## Methodology",
			"## Transition events",
			"## Scores",
			"### Overall",
			"### Any transition",
			"### Peer exhaustion by time since death",
			"### By class and window",
			"### Scenario-only cohort",
			"### Bootstrap",
			"## Pool calibration (all-out within 14 d)",
			"## Verdict",
			"### Identity with the current model on the first assignment",
			"## Share rules beside the basis",
			`### \`${PRIOR_BASIS_MODEL}\``,
			"### `scenario-headroom`",
			"## Known limits",
			"## Notes",
		];
		for (const heading of headings) {
			expect(markdown).toContain(heading);
		}
		// And in that order: the identity is part of the verdict, the rules
		// scored beside it come after it and before the limits.
		expect(headings.map((heading) => markdown.indexOf(heading))).toEqual(
			[...headings.map((heading) => markdown.indexOf(heading))].sort(
				(a, b) => a - b,
			),
		);
		expect(markdown).toContain(`**Verdict: ${verdict.verdict}**`);
		expect(markdown).not.toContain("undefined");
		expect(markdown).not.toContain("NaN");
		// The transition table names the account rather than printing its id.
		expect(markdown).toContain("| Claude-B |");
		// Both accounts read 100 % together, so the section prints the episode
		// instead of asserting there was none.
		expect(result.allOutIntervals.length).toBeGreaterThan(0);
		const interval = result.allOutIntervals[0];
		expect(markdown).toContain(
			`- \`anthropic\`: all-out \`${new Date(interval.fromMs).toISOString()}\`–\`${new Date(interval.toMs).toISOString()}\` (\`${interval.ticks}\` ticks)`,
		);
		expect(markdown).toContain(
			"These intervals are the positives behind the `observed out` column",
		);
		expect(markdown).not.toContain(OLD_FIXED_SENTENCE);
	});

	test("states the absence of all-out ticks from the grid, not from a fixed claim", () => {
		const start = T0 - DAY;
		const step = 12 * HOUR;
		const range: ReplayRange = {
			label: "grid",
			fromMs: T0,
			toMs: T0 + 16 * DAY,
		};
		const snapshotRows = [
			...rows({
				accountId: "A",
				from: start,
				to: T0 + 16 * DAY,
				stepMs: step,
				sevenDay: weekly(start, 8, 95),
			}),
			...rows({
				accountId: "B",
				from: start,
				to: T0 + 16 * DAY,
				stepMs: step,
				sevenDay: weekly(start, 9, 95),
			}),
		];
		const accounts = [account("A"), account("B")];
		const result = replayRange(snapshotRows, accounts, range, step / MIN, 7);
		const { markdown } = reportFor(result, snapshotRows);

		expect(result.allOutIntervals).toEqual([]);
		expect(markdown).toContain(
			"- `anthropic`: no all-out tick observed in the interval",
		);
		expect(markdown).toContain(
			"These intervals are the positives behind the `observed out` column",
		);
		expect(markdown).not.toContain(OLD_FIXED_SENTENCE);
	});

	test("prescribes a re-run only for the cohorts a re-run can label", () => {
		const pending = verdictFixture({
			...VERDICT_BASE,
			unlabelled: true,
			pendingWeekly: { "add::codex": 2 },
		});
		const pendingVerdict = evaluateVerdict(pending.cohorts, pending.replay);
		const pendingMarkdown = reportOf(
			pending.replay,
			pending.cohorts,
			pendingVerdict,
			10,
		);
		expect(pendingMarkdown).toContain(
			"PROVISIONAL: the add (codex) pair holds no usable, uncensored weekly record common to all models, and it carries at least one tagged weekly window still pending at the label horizon",
		);
		expect(pendingMarkdown).not.toContain(
			"No usable, uncensored weekly records common to all models for:",
		);

		const structural = verdictFixture({
			...VERDICT_BASE,
			unlabelled: true,
			codexEvent: "peer-exhaustion",
		});
		const structuralVerdict = evaluateVerdict(
			structural.cohorts,
			structural.replay,
		);
		const structuralMarkdown = reportOf(
			structural.replay,
			structural.cohorts,
			structuralVerdict,
			10,
		);
		expect(structuralMarkdown).toContain(
			"No usable, uncensored weekly records common to all models for: peer-exhaustion (codex). No weekly window of that pair is pending at the label horizon; missing evidence can reflect absent tagged survivors, withheld predictions, or censored truth.",
		);
		expect(structuralMarkdown).not.toContain("PROVISIONAL:");

		// Neither sentence when every pair is labelled.
		const labelled = verdictFixture(VERDICT_BASE);
		const labelledVerdict = evaluateVerdict(labelled.cohorts, labelled.replay);
		const labelledMarkdown = reportOf(
			labelled.replay,
			labelled.cohorts,
			labelledVerdict,
			10,
		);
		expect(labelledMarkdown).toContain(
			"No pending or unlabelled transition tag/class pairs were identified.",
		);
		expect(labelledMarkdown).not.toContain("PROVISIONAL:");
		expect(labelledMarkdown).not.toContain(
			"No usable, uncensored weekly records common to all models for:",
		);
	});

	test("a withheld tagged weekly record is structural, not pending", () => {
		// The record exists and carries the tag, but `scenario-equal` had to
		// withhold it, so the pair has no weekly evidence common to all models —
		// and nothing is pending, so a later `--to` changes nothing.
		const withheld = verdictFixture({
			...VERDICT_BASE,
			codexWithheld: true,
		});
		const withheldVerdict = evaluateVerdict(withheld.cohorts, withheld.replay);
		expect(withheldVerdict.unlabelledCohorts).toEqual(["add (codex)"]);
		expect(withheldVerdict.pendingCohorts).toEqual([]);
		const withheldMarkdown = reportOf(
			withheld.replay,
			withheld.cohorts,
			withheldVerdict,
			10,
		);
		expect(withheldMarkdown).toContain(
			"No usable, uncensored weekly records common to all models for: add (codex). No weekly window of that pair is pending at the label horizon; missing evidence can reflect absent tagged survivors, withheld predictions, or censored truth.",
		);
		expect(withheldMarkdown).not.toContain("PROVISIONAL:");
	});
});

// ---------------------------------------------------------------------------
// Fine since-death buckets, slope trajectory, churn, per-record dump
// ---------------------------------------------------------------------------

/**
 * One record per model, tagged `peer-exhaustion`, at a given age since the
 * death. Each (account, windowKind) is its own lifecycle, exactly as
 * `replayInstant` builds them.
 */
function peerPerModel(options: {
	accountId: string;
	windowKind: "five_hour" | "seven_day";
	/** Minutes since the death, one record per entry. */
	sinceDeathMinutes: number[];
	deathAtMs?: number;
	/** Current-model slope at each instant, parallel to `sinceDeathMinutes`. */
	slopes?: (number | null)[];
	etaOffsetMinutes?: (index: number) => number;
	predictsExhaust?: (index: number) => boolean;
}): RedistributionRecord[] {
	const deathAtMs = options.deathAtMs ?? T0;
	const out: RedistributionRecord[] = [];
	options.sinceDeathMinutes.forEach((age, index) => {
		const T = deathAtMs + age * MIN;
		for (const model of REPLAY_MODELS) {
			const predicts = options.predictsExhaust?.(index) ?? true;
			out.push(
				record({
					model,
					accountId: options.accountId,
					T,
					windowKind: options.windowKind,
					lifecycleId: `${options.accountId}::${options.windowKind}::0`,
					tags: ["peer-exhaustion"],
					eventIds: [1],
					sinceDeathMs: T - deathAtMs,
					slopePctPerHour: options.slopes?.[index] ?? null,
					predictsExhaust: predicts,
					predictedEtaMs: predicts
						? T + DAY + (options.etaOffsetMinutes?.(index) ?? 0) * MIN
						: null,
					outcome: { kind: "exhausted", atMs: T + DAY },
				}),
			);
		}
	});
	return out;
}

describe("the share rules beside the basis", () => {
	const besideFixture = (): {
		markdown: string;
		verdict: Verdict;
		beside: BesideBasisScores[];
		identity: ReturnType<typeof basisIdentityCheck>;
		replay: ReplayResult;
		cohorts: CohortSet;
	} => {
		const fixture = pairFixture();
		const replay = replayRange(
			fixture.rows,
			fixture.accounts,
			RANGE,
			6 * 60,
			20260823,
		);
		const cohorts = scoreCohorts(replay);
		const verdict = evaluateVerdict(cohorts, replay);
		return {
			markdown: reportOf(replay, cohorts, verdict, fixture.rows.length),
			verdict,
			beside: evaluateBesideBasis(cohorts),
			identity: basisIdentityCheck(replay),
			replay,
			cohorts,
		};
	};

	/** The section itself, without the mentions of it elsewhere in the report. */
	const sectionOf = (markdown: string): string => {
		const from = markdown.indexOf("\n## Share rules beside the basis\n");
		expect(from).toBeGreaterThan(-1);
		return markdown.slice(from, markdown.indexOf("\n## Known limits\n"));
	};

	/** The verdict section, up to the rules scored beside it. */
	const verdictSectionOf = (markdown: string): string =>
		markdown.slice(
			markdown.indexOf("\n## Verdict\n"),
			markdown.indexOf("\n## Share rules beside the basis\n"),
		);

	test("states beside criterion D what it compares and which leg decided it", () => {
		const sectionFor = (options: Parameters<typeof verdictFixture>[0]) => {
			const fixture = verdictFixture(options);
			const verdict = evaluateVerdict(fixture.cohorts, fixture.replay);
			const markdown = reportOf(fixture.replay, fixture.cohorts, verdict, 2);
			return markdown.slice(
				markdown.indexOf("\n## Verdict\n"),
				markdown.indexOf("\n## Share rules beside the basis\n"),
			);
		};

		const failing = sectionFor({
			...VERDICT_BASE,
			scenarioF1: 0.5,
			originalF1: 0.6,
		});
		// What D is a comparison OF, beside the criterion rather than left to the
		// pre-declared rule: the basis against its own uncorrected scan.
		expect(failing).toContain(
			`D compares \`${VERDICT_BASIS_MODEL}\` with its OWN lag-uncorrected scan, \`${VERDICT_BASIS_CONTROL_MODEL}\``,
		);
		expect(failing).toContain(
			`it does not compare the proportional rule with the equal split, and no number in it is a statement about \`${PRIOR_BASIS_MODEL}\``,
		);
		// The failing leg, its two numbers, the shortfall and the population.
		expect(failing).toContain(
			"Its F1 leg is the one that FAILED this run: 0.500 against the control's 0.600 on the lifecycle-balanced any-transition cohort, short by 0.100",
		);
		expect(failing).toContain("Its error leg holds");
		expect(failing).not.toContain("Its error leg FAILED");

		// The other leg failing is reported as that leg, not as D's F1.
		const byError = sectionFor({
			...VERDICT_BASE,
			originalF1: VERDICT_BASE.scenarioF1,
			pairedAbsVsOriginal: 4,
		});
		expect(byError).toContain("Its F1 leg holds");
		// "too" would claim a second failure beside a leg that held.
		expect(byError).toContain("Its error leg FAILED: the correction landed");
		expect(byError).not.toContain("FAILED too");
		expect(byError).toContain("4.000 min further from the truth");

		// Both legs failing is the one case that reads as "too".
		const byBoth = sectionFor({
			...VERDICT_BASE,
			scenarioF1: 0.5,
			originalF1: 0.6,
			pairedAbsVsOriginal: 4,
		});
		expect(byBoth).toContain("Its F1 leg is the one that FAILED this run");
		expect(byBoth).toContain("Its error leg FAILED too: the correction landed");

		// The rule itself stays free of every number this run produced.
		expect(VERDICT_RULE).not.toMatch(/0\.\d/);
	});

	test("says which pairing each of criterion A's columns is a median over", () => {
		const section = sectionOf(besideFixture().markdown);

		// The table puts medians from three populations side by side, so the
		// section has to say so: without it the basis's column reads as this
		// rule's comparator, which it is not.
		expect(section).toContain(
			"A paired median is taken over the records the pair being compared BOTH dated",
		);
		expect(section).toContain(
			"The scored rule's column and the `current` column come from that rule's own pairing with the current model",
		);
		expect(section).toContain(
			`the \`${VERDICT_BASIS_MODEL}\` column comes from the BASIS's pairing with the current model`,
		);
		expect(section).toContain("Each pairing's `paired n` is in the value list");
	});

	test("renders the prior basis and the headroom rule, four criteria each", () => {
		const { markdown, beside } = besideFixture();
		const section = sectionOf(markdown);

		// Placed between the verdict and the known limits, and named for what it
		// holds rather than for one candidate.
		expect(markdown.indexOf("\n## Verdict\n")).toBeLessThan(
			markdown.indexOf("\n## Share rules beside the basis\n"),
		);
		expect(
			markdown.indexOf("\n## Share rules beside the basis\n"),
		).toBeLessThan(markdown.indexOf("\n## Known limits\n"));
		expect(section).toContain("NONE of it enters the verdict");
		expect(section).toContain(
			`\`${PRIOR_BASIS_MODEL}\` is here because it WAS the verdict basis through v2026.9.19`,
		);

		expect(beside.map((entry) => entry.model)).toEqual([
			PRIOR_BASIS_MODEL,
			"scenario-headroom",
		]);
		for (const entry of beside) {
			expect(entry.criteria.map((criterion) => criterion.id)).toEqual([
				"A",
				"B",
				"C",
				"D",
			]);
			expect(section).toContain(`### \`${entry.model}\``);
			for (const row of entry.rows) {
				expect(section).toContain(`| ${row.id}. ${row.label} |`);
			}
		}
		expect(section).not.toContain("undefined");
		expect(section).not.toContain("NaN");
		expect(markdown).not.toContain("undefined");
		expect(markdown).not.toContain("NaN");
	});

	test("the prior basis is judged against its OWN pre-correction control", () => {
		const { markdown, beside } = besideFixture();
		const section = sectionOf(markdown);
		const prior = beside[0];
		expect(prior.control).toBe(PRIOR_BASIS_CONTROL_MODEL);
		expect(section).toContain(
			`| criterion | statistic | ${PRIOR_BASIS_MODEL} | ${VERDICT_BASIS_MODEL} | current | ${PRIOR_BASIS_CONTROL_MODEL} | result |`,
		);
		// D turns on two statistics, so it has a row for each: the F1 comparison
		// against its own control, and the error change it is judged on beside it.
		const dRows = prior.rows.filter((row) => row.id === "D");
		expect(dRows.map((row) => row.statistic)).toEqual([
			"F1 on transitions",
			"paired median absolute-error change against its own pre-correction scan (min)",
		]);
		expect(dRows[0].control).not.toBeNull();
		expect(dRows[1].control).toBeNull();
		expect(dRows[0].pass).toBe(dRows[1].pass);
		expect(prior.criteria[3].values.map((value) => value.name)).toContain(
			`F1, ${PRIOR_BASIS_CONTROL_MODEL}`,
		);
		expect(prior.notes).toEqual([]);
	});

	test("the headroom rule's D is indeterminate, with the reason printed", () => {
		const { markdown, beside } = besideFixture();
		const headroom = beside[1];
		expect(headroom.model).toBe("scenario-headroom");
		expect(headroom.control).toBeNull();
		const dRows = headroom.rows.filter((row) => row.id === "D");
		expect(dRows.every((row) => row.pass === null)).toBe(true);
		expect(dRows[0].control).toBeNull();
		expect(
			headroom.criteria.find((criterion) => criterion.id === "D")?.pass,
		).toBeNull();
		expect(headroom.notes.join(" ")).toContain(
			"D is indeterminate: `scenario-headroom` has no pre-correction scan of its own",
		);
		// C too: it is defined on a bootstrap pair only the two bases carry.
		expect(
			headroom.criteria.find((criterion) => criterion.id === "C")?.pass,
		).toBeNull();
		expect(headroom.notes.join(" ")).toContain("C is indeterminate");

		const section = sectionOf(markdown);
		expect(section).toContain("INDETERMINATE");
		expect(section).toContain(
			"has no pre-correction scan of its own in this replay",
		);
		expect(section).not.toContain("undefined");
		expect(section).not.toContain("NaN");
	});

	test("the identity line renders under the verdict, on the basis", () => {
		// Two accounts and no death before either window is projected on the
		// scan's first assignment: the basis IS the current model there.
		const { markdown, identity } = besideFixture();
		expect(identity.eligible).toBeGreaterThan(0);
		expect(identity.matching).toBe(identity.eligible);
		expect(identity.share).toBe(1);
		const verdictSection = verdictSectionOf(markdown);
		expect(verdictSection).toContain(
			"### Identity with the current model on the first assignment",
		);
		expect(verdictSection).toContain(
			`n=${identity.eligible} eligible records, ${identity.matching} of which the basis dated within 1 ms of the current model (100.0%)`,
		);
		// And nowhere else: it is a property of the basis, not of the rules
		// scored beside it.
		expect(sectionOf(markdown)).not.toContain(
			"### Identity with the current model on the first assignment",
		);
	});

	test("the numbers beside the basis do not move the verdict", () => {
		// The same replay twice, differing only in what the PRIOR BASIS answered:
		// once as it scans, once wrong by a week.
		const fixture = pairFixture();
		const replay = replayRange(
			fixture.rows,
			fixture.accounts,
			RANGE,
			6 * 60,
			20260823,
		);
		const wrecked: ReplayResult = {
			...replay,
			records: replay.records.map((entry) =>
				entry.model === PRIOR_BASIS_MODEL && entry.predictedEtaMs != null
					? { ...entry, predictedEtaMs: entry.predictedEtaMs + 7 * DAY }
					: entry,
			),
		};
		const verdictOf = (result: ReplayResult): Verdict =>
			evaluateVerdict(scoreCohorts(result), result);

		const before = verdictOf(replay);
		const after = verdictOf(wrecked);
		expect(after.verdict).toBe(before.verdict);
		expect(after.criteria).toEqual(before.criteria);
		expect(
			verdictSectionOf(
				reportOf(wrecked, scoreCohorts(wrecked), after, fixture.rows.length),
			),
		).toBe(
			verdictSectionOf(
				reportOf(replay, scoreCohorts(replay), before, fixture.rows.length),
			),
		);
		// The prior basis's own scoring DID move, so the check is not vacuous.
		expect(
			evaluateBesideBasis(scoreCohorts(wrecked))[0].rows[0].value,
		).not.toBe(evaluateBesideBasis(scoreCohorts(replay))[0].rows[0].value);
	});

	test("the identity population excludes instants a class member is already dead at", () => {
		const { replay } = besideFixture();
		const eligible = replay.records.filter(
			(entry) =>
				entry.model === VERDICT_BASIS_MODEL && entry.basisFirstAssignment,
		);
		expect(eligible.length).toBeGreaterThan(0);
		// B reads 100 % from early on day 1; nothing at or after that instant is
		// on a first assignment of own slopes, because A carries B's demand from
		// the start of every scan there.
		const deathAt = Math.min(
			...replay.records
				.filter(
					(entry) =>
						entry.accountId === "B" && entry.outcome.kind === "exhausted",
				)
				.map((entry) =>
					entry.outcome.kind === "exhausted"
						? entry.outcome.atMs
						: Number.POSITIVE_INFINITY,
				),
		);
		expect(eligible.every((entry) => entry.T < deathAt)).toBe(true);
		expect(basisIdentityCheck(replay).eligible).toBeLessThanOrEqual(
			eligible.length,
		);
	});

	/** One instant of a hand-built roster, every model's records. */
	const instantOf = (
		snapshotRows: RosterSnapshotRow[],
		accounts: RosterAccount[],
		toMs = T0 + 8 * DAY,
	): ReturnType<typeof replayInstant> =>
		replayInstant(
			T0,
			buildRosterAtInstant(T0, prepareSeries(snapshotRows, accounts), accounts),
			[],
			{ label: "test", fromMs: T0, toMs },
		);

	const weeklyRecordOf = (
		replay: ReturnType<typeof replayInstant>,
		accountId: string,
		model: ReplayModel,
	): RedistributionRecord | undefined =>
		replay.records.find(
			(entry) =>
				entry.accountId === accountId &&
				entry.windowKind === "seven_day" &&
				entry.model === model,
		);

	test("the identity population excludes an instant whose demand was withheld from the assignment", () => {
		// B's zero-usage five-hour window is a kind the class never measured, so
		// the strict unmeasured rule withholds B from the assignment. B's WEEKLY
		// burn is in the class demand all the same, and A is handed every bit of
		// it at the first assignment — nobody is exhausted, nothing dies, and the
		// two models still disagree.
		const aStart = T0 - 3 * DAY;
		const bStart = T0 - 2 * DAY;
		const fiveStart = T0 - 4 * HOUR;
		const replay = instantOf(
			[
				...rows({
					accountId: "A",
					from: aStart,
					to: T0,
					sevenDay: weekly(aStart, 20),
				}),
				...rows({
					accountId: "B",
					from: bStart,
					to: T0,
					sevenDay: weekly(bStart, 25),
					fiveHour: () => ({ pct: 0, reset: fiveStart + 5 * HOUR }),
				}),
			],
			[account("A"), account("B")],
		);
		const scan = replay.classes[0].scenarioOutcomes.get(VERDICT_BASIS_MODEL);
		expect(
			scan != null && "learningAccountIds" in scan
				? (scan.learningAccountIds ?? [])
				: [],
		).toEqual(["B"]);

		// A's own burn is 20 %/d, so the current model dates it 48 h out; carrying
		// the class's whole 37.5 units/h it fills in 21⅓ h.
		expect(weeklyRecordOf(replay, "A", "current")?.predictedEtaMs).toBeCloseTo(
			T0 + 48 * HOUR,
			-4,
		);
		expect(
			weeklyRecordOf(replay, "A", VERDICT_BASIS_MODEL)?.predictedEtaMs,
		).toBeCloseTo(T0 + (64 / 3) * HOUR, -4);
		expect(
			weeklyRecordOf(replay, "A", VERDICT_BASIS_MODEL)?.basisFirstAssignment,
		).toBe(false);
	});

	test("the identity population excludes a class death in a later cycle", () => {
		// A alone. Its five-hour window was refunded 90 minutes ago and has burned
		// 30 %/h since, so it reads 45 % and is projected past the reset an hour
		// out: it never fills in the cycle the reading is from, and
		// `projectedExhaustions` — first cycles only — has no entry for it. EVERY
		// later five-hour cycle fills in 3⅓ h and then holds the account dead for
		// the rest of it, which suspends the weekly burn: the basis dates the
		// weekly 34 h out where the current model, holding one slope, says 24 h.
		const weeklyStart = T0 - 4 * DAY;
		const fiveReset = T0 + HOUR;
		const dropAt = T0 - 90 * MIN;
		const cycleStartOf = (t: number): number =>
			fiveReset -
			5 * HOUR +
			Math.floor((t - (fiveReset - 5 * HOUR)) / (5 * HOUR)) * 5 * HOUR;
		const replay = instantOf(
			rows({
				accountId: "A",
				from: T0 - DAY,
				to: T0,
				sevenDay: weekly(weeklyStart, 20),
				fiveHour: (t) => ({
					pct:
						t >= dropAt
							? ((t - dropAt) / HOUR) * 30
							: Math.min(60, ((t - cycleStartOf(t)) / HOUR) * 20),
					reset: cycleStartOf(t) + 5 * HOUR,
				}),
			}),
			[account("A")],
			T0 + 10 * DAY,
		);
		const scan = replay.classes[0].scenarioOutcomes.get(VERDICT_BASIS_MODEL);
		// The death the first-cycle list cannot carry: only the weekly is in it.
		expect(scan?.projectedExhaustions.map((entry) => entry.windowKind)).toEqual(
			["seven_day"],
		);

		expect(weeklyRecordOf(replay, "A", "current")?.predictedEtaMs).toBeCloseTo(
			T0 + 24 * HOUR,
			-4,
		);
		expect(
			weeklyRecordOf(replay, "A", VERDICT_BASIS_MODEL)?.predictedEtaMs,
		).toBeCloseTo(T0 + 34 * HOUR, -4);
		expect(
			weeklyRecordOf(replay, "A", VERDICT_BASIS_MODEL)?.basisFirstAssignment,
		).toBe(false);
	});
});

describe("SINCE_DEATH_BUCKETS", () => {
	test("are the eight fine buckets, contiguous and open at the top", () => {
		expect(SINCE_DEATH_BUCKETS.map((bucket) => bucket.label)).toEqual([
			"0-30m",
			"30-60m",
			"1-2h",
			"2-3h",
			"3-4h",
			"4-6h",
			"6-12h",
			"12-24h",
		]);
		const bounds = SINCE_DEATH_BUCKETS.map((bucket) => bucket.maxMs);
		expect(bounds.slice(0, -1)).toEqual([
			30 * MIN,
			HOUR,
			2 * HOUR,
			3 * HOUR,
			4 * HOUR,
			6 * HOUR,
			12 * HOUR,
		]);
		// The transition shadow is 24 h, so the last bucket cannot lose a record.
		expect(bounds[bounds.length - 1]).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("peer exhaustion by since-death bucket, per window kind", () => {
	test("splits the fine buckets and reports combined plus each window kind", () => {
		const records = [
			...peerPerModel({
				accountId: "A",
				windowKind: "five_hour",
				sinceDeathMinutes: [10, 45, 90],
			}),
			...peerPerModel({
				accountId: "B",
				windowKind: "seven_day",
				sinceDeathMinutes: [20, 200, 800],
			}),
		];
		const cohorts = scoreCohorts(replayOf(records));
		expect(
			cohorts.peerExhaustionBySinceDeath.map((group) => group.scope),
		).toEqual(["combined", "five_hour", "seven_day"]);
		const byScope = new Map(
			cohorts.peerExhaustionBySinceDeath.map((group) => [group.scope, group]),
		);
		for (const group of cohorts.peerExhaustionBySinceDeath) {
			expect(group.buckets.map((bucket) => bucket.label)).toEqual(
				SINCE_DEATH_BUCKETS.map((bucket) => bucket.label),
			);
		}
		const countsOf = (scope: "combined" | "five_hour" | "seven_day") =>
			byScope.get(scope)?.buckets.map((bucket) => bucket.records) ?? [];
		// 10 min and 20 min -> 0-30m; 45 -> 30-60m; 90 -> 1-2h; 200 -> 3-4h;
		// 800 -> 12-24h.
		expect(countsOf("combined")).toEqual([2, 1, 1, 0, 1, 0, 0, 1]);
		expect(countsOf("five_hour")).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
		expect(countsOf("seven_day")).toEqual([1, 0, 0, 0, 1, 0, 0, 1]);
		// Every bucket still carries the full cohort payload.
		const first = byScope.get("combined")?.buckets[0];
		expect(first?.balanced).toHaveLength(REPLAY_MODELS.length);
		expect(first?.perRecord).toHaveLength(REPLAY_MODELS.length);
		expect(first?.biasVsCurrent[VERDICT_BASIS_MODEL].n).toBeGreaterThanOrEqual(
			0,
		);
	});

	test("a record with no since-death age never reaches a bucket", () => {
		const records = perModel("A", [T0], {
			current: () => ({ tags: ["peer-exhaustion"] as const }),
		});
		for (const entry of records) entry.tags = ["peer-exhaustion"];
		const cohorts = scoreCohorts(replayOf(records));
		const combined = cohorts.peerExhaustionBySinceDeath[0];
		expect(combined.buckets.every((bucket) => bucket.records === 0)).toBe(true);
	});
});

describe("survivorSlopeTrajectory", () => {
	test("ratios the survivor's slope against the first instant after the death", () => {
		const records = peerPerModel({
			accountId: "A",
			windowKind: "five_hour",
			sinceDeathMinutes: [10, 45, 90],
			slopes: [4, 8, 2],
		});
		const rows = survivorSlopeTrajectory(records);
		const cell = (
			label: string,
			scope: "combined" | "five_hour" | "seven_day",
		) => rows.find((row) => row.label === label)?.cells[scope];
		expect(cell("0-30m", "combined")?.medianRatio).toBeCloseTo(1, 9);
		expect(cell("30-60m", "combined")?.medianRatio).toBeCloseTo(2, 9);
		expect(cell("1-2h", "combined")?.medianRatio).toBeCloseTo(0.5, 9);
		expect(cell("30-60m", "five_hour")?.medianRatio).toBeCloseTo(2, 9);
		expect(cell("30-60m", "seven_day")?.medianRatio).toBeNull();
		expect(cell("30-60m", "combined")?.lifecycles).toBe(1);
		expect(cell("30-60m", "combined")?.medianSlopePctPerHour).toBeCloseTo(8, 9);
	});

	test("medians across lifecycles, not across instants", () => {
		const records = [
			// One lifecycle contributes many instants in the same bucket; it must
			// still count once.
			...peerPerModel({
				accountId: "A",
				windowKind: "five_hour",
				sinceDeathMinutes: [5, 70, 75, 80, 85],
				slopes: [10, 40, 40, 40, 40],
			}),
			...peerPerModel({
				accountId: "B",
				windowKind: "five_hour",
				sinceDeathMinutes: [5, 70],
				slopes: [10, 10],
			}),
		];
		const rows = survivorSlopeTrajectory(records);
		const cell = rows.find((row) => row.label === "1-2h")?.cells.combined;
		expect(cell?.lifecycles).toBe(2);
		// Per-lifecycle medians are 4 and 1; the median across lifecycles is the
		// lower of the two on an even count.
		expect(cell?.medianRatio).toBeCloseTo(1, 9);
	});

	test("drops a lifecycle whose baseline slope is zero", () => {
		// 9/0 is not a ratio, and imputing one would invent the very absorption
		// the table exists to measure.
		const zero = survivorSlopeTrajectory(
			peerPerModel({
				accountId: "A",
				windowKind: "five_hour",
				sinceDeathMinutes: [5, 70],
				slopes: [0, 9],
			}),
		);
		expect(
			zero.find((row) => row.label === "1-2h")?.cells.combined.lifecycles,
		).toBe(0);
	});

	test("baselines on the earliest post-death instant that HAS a slope", () => {
		// A survivor is very often still learning at the instant its peer dies,
		// so requiring a slope at the literal first instant would throw away the
		// lifecycles the table is about. The baseline is the first reading that
		// exists, and the ratio is measured from there.
		const rows = survivorSlopeTrajectory(
			peerPerModel({
				accountId: "A",
				windowKind: "five_hour",
				sinceDeathMinutes: [5, 40, 70],
				slopes: [null, 9, 18],
			}),
		);
		const at1to2h = rows.find((row) => row.label === "1-2h")?.cells.combined;
		expect(at1to2h?.lifecycles).toBe(1);
		expect(at1to2h?.medianRatio).toBeCloseTo(2, 9);
		// The instant with no slope contributes to no bucket at all.
		expect(
			rows.find((row) => row.label === "0-30m")?.cells.combined.lifecycles,
		).toBe(0);
		expect(
			rows.find((row) => row.label === "30-60m")?.cells.combined.medianRatio,
		).toBeCloseTo(1, 9);
	});

	test("never baselines on an instant BEFORE the death", () => {
		// The bucket index already rejects a negative age; the baseline has to
		// reject it too, or a pre-death reading sets the scale for every ratio
		// measured after it.
		const rows = survivorSlopeTrajectory(
			peerPerModel({
				accountId: "A",
				windowKind: "five_hour",
				sinceDeathMinutes: [-30, 5, 70],
				slopes: [1, 10, 20],
			}),
		);
		expect(
			rows.find((row) => row.label === "1-2h")?.cells.combined.medianRatio,
		).toBeCloseTo(2, 9);
	});

	test("only the named model's records are read", () => {
		const records = peerPerModel({
			accountId: "A",
			windowKind: "five_hour",
			sinceDeathMinutes: [5, 70],
			slopes: [10, 20],
		});
		for (const entry of records) {
			if (entry.model !== "current") entry.slopePctPerHour = null;
		}
		const rows = survivorSlopeTrajectory(records, "current");
		expect(
			rows.find((row) => row.label === "1-2h")?.cells.combined.medianRatio,
		).toBeCloseTo(2, 9);
	});
});

describe("churnRows", () => {
	test("measures ETA movement and yes/no flips over consecutive usable instants", () => {
		const step = 10;
		const instants = [T0, T0 + step * MIN, T0 + 2 * step * MIN];
		const records: RedistributionRecord[] = [];
		// ETA moves +30 min then -10 min; the verdict never flips.
		const etas = [DAY, DAY + 30 * MIN, DAY + 20 * MIN];
		instants.forEach((T, index) => {
			for (const model of REPLAY_MODELS) {
				records.push(
					record({
						model,
						accountId: "A",
						T,
						lifecycleId: "A::seven_day::0",
						predictedEtaMs: T0 + etas[index],
						outcome: { kind: "exhausted", atMs: T0 + 2 * DAY },
					}),
				);
			}
		});
		const rows = churnRows("Overall", records, step);
		expect(rows.map((row) => row.model)).toEqual([...REPLAY_MODELS]);
		const current = rows[0];
		expect(current.cohort).toBe("Overall");
		expect(current.lifecycles).toBe(1);
		expect(current.pairs).toBe(2);
		// |+30| and |-10| -> per-lifecycle median 10 (lower median of two).
		expect(current.medianEtaChangeMinutes).toBeCloseTo(10, 9);
		expect(current.p90EtaChangeMinutes).toBeCloseTo(30, 9);
		expect(current.medianFlipRate).toBeCloseTo(0, 9);
	});

	test("counts a flip when the yes/no verdict changes between instants", () => {
		const step = 10;
		const records: RedistributionRecord[] = [];
		[true, false, false, true].forEach((predicts, index) => {
			const T = T0 + index * step * MIN;
			for (const model of REPLAY_MODELS) {
				records.push(
					record({
						model,
						accountId: "A",
						T,
						lifecycleId: "A::seven_day::0",
						predictsExhaust: predicts,
						predictedEtaMs: predicts ? T + DAY : null,
					}),
				);
			}
		});
		const rows = churnRows("Overall", records, step);
		// 3 pairs, 2 of which change the verdict.
		expect(rows[0].pairs).toBe(3);
		expect(rows[0].medianFlipRate).toBeCloseTo(2 / 3, 9);
		// Only one pair had an ETA on both sides (none, in fact: the yes-runs are
		// never adjacent), so the ETA statistic has nothing to say.
		expect(rows[0].medianEtaChangeMinutes).toBeNull();
	});

	test("pairs only instants exactly one grid step apart, never across lifecycles", () => {
		const step = 10;
		const records: RedistributionRecord[] = [];
		for (const [lifecycle, offsets] of [
			["A::seven_day::0", [0, 10]],
			// A two-step hole: the pair straddling it is not churn.
			["A::seven_day::1", [0, 20]],
			// A three-step hole, likewise.
			["A::seven_day::2", [0, 30]],
		] as const) {
			for (const offset of offsets) {
				for (const model of REPLAY_MODELS) {
					records.push(
						record({
							model,
							accountId: "A",
							T: T0 + offset * MIN,
							lifecycleId: lifecycle,
							predictedEtaMs: T0 + offset * MIN + DAY,
						}),
					);
				}
			}
		}
		const rows = churnRows("Overall", records, step);
		expect(rows[0].pairs).toBe(1);
		expect(rows[0].lifecycles).toBe(1);
	});

	test("never bridges an unusable instant", () => {
		const step = 10;
		const records: RedistributionRecord[] = [];
		[true, false, true].forEach((usable, index) => {
			const T = T0 + index * step * MIN;
			for (const model of REPLAY_MODELS) {
				records.push(
					record({
						model,
						accountId: "A",
						T,
						lifecycleId: "A::seven_day::0",
						usable,
						unusableReason: usable ? null : "no_slope",
						predictsExhaust: usable,
						predictedEtaMs: usable ? T + DAY : null,
					}),
				);
			}
		});
		// The statistic is defined on ADJACENT usable instants. An instant the
		// model could not answer leaves its neighbours two grid steps apart,
		// which is a hole in the series and not the estimator changing its mind.
		expect(churnRows("Overall", records, step)[0].pairs).toBe(0);
		// Fill the hole and both pairs appear.
		for (const entry of records) entry.usable = true;
		expect(churnRows("Overall", records, step)[0].pairs).toBe(2);
	});

	test("does not manufacture a flip across a skipped grid instant", () => {
		// Minutes 0 and 20 on a 10-minute grid, with opposite verdicts. Pairing
		// them reports a 100 % flip rate for a change no operator ever saw.
		const step = 10;
		const records: RedistributionRecord[] = [];
		for (const [offset, predicts] of [
			[0, true],
			[20, false],
		] as const) {
			const T = T0 + offset * MIN;
			for (const model of REPLAY_MODELS) {
				records.push(
					record({
						model,
						accountId: "A",
						T,
						lifecycleId: "A::seven_day::0",
						predictsExhaust: predicts,
						predictedEtaMs: predicts ? T + DAY : null,
					}),
				);
			}
		}
		const rows = churnRows("Overall", records, step);
		expect(rows[0].pairs).toBe(0);
		expect(rows[0].lifecycles).toBe(0);
		expect(rows[0].medianFlipRate).toBeNull();
	});
});

describe("scoreCohorts churn and slope trajectory", () => {
	test("carries a churn row per model for the overall and any-transition cohorts", () => {
		const records = [
			...perModel("A", [T0, T0 + 10 * MIN, T0 + 20 * MIN]),
			...peerPerModel({
				accountId: "B",
				windowKind: "five_hour",
				sinceDeathMinutes: [10, 20, 30],
				slopes: [5, 10, 15],
				deathAtMs: T0,
			}),
		];
		const cohorts = scoreCohorts(replayOf(records));
		expect(cohorts.churn.map((row) => row.cohort)).toEqual([
			...REPLAY_MODELS.map(() => "Overall"),
			...REPLAY_MODELS.map(() => "Any transition"),
		]);
		expect(cohorts.churn[0].pairs).toBeGreaterThan(0);
		expect(
			cohorts.slopeTrajectory.some((row) => row.cells.combined.lifecycles > 0),
		).toBe(true);
	});

	test("baselines the slope on the earliest post-death instant the replay saw, not the earliest COMPARABLE one", () => {
		// Slopes 4, 8, 8 at 10, 40 and 70 minutes after the death, with one
		// scenario model unable to answer at minute 10. Which instants are
		// SCORED depends on all three models agreeing to answer; where the
		// survivor's own slope is measured from does not.
		const records = peerPerModel({
			accountId: "A",
			windowKind: "five_hour",
			sinceDeathMinutes: [10, 40, 70],
			slopes: [4, 8, 8],
			deathAtMs: T0,
		});
		for (const entry of records) {
			if (entry.model !== "scenario-headroom") continue;
			if (entry.sinceDeathMs !== 10 * MIN) continue;
			entry.usable = false;
			entry.unusableReason = "insufficient_data";
			entry.predictsExhaust = false;
			entry.predictedEtaMs = null;
		}
		const cohorts = scoreCohorts(replayOf(records));
		const cell = (label: string) =>
			cohorts.slopeTrajectory.find((row) => row.label === label)?.cells
				.combined;
		expect(cell("0-30m")?.lifecycles).toBe(1);
		expect(cell("0-30m")?.medianRatio).toBeCloseTo(1, 9);
		expect(cell("30-60m")?.medianRatio).toBeCloseTo(2, 9);
		expect(cell("1-2h")?.medianRatio).toBeCloseTo(2, 9);
		// The SCORED bucket still honours the common cohort: minute 10 is not
		// comparable across models, so nothing is scored there.
		expect(cohorts.peerExhaustionBySinceDeath[0].buckets[0].records).toBe(0);
	});

	test("measures each model's churn on its OWN usable instants", () => {
		// `scenario-headroom` abstaining empties the common cohort; the other
		// two models' consecutive predictions are still perfectly measurable,
		// and their stability is not a claim about the third model.
		const records = perModel("A", [T0, T0 + 10 * MIN, T0 + 20 * MIN]);
		for (const entry of records) {
			if (entry.model !== "scenario-headroom") continue;
			entry.usable = false;
			entry.unusableReason = "insufficient_data";
			entry.predictsExhaust = false;
			entry.predictedEtaMs = null;
		}
		const cohorts = scoreCohorts(replayOf(records));
		expect(cohorts.common).toHaveLength(0);
		const overall = new Map(
			cohorts.churn
				.filter((row) => row.cohort === "Overall")
				.map((row) => [row.model, row]),
		);
		expect(overall.get("current")?.pairs).toBe(2);
		expect(overall.get("scenario-equal")?.pairs).toBe(2);
		// The model that could not answer has no pairs of its own, which is the
		// honest answer for it and no reason to erase the other two.
		expect(overall.get("scenario-headroom")?.pairs).toBe(0);
	});

	test("keeps a censored outcome out of the scores but inside the churn cohort", () => {
		// Truth censoring says the window's fate was never observed. It cannot
		// say the estimator was unstable, so it must not silence the churn row.
		const records = perModel("A", [T0, T0 + 10 * MIN, T0 + 20 * MIN]);
		for (const entry of records) entry.outcome = { kind: "censored" };
		const cohorts = scoreCohorts(replayOf(records));
		expect(cohorts.common).toHaveLength(0);
		const current = cohorts.churn.find(
			(row) => row.cohort === "Overall" && row.model === "current",
		);
		expect(current?.pairs).toBe(2);
	});
});

describe("redistributionRecordToJson", () => {
	test("renders every field, with instants as ISO strings", () => {
		const entry = record({
			model: "current",
			accountId: "A",
			T: T0,
			windowKind: "five_hour",
			tags: ["peer-exhaustion"],
			eventIds: [3, 4],
			sinceDeathMs: 90 * MIN,
			slopePctPerHour: 12.5,
		});
		const json = redistributionRecordToJson(entry);
		expect(json.tIso).toBe(new Date(T0).toISOString());
		expect(json.tMs).toBe(T0);
		expect(json.model).toBe("current");
		expect(json.lifecycleId).toBe("A::seven_day::0");
		expect(json.windowKind).toBe("five_hour");
		expect(json.tags).toEqual(["peer-exhaustion"]);
		expect(json.eventIds).toEqual([3, 4]);
		expect(json.sinceDeathMs).toBe(90 * MIN);
		expect(json.sinceDeathMinutes).toBeCloseTo(90, 9);
		expect(json.slopePctPerHour).toBe(12.5);
		expect(json.outcomeKind).toBe("exhausted");
		expect(json.outcomeAtIso).toBe(new Date(T0 + DAY).toISOString());
		expect(json.predictedEtaIso).toBe(new Date(T0 + DAY).toISOString());
		expect(json.knownResetIso).toBe(new Date(T0 + 3 * DAY).toISOString());
		// Round-trips through JSON without producing `undefined`.
		expect(JSON.stringify(json)).not.toContain("undefined");
	});

	test("nulls rather than fabricates an instant that is absent", () => {
		const entry = record({
			model: "scenario-equal",
			accountId: "A",
			T: T0,
			predictsExhaust: false,
			predictedEtaMs: null,
			outcome: { kind: "censored" },
			knownResetAtMs: null,
			labelResetAtMs: null,
			sinceDeathMs: null,
		});
		const json = redistributionRecordToJson(entry);
		expect(json.predictedEtaIso).toBeNull();
		expect(json.outcomeAtIso).toBeNull();
		expect(json.knownResetIso).toBeNull();
		expect(json.labelResetIso).toBeNull();
		expect(json.sinceDeathMinutes).toBeNull();
	});

	test("keeps the exported key of the first-assignment flag frozen", () => {
		// The field was renamed when the basis was re-declared; the KEY was not,
		// so an exported record still compares field-for-field against one an
		// earlier release wrote.
		const json = redistributionRecordToJson(
			record({
				model: VERDICT_BASIS_MODEL,
				accountId: "A",
				T: T0,
				basisFirstAssignment: true,
			}),
		);
		expect(json).toHaveProperty("proportionalFirstAssignment", true);
		expect(Object.keys(json)).not.toContain("basisFirstAssignment");
		expect(JSON.stringify(json)).not.toContain("basisFirstAssignment");
	});
});

describe("replayInstant slope capture", () => {
	test("records the current estimator's fitted slope on every record at T", () => {
		const fixture = pairFixture();
		const roster = buildRosterAtInstant(
			T0 + 2 * DAY,
			prepareSeries(fixture.rows, fixture.accounts),
			fixture.accounts,
		);
		const replay = replayInstant(T0 + 2 * DAY, roster, [], {
			label: "test",
			fromMs: T0,
			toMs: T0 + 20 * DAY,
		});
		// The 90 %/day account is already at 100 % here, and a full window emits
		// no record; the 20 %/day survivor is the one being measured.
		const forA = replay.records.filter((entry) => entry.accountId === "A");
		expect(forA.length).toBe(REPLAY_MODELS.length);
		for (const entry of forA) {
			// 20 %/day is 0.833 %/h.
			expect(entry.slopePctPerHour ?? 0).toBeCloseTo(20 / 24, 6);
		}
		// Every model's record at one instant carries the SAME reading: the
		// slope is a property of the account's window, not of the projection.
		expect(new Set(forA.map((entry) => entry.slopePctPerHour)).size).toBe(1);
	});
});

describe("the report's new sections", () => {
	test("names every since-death scope, the slope table and the churn section", () => {
		const fixture = pairFixture();
		const range: ReplayRange = {
			label: "test",
			fromMs: T0,
			toMs: T0 + 8 * DAY,
		};
		const result = replayRange(
			fixture.rows,
			fixture.accounts,
			range,
			60,
			20260823,
		);
		const { markdown } = reportFor(result, fixture.rows);
		for (const heading of [
			"### Peer exhaustion by time since death",
			"#### combined",
			"#### five_hour",
			"#### seven_day",
			"##### since death 0-30m",
			"##### since death 12-24h",
			"### Survivor slope trajectory after a death",
			"## Prediction churn",
		]) {
			expect(markdown).toContain(heading);
		}
		// The disclosure survives the rework, as a hypothesis rather than as a
		// claim the run establishes.
		expect(markdown).toContain(
			"IF a survivor's own lookback already contains the traffic it absorbed, the scenario would be adding that demand a second time",
		);
		// Churn comes before pool calibration.
		expect(markdown.indexOf("## Prediction churn")).toBeGreaterThan(0);
		expect(markdown.indexOf("## Prediction churn")).toBeLessThan(
			markdown.indexOf("## Pool calibration"),
		);
		expect(markdown).not.toContain("undefined");
		expect(markdown).not.toContain("NaN");
	});
});

// ---------------------------------------------------------------------------
// Observation lag
// ---------------------------------------------------------------------------

describe("scenario models", () => {
	test("carries a pre-correction scan beside each corrected one", () => {
		expect([...REPLAY_MODELS]).toEqual([
			"current",
			"scenario-equal",
			"scenario-equal-original",
			"scenario-headroom",
			"scenario-proportional",
			"scenario-proportional-original",
		]);
		expect([...SCENARIO_MODEL_IDS]).toEqual([
			"scenario-equal",
			"scenario-equal-original",
			"scenario-headroom",
			"scenario-proportional",
			"scenario-proportional-original",
		]);
		expect(SCENARIO_MODELS["scenario-equal"].observationLag).toBe("advance");
		expect(SCENARIO_MODELS["scenario-equal-original"].observationLag).toBe(
			"ignore",
		);
		expect(SCENARIO_MODELS["scenario-headroom"].observationLag).toBe("advance");
		expect(
			SCENARIO_MODELS["scenario-proportional-original"].observationLag,
		).toBe("ignore");
		// Each pair differs ONLY in the lag treatment.
		expect(SCENARIO_MODELS["scenario-equal-original"].shareRule).toBe(
			SCENARIO_MODELS["scenario-equal"].shareRule,
		);
		expect(SCENARIO_MODELS["scenario-proportional-original"].shareRule).toBe(
			SCENARIO_MODELS["scenario-proportional"].shareRule,
		);
		// And each corrected rule names its own control, never another's.
		expect(CONTROL_MODELS[VERDICT_BASIS_MODEL]).toBe(
			VERDICT_BASIS_CONTROL_MODEL,
		);
		expect(CONTROL_MODELS[PRIOR_BASIS_MODEL]).toBe(PRIOR_BASIS_CONTROL_MODEL);
		expect(CONTROL_MODELS["scenario-headroom"]).toBeUndefined();
	});

	test("the verdict basis is the proportional rule, on the corrected scan", () => {
		expect(VERDICT_BASIS_MODEL).toBe("scenario-proportional");
		expect(SCENARIO_MODELS[VERDICT_BASIS_MODEL].shareRule).toBe(
			proportionalShareRule,
		);
		expect(SCENARIO_MODELS[VERDICT_BASIS_MODEL].observationLag).toBe("advance");
		expect(SCENARIO_MODELS[VERDICT_BASIS_CONTROL_MODEL].shareRule).toBe(
			proportionalShareRule,
		);
		// The equal split is kept beside it as the prior basis, never as it.
		expect(PRIOR_BASIS_MODEL).toBe("scenario-equal");
		expect(VERDICT_BASIS_MODEL).not.toBe(PRIOR_BASIS_MODEL);
		expect([...BESIDE_BASIS_MODELS]).toEqual([
			PRIOR_BASIS_MODEL,
			"scenario-headroom",
		]);
		expect(BESIDE_BASIS_MODELS).not.toContain(VERDICT_BASIS_MODEL);
	});

	test("the rule states the basis, the re-declaration and no score", () => {
		expect(VERDICT_RULE).toContain(VERDICT_BASIS_MODEL);
		expect(VERDICT_RULE).toContain(VERDICT_BASIS_CONTROL_MODEL);
		expect(VERDICT_RULE).toContain(
			"The verdict basis is the PROPORTIONAL share rule, re-declared on 2026-09-07",
		);
		expect(VERDICT_RULE).toContain(
			"after it was scored as a candidate beside the equal split, which had been",
		);
		expect(VERDICT_RULE).toContain("the basis through v2026.9.19");
		expect(VERDICT_RULE).toContain(
			"scored beside it and never enter the verdict",
		);
		// No number the run produced: a rule that quoted a score would be read off
		// the tables it judges.
		expect(VERDICT_RULE).not.toMatch(/0\.\d/);
	});

	test("every per-model table carries the basis and its control", () => {
		const fixture = pairFixture();
		const result = replayRange(
			fixture.rows,
			fixture.accounts,
			RANGE,
			6 * 60,
			20260823,
		);
		const cohorts = scoreCohorts(result);
		for (const model of [VERDICT_BASIS_MODEL, VERDICT_BASIS_CONTROL_MODEL]) {
			expect(result.records.some((entry) => entry.model === model)).toBe(true);
			for (const rows of [
				cohorts.overall.balanced,
				cohorts.overall.perRecord,
				cohorts.anyTransition.balanced,
			]) {
				expect(rows.map((row) => row.estimator)).toContain(model);
			}
			expect(cohorts.churn.some((row) => row.model === model)).toBe(true);
		}

		// The calibration grid needs a whole horizon of observed truth after each
		// instant, which the range above does not reach, so it is checked on the
		// long-range fixture instead.
		const start = T0 - DAY;
		const step = 12 * HOUR;
		const calibrated = replayRange(
			[
				...rows({
					accountId: "A",
					from: start,
					to: T0 + 16 * DAY,
					stepMs: step,
					sevenDay: weekly(start, 8, 95),
				}),
				...rows({
					accountId: "B",
					from: start,
					to: T0 + 16 * DAY,
					stepMs: step,
					sevenDay: weekly(start, 9, 95),
				}),
			],
			[account("A"), account("B")],
			{ label: "grid", fromMs: T0, toMs: T0 + 16 * DAY },
			step / MIN,
			7,
		);
		const rowsFor = (model: ReplayModel): number =>
			calibrated.calibration.filter((row) => row.model === model).length;
		expect(rowsFor(VERDICT_BASIS_MODEL)).toBeGreaterThan(0);
		expect(rowsFor(VERDICT_BASIS_MODEL)).toBe(rowsFor(PRIOR_BASIS_MODEL));
		expect(rowsFor(VERDICT_BASIS_CONTROL_MODEL)).toBe(
			rowsFor(VERDICT_BASIS_MODEL),
		);
	});
});

const FIVE_HOUR_RESET = T0 + 5 * HOUR;

/** One anthropic account burning `pctPerHour` on a five-hour window. */
function fiveHourFixture(options: {
	accountId?: string;
	pctPerHour: number;
	observedOffsetMs?: number;
}): { rows: RosterSnapshotRow[]; accounts: RosterAccount[] } {
	const accountId = options.accountId ?? "A";
	return {
		rows: rows({
			accountId,
			from: T0,
			to: T0 + 2 * HOUR,
			stepMs: 10 * MIN,
			observedOffsetMs: options.observedOffsetMs,
			fiveHour: (t) => ({
				pct: ((t - T0) / HOUR) * options.pctPerHour,
				reset: FIVE_HOUR_RESET,
			}),
		}),
		accounts: [account(accountId)],
	};
}

/** One weekly window burning 20 %/day since `T0 - DAY`. */
function weeklyFixture(options: {
	accountId?: string;
	observed?: boolean;
	observedOffsetMs?: number;
}): { rows: RosterSnapshotRow[]; accounts: RosterAccount[] } {
	const accountId = options.accountId ?? "A";
	const start = T0 - DAY;
	return {
		rows: rows({
			accountId,
			from: start,
			to: T0,
			stepMs: 30 * MIN,
			observed: options.observed,
			observedOffsetMs: options.observedOffsetMs,
			sevenDay: weekly(start, 20),
		}),
		accounts: [account(accountId)],
	};
}

/**
 * The instant of {@link lagDeathPairFixture}: ten minutes past the last sample,
 * so every reading carries a ten-minute lag.
 */
const LAG_DEATH_T = T0 + 2 * HOUR + 10 * MIN;

/**
 * Two equal-capacity accounts in one class, each burning 12 pp/h on a five-hour
 * window, reading 99 % and 90 % at the last sample.
 *
 * At {@link LAG_DEATH_T} the corrected scan advances A over its lag, fills it
 * part-way through and applies that death at the instant itself; the original
 * scan keeps A alive at the instant and kills it five minutes later, part-way
 * to B's ETA. The two scans therefore order the class's events differently.
 */
function lagDeathPairFixture(): {
	rows: RosterSnapshotRow[];
	accounts: RosterAccount[];
} {
	const burn = (basePct: number) => (t: number) => ({
		pct: basePct + ((t - T0) / HOUR) * 12,
		reset: FIVE_HOUR_RESET,
	});
	return {
		rows: [
			...rows({
				accountId: "A",
				from: T0,
				to: T0 + 2 * HOUR,
				stepMs: 10 * MIN,
				fiveHour: burn(75),
			}),
			...rows({
				accountId: "B",
				from: T0,
				to: T0 + 2 * HOUR,
				stepMs: 10 * MIN,
				fiveHour: burn(66),
			}),
		],
		accounts: [account("A"), account("B")],
	};
}

/** The instant of {@link resetCrossingFixture}, ten minutes past its last sample. */
const RESET_CROSSING_T = T0 + HOUR + 10 * MIN;

/**
 * One account reading 50 % on a ten-minute-old sample, burning 50 pp/h on a
 * window that resets 55 minutes after {@link RESET_CROSSING_T}.
 *
 * The current model and the corrected scan both date exhaustion 50 minutes out;
 * the pre-correction scan needs 60 minutes from the instant and so projects
 * nothing before the reset.
 */
function resetCrossingFixture(): {
	rows: RosterSnapshotRow[];
	accounts: RosterAccount[];
} {
	const reset = RESET_CROSSING_T + 55 * MIN;
	return {
		rows: rows({
			accountId: "A",
			from: T0,
			to: T0 + HOUR,
			stepMs: 10 * MIN,
			fiveHour: (t) => ({ pct: ((t - T0) / HOUR) * 50, reset }),
		}),
		accounts: [account("A")],
	};
}

/** The instant of {@link lagFillPairFixture}, one minute past A's last sample. */
const LAG_FILL_T = T0 + 2 * HOUR + MIN;

/**
 * Two equal-capacity accounts burning 12 pp/h on a five-hour window, sampled on
 * different cadences: A reads 99 % one minute before {@link LAG_FILL_T}, B
 * reads 98.8 % ten minutes before it.
 *
 * B fills inside its OWN lag, so the corrected scan applies its death at the
 * instant and doubles A's share from there on. A is still the first event of
 * both scans — in the pre-correction scan B dies a minute after A — but its ETA
 * moves by three minutes against a one-minute lag of its own, because the peer
 * that died at the instant is what moved it.
 */
function lagFillPairFixture(): {
	rows: RosterSnapshotRow[];
	accounts: RosterAccount[];
} {
	const burn = (endPct: number, endAt: number) => (t: number) => ({
		pct: endPct - ((endAt - t) / HOUR) * 12,
		reset: FIVE_HOUR_RESET,
	});
	const aEnd = LAG_FILL_T - MIN;
	const bEnd = LAG_FILL_T - 10 * MIN;
	return {
		rows: [
			...rows({
				accountId: "A",
				from: aEnd - 2 * HOUR,
				to: aEnd,
				stepMs: 10 * MIN,
				fiveHour: burn(99, aEnd),
			}),
			...rows({
				accountId: "B",
				from: bEnd - 2 * HOUR,
				to: bEnd,
				stepMs: 10 * MIN,
				fiveHour: burn(98.8, bEnd),
			}),
		],
		accounts: [account("A"), account("B")],
	};
}

/** The instant of {@link ownFillInsideLagFixture}, ten minutes past its last sample. */
const OWN_FILL_T = T0 + 2 * HOUR + 10 * MIN;

/**
 * ONE pooled account, whose five-hour window reads 98 % on a ten-minute-old
 * sample while burning 24 pp/h, and whose weekly window is still projecting.
 *
 * The corrected scan advances the five-hour reading past 100 % and applies that
 * death at the instant, so the account is idle until the five-hour reset and
 * the weekly's projection carries that whole dead span.
 */
function ownFillInsideLagFixture(): {
	rows: RosterSnapshotRow[];
	accounts: RosterAccount[];
} {
	const start = T0 - DAY;
	const fiveHourEnd = OWN_FILL_T - 10 * MIN;
	return {
		rows: rows({
			accountId: "A",
			from: start,
			to: fiveHourEnd,
			stepMs: 10 * MIN,
			sevenDay: weekly(start, 20),
			fiveHour: (t) =>
				t < T0
					? { pct: null, reset: null }
					: {
							pct: 98 - ((fiveHourEnd - t) / HOUR) * 24,
							reset: FIVE_HOUR_RESET,
						},
		}),
		accounts: [account("A")],
	};
}

/**
 * One account idle at 40 % inside a live five-hour window: the fit is flat, so
 * the regression path states no ETA and its anchor cannot be back-solved.
 */
function flatFiveHourFixture(): {
	rows: RosterSnapshotRow[];
	accounts: RosterAccount[];
} {
	return {
		rows: rows({
			accountId: "A",
			from: T0,
			to: T0 + 2 * HOUR,
			stepMs: 10 * MIN,
			fiveHour: () => ({ pct: 40, reset: FIVE_HOUR_RESET }),
		}),
		accounts: [account("A")],
	};
}

const merge = (
	...parts: Array<{ rows: RosterSnapshotRow[]; accounts: RosterAccount[] }>
): { rows: RosterSnapshotRow[]; accounts: RosterAccount[] } => ({
	rows: parts.flatMap((part) => part.rows),
	accounts: parts.flatMap((part) => part.accounts),
});

/** `replayInstant` at `T` over a fixture, with a range that labels everything. */
function replayFixtureAt(
	T: number,
	fixture: { rows: RosterSnapshotRow[]; accounts: RosterAccount[] },
	toMs = T0 + 8 * DAY,
) {
	const roster = buildRosterAtInstant(
		T,
		prepareSeries(fixture.rows, fixture.accounts),
		fixture.accounts,
	);
	return replayInstant(T, roster, [], { label: "test", fromMs: T0, toMs });
}

const recordOf = (
	replay: { records: RedistributionRecord[] },
	accountId: string,
	model: ReplayModel,
	windowKind = "five_hour",
): RedistributionRecord | undefined =>
	replay.records.find(
		(entry) =>
			entry.accountId === accountId &&
			entry.model === model &&
			entry.windowKind === windowKind,
	);

describe("replayInstant reading-level fields", () => {
	test("derives the regression lag from the FIT, not from the observation", () => {
		// The row was observed 3 min before it was sampled, and the instant is 5
		// min past the sample. The fit's last point is the SAMPLE, so that is
		// what the regression path's ETA is anchored to.
		const T = T0 + 2 * HOUR + 5 * MIN;
		const replay = replayFixtureAt(
			T,
			fiveHourFixture({ pctPerHour: 30, observedOffsetMs: 3 * MIN }),
		);
		const forA = replay.records.filter((entry) => entry.accountId === "A");
		expect(forA).toHaveLength(REPLAY_MODELS.length);
		for (const entry of forA) {
			expect(entry.estimatorSource).toBe("regression");
			expect(entry.observationAgeMs).toBe(8 * MIN);
			expect(entry.sampleAgeMs).toBe(5 * MIN);
			expect(Math.abs((entry.lagMs ?? 0) - 5 * MIN)).toBeLessThanOrEqual(1);
			expect(entry.pooledInClass).toBe(1);
			expect(entry.classLagFree).toBe(false);
			expect(entry.firstEvent).toBe(true);
			expect(entry.exactShiftEligible).toBe(true);
		}
		// The corrected scan lands on the fit's own ETA; the original one is the
		// lag later.
		const corrected = recordOf(replay, "A", "scenario-equal");
		const original = recordOf(replay, "A", "scenario-equal-original");
		const current = recordOf(replay, "A", "current");
		expect(
			Math.abs(
				(corrected?.predictedEtaMs as number) -
					(current?.predictedEtaMs as number),
			),
		).toBeLessThanOrEqual(1000);
		expect(
			(original?.predictedEtaMs as number) -
				(corrected?.predictedEtaMs as number),
		).toBeCloseTo(5 * MIN, -3);
	});

	test("derives an observation-anchored weekly lag from the observation", () => {
		const T = T0 + 5 * MIN;
		const replay = replayFixtureAt(
			T,
			weeklyFixture({ observedOffsetMs: 3 * MIN }),
		);
		const corrected = recordOf(replay, "A", "scenario-equal", "seven_day");
		const current = recordOf(replay, "A", "current", "seven_day");
		expect(corrected?.estimatorSource).toBe("lifetime-primary");
		expect(corrected?.lagMs).toBe(8 * MIN);
		expect(corrected?.observationAgeMs).toBe(8 * MIN);
		expect(corrected?.sampleAgeMs).toBe(5 * MIN);
		expect(
			Math.abs(
				(corrected?.predictedEtaMs as number) -
					(current?.predictedEtaMs as number),
			),
		).toBeLessThanOrEqual(1000);
	});

	test("reports no lag and no observation age for a now-anchored reading", () => {
		const replay = replayFixtureAt(
			T0 + 5 * MIN,
			weeklyFixture({ observed: false }),
		);
		const record = recordOf(replay, "A", "scenario-equal", "seven_day");
		expect(record?.estimatorSource).toBe("lifetime-average");
		expect(record?.lagMs).toBe(0);
		expect(record?.observationAgeMs).toBeNull();
		expect(record?.classLagFree).toBe(true);
	});

	test("a peer's lag makes the whole class-instant not lag-free", () => {
		const T = T0 + 5 * MIN;
		const replay = replayFixtureAt(
			T,
			merge(
				weeklyFixture({ accountId: "A", observed: false }),
				weeklyFixture({ accountId: "B" }),
			),
		);
		const forA = recordOf(replay, "A", "scenario-equal", "seven_day");
		expect(forA?.lagMs).toBe(0);
		// A's own window carries no lag, but its ETA still moves with B's.
		expect(forA?.classLagFree).toBe(false);
		expect(forA?.pooledInClass).toBe(2);
	});

	test("a peer that exhausts first takes the first-event flag away", () => {
		const T = T0 + 2 * HOUR + 5 * MIN;
		const replay = replayFixtureAt(
			T,
			merge(
				fiveHourFixture({ accountId: "A", pctPerHour: 30 }),
				fiveHourFixture({ accountId: "B", pctPerHour: 45 }),
			),
		);
		const forA = recordOf(replay, "A", "scenario-equal");
		const forB = recordOf(replay, "B", "scenario-equal");
		expect(forA?.predictedEtaMs).not.toBeNull();
		expect(forB?.predictedEtaMs).not.toBeNull();
		expect(
			(forB?.predictedEtaMs as number) < (forA?.predictedEtaMs as number),
		).toBe(true);
		expect(forB?.firstEvent).toBe(true);
		expect(forA?.firstEvent).toBe(false);
	});

	test("a peer killed inside its lag leaves the survivor first-event but not exact-shift", () => {
		const replay = replayFixtureAt(LAG_DEATH_T, lagDeathPairFixture());
		const forB = recordOf(replay, "B", "scenario-equal");
		expect(forB?.estimatorSource).toBe("regression");
		expect(Math.abs((forB?.lagMs ?? 0) - 10 * MIN)).toBeLessThanOrEqual(1);
		// A fills inside its lag, so the corrected scan applies its death at the
		// instant: nothing is left ahead of B's own exhaustion in THAT scan.
		expect(forB?.firstEvent).toBe(true);
		// The original scan keeps A alive at the instant and kills it part-way to
		// B's ETA, so one slope does not govern B's projection across both scans.
		expect(forB?.exactShiftEligible).toBe(false);
		// A itself is the first event of both scans.
		const forA = recordOf(replay, "A", "scenario-equal");
		expect(forA?.firstEvent).toBe(true);
		expect(forA?.exactShiftEligible).toBe(true);
	});

	test("a peer that fills inside its lag disqualifies the survivor's exact shift", () => {
		const replay = replayFixtureAt(LAG_FILL_T, lagFillPairFixture());
		const forA = recordOf(replay, "A", "scenario-equal");
		const forB = recordOf(replay, "B", "scenario-equal");
		expect(Math.abs((forA?.lagMs ?? 0) - MIN)).toBeLessThanOrEqual(1);
		expect(Math.abs((forB?.lagMs ?? 0) - 10 * MIN)).toBeLessThanOrEqual(1);
		// B fills inside its own lag, so the corrected scan applies its death at
		// the instant: nothing of the class is left ahead of A there, and in the
		// pre-correction scan B dies AFTER A. A is the first event of both scans.
		expect(forA?.firstEvent).toBe(true);
		// But A's share doubled at the instant, so its shift is the arithmetic of
		// two slopes rather than its own lag.
		expect(forA?.peerDiedInLag).toBe(true);
		expect(forA?.exactShiftEligible).toBe(false);
		const corrected = forA?.predictedEtaMs as number;
		const original = recordOf(replay, "A", "scenario-equal-original")
			?.predictedEtaMs as number;
		expect((original - corrected) / MIN).toBeCloseTo(3, 1);
	});

	test("a record whose own account died inside its lag is peer-died-in-lag", () => {
		const replay = replayFixtureAt(OWN_FILL_T, ownFillInsideLagFixture());
		const weeklyRecord = recordOf(replay, "A", "scenario-equal", "seven_day");
		expect(weeklyRecord?.pooledInClass).toBe(1);
		expect(weeklyRecord?.firstEvent).toBe(true);
		expect(weeklyRecord?.predictedEtaMs).not.toBeNull();
		// The five-hour window of the SAME account filled inside its lag, and the
		// weekly's projection carries the dead span that death opened.
		expect(weeklyRecord?.peerDiedInLag).toBe(true);
	});

	test("reports a flat regression fit as having no derivable lag anchor", () => {
		const replay = replayFixtureAt(
			T0 + 2 * HOUR + 5 * MIN,
			flatFiveHourFixture(),
		);
		const record = recordOf(replay, "A", "current");
		expect(record?.estimatorSource).toBe("regression");
		expect(record?.lagMs).toBe(0);
		// A measured zero would say the correction moved this reading by nothing;
		// the truth is that its anchor is unrecoverable.
		expect(record?.lagAnchorKnown).toBe(false);
	});

	test("keeps the lag anchor known where the estimator derived one", () => {
		const regression = replayFixtureAt(
			T0 + 2 * HOUR + 5 * MIN,
			fiveHourFixture({ pctPerHour: 30 }),
		);
		expect(recordOf(regression, "A", "current")?.lagAnchorKnown).toBe(true);
		const weeklyReplay = replayFixtureAt(T0 + 5 * MIN, weeklyFixture({}));
		expect(
			recordOf(weeklyReplay, "A", "current", "seven_day")?.lagAnchorKnown,
		).toBe(true);
		// A now-anchored reading admits no lag at all, so its zero is derived.
		const lowReplay = replayFixtureAt(
			T0 + 5 * MIN,
			weeklyFixture({ observed: false }),
		);
		expect(
			recordOf(lowReplay, "A", "current", "seven_day")?.lagAnchorKnown,
		).toBe(true);
	});

	test("a peer's revival re-times the shares and takes the flag away", () => {
		// C is spent at T and comes back 30 min later, which re-splits the class
		// before A reaches 100 %.
		const T = T0 + 2 * HOUR + 5 * MIN;
		const revivalReset = T + 30 * MIN;
		const spent = {
			rows: rows({
				accountId: "C",
				from: T0,
				to: T0 + 2 * HOUR,
				stepMs: 10 * MIN,
				fiveHour: (t) => ({
					pct: Math.min(100, ((t - T0) / HOUR) * 60),
					reset: revivalReset,
				}),
			}),
			accounts: [account("C")],
		};
		const replay = replayFixtureAt(
			T,
			merge(fiveHourFixture({ accountId: "A", pctPerHour: 30 }), spent),
		);
		const forA = recordOf(replay, "A", "scenario-equal");
		expect(forA?.predictedEtaMs).not.toBeNull();
		expect(forA?.firstEvent).toBe(false);
		// C is at 100 %, so it emits no record of its own.
		expect(recordOf(replay, "C", "scenario-equal")).toBeUndefined();
	});
});

/** A replay result carrying one instant's records. */
const replayOfInstant = (replay: {
	records: RedistributionRecord[];
}): ReplayResult => replayOf(replay.records);

describe("observationLagChecks", () => {
	test("the two models are identical where no pooled window has a lag", () => {
		const replay = replayOfInstant(
			replayFixtureAt(
				T0 + 5 * MIN,
				merge(
					weeklyFixture({ accountId: "A", observed: false }),
					weeklyFixture({ accountId: "B", observed: false }),
				),
			),
		);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		expect(checks.identity.eligible).toBe(2);
		expect(checks.identity.differing).toBe(0);
		expect(checks.identity.fromMs).toBe(T0 + 5 * MIN);
	});

	test("a class-instant with a lagged peer is not eligible for the identity check", () => {
		const replay = replayOfInstant(
			replayFixtureAt(
				T0 + 5 * MIN,
				merge(
					weeklyFixture({ accountId: "A", observed: false }),
					weeklyFixture({ accountId: "B" }),
				),
			),
		);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		expect(checks.identity.eligible).toBe(0);
		expect(checks.identity.differing).toBe(0);
	});

	test("a first-event record's ETA moves by exactly its own lag", () => {
		const replay = replayOfInstant(
			replayFixtureAt(
				T0 + 2 * HOUR + 5 * MIN,
				fiveHourFixture({ pctPerHour: 30 }),
			),
		);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		expect(checks.shift.firstEvent.n).toBe(1);
		expect(checks.shift.firstEvent.medianShiftMinutes).toBeCloseTo(5, 3);
		expect(checks.shift.firstEvent.medianExcessMinutes).toBeCloseTo(0, 3);
		expect(checks.shift.firstEvent.matchingShare).toBe(1);
		expect(checks.shift.rest.n).toBe(0);
	});

	test("a record whose peer dies first is described, not held to its own lag", () => {
		const replay = replayOfInstant(
			replayFixtureAt(
				T0 + 2 * HOUR + 5 * MIN,
				merge(
					fiveHourFixture({ accountId: "A", pctPerHour: 30 }),
					fiveHourFixture({ accountId: "B", pctPerHour: 45 }),
				),
			),
		);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		expect(checks.shift.firstEvent.n).toBe(1);
		expect(checks.shift.rest.n).toBe(1);
	});

	test("keeps a survivor whose peer died inside its lag out of the exact split", () => {
		const replay = replayOfInstant(
			replayFixtureAt(LAG_DEATH_T, lagDeathPairFixture()),
		);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		// Only A, whose own death instant moved by exactly its lag.
		expect(checks.shift.firstEvent.n).toBe(1);
		expect(checks.shift.firstEvent.medianShiftMinutes).toBeCloseTo(10, 3);
		expect(checks.shift.firstEvent.matchingShare).toBe(1);
		// B's shift is 7.5 min against a 10 min lag, and it is described only.
		expect(checks.shift.rest.n).toBe(1);
		expect(checks.shift.rest.medianShiftMinutes).toBeCloseTo(7.5, 3);
	});

	test("keeps a survivor whose peer filled inside its lag out of the exact split", () => {
		const replay = replayOfInstant(
			replayFixtureAt(LAG_FILL_T, lagFillPairFixture()),
		);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		// A's shift is 3 min against its own 1 min lag: no exact expectation
		// exists for it, so it is described beside B rather than held to one.
		expect(checks.shift.firstEvent.n).toBe(0);
		expect(checks.shift.rest.n).toBe(2);
	});

	test("keeps a lone account that died inside its own lag out of the parity check", () => {
		const replay = replayOfInstant(
			replayFixtureAt(OWN_FILL_T, ownFillInsideLagFixture()),
		);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		// The weekly is a lone account's first event, but the account is dead
		// until its five-hour reset, so parity with the current model is not the
		// expectation and the row must not count it.
		expect(
			checks.parity.find((row) => row.path === "lifetime-primary")?.n,
		).toBe(0);
		// The five-hour window itself still counts: it is the window that died,
		// not one carrying a dead span, and it agrees with the current model.
		const regression = checks.parity.find((row) => row.path === "regression");
		expect(regression?.n).toBe(1);
		expect(regression?.withinToleranceShare).toBe(1);
	});

	test("counts parity on a record the original scan never dated", () => {
		const replay = replayOfInstant(
			replayFixtureAt(RESET_CROSSING_T, resetCrossingFixture()),
		);
		const current = recordOf(replay, "A", "current");
		const corrected = recordOf(replay, "A", "scenario-equal");
		const original = recordOf(replay, "A", "scenario-equal-original");
		expect(current?.predictedEtaMs).not.toBeNull();
		expect(corrected?.predictedEtaMs).not.toBeNull();
		expect(original?.predictedEtaMs).toBeNull();
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		const regression = checks.parity.find((row) => row.path === "regression");
		expect(regression?.n).toBe(1);
		expect(regression?.withinToleranceShare).toBe(1);
		// The shift statistic still needs both ETAs, so this record is not in it.
		expect(checks.shift.firstEvent.n).toBe(0);
		expect(checks.shift.rest.n).toBe(0);
	});

	test("checks parity with the current model per estimator path", () => {
		const regression = observationLagChecks(
			replayOfInstant(
				replayFixtureAt(
					T0 + 2 * HOUR + 5 * MIN,
					fiveHourFixture({ pctPerHour: 30 }),
				),
			),
			scoreCohorts(
				replayOfInstant(
					replayFixtureAt(
						T0 + 2 * HOUR + 5 * MIN,
						fiveHourFixture({ pctPerHour: 30 }),
					),
				),
			),
		);
		const byPath = (checks: typeof regression, path: string) =>
			checks.parity.find((row) => row.path === path);
		expect(byPath(regression, "regression")?.n).toBe(1);
		expect(byPath(regression, "regression")?.withinToleranceShare).toBe(1);

		const weeklyReplay = replayOfInstant(
			replayFixtureAt(
				T0 + 5 * MIN,
				weeklyFixture({ observedOffsetMs: 3 * MIN }),
			),
		);
		const weekly = observationLagChecks(
			weeklyReplay,
			scoreCohorts(weeklyReplay),
		);
		expect(byPath(weekly, "lifetime-primary")?.n).toBe(1);
		expect(byPath(weekly, "lifetime-primary")?.withinToleranceShare).toBe(1);
		expect(byPath(weekly, "other")?.n).toBe(0);

		// A now-anchored reading is neither anchored path, so it is reported
		// under `other` and never held to the parity expectation.
		const lowReplay = replayOfInstant(
			replayFixtureAt(T0 + 5 * MIN, weeklyFixture({ observed: false })),
		);
		const low = observationLagChecks(lowReplay, scoreCohorts(lowReplay));
		expect(byPath(low, "lifetime-primary")?.n).toBe(0);
		expect(byPath(low, "other")?.n).toBe(1);
	});

	test("buckets the observation ages, reconciling to the eligible count", () => {
		const ages = [-1 * MIN, MIN, 3 * MIN, 7 * MIN, 15 * MIN, null];
		const records: RedistributionRecord[] = [];
		ages.forEach((age, index) => {
			records.push(
				...perModel(`A${index}`, [T0 + index * 10 * MIN], {
					current: () => ({ observationAgeMs: age }),
					"scenario-equal": () => ({ observationAgeMs: age }),
					"scenario-equal-original": () => ({ observationAgeMs: age }),
					"scenario-headroom": () => ({ observationAgeMs: age }),
				}),
			);
		});
		for (const entry of records) {
			entry.lifecycleId = `${entry.accountId}::seven_day::0`;
		}
		const replay = replayOf(records);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		const combined = checks.ageGroups.find(
			(group) => group.scope === "combined",
		);
		expect(combined?.buckets.map((bucket) => bucket.label)).toEqual(
			OBSERVATION_AGE_BUCKETS.map((bucket) => bucket.label),
		);
		expect(combined?.buckets.map((bucket) => bucket.records)).toEqual([
			1, 1, 1, 1, 1,
		]);
		expect(combined?.unknown.records).toBe(1);
		const summed =
			(combined?.buckets.reduce((sum, bucket) => sum + bucket.records, 0) ??
				0) + (combined?.unknown.records ?? 0);
		expect(summed).toBe(combined?.eligible);
		expect(combined?.eligible).toBe(6);
	});

	test("the fixed subset takes only records every model dated", () => {
		const records = [
			...perModel("A", [T0]),
			...perModel("B", [T0], {
				"scenario-equal-original": () => ({
					predictsExhaust: false,
					predictedEtaMs: null,
				}),
			}),
		];
		const replay = replayOf(records);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		const overall = checks.pairedEta.filter((row) => row.cohort === "Overall");
		// The three models the subset is defined by, and only those.
		expect(overall.map((row) => row.model)).toEqual([
			"current",
			"scenario-equal",
			"scenario-equal-original",
		]);
		for (const row of overall) expect(row.n).toBe(1);
	});

	test("reports the lag population per estimator path", () => {
		const records = [
			...perModel("A", [T0], {
				current: () => ({
					estimatorSource: "regression",
					lagMs: 4 * MIN,
					observationAgeMs: 7 * MIN,
					sampleAgeMs: 4 * MIN,
				}),
			}),
			...perModel("B", [T0], {
				current: () => ({
					estimatorSource: "lifetime-primary",
					lagMs: 8 * MIN,
					observationAgeMs: 8 * MIN,
					sampleAgeMs: 5 * MIN,
				}),
			}),
		];
		const replay = replayOf(records);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		const byPath = new Map(checks.population.map((row) => [row.path, row]));
		expect(byPath.get("regression")?.records).toBe(1);
		expect(byPath.get("regression")?.medianLagMinutes).toBeCloseTo(4, 6);
		// sampled_at - observed_at, from the two ages the record carries.
		expect(
			byPath.get("regression")?.medianSampleToObservationMinutes,
		).toBeCloseTo(3, 6);
		expect(byPath.get("lifetime-primary")?.medianLagMinutes).toBeCloseTo(8, 6);
	});

	test("counts a record with no derivable anchor apart from the lags", () => {
		const records = [
			...perModel("A", [T0], {
				current: () => ({
					estimatorSource: "regression",
					lagMs: 4 * MIN,
					lagAnchorKnown: true,
				}),
			}),
			...perModel("B", [T0], {
				current: () => ({
					estimatorSource: "regression",
					lagMs: 0,
					lagAnchorKnown: false,
				}),
			}),
		];
		const replay = replayOf(records);
		const checks = observationLagChecks(replay, scoreCohorts(replay));
		const regression = checks.population.find(
			(row) => row.path === "regression",
		);
		expect(regression?.records).toBe(2);
		expect(regression?.noAnchorRecords).toBe(1);
		// The unrecoverable anchor is a 0 nobody measured: folding it in would
		// halve the median the correction actually moved this path by.
		expect(regression?.medianLagMinutes).toBeCloseTo(4, 6);
		expect(regression?.p90LagMinutes).toBeCloseTo(4, 6);
	});
});

describe("pairedAbsMedian", () => {
	test("medians the change in absolute error over records both models dated", () => {
		const records = [
			...perModel("A", [T0], {
				"scenario-equal": (T) => ({ predictedEtaMs: T + DAY + 10 * MIN }),
				"scenario-equal-original": (T) => ({
					predictedEtaMs: T + DAY + 30 * MIN,
				}),
			}),
			// Only one side committed to a date: not a pair.
			...perModel("B", [T0], {
				"scenario-equal-original": () => ({
					predictsExhaust: false,
					predictedEtaMs: null,
				}),
			}),
		];
		const delta = pairedAbsMedian(
			records,
			"scenario-equal",
			"scenario-equal-original",
		);
		expect(delta.n).toBe(1);
		expect(delta.medianDeltaMinutes).toBeCloseTo(-20, 6);
	});
});

describe("the observation-lag report section", () => {
	test("names every check and prints the original model beside the corrected one", () => {
		const fixture = pairFixture();
		const range: ReplayRange = {
			label: "test",
			fromMs: T0,
			toMs: T0 + 8 * DAY,
		};
		const result = replayRange(
			fixture.rows,
			fixture.accounts,
			range,
			60,
			20260823,
		);
		const { markdown } = reportFor(result, fixture.rows);
		for (const heading of [
			"## Observation-lag mechanism check",
			"### Observation age",
			"### Identity on lag-free class-instants",
			"### Lag shift",
			"### Parity with the current model on lone accounts",
			"### Fixed paired-ETA subset",
			"### Lag population by estimator path",
		]) {
			expect(markdown).toContain(heading);
		}
		// The section comes before the churn one, as declared.
		expect(markdown.indexOf("## Observation-lag mechanism check")).toBeLessThan(
			markdown.indexOf("## Prediction churn"),
		);
		expect(markdown).toContain("| scenario-equal-original |");
		expect(markdown).toContain(TRANSITION_BOOTSTRAP_LABEL);
		expect(markdown).toContain("| baseline |");
		expect(markdown).not.toContain("undefined");
		expect(markdown).not.toContain("NaN");
	});
});

// ---------------------------------------------------------------------------
// Absorption measurements: time to first 100 %
// ---------------------------------------------------------------------------

/** A five-hour window whose start is `reset - 5 h`, filling at `fillAt`. */
const fiveHourRamp =
	(start: number, reset: number, fillAt: number | null, cap = 99) =>
	(t: number) => ({
		pct:
			fillAt != null && t >= fillAt
				? 100
				: Math.min(cap, Math.max(0, ((t - start) / HOUR) * 25)),
		reset,
	});

const fillsFor = (
	snapshotRows: RosterSnapshotRow[],
	accounts: RosterAccount[],
	range: ReplayRange,
): ReplayResult => replayRange(snapshotRows, accounts, range, 6 * 60, 11);

const rowOf = (
	tally: WindowFillTally,
	exposure: string,
	window: WindowFillRow["window"],
): WindowFillRow => {
	const found = [...tally.prefixRows, ...tally.duringFillRows].find(
		(entry) => entry.exposure === exposure && entry.window === window,
	);
	if (!found) throw new Error(`no row for ${exposure} / ${window}`);
	return found;
};

/** One synthetic fill, filled at `+1 h` unless overridden. */
const windowFill = (over: Partial<WindowFill> = {}): WindowFill => ({
	accountId: "A",
	demandClass: "anthropic",
	windowKind: "five_hour",
	lifecycleId: `A::five_hour::${T0}`,
	windowStartMs: T0,
	labelResetAtMs: T0 + 5 * HOUR,
	firstSampleMs: T0,
	firstSampleUtilization: 0,
	lastSampleMs: T0 + 4 * HOUR,
	nextWindowStartsMs: T0 + 5 * HOUR,
	firstHundredMs: T0 + HOUR,
	resolutionMs: 10 * MIN,
	peerLostInPrefix: false,
	peerLostDuringFill: false,
	exposureObservable: true,
	duringFillObservable: true,
	...over,
});

describe("window fills", () => {
	test("the prefix is one hour on a five-hour window and 24 h on a weekly one", () => {
		expect(PEER_LOSS_PREFIX_MS).toEqual({
			five_hour: HOUR,
			seven_day: 24 * HOUR,
		});
	});

	test("measures from the derived window start, not the first sample", () => {
		const reset = T0 + 5 * HOUR;
		const snapshotRows = rows({
			accountId: "A",
			from: T0 + 40 * MIN,
			to: T0 + 4 * HOUR,
			stepMs: 10 * MIN,
			fiveHour: fiveHourRamp(T0, reset, T0 + 3 * HOUR),
		});
		const { fills } = fillsFor(snapshotRows, [account("A")], {
			label: "fill",
			fromMs: T0 - DAY,
			toMs: T0 + DAY,
		});

		expect(fills).toHaveLength(1);
		const fill = fills[0];
		expect(fill.windowStartMs).toBe(T0);
		expect(fill.firstSampleMs).toBe(T0 + 40 * MIN);
		expect(fill.firstHundredMs).toBe(T0 + 3 * HOUR);
		expect(fill.resolutionMs).toBe(10 * MIN);

		const metrics = windowFillMetrics(fill);
		expect(metrics.fillDurationMs).toBe(3 * HOUR);
		expect(metrics.observedSpanMs).toBe(3 * HOUR - 40 * MIN);
		expect(metrics.unobservedHeadMs).toBe(40 * MIN);
		// The 40 minutes of fill that happened before the first sample.
		expect((metrics.fillDurationMs ?? 0) - (metrics.observedSpanMs ?? 0)).toBe(
			40 * MIN,
		);
	});

	test("a window that never reaches 100 % is censored, not dropped", () => {
		const reset = T0 + 5 * HOUR;
		const snapshotRows = rows({
			accountId: "A",
			from: T0,
			to: T0 + 4 * HOUR,
			stepMs: 10 * MIN,
			fiveHour: fiveHourRamp(T0, reset, null, 80),
		});
		const { fills } = fillsFor(snapshotRows, [account("A")], {
			label: "censored",
			fromMs: T0 - DAY,
			toMs: T0 + DAY,
		});

		expect(fills).toHaveLength(1);
		expect(fills[0].firstHundredMs).toBeNull();
		expect(windowFillMetrics(fills[0]).fillDurationMs).toBeNull();

		const tally = tallyWindowFills(fills);
		expect(tally.filled).toBe(0);
		expect(tally.censored).toBe(1);
		expect(rowOf(tally, "no peer lost in prefix", "five_hour").censored).toBe(
			1,
		);
	});

	test("a segment with no reset is counted apart from the fills", () => {
		const reset = T0 + 5 * HOUR;
		const snapshotRows = [
			...rows({
				accountId: "A",
				from: T0,
				to: T0 + 2 * HOUR,
				stepMs: 10 * MIN,
				fiveHour: () => ({ pct: 20, reset }),
			}),
			...rows({
				accountId: "A",
				from: T0 + 2 * HOUR + 10 * MIN,
				to: T0 + 2 * HOUR + 30 * MIN,
				stepMs: 10 * MIN,
				fiveHour: () => ({ pct: 20, reset: null }),
			}),
		];
		const { fills } = fillsFor(snapshotRows, [account("A")], {
			label: "null-reset",
			fromMs: T0 - DAY,
			toMs: T0 + DAY,
		});

		expect(fills).toHaveLength(2);
		expect(fills.filter((fill) => fill.windowStartMs == null)).toHaveLength(1);

		const tally = tallyWindowFills(fills);
		expect(tally.noResetOnSegment).toBe(1);
		// The null-reset segment enters no arm: only the dated one is counted.
		expect(tally.filled + tally.censored).toBe(1);
	});

	test("a first sample already at 100 % is counted apart from the fills", () => {
		const snapshotRows = rows({
			accountId: "A",
			from: T0,
			to: T0 + HOUR,
			stepMs: 10 * MIN,
			fiveHour: () => ({ pct: 100, reset: T0 + 5 * HOUR }),
		});
		const { fills } = fillsFor(snapshotRows, [account("A")], {
			label: "already-full",
			fromMs: T0 - DAY,
			toMs: T0 + DAY,
		});

		expect(fills).toHaveLength(1);
		expect(fills[0].firstSampleUtilization).toBe(100);

		const tally = tallyWindowFills(fills);
		expect(tally.firstSampleAlreadyFull).toBe(1);
		expect(tally.filled + tally.censored).toBe(0);
		expect(rowOf(tally, "no peer lost in prefix", "combined").fills).toBe(0);
	});

	test("placeholder lifecycles never appear", () => {
		const snapshotRows = [
			// Two samples, never above 0 %: a codex-style artefact, not a window.
			...rows({
				accountId: "A",
				from: T0,
				to: T0 + 10 * MIN,
				stepMs: 10 * MIN,
				fiveHour: () => ({ pct: 0, reset: T0 + 2 * HOUR }),
			}),
			...rows({
				accountId: "A",
				from: T0 + 20 * MIN,
				to: T0 + 4 * HOUR,
				stepMs: 10 * MIN,
				fiveHour: fiveHourRamp(T0, T0 + 5 * HOUR, T0 + 3 * HOUR),
			}),
		];
		const result = fillsFor(snapshotRows, [account("A")], {
			label: "placeholder",
			fromMs: T0 - DAY,
			toMs: T0 + DAY,
		});

		expect(result.fills).toHaveLength(1);
		expect(result.fills[0].lifecycleId).toBe(`A::five_hour::${T0 + 20 * MIN}`);
		expect(result.placeholderLifecyclesSkipped).toBe(1);
	});

	test("segments on the reset boundary, so a jittered 5 h move splits", () => {
		const firstReset = T0 + 5 * HOUR;
		// Exactly one window later, with about a second of rollover jitter.
		const secondReset = firstReset + 5 * HOUR + 1_000;
		const snapshotRows = [
			...rows({
				accountId: "A",
				from: T0,
				to: T0 + 4 * HOUR + 50 * MIN,
				stepMs: 10 * MIN,
				fiveHour: fiveHourRamp(T0, firstReset, T0 + 3 * HOUR),
			}),
			...rows({
				accountId: "A",
				from: T0 + 5 * HOUR + 10 * MIN,
				to: T0 + 9 * HOUR,
				stepMs: 10 * MIN,
				fiveHour: fiveHourRamp(
					secondReset - 5 * HOUR,
					secondReset,
					T0 + 8 * HOUR,
				),
			}),
		];
		const { fills } = fillsFor(snapshotRows, [account("A")], {
			label: "jitter",
			fromMs: T0 - DAY,
			toMs: T0 + DAY,
		});

		expect(fills).toHaveLength(2);
		expect(fills.map((fill) => fill.firstHundredMs)).toEqual([
			T0 + 3 * HOUR,
			T0 + 8 * HOUR,
		]);
		expect(fills[1].windowStartMs).toBe(secondReset - 5 * HOUR);
	});
});

describe("window fill peer exposure", () => {
	/** A survivor filling at +4 h beside a peer that dies at `deathOffsetMs`. */
	const peerFixture = (deathOffsetMs: number) => {
		const reset = T0 + 5 * HOUR;
		return {
			rows: [
				...rows({
					accountId: "S",
					from: T0,
					to: T0 + 4 * HOUR + 50 * MIN,
					stepMs: 10 * MIN,
					fiveHour: fiveHourRamp(T0, reset, T0 + 4 * HOUR),
				}),
				...rows({
					accountId: "P",
					from: T0,
					to: T0 + 4 * HOUR + 50 * MIN,
					stepMs: 10 * MIN,
					fiveHour: fiveHourRamp(T0, reset, T0 + deathOffsetMs),
				}),
			],
			accounts: [account("S"), account("P")],
			range: { label: "peer", fromMs: T0 - HOUR, toMs: T0 + DAY },
		};
	};

	test("a peer death inside the fixed prefix sets peerLostInPrefix", () => {
		const fixture = peerFixture(30 * MIN);
		const { fills } = fillsFor(fixture.rows, fixture.accounts, fixture.range);
		const survivor = fills.find((fill) => fill.accountId === "S");
		expect(survivor?.peerLostInPrefix).toBe(true);
		expect(survivor?.peerLostDuringFill).toBe(true);
		expect(survivor?.exposureObservable).toBe(true);
	});

	test("a peer death past the prefix sets only peerLostDuringFill", () => {
		const fixture = peerFixture(90 * MIN);
		const { fills } = fillsFor(fixture.rows, fixture.accounts, fixture.range);
		const survivor = fills.find((fill) => fill.accountId === "S");
		expect(survivor?.peerLostInPrefix).toBe(false);
		expect(survivor?.peerLostDuringFill).toBe(true);
	});

	test("an account's own death never sets its own exposure", () => {
		const fixture = peerFixture(30 * MIN);
		const { fills } = fillsFor(fixture.rows, fixture.accounts, fixture.range);
		// P dies 30 min into its OWN window, which is inside its own prefix.
		const dying = fills.find((fill) => fill.accountId === "P");
		expect(dying?.firstHundredMs).toBe(T0 + 30 * MIN);
		expect(dying?.peerLostInPrefix).toBe(false);
		expect(dying?.peerLostDuringFill).toBe(false);
	});

	test("a peer's five-hour death sets the exposure on a weekly fill", () => {
		const snapshotRows = [
			...rows({
				accountId: "S",
				from: T0,
				to: T0 + 6 * DAY,
				stepMs: 6 * HOUR,
				sevenDay: weekly(T0, 20),
			}),
			...rows({
				accountId: "P",
				from: T0,
				to: T0 + 4 * HOUR,
				stepMs: 10 * MIN,
				fiveHour: fiveHourRamp(T0, T0 + 5 * HOUR, T0 + 3 * HOUR),
			}),
		];
		const result = fillsFor(snapshotRows, [account("S"), account("P")], {
			label: "cross-window",
			fromMs: T0 - HOUR,
			toMs: T0 + 8 * DAY,
		});

		const death = result.events.find(
			(event) => event.kind === "peer-exhaustion" && event.accountId === "P",
		);
		expect(death?.windowKind).toBe("five_hour");

		const weeklyFill = result.fills.find(
			(fill) => fill.accountId === "S" && fill.windowKind === "seven_day",
		);
		expect(weeklyFill?.windowStartMs).toBe(T0);
		expect(weeklyFill?.peerLostInPrefix).toBe(true);
	});

	test("a prefix that starts before the range enters neither arm", () => {
		const reset = T0 + 5 * HOUR;
		const snapshotRows = rows({
			accountId: "A",
			from: T0,
			to: T0 + 4 * HOUR,
			stepMs: 10 * MIN,
			fiveHour: fiveHourRamp(T0, reset, T0 + 3 * HOUR),
		});
		// The window starts 10 min before the replay does, so a peer death in its
		// prefix could not have been detected.
		const { fills } = fillsFor(snapshotRows, [account("A")], {
			label: "unobservable",
			fromMs: T0 + 10 * MIN,
			toMs: T0 + DAY,
		});

		expect(fills).toHaveLength(1);
		expect(fills[0].exposureObservable).toBe(false);

		const tally = tallyWindowFills(fills);
		expect(rowOf(tally, "peer lost in prefix", "combined").fills).toBe(0);
		expect(rowOf(tally, "no peer lost in prefix", "combined").fills).toBe(0);
		expect(rowOf(tally, "exposure unobservable", "combined").fills).toBe(1);
	});

	test("a fill running past the range is observable for the prefix split only", () => {
		const start = T0;
		const snapshotRows = rows({
			accountId: "A",
			from: start,
			to: start + 6 * DAY,
			stepMs: 6 * HOUR,
			sevenDay: weekly(start, 20),
		});
		// The 24 h prefix is wholly inside the range; the fill at +5 d is not.
		const { fills } = fillsFor(snapshotRows, [account("A")], {
			label: "during-fill",
			fromMs: start - HOUR,
			toMs: start + 3 * DAY,
		});

		expect(fills).toHaveLength(1);
		expect(fills[0].windowStartMs).toBe(start);
		expect(fills[0].firstHundredMs).toBe(start + 5 * DAY);
		expect(fills[0].exposureObservable).toBe(true);
		expect(fills[0].duringFillObservable).toBe(false);

		const tally = tallyWindowFills(fills);
		expect(
			rowOf(tally, "peer lost in prefix", "seven_day").fills +
				rowOf(tally, "no peer lost in prefix", "seven_day").fills,
		).toBe(1);
		expect(rowOf(tally, "peer lost during fill", "combined").fills).toBe(0);
		expect(rowOf(tally, "no peer lost during fill", "combined").fills).toBe(0);
		expect(
			rowOf(tally, "during-fill exposure unobservable", "combined").fills,
		).toBe(1);
	});

	test("the during-fill split is length-biased where the prefix split is not", () => {
		const reset = T0 + 5 * HOUR;
		const filler = (accountId: string, fillAt: number) =>
			rows({
				accountId,
				from: T0,
				to: T0 + 4 * HOUR + 50 * MIN,
				stepMs: 10 * MIN,
				fiveHour: fiveHourRamp(T0, reset, fillAt),
			});
		const snapshotRows = [
			...filler("X", T0 + 60 * MIN),
			...filler("Y", T0 + 240 * MIN),
			...filler("Z", T0 + 120 * MIN),
		];
		const { fills } = fillsFor(
			snapshotRows,
			[account("X"), account("Y"), account("Z")],
			{ label: "length-bias", fromMs: T0 - HOUR, toMs: T0 + DAY },
		);

		const shortFill = fills.find((fill) => fill.accountId === "X");
		const longFill = fills.find((fill) => fill.accountId === "Y");
		expect(shortFill?.firstHundredMs).toBe(T0 + 60 * MIN);
		expect(longFill?.firstHundredMs).toBe(T0 + 240 * MIN);

		// Z dies at +120 min: inside the long fill's calendar span and outside
		// the short one's, purely because the long fill is longer.
		expect(longFill?.peerLostDuringFill).toBe(true);
		expect(shortFill?.peerLostDuringFill).toBe(false);
		// The prefix is the same hour for both, and holds no peer death: X's own
		// death lands exactly on the half-open boundary at +60 min.
		expect(longFill?.peerLostInPrefix).toBe(false);
		expect(shortFill?.peerLostInPrefix).toBe(false);
	});
});

describe("tallyWindowFills", () => {
	test("censoring moves the fill fraction, not the median over the filled", () => {
		const filled = [
			windowFill({ lifecycleId: "A::1", firstHundredMs: T0 + HOUR }),
			windowFill({ lifecycleId: "A::2", firstHundredMs: T0 + 3 * HOUR }),
		];
		const censored = windowFill({
			lifecycleId: "A::3",
			firstHundredMs: null,
			resolutionMs: null,
			lastSampleMs: T0 + 4 * HOUR,
		});

		const withoutCensored = rowOf(
			tallyWindowFills(filled),
			"no peer lost in prefix",
			"five_hour",
		);
		const withCensored = rowOf(
			tallyWindowFills([...filled, censored]),
			"no peer lost in prefix",
			"five_hour",
		);

		expect(withoutCensored.censored).toBe(0);
		expect(withCensored.censored).toBe(1);
		expect(withoutCensored.fillFraction).toBe(1);
		expect(withCensored.fillFraction).toBeCloseTo(2 / 3, 10);
		expect(withCensored.medianFillHours).toBe(withoutCensored.medianFillHours);
		expect(withCensored.medianFillHours).toBe(1);
		expect(withCensored.medianCensoredSpanHours).toBe(4);
	});

	test("a window observed to its reset is completed below 100 %", () => {
		const tally = tallyWindowFills([
			windowFill({
				lifecycleId: "A::4",
				firstHundredMs: null,
				resolutionMs: null,
				// Ten minutes short of the reset: the slack the label rule allows.
				lastSampleMs: T0 + 5 * HOUR - SEGMENT_COVERAGE_SLACK_MS,
			}),
		]);
		const cell = rowOf(tally, "no peer lost in prefix", "five_hour");
		expect(cell.censored).toBe(1);
		expect(cell.completedBelowHundred).toBe(1);
		expect(cell.followUpIncomplete).toBe(0);
		expect(tally.completedBelowHundred).toBe(1);
		expect(tally.followUpIncomplete).toBe(0);
	});

	test("a window whose samples stop half an hour early is follow-up incomplete", () => {
		const tally = tallyWindowFills([
			windowFill({
				lifecycleId: "A::5",
				firstHundredMs: null,
				resolutionMs: null,
				lastSampleMs: T0 + 5 * HOUR - 30 * MIN,
			}),
		]);
		const cell = rowOf(tally, "no peer lost in prefix", "five_hour");
		expect(cell.censored).toBe(1);
		expect(cell.completedBelowHundred).toBe(0);
		expect(cell.followUpIncomplete).toBe(1);
		expect(tally.followUpIncomplete).toBe(1);
	});

	test("a censored window with no observed successor is follow-up incomplete", () => {
		// Two minutes short of its own reset, so proximity alone would call it
		// completed; `deriveOutcome` also requires the next window to have been
		// observed to start, and this one was never followed that far.
		const tally = tallyWindowFills([
			windowFill({
				lifecycleId: "A::10",
				firstHundredMs: null,
				resolutionMs: null,
				lastSampleMs: T0 + 5 * HOUR - 2 * MIN,
				nextWindowStartsMs: null,
			}),
		]);
		const cell = rowOf(tally, "no peer lost in prefix", "five_hour");
		expect(cell.censored).toBe(1);
		expect(cell.completedBelowHundred).toBe(0);
		expect(cell.followUpIncomplete).toBe(1);
		expect(tally.completedBelowHundred).toBe(0);
		expect(tally.followUpIncomplete).toBe(1);
	});

	test("a censored window with no reset on its segment is follow-up incomplete", () => {
		const tally = tallyWindowFills([
			windowFill({
				lifecycleId: "A::6",
				firstHundredMs: null,
				resolutionMs: null,
				labelResetAtMs: null,
			}),
		]);
		expect(tally.followUpIncomplete).toBe(1);
	});

	test("a window followed to its successor's start is completed below 100 %", () => {
		// Three hours short of its own reset, but the successor was observed to
		// start five minutes after the last sample. `deriveOutcome` ends a window
		// at the EARLIER of its reset and its successor's start and calls this one
		// survived, so the census has to end it at the same instant.
		const tally = tallyWindowFills([
			windowFill({
				lifecycleId: "A::11",
				firstHundredMs: null,
				resolutionMs: null,
				lastSampleMs: T0 + 2 * HOUR,
				nextWindowStartsMs: T0 + 2 * HOUR + 5 * MIN,
			}),
		]);
		const cell = rowOf(tally, "no peer lost in prefix", "five_hour");
		expect(cell.censored).toBe(1);
		expect(cell.completedBelowHundred).toBe(1);
		expect(cell.followUpIncomplete).toBe(0);
		expect(tally.completedBelowHundred).toBe(1);
		expect(tally.followUpIncomplete).toBe(0);
	});

	test("the censored span pools both censored kinds into one median", () => {
		// One window observed to its reset, two cut short: spans of about 4.8 h,
		// 1 h and 2 h from the same window start.
		const censored = (lifecycleId: string, lastSampleMs: number) =>
			windowFill({
				lifecycleId,
				firstHundredMs: null,
				resolutionMs: null,
				lastSampleMs,
			});
		const cell = rowOf(
			tallyWindowFills([
				censored("A::7", T0 + 5 * HOUR - SEGMENT_COVERAGE_SLACK_MS),
				censored("A::8", T0 + HOUR),
				censored("A::9", T0 + 2 * HOUR),
			]),
			"no peer lost in prefix",
			"five_hour",
		);
		expect(cell.completedBelowHundred).toBe(1);
		expect(cell.followUpIncomplete).toBe(2);
		// The median of all three spans. Over the follow-up-incomplete ones alone
		// it would be 1 h, over the completed one alone about 4.8 h.
		expect(cell.medianCensoredSpanHours).toBe(2);
	});

	test("an empty cell carries counts and nulls rather than NaN", () => {
		const tally = tallyWindowFills([]);
		const cell = rowOf(tally, "peer lost in prefix", "seven_day");
		expect(cell.fills).toBe(0);
		expect(cell.censored).toBe(0);
		expect(cell.completedBelowHundred).toBe(0);
		expect(cell.followUpIncomplete).toBe(0);
		expect(cell.fillFraction).toBeNull();
		expect(cell.medianFillHours).toBeNull();
		expect(cell.medianObservedSpanHours).toBeNull();
		expect(cell.medianUnobservedHeadMinutes).toBeNull();
		expect(cell.medianResolutionMinutes).toBeNull();
		expect(cell.medianCensoredSpanHours).toBeNull();
		expect(cell.fillDurationsHours).toEqual([]);
	});
});

describe("the absorption measurements section", () => {
	const absorptionReport = () => {
		const fixture = pairFixture();
		const range: ReplayRange = {
			label: "test",
			fromMs: T0,
			toMs: T0 + 8 * DAY,
		};
		const result = replayRange(
			fixture.rows,
			fixture.accounts,
			range,
			6 * 60,
			20260823,
		);
		return reportFor(result, fixture.rows);
	};

	test("emits the heading pair and prints no hole", () => {
		const { markdown } = absorptionReport();
		expect(markdown).toContain("## Absorption measurements");
		expect(markdown).toContain("### Time to first 100 %");
		expect(markdown).not.toContain("undefined");
		expect(markdown).not.toContain("NaN");
		// Between the bootstrap block and the observation-lag section. Anchored
		// on the heading line, because the slope section names the section too.
		const heading = markdown.indexOf("\n## Absorption measurements\n");
		expect(heading).toBeGreaterThan(markdown.indexOf("### Bootstrap"));
		expect(heading).toBeLessThan(
			markdown.indexOf("## Observation-lag mechanism check"),
		);
		// The slope table points at the direct measurement of its own question.
		expect(markdown).toContain(
			"The direct, slope-free measurement of the same question",
		);
	});

	test("renders an empty cell as a dash beside its counts", () => {
		const { markdown } = absorptionReport();
		// The fixture has weekly windows only, so every five-hour cell is empty.
		expect(markdown).toContain(
			"| peer lost in prefix | five_hour | 0 | 0 | 0 | — | — | — | — | — | — |",
		);
		expect(markdown).toContain("(0 fills): —");
	});

	test("states what the fill medians are conditional on, and the length bias", () => {
		const { markdown } = absorptionReport();
		expect(markdown).toContain("conditional on an observed fill");
		expect(markdown).toContain(
			"a larger censored fraction does not by itself establish a larger bias",
		);
		expect(markdown).not.toContain(
			"understates typical time-to-fill, and it understates it more in whichever cell censors more",
		);
		expect(markdown).toContain(
			"length-biased in the direction of longer fills",
		);
		expect(markdown).toContain(
			"equally consistent with absorption and with common cause",
		);
	});

	test("splits the censored windows into two counted columns", () => {
		const { markdown } = absorptionReport();
		expect(markdown).toContain("| completed below 100 % |");
		expect(markdown).toContain("| follow-up incomplete |");
		expect(markdown).toContain(
			"`completed below 100 %` counts the windows whose sampling ran to within",
		);
	});

	test("says the censored-span column covers both censored kinds", () => {
		const { markdown } = absorptionReport();
		expect(markdown).toContain("| median censored span, both kinds (h) |");
		expect(markdown).toContain(
			"it pools both censored kinds — completed below 100 % and follow-up incomplete — into one median",
		);
	});

	test("labels the exposure arms and reads the combined rows carefully", () => {
		const { markdown } = absorptionReport();
		expect(markdown).toContain("exposure labels");
		expect(markdown).toContain(
			"does not require the focal account to have been available when the peer died",
		);
		expect(markdown).toContain("already exhausted at the window start");
		expect(markdown).toContain("composition problem");
		expect(markdown).not.toContain("not a summary of anything");
		expect(markdown).toContain("the median summarises few observed fills");
	});

	test("reconciles every lifecycle it saw", () => {
		const { markdown } = absorptionReport();
		expect(markdown).toMatch(
			/Reconciliation: \d+ filled \+ \d+ completed below 100 % \+ \d+ follow-up incomplete \+ \d+ with no reset on the segment \+ \d+ already full at the first sample \+ \d+ placeholder lifecycles skipped = \d+ window lifecycles\./,
		);
	});

	test("names the sampled-crossing limit", () => {
		const { cohorts, replay } = verdictFixture(VERDICT_BASE);
		const limits = knownLimitsFor(
			replay,
			cohorts,
			evaluateVerdict(cohorts, replay),
		);
		expect(limits.some((limit) => limit.includes("sampled crossing"))).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// Request-volume changes around observed exhaustion
// ---------------------------------------------------------------------------

const ABS_D = T0 + 10 * DAY;
const ABS_RANGE: ReplayRange = {
	label: "absorption",
	fromMs: ABS_D - 8 * DAY,
	toMs: ABS_D + 8 * DAY,
};
/** The loaded request span: wide enough for a ±7 d control at W = 6 h. */
const ABS_FROM = ABS_D - 9 * DAY;
const ABS_TO = ABS_D + 9 * DAY;

/**
 * Minute buckets at a constant rate over `[from, to)`, aligned to the grid the
 * loader groups on.
 */
function buckets(spec: {
	accountId: string;
	from: number;
	to: number;
	perMinute: number;
	tokensPerMinute?: number;
}): RequestBucket[] {
	const out: RequestBucket[] = [];
	const first = Math.ceil(spec.from / REQUEST_BUCKET_MS) * REQUEST_BUCKET_MS;
	for (let t = first; t < spec.to; t += REQUEST_BUCKET_MS) {
		out.push({
			accountId: spec.accountId,
			bucketStartMs: t,
			requests: spec.perMinute,
			tokens: spec.tokensPerMinute ?? spec.perMinute * 1000,
		});
	}
	return out;
}

function deathEvent(over: Partial<TransitionEvent> = {}): TransitionEvent {
	return {
		id: 1,
		kind: "peer-exhaustion",
		atMs: ABS_D,
		endsAtMs: ABS_D + DAY,
		demandClass: "anthropic",
		accountId: "D",
		accountName: "acct-d",
		windowKind: "five_hour",
		detail: "five_hour hit 100 %",
		...over,
	};
}

const ABS_ACCOUNTS: RosterAccount[] = [
	account("D"),
	account("S1"),
	account("S2"),
];

/** One account's observed availability, as snapshot rows the timeline reads. */
interface AvailabilitySpec {
	accountId: string;
	/** Intervals `[from, to)` the account reads 100 % over. */
	exhausted?: Array<[number, number]>;
	/** Intervals `[from, to)` with no samples at all: an unknown stretch. */
	gaps?: Array<[number, number]>;
	fromMs?: number;
	toMs?: number;
}

/**
 * Snapshot rows on a five-minute grid, half the staleness bar, so a stretch is
 * `unknown` only where the spec says to drop the samples.
 */
function availabilityRows(specs: AvailabilitySpec[]): RosterSnapshotRow[] {
	const out: RosterSnapshotRow[] = [];
	for (const spec of specs) {
		const inside = (list: Array<[number, number]> | undefined, t: number) =>
			(list ?? []).some(([from, to]) => t >= from && t < to);
		out.push(
			...rows({
				accountId: spec.accountId,
				from: spec.fromMs ?? ABS_FROM,
				to: spec.toMs ?? ABS_TO,
				stepMs: 5 * MIN,
				skip: (t) => inside(spec.gaps, t),
				fiveHour: (t) => ({
					pct: inside(spec.exhausted, t) ? 100 : 20,
					reset: null,
				}),
			}),
		);
	}
	return out;
}

const absSeries = (
	specs: AvailabilitySpec[],
	accounts: RosterAccount[] = ABS_ACCOUNTS,
): Map<string, AccountSeries> =>
	prepareSeries(availabilityRows(specs), accounts);

/** The dying account available until `D` and exhausted after it; peers alive. */
const ABS_SERIES = absSeries([
	{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
	{ accountId: "S1" },
	{ accountId: "S2" },
]);

function absorptionInput(over: Partial<AbsorptionInput> = {}): AbsorptionInput {
	return {
		events: [deathEvent()],
		accounts: ABS_ACCOUNTS,
		series: ABS_SERIES,
		buckets: [],
		range: ABS_RANGE,
		requestsFromMs: ABS_FROM,
		requestsToMs: ABS_TO,
		...over,
	};
}

/** Flat traffic either side of an instant, with a rate step at it. */
function flatBuckets(spec: {
	accountId: string;
	prePerMinute: number;
	postPerMinute: number;
	preTokensPerMinute?: number;
	postTokensPerMinute?: number;
	atMs?: number;
	from?: number;
	to?: number;
}): RequestBucket[] {
	const at = spec.atMs ?? ABS_D;
	return [
		...buckets({
			accountId: spec.accountId,
			from: spec.from ?? at - 12 * HOUR,
			to: at,
			perMinute: spec.prePerMinute,
			tokensPerMinute: spec.preTokensPerMinute,
		}),
		...buckets({
			accountId: spec.accountId,
			from: at,
			to: spec.to ?? at + 12 * HOUR,
			perMinute: spec.postPerMinute,
			tokensPerMinute: spec.postTokensPerMinute,
		}),
	];
}

/**
 * Flat before the death, doubled after it, tripled again from the +7 d control
 * on: the two matched controls therefore carry DIFFERENT ratios, so a paired
 * delta that dropped an eligible control would print a different number.
 */
function controlBuckets(): RequestBucket[] {
	const survivor = (accountId: string): RequestBucket[] => [
		...buckets({ accountId, from: ABS_FROM, to: ABS_D, perMinute: 5 }),
		...buckets({
			accountId,
			from: ABS_D,
			to: ABS_D + 7 * DAY,
			perMinute: 10,
		}),
		...buckets({
			accountId,
			from: ABS_D + 7 * DAY,
			to: ABS_TO,
			perMinute: 30,
		}),
	];
	return [
		...buckets({ accountId: "D", from: ABS_FROM, to: ABS_D, perMinute: 10 }),
		...survivor("S1"),
		...survivor("S2"),
	];
}

describe("account availability", () => {
	const timelineFor = (
		snapshotRows: RosterSnapshotRow[],
		accountId = "A",
	): AvailabilityTimeline => {
		const timelines = buildAvailabilityTimelines(
			prepareSeries(snapshotRows, [account(accountId)]),
		);
		const timeline = timelines.get(accountId);
		if (timeline == null) throw new Error("no timeline");
		return timeline;
	};

	test("a reading at or above 100 % on either window is exhausted", () => {
		const timeline = timelineFor(
			rows({
				accountId: "A",
				from: T0,
				to: T0 + HOUR,
				stepMs: 5 * MIN,
				fiveHour: () => ({ pct: 40, reset: T0 + 5 * HOUR }),
				sevenDay: () => ({ pct: 100, reset: T0 + 7 * DAY }),
			}),
		);
		expect(availabilityAt(timeline, T0 + 30 * MIN)).toBe("exhausted");
	});

	test("a reading below 100 % on both windows is available", () => {
		const timeline = timelineFor(
			rows({
				accountId: "A",
				from: T0,
				to: T0 + HOUR,
				stepMs: 5 * MIN,
				fiveHour: () => ({ pct: 40, reset: T0 + 5 * HOUR }),
				sevenDay: () => ({ pct: 99.9, reset: T0 + 7 * DAY }),
			}),
		);
		expect(availabilityAt(timeline, T0 + 30 * MIN)).toBe("available");
	});

	test("no reading inside the staleness bar is unknown, not available", () => {
		const timeline = timelineFor(
			rows({
				accountId: "A",
				from: T0,
				to: T0 + HOUR,
				stepMs: 5 * MIN,
				fiveHour: () => ({ pct: 40, reset: T0 + 5 * HOUR }),
			}),
		);
		// Before any sample, and past the bar after the last one. The bar is
		// inclusive, as `buildRosterAtInstant` reads it: a reading exactly
		// READING_STALE_MS old is still projected from.
		expect(availabilityAt(timeline, T0 - MIN)).toBe("unknown");
		expect(availabilityAt(timeline, T0 + HOUR + READING_STALE_MS - 1)).toBe(
			"available",
		);
		expect(availabilityAt(timeline, T0 + HOUR + READING_STALE_MS)).toBe(
			"available",
		);
		expect(availabilityAt(timeline, T0 + HOUR + READING_STALE_MS + 1)).toBe(
			"unknown",
		);
	});

	test("the staleness bar matches the roster's at the expiry instant", () => {
		const last = T0 + HOUR;
		const expiry = last + READING_STALE_MS;
		const reading = (from: number, to: number): RosterSnapshotRow[] =>
			rows({
				accountId: "A",
				from,
				to,
				stepMs: 5 * MIN,
				fiveHour: () => ({ pct: 40, reset: T0 + 5 * HOUR }),
			});
		const base = reading(T0, last);

		for (const offset of [-1, 0, 1]) {
			const T = expiry + offset;
			for (const replacement of [false, true]) {
				const snapshotRows = replacement ? [...base, ...reading(T, T)] : base;
				const series = prepareSeries(snapshotRows, [account("A")]);
				const timeline = buildAvailabilityTimelines(series).get("A");
				const roster = buildRosterAtInstant(T, series, [account("A")]);
				const inRoster = roster.accounts.some(
					(entry) => entry.accountId === "A",
				);
				expect(availabilityAt(timeline, T) !== "unknown").toBe(inRoster);
				expect(inRoster).toBe(replacement || offset <= 0);
			}
		}
	});

	test("a row with both windows null reads as unknown, not available", () => {
		const timeline = timelineFor(
			rows({ accountId: "A", from: T0, to: T0 + HOUR, stepMs: 5 * MIN }),
		);
		expect(availabilityAt(timeline, T0 + 30 * MIN)).toBe("unknown");
	});

	test("a single null window imposes no constraint of its own", () => {
		// The Codex placeholder shape: no five-hour reading, a live weekly one.
		const under = timelineFor(
			rows({
				accountId: "A",
				from: T0,
				to: T0 + HOUR,
				stepMs: 5 * MIN,
				sevenDay: () => ({ pct: 40, reset: T0 + 7 * DAY }),
			}),
		);
		expect(availabilityAt(under, T0 + 30 * MIN)).toBe("available");

		const over = timelineFor(
			rows({
				accountId: "A",
				from: T0,
				to: T0 + HOUR,
				stepMs: 5 * MIN,
				sevenDay: () => ({ pct: 100, reset: T0 + 7 * DAY }),
			}),
		);
		expect(availabilityAt(over, T0 + 30 * MIN)).toBe("exhausted");
	});

	test("an exhausted account whose readings go null is unknown, not revived", () => {
		const timeline = timelineFor([
			...rows({
				accountId: "A",
				from: T0,
				to: T0 + 30 * MIN,
				stepMs: 5 * MIN,
				fiveHour: () => ({ pct: 100, reset: T0 + 5 * HOUR }),
			}),
			...rows({
				accountId: "A",
				from: T0 + 35 * MIN,
				to: T0 + HOUR,
				stepMs: 5 * MIN,
			}),
		]);
		expect(availabilityAt(timeline, T0 + 30 * MIN)).toBe("exhausted");
		expect(availabilityAt(timeline, T0 + 40 * MIN)).toBe("unknown");
		expect(availabilityAt(timeline, T0 + HOUR)).toBe("unknown");
	});

	test("the nearest state change is measured on either side", () => {
		const timeline = timelineFor(
			rows({
				accountId: "A",
				from: T0,
				to: T0 + 4 * HOUR,
				stepMs: 5 * MIN,
				fiveHour: (t) => ({
					pct: t >= T0 + 2 * HOUR && t < T0 + 3 * HOUR ? 100 : 10,
					reset: T0 + 5 * HOUR,
				}),
			}),
		);
		// 20 minutes before the revival at +3 h, 40 after the death at +2 h.
		expect(
			nearestAvailabilityChangeMs(timeline, T0 + 2 * HOUR + 40 * MIN),
		).toBe(20 * MIN);
		// The change at the instant itself is ignorable, for the dying account.
		expect(
			nearestAvailabilityChangeMs(timeline, T0 + 2 * HOUR, {
				ignoreAtMs: T0 + 2 * HOUR,
			}),
		).toBe(HOUR);
	});
});

describe("absorptionChecks survivor set", () => {
	const traffic = (): RequestBucket[] => [
		...flatBuckets({ accountId: "D", prePerMinute: 10, postPerMinute: 0 }),
		...flatBuckets({ accountId: "S1", prePerMinute: 5, postPerMinute: 10 }),
		...flatBuckets({ accountId: "S2", prePerMinute: 5, postPerMinute: 10 }),
	];

	test("a peer exhausted just before the death is excluded from S and listed", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2", exhausted: [[ABS_D - 3 * DAY, ABS_TO + 1]] },
				]),
			}),
		);
		expect(checks.deaths).toHaveLength(1);
		const death = checks.deaths[0];
		expect(death.survivorIds).toEqual(["S1"]);
		expect(death.excludedMembers).toEqual([
			{ accountId: "S2", state: "exhausted" },
		]);
		expect(
			death.narrow.measurements.requests.survivors.map(
				(entry) => entry.accountId,
			),
		).toEqual(["S1"]);
	});

	test("a peer with no reading inside the bar is listed as unknown", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2", gaps: [[ABS_D - 2 * HOUR, ABS_D + 2 * HOUR]] },
				]),
			}),
		);
		const death = checks.deaths[0];
		expect(death.survivorIds).toEqual(["S1"]);
		expect(death.excludedMembers).toEqual([
			{ accountId: "S2", state: "unknown" },
		]);
	});

	test("a dying account already exhausted on its other window is excluded", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D - 2 * DAY, ABS_TO + 1]] },
					{ accountId: "S1" },
					{ accountId: "S2" },
				]),
			}),
		);
		expect(checks.deaths).toHaveLength(0);
		expect(checks.excluded.alreadyExhausted).toBe(1);
		expect(checks.excludedDeaths[0].reason).toBe("alreadyExhausted");
	});

	test("a dying account with no reading before the death is excluded as unknown", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{
						accountId: "D",
						exhausted: [[ABS_D, ABS_D + 12 * HOUR]],
						gaps: [[ABS_D - 2 * HOUR, ABS_D]],
					},
					{ accountId: "S1" },
					{ accountId: "S2" },
				]),
			}),
		);
		expect(checks.deaths).toHaveLength(0);
		expect(checks.excluded.dyingStateUnknown).toBe(1);
	});
});

describe("absorptionChecks interval", () => {
	const traffic = (): RequestBucket[] => [
		...flatBuckets({
			accountId: "D",
			prePerMinute: 10,
			postPerMinute: 0,
			from: ABS_D - 12 * HOUR,
			to: ABS_D + 12 * HOUR,
		}),
		...flatBuckets({
			accountId: "S1",
			prePerMinute: 5,
			postPerMinute: 10,
			from: ABS_D - 12 * HOUR,
			to: ABS_D + 12 * HOUR,
		}),
		...flatBuckets({
			accountId: "S2",
			prePerMinute: 5,
			postPerMinute: 10,
			from: ABS_D - 12 * HOUR,
			to: ABS_D + 12 * HOUR,
		}),
	];

	test("a survivor reviving 20 minutes after the death caps both halves", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					// Exhausted well before the death, back 20 minutes after it: it is
					// not in S, and its revival is a regime change all the same.
					{
						accountId: "S2",
						exhausted: [[ABS_D - 3 * DAY, ABS_D + 20 * MIN]],
					},
				]),
			}),
		);
		const death = checks.deaths[0];
		expect(death.availabilityBoundMs).toBe(20 * MIN);
		expect(death.narrow.halfWidthMs).toBe(20 * MIN);
		expect(death.narrow.measurements.requests.preMinutes).toBe(20);
		expect(death.narrow.measurements.requests.postMinutes).toBe(20);
	});

	test("a survivor of S changing state 25 minutes before the death caps W", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					// Available again 25 minutes before the death.
					{
						accountId: "S2",
						exhausted: [[ABS_D - 3 * DAY, ABS_D - 25 * MIN]],
					},
				]),
			}),
		);
		const death = checks.deaths[0];
		expect(death.availabilityBoundMs).toBe(25 * MIN);
		expect(death.narrow.halfWidthMs).toBe(25 * MIN);
	});

	test("an unknown stretch inside the interval caps W at its start", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					// Samples stop 15 minutes after the death; the staleness bar makes
					// the account unknown ten minutes after the last one.
					{
						accountId: "S2",
						gaps: [[ABS_D + 20 * MIN, ABS_D + 4 * HOUR]],
					},
				]),
			}),
		);
		const death = checks.deaths[0];
		// Last sample at +15 min on the five-minute grid; the bar is inclusive,
		// so the reading is still projectable at +25 min and unknown begins one
		// millisecond later.
		expect(death.availabilityBoundMs).toBe(15 * MIN + READING_STALE_MS + 1);
		expect(death.narrow.halfWidthMs).toBe(25 * MIN + 1);
	});

	test("a bound under fifteen minutes excludes the death and records it", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2", exhausted: [[ABS_D + 10 * MIN, ABS_TO + 1]] },
				]),
			}),
		);
		expect(checks.deaths).toHaveLength(0);
		expect(checks.excluded.intervalTooShort).toBe(1);
		expect(checks.excludedDeaths[0].reason).toBe("intervalTooShort");
		expect(checks.excludedDeaths[0].boundMs).toBe(10 * MIN);
		expect(checks.excludedDeaths[0].detail).toContain("S2");
	});

	test("the narrow horizon is measured where the wide one collapses onto it", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2", exhausted: [[ABS_D + 40 * MIN, ABS_TO + 1]] },
				]),
			}),
		);
		const death = checks.deaths[0];
		expect(death.availabilityBoundMs).toBe(40 * MIN);
		expect(death.narrow.halfWidthMs).toBe(40 * MIN);
		expect(death.narrow.measurements.requests.preMinutes).toBe(40);
		expect(death.wide).toBeNull();
		expect(death.wideAbsentReason).toContain("40");
	});

	test("nothing near the death leaves both horizons at their own width", () => {
		const checks = absorptionChecks(
			absorptionInput({ buckets: controlBuckets() }),
		);
		const death = checks.deaths[0];
		expect(death.narrow.halfWidthMs).toBe(60 * MIN);
		expect(death.wide?.halfWidthMs).toBe(6 * HOUR);
		expect(death.wideAbsentReason).toBeNull();
	});

	test("the pre-death weights do not move with a survivor exhausting later", () => {
		// Identical up to D, and identical requests: the only difference is a
		// survivor leaving 30 minutes AFTER the death, which no quantity
		// computable at D may see.
		const stable = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2" },
				]),
			}),
		);
		const churned = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2", exhausted: [[ABS_D + 30 * MIN, ABS_TO + 1]] },
				]),
			}),
		);
		const a = stable.deaths[0];
		const b = churned.deaths[0];
		expect(a.survivorIds).toEqual(b.survivorIds);

		// The symmetric interval DOES move: that is what the future bounds.
		expect(a.narrow.halfWidthMs).toBe(60 * MIN);
		expect(b.narrow.halfWidthMs).toBe(30 * MIN);
		// The pre-only lookback does not.
		expect(a.narrow.preWeightHalfWidthMs).toBe(60 * MIN);
		expect(b.narrow.preWeightHalfWidthMs).toBe(60 * MIN);

		for (const basis of ["requests", "tokens"] as const) {
			expect(b.narrow.measurements[basis].dyingPreShare).toBe(
				a.narrow.measurements[basis].dyingPreShare,
			);
			expect(b.narrow.measurements[basis].equalSplitShare).toBe(
				a.narrow.measurements[basis].equalSplitShare,
			);
			expect(
				b.narrow.measurements[basis].survivors.map((entry) => entry.preShare),
			).toEqual(
				a.narrow.measurements[basis].survivors.map((entry) => entry.preShare),
			);
		}
	});

	test("the pre-only lookback stops at a change before the death", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2", exhausted: [[ABS_D - 3 * DAY, ABS_D - 25 * MIN]] },
				]),
			}),
		);
		const death = checks.deaths[0];
		expect(death.narrow.halfWidthMs).toBe(25 * MIN);
		expect(death.narrow.preWeightHalfWidthMs).toBe(25 * MIN);
	});

	test("an account created after the death bounds W and stays out of S", () => {
		const late = account("L", { createdAtMs: ABS_D + 20 * MIN });
		const accounts = [...ABS_ACCOUNTS, late];
		const checks = absorptionChecks(
			absorptionInput({
				accounts,
				series: absSeries(
					[
						{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
						{ accountId: "S1" },
						{ accountId: "S2" },
						{ accountId: "L", fromMs: ABS_D + 20 * MIN },
					],
					accounts,
				),
				buckets: traffic(),
			}),
		);
		const death = checks.deaths[0];
		expect(death.survivorIds).toEqual(["S1", "S2"]);
		expect(death.availabilityBoundMs).toBe(20 * MIN);
		expect(death.availabilityBoundAccountId).toBe("L");
		expect(death.narrow.halfWidthMs).toBe(20 * MIN);
	});

	test("an account created after the death still rejects a control", () => {
		const late = account("L", { createdAtMs: ABS_D + 3 * DAY });
		const accounts = [...ABS_ACCOUNTS, late];
		const checks = absorptionChecks(
			absorptionInput({
				accounts,
				series: absSeries(
					[
						{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
						{ accountId: "S1" },
						{ accountId: "S2" },
						{
							accountId: "L",
							fromMs: ABS_D + 3 * DAY,
							exhausted: [
								[ABS_D + 7 * DAY - 20 * MIN, ABS_D + 7 * DAY + 20 * MIN],
							],
						},
					],
					accounts,
				),
				buckets: controlBuckets(),
			}),
		);
		const death = checks.deaths[0];
		expect(death.survivorIds).toEqual(["S1", "S2"]);
		expect(death.narrow.controls[0].eligible).toBe(true);
		expect(death.narrow.controls[1].eligible).toBe(false);
		expect(death.narrow.controls[1].rejection).toBe(
			"availability-change-inside",
		);
		expect(death.narrow.controls[1].rejectionDetail).toContain("L");
	});

	test("the pre-only lookback stops at the edge of the loaded requests", () => {
		// The 30 minutes before the death are loaded; the 30 before those are not
		// there at all. `X` reviving at +30 min caps `W` at 30 min, so the death is
		// measured; read over the 60-minute cap instead, the weights would count
		// the unloaded half as no traffic rather than as no data.
		const accounts = [...ABS_ACCOUNTS, account("X")];
		const near = (
			accountId: string,
			preRate: number,
			postRate: number,
		): RequestBucket[] => [
			...buckets({
				accountId,
				from: ABS_D - 30 * MIN,
				to: ABS_D,
				perMinute: preRate,
			}),
			...buckets({
				accountId,
				from: ABS_D,
				to: ABS_D + 30 * MIN,
				perMinute: postRate,
			}),
		];
		// Dying-heavy in the earlier half, evenly split in the later one, so the
		// two widths do not agree on the pre-share.
		const full = (
			accountId: string,
			earlyRate: number,
			lateRate: number,
			postRate: number,
		): RequestBucket[] => [
			...buckets({
				accountId,
				from: ABS_D - 12 * HOUR,
				to: ABS_D - 30 * MIN,
				perMinute: earlyRate,
			}),
			...buckets({
				accountId,
				from: ABS_D - 30 * MIN,
				to: ABS_D,
				perMinute: lateRate,
			}),
			...buckets({
				accountId,
				from: ABS_D,
				to: ABS_D + 12 * HOUR,
				perMinute: postRate,
			}),
		];
		const presentBuckets = [
			...full("D", 10, 10, 0),
			...full("S1", 1, 5, 10),
			...full("S2", 1, 5, 10),
		];

		const truncated = absorptionChecks(
			absorptionInput({
				accounts,
				requestsFromMs: ABS_D - 30 * MIN,
				requestsToMs: ABS_D + 30 * MIN,
				buckets: [
					...near("D", 10, 0),
					...near("S1", 5, 10),
					...near("S2", 5, 10),
				],
				series: absSeries(
					[
						{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
						{ accountId: "S1" },
						{ accountId: "S2" },
						{
							accountId: "X",
							exhausted: [[ABS_D - 3 * DAY, ABS_D + 30 * MIN]],
						},
					],
					accounts,
				),
			}),
		);
		const death = truncated.deaths[0];
		expect(death.survivorIds).toEqual(["S1", "S2"]);
		expect(death.narrow.halfWidthMs).toBe(30 * MIN);
		expect(death.narrow.preWeightHalfWidthMs).toBe(30 * MIN);
		expect(death.narrow.preWeightBoundedBy).toBe("coverage");
		// The rates the weights divide by: over the 60-minute cap the same volume
		// would read as half the rate, with the missing half counted as zero.
		expect(death.narrow.measurements.requests.preWeightMinutes).toBe(30);
		expect(death.narrow.measurements.requests.preWeightRateDying).toBe(10);
		expect(death.narrow.measurements.requests.preWeightRateSurvivors).toBe(10);

		// The identical buckets over the identical `W_pre`, shortened by a class
		// member's availability instead of by the loaded span.
		const present = absorptionChecks(
			absorptionInput({
				accounts,
				buckets: presentBuckets,
				series: absSeries(
					[
						{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
						{ accountId: "S1" },
						{ accountId: "S2" },
						{
							accountId: "X",
							exhausted: [[ABS_D - 30 * MIN, ABS_D + 12 * HOUR]],
						},
					],
					accounts,
				),
			}),
		);
		const matched = present.deaths[0];
		expect(matched.survivorIds).toEqual(["S1", "S2"]);
		expect(matched.narrow.preWeightHalfWidthMs).toBe(30 * MIN);
		expect(matched.narrow.preWeightBoundedBy).toBe("availability");
		for (const basis of ["requests", "tokens"] as const) {
			const shortened = death.narrow.measurements[basis];
			const reference = matched.narrow.measurements[basis];
			expect(shortened.preWeightMinutes).toBe(reference.preWeightMinutes);
			expect(shortened.preWeightRateDying).toBe(reference.preWeightRateDying);
			expect(shortened.preWeightRateSurvivors).toBe(
				reference.preWeightRateSurvivors,
			);
			expect(shortened.dyingPreShare).toBe(reference.dyingPreShare);
			expect(shortened.survivors.map((entry) => entry.preShare)).toEqual(
				reference.survivors.map((entry) => entry.preShare),
			);
		}

		// The same buckets read over the full 60-minute cap: the earlier half is
		// dying-heavy, so the width the weights are taken over moves the share.
		const uncapped = absorptionChecks(
			absorptionInput({ buckets: presentBuckets }),
		).deaths[0];
		expect(uncapped.narrow.preWeightHalfWidthMs).toBe(60 * MIN);
		expect(uncapped.narrow.preWeightBoundedBy).toBe("cap");
		expect(uncapped.narrow.measurements.requests.dyingPreShare).toBeCloseTo(
			0.625,
			10,
		);
		expect(death.narrow.measurements.requests.dyingPreShare).toBeCloseTo(
			0.5,
			10,
		);
	});

	test("an account created 20 minutes after the death caps W at its creation", () => {
		// Creation and the first snapshot do NOT coincide here: the account exists
		// from +20 min and is first sampled at +40 min, and it is the creation that
		// changed the class.
		const late = account("L", { createdAtMs: ABS_D + 20 * MIN });
		const accounts = [...ABS_ACCOUNTS, late];
		const checks = absorptionChecks(
			absorptionInput({
				accounts,
				series: absSeries(
					[
						{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
						{ accountId: "S1" },
						{ accountId: "S2" },
						{ accountId: "L", fromMs: ABS_D + 40 * MIN },
					],
					accounts,
				),
				buckets: traffic(),
			}),
		);
		const death = checks.deaths[0];
		expect(death.survivorIds).toEqual(["S1", "S2"]);
		expect(death.availabilityBoundMs).toBe(20 * MIN);
		expect(death.availabilityBoundAccountId).toBe("L");
		expect(death.narrow.halfWidthMs).toBe(20 * MIN);
	});

	test("an account created inside a control interval rejects that control", () => {
		// Never sampled at all, so no availability transition exists to find: the
		// creation is the only change the class went through.
		const late = account("L", { createdAtMs: ABS_D + 7 * DAY });
		const accounts = [...ABS_ACCOUNTS, late];
		const checks = absorptionChecks(
			absorptionInput({
				accounts,
				series: absSeries(
					[
						{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
						{ accountId: "S1" },
						{ accountId: "S2" },
					],
					accounts,
				),
				buckets: controlBuckets(),
			}),
		);
		const death = checks.deaths[0];
		expect(death.survivorIds).toEqual(["S1", "S2"]);
		expect(death.narrow.halfWidthMs).toBe(60 * MIN);
		expect(death.narrow.controls[0].eligible).toBe(true);
		expect(death.narrow.controls[1].eligible).toBe(false);
		expect(death.narrow.controls[1].rejection).toBe(
			"availability-change-inside",
		);
		expect(death.narrow.controls[1].rejectionDetail).toContain("L");
	});

	test("request coverage of 90 minutes keeps the primary and drops the wide", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: traffic(),
				requestsFromMs: ABS_D - 90 * MIN,
				requestsToMs: ABS_D + 90 * MIN,
			}),
		);
		expect(checks.excluded.outsideLoadedSpan).toBe(0);
		expect(checks.deaths).toHaveLength(1);
		const death = checks.deaths[0];
		expect(death.narrow.halfWidthMs).toBe(60 * MIN);
		expect(death.narrow.measurements.requests.preMinutes).toBe(60);
		expect(death.wide).toBeNull();
		expect(death.wideAbsentReason).toContain("request coverage");
	});
});

describe("absorptionChecks", () => {
	test("no post-death bucket enters any pre-death share or weight", () => {
		const pre = [
			...buckets({
				accountId: "D",
				from: ABS_D - 12 * HOUR,
				to: ABS_D,
				perMinute: 10,
			}),
			...buckets({
				accountId: "S1",
				from: ABS_D - 12 * HOUR,
				to: ABS_D,
				perMinute: 6,
			}),
			...buckets({
				accountId: "S2",
				from: ABS_D - 12 * HOUR,
				to: ABS_D,
				perMinute: 2,
			}),
		];
		const postOf = (perMinute: number): RequestBucket[] => [
			...buckets({
				accountId: "S1",
				from: ABS_D,
				to: ABS_D + 12 * HOUR,
				perMinute,
			}),
			...buckets({
				accountId: "S2",
				from: ABS_D,
				to: ABS_D + 12 * HOUR,
				perMinute,
			}),
		];

		const huge = absorptionChecks(
			absorptionInput({ buckets: [...pre, ...postOf(1_000_000)] }),
		).deaths[0];
		const zero = absorptionChecks(
			absorptionInput({ buckets: [...pre, ...postOf(0)] }),
		).deaths[0];

		for (const basis of ["requests", "tokens"] as const) {
			const a = huge.wide?.measurements[basis];
			const b = zero.wide?.measurements[basis];
			expect(a?.preRateDying).toBe(b?.preRateDying);
			expect(a?.preRateSurvivors).toBe(b?.preRateSurvivors);
			expect(a?.dyingPreShare).toBe(b?.dyingPreShare);
			expect(a?.equalSplitShare).toBe(b?.equalSplitShare);
			expect(a?.survivors.map((entry) => entry.preRate)).toEqual(
				b?.survivors.map((entry) => entry.preRate) ?? [],
			);
			expect(a?.survivors.map((entry) => entry.preShare)).toEqual(
				b?.survivors.map((entry) => entry.preShare) ?? [],
			);
			// Only the post-death observables move.
			expect(a?.alpha).not.toBe(b?.alpha);
			expect(a?.survivorRateRatio).not.toBe(b?.survivorRateRatio);
			expect(a?.largestGainShare).not.toBe(b?.largestGainShare);
		}
		// The shares are the ones the pre-death rates imply, not the equal split.
		const wide = huge.wide?.measurements.requests;
		expect(wide?.dyingPreShare).toBeCloseTo(10 / 18, 12);
		expect(wide?.survivors[0].preShare).toBeCloseTo(0.75, 12);
		expect(wide?.equalSplitShare).toBeCloseTo(0.5, 12);
	});

	test("alpha is 1 when the survivors take exactly the dying rate", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: [
					...flatBuckets({
						accountId: "D",
						prePerMinute: 10,
						postPerMinute: 0,
					}),
					...flatBuckets({
						accountId: "S1",
						prePerMinute: 5,
						postPerMinute: 10,
					}),
					...flatBuckets({
						accountId: "S2",
						prePerMinute: 5,
						postPerMinute: 10,
					}),
				],
			}),
		);
		expect(checks.deaths).toHaveLength(1);
		const wide = checks.deaths[0].wide?.measurements.requests;
		expect(wide?.alpha).toBeCloseTo(1, 12);
		expect(wide?.survivorRateRatio).toBeCloseTo(2, 12);
	});

	test("alpha is 0 when the dying traffic simply stops", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: [
					...flatBuckets({
						accountId: "D",
						prePerMinute: 10,
						postPerMinute: 0,
					}),
					...flatBuckets({
						accountId: "S1",
						prePerMinute: 5,
						postPerMinute: 5,
					}),
					...flatBuckets({
						accountId: "S2",
						prePerMinute: 5,
						postPerMinute: 5,
					}),
				],
			}),
		);
		const wide = checks.deaths[0].wide?.measurements.requests;
		expect(wide?.alpha).toBeCloseTo(0, 12);
		expect(wide?.survivorRateRatio).toBeCloseTo(1, 12);
	});

	test("the per-survivor contributions sum to alpha", () => {
		const accounts = [...ABS_ACCOUNTS, account("S3")];
		const checks = absorptionChecks(
			absorptionInput({
				accounts,
				series: absSeries(
					[
						{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
						{ accountId: "S1" },
						{ accountId: "S2" },
						{ accountId: "S3" },
					],
					accounts,
				),
				buckets: [
					...flatBuckets({
						accountId: "D",
						prePerMinute: 10,
						postPerMinute: 0,
					}),
					// Mixed signs: one gains, one gains less, one loses.
					...flatBuckets({
						accountId: "S1",
						prePerMinute: 5,
						postPerMinute: 12,
					}),
					...flatBuckets({
						accountId: "S2",
						prePerMinute: 4,
						postPerMinute: 6,
					}),
					...flatBuckets({
						accountId: "S3",
						prePerMinute: 6,
						postPerMinute: 1,
					}),
				],
			}),
		);
		for (const basis of ["requests", "tokens"] as const) {
			for (const horizon of [checks.deaths[0].narrow, checks.deaths[0].wide]) {
				const cell = horizon?.measurements[basis];
				if (cell == null) throw new Error("no measurement");
				const sum = cell.survivors.reduce(
					(total, entry) => total + (entry.contribution ?? 0),
					0,
				);
				expect(cell.alpha).not.toBeNull();
				expect(sum).toBeCloseTo(cell.alpha ?? 0, 9);
			}
		}
	});

	test("the largest gain share splits the positive changes, not the net", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: [
					...flatBuckets({
						accountId: "D",
						prePerMinute: 10,
						postPerMinute: 0,
					}),
					...flatBuckets({
						accountId: "S1",
						prePerMinute: 4,
						postPerMinute: 10,
					}),
					...flatBuckets({
						accountId: "S2",
						prePerMinute: 4,
						postPerMinute: 6,
					}),
				],
			}),
		);
		const wide = checks.deaths[0].wide?.measurements.requests;
		expect(wide?.grossPositive).toBeCloseTo(8, 12);
		expect(wide?.grossNegative).toBeCloseTo(0, 12);
		expect(wide?.netChange).toBeCloseTo(8, 12);
		expect(wide?.largestGainShare).toBeCloseTo(0.75, 12);
	});

	test("the largest gain share is null when the net change is not positive", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: [
					...flatBuckets({
						accountId: "D",
						prePerMinute: 10,
						postPerMinute: 0,
					}),
					// One rises, the other falls further: G <= 0, so the share of the
					// positive changes describes nothing.
					...flatBuckets({
						accountId: "S1",
						prePerMinute: 5,
						postPerMinute: 7,
					}),
					...flatBuckets({
						accountId: "S2",
						prePerMinute: 5,
						postPerMinute: 1,
					}),
				],
			}),
		);
		const wide = checks.deaths[0].wide?.measurements.requests;
		expect(wide?.grossPositive).toBeCloseTo(2, 12);
		expect(wide?.grossNegative).toBeCloseTo(4, 12);
		expect(wide?.netChange).toBeCloseTo(-2, 12);
		expect(wide?.largestGainShare).toBeNull();
	});

	test("the bucket straddling the death enters neither half", () => {
		const at = ABS_D + 30_000;
		const steady = (accountId: string, perMinute: number): RequestBucket[] =>
			buckets({
				accountId,
				from: ABS_D - 6 * HOUR,
				to: ABS_D + 6 * HOUR + REQUEST_BUCKET_MS,
				perMinute,
			});
		const checks = absorptionChecks(
			absorptionInput({
				events: [deathEvent({ atMs: at, endsAtMs: at + DAY })],
				series: absSeries([
					{ accountId: "D", toMs: at - 1 },
					{
						accountId: "D",
						fromMs: at,
						exhausted: [[at, at + 12 * HOUR]],
					},
					{ accountId: "S1" },
					{ accountId: "S2" },
				]),
				buckets: [
					...steady("D", 10),
					...steady("S1", 5),
					...steady("S2", 5),
					// The whole of one minute's volume, in the minute the death
					// falls inside.
					{
						accountId: "S1",
						bucketStartMs: ABS_D,
						requests: 1_000_000,
						tokens: 1_000_000_000,
					},
				],
			}),
		);
		const wide = checks.deaths[0].wide?.measurements.requests;
		// Six hours of whole minutes either side, less the straddled one.
		expect(wide?.preMinutes).toBe(359);
		expect(wide?.postMinutes).toBe(359);
		expect(wide?.preVolumeDying).toBe(10 * 359);
		expect(wide?.preVolumeSurvivors).toBe(2 * 5 * 359);
		expect(wide?.postVolumeSurvivors).toBe(2 * 5 * 359);
	});

	test("a dying account with no pre-death traffic is excluded, never coerced to zero", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: [
					...flatBuckets({ accountId: "D", prePerMinute: 0, postPerMinute: 4 }),
					...flatBuckets({
						accountId: "S1",
						prePerMinute: 5,
						postPerMinute: 8,
					}),
					...flatBuckets({
						accountId: "S2",
						prePerMinute: 5,
						postPerMinute: 8,
					}),
				],
			}),
		);
		expect(checks.deaths).toHaveLength(0);
		expect(checks.excluded.noPreDeathDyingTraffic).toBe(1);

		// The same absence one basis down: the requests are there, the tokens are
		// not, so the token alpha has no denominator and says so.
		const mixed = absorptionChecks(
			absorptionInput({
				buckets: [
					...flatBuckets({
						accountId: "D",
						prePerMinute: 10,
						postPerMinute: 0,
						preTokensPerMinute: 0,
						postTokensPerMinute: 0,
					}),
					...flatBuckets({
						accountId: "S1",
						prePerMinute: 5,
						postPerMinute: 8,
					}),
					...flatBuckets({
						accountId: "S2",
						prePerMinute: 5,
						postPerMinute: 8,
					}),
				],
			}),
		);
		expect(mixed.deaths).toHaveLength(1);
		expect(mixed.deaths[0].wide?.measurements.tokens.alpha).toBeNull();
		expect(
			mixed.deaths[0].wide?.measurements.tokens.survivors[0].contribution,
		).toBeNull();
		expect(mixed.deaths[0].wide?.measurements.requests.alpha).toBeCloseTo(
			0.6,
			12,
		);
	});

	test("a control whose survivor changes state inside it is rejected by name", () => {
		const clean = absorptionChecks(
			absorptionInput({ buckets: controlBuckets() }),
		);
		const cleanDeath = clean.deaths[0];
		expect(
			cleanDeath.narrow.controls.map((control) => control.eligible),
		).toEqual([true, true]);
		expect(cleanDeath.narrow.controlsEligible).toBe(2);
		expect(
			cleanDeath.narrow.controls[0].measurements?.requests.survivorRateRatio,
		).toBeCloseTo(1, 12);
		expect(
			cleanDeath.narrow.controls[1].measurements?.requests.survivorRateRatio,
		).toBeCloseTo(3, 12);
		// The control reads the death's own survivor set and half-width.
		expect(
			cleanDeath.narrow.controls[0].measurements?.requests.survivors.map(
				(entry) => entry.accountId,
			),
		).toEqual(cleanDeath.survivorIds);
		expect(
			cleanDeath.narrow.controls[0].measurements?.requests.preMinutes,
		).toBe(cleanDeath.narrow.measurements.requests.preMinutes);
		// Ratio at death 2, mean control ratio (1 + 3) / 2 = 2.
		const cleanPaired = clean.paired.find(
			(entry) => entry.basis === "requests" && entry.horizon === "narrow",
		);
		expect(cleanPaired?.n).toBe(1);
		expect(cleanPaired?.medianDelta).toBeCloseTo(0, 12);

		const blocked = absorptionChecks(
			absorptionInput({
				buckets: controlBuckets(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{
						accountId: "S2",
						exhausted: [
							[ABS_D - 7 * DAY - 20 * MIN, ABS_D - 7 * DAY + 20 * MIN],
						],
					},
				]),
			}),
		);
		const death = blocked.deaths[0];
		expect(death.narrow.controls[0].eligible).toBe(false);
		expect(death.narrow.controls[0].rejection).toBe(
			"availability-change-inside",
		);
		expect(death.narrow.controls[0].rejectionDetail).toContain("S2");
		expect(death.narrow.controls[0].measurements).toBeNull();
		expect(death.narrow.controls[1].eligible).toBe(true);
		expect(death.narrow.controlsEligible).toBe(1);
		// Only the accepted control feeds the delta: 2 − 3 = −1.
		const blockedPaired = blocked.paired.find(
			(entry) => entry.basis === "requests" && entry.horizon === "narrow",
		);
		expect(blockedPaired?.medianDelta).toBeCloseTo(-1, 12);
	});

	test("a control interval outside the loaded request span is rejected, not read as silence", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: controlBuckets(),
				requestsFromMs: ABS_D - 3 * DAY,
			}),
		);
		const death = checks.deaths[0];
		expect(death.narrow.controls[0].eligible).toBe(false);
		expect(death.narrow.controls[0].rejection).toBe("outside-loaded-span");
		expect(death.narrow.controls[0].measurements).toBeNull();
		expect(death.narrow.controls[1].eligible).toBe(true);
		expect(
			checks.controlsIneligible["outside-loaded-span"],
		).toBeGreaterThanOrEqual(1);
	});

	test("a class member that joins after the death is in neither the death nor its controls", () => {
		const late = account("L", { createdAtMs: ABS_D + DAY });
		const accounts = [...ABS_ACCOUNTS, late];
		const checks = absorptionChecks(
			absorptionInput({
				accounts,
				series: absSeries(
					[
						{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
						{ accountId: "S1" },
						{ accountId: "S2" },
						{ accountId: "L" },
					],
					accounts,
				),
				buckets: [
					...controlBuckets(),
					...buckets({
						accountId: "L",
						from: ABS_FROM,
						to: ABS_TO,
						perMinute: 50,
					}),
				],
			}),
		);
		const death = checks.deaths[0];
		expect(death.survivorIds).toEqual(["S1", "S2"]);
		expect(
			death.narrow.measurements.requests.survivors.map(
				(entry) => entry.accountId,
			),
		).toEqual(["S1", "S2"]);
		for (const control of death.narrow.controls) {
			expect(
				control.measurements?.requests.survivors.map(
					(entry) => entry.accountId,
				),
			).toEqual(["S1", "S2"]);
		}
	});

	test("an empty other class reports no concurrent context rather than a number", () => {
		const checks = absorptionChecks(
			absorptionInput({ buckets: controlBuckets() }),
		);
		expect(checks.deaths[0].narrow.placebo).toBeNull();
		const rows = checks.groups.filter(
			(row) => row.population === ABSORPTION_POPULATION_LABELS.placeboNarrow,
		);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.measurements).toBe(0);
			expect(row.survivorRateRatio.median).toBeNull();
			expect(row.alpha.median).toBeNull();
		}
	});

	test("no buckets at all excludes every death for want of request coverage", () => {
		const checks = absorptionChecks(absorptionInput({ buckets: [] }));
		expect(checks.deaths).toHaveLength(0);
		expect(checks.excluded.noRequestCoverage).toBe(1);
		expect(checks.peerExhaustionEvents).toBe(1);
		for (const row of checks.groups) {
			expect(row.measurements).toBe(0);
			expect(row.survivorRateRatio.median).toBeNull();
			expect(row.largestGainShare.median).toBeNull();
		}
		for (const entry of checks.paired) {
			expect(entry.n).toBe(0);
			expect(entry.medianDelta).toBeNull();
		}
	});

	test("the two bases are computed independently and can disagree", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: [
					...flatBuckets({
						accountId: "D",
						prePerMinute: 10,
						postPerMinute: 0,
						preTokensPerMinute: 10_000,
						postTokensPerMinute: 0,
					}),
					// Many small requests: the request rate doubles while the token
					// rate barely moves.
					...flatBuckets({
						accountId: "S1",
						prePerMinute: 5,
						postPerMinute: 10,
						preTokensPerMinute: 5_000,
						postTokensPerMinute: 5_100,
					}),
					...flatBuckets({
						accountId: "S2",
						prePerMinute: 5,
						postPerMinute: 10,
						preTokensPerMinute: 5_000,
						postTokensPerMinute: 5_100,
					}),
				],
			}),
		);
		const wide = checks.deaths[0].wide?.measurements;
		expect(wide?.requests.alpha).toBeCloseTo(1, 12);
		expect(wide?.tokens.alpha).toBeCloseTo(0.02, 12);
		expect(wide?.requests.survivorRateRatio).toBeCloseTo(2, 12);
		expect(wide?.tokens.survivorRateRatio).toBeCloseTo(1.02, 12);
	});

	test("each aggregate statistic carries its own denominator", () => {
		// Two deaths of the same class, days apart in the availability history so
		// neither bounds the other's interval. The first has survivors with no
		// pre-death traffic (no ratio); the second has a net loss (no largest-gain
		// share).
		const second = ABS_D + 3 * DAY;
		const checks = absorptionChecks(
			absorptionInput({
				events: [
					deathEvent(),
					deathEvent({
						id: 2,
						atMs: second,
						endsAtMs: second + DAY,
						accountId: "S2",
						accountName: "acct-s2",
					}),
				],
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2", exhausted: [[second, ABS_TO + 1]] },
				]),
				buckets: [
					// First death: the survivors start from nothing, so the ratio has
					// no denominator while the gain share does.
					...buckets({
						accountId: "D",
						from: ABS_D - 12 * HOUR,
						to: ABS_D,
						perMinute: 10,
					}),
					...buckets({
						accountId: "S1",
						from: ABS_D,
						to: ABS_D + 2 * HOUR,
						perMinute: 4,
					}),
					// Second death: S1 loses traffic, so G <= 0 and the gain share has
					// no denominator while the ratio does.
					...buckets({
						accountId: "S2",
						from: second - 12 * HOUR,
						to: second,
						perMinute: 10,
					}),
					...buckets({
						accountId: "S1",
						from: second - 12 * HOUR,
						to: second,
						perMinute: 8,
					}),
					...buckets({
						accountId: "S1",
						from: second,
						to: second + 12 * HOUR,
						perMinute: 2,
					}),
				],
			}),
		);
		expect(checks.deaths).toHaveLength(2);
		const row = checks.groups.find(
			(entry) =>
				entry.population === ABSORPTION_POPULATION_LABELS.narrow &&
				entry.basis === "requests",
		);
		expect(row?.measurements).toBe(2);
		expect(row?.survivorRateRatio.n).toBe(1);
		expect(row?.largestGainShare.n).toBe(1);
		expect(row?.alpha.n).toBe(2);
	});

	test("both windows filling in one sample are one departure with two kinds", () => {
		const checks = absorptionChecks(
			absorptionInput({
				events: [
					deathEvent({ id: 1, windowKind: "five_hour" }),
					deathEvent({ id: 2, windowKind: "seven_day" }),
				],
				buckets: controlBuckets(),
			}),
		);
		expect(checks.peerExhaustionEvents).toBe(2);
		expect(checks.deaths).toHaveLength(1);
		expect(checks.deaths[0].windowKinds).toEqual(["five_hour", "seven_day"]);
		expect(checks.foldedSimultaneous).toBe(1);
		// The two folded events share one S and one W, so measuring both would
		// have counted the same departure twice.
		expect(checks.deaths[0].survivorIds).toEqual(["S1", "S2"]);

		const total =
			checks.deaths.length +
			checks.foldedSimultaneous +
			ABSORPTION_EXCLUSION_REASONS.reduce(
				(sum, reason) => sum + checks.excluded[reason],
				0,
			);
		expect(total).toBe(checks.peerExhaustionEvents);
	});

	test("the reconciliation accounts for every peer-exhaustion event in range", () => {
		const checks = absorptionChecks(
			absorptionInput({
				events: [
					deathEvent(),
					deathEvent({
						id: 2,
						demandClass: "codex",
						accountId: "C1",
						accountName: "acct-c1",
					}),
				],
				buckets: controlBuckets(),
			}),
		);
		const total =
			checks.deaths.length +
			checks.foldedSimultaneous +
			ABSORPTION_EXCLUSION_REASONS.reduce(
				(sum, reason) => sum + checks.excluded[reason],
				0,
			);
		expect(checks.peerExhaustionEvents).toBe(2);
		expect(checks.foldedSimultaneous).toBe(0);
		expect(total).toBe(checks.peerExhaustionEvents);
		expect(checks.excluded.noSurvivors).toBe(1);
	});

	test("the other class's accounts are the concurrent context, with no dying share", () => {
		const codex = account("C1", {
			provider: "codex",
			createdAtMs: T0 - 30 * DAY,
		});
		const accounts = [...ABS_ACCOUNTS, codex];
		const checks = absorptionChecks(
			absorptionInput({
				accounts,
				series: absSeries(
					[
						{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
						{ accountId: "S1" },
						{ accountId: "S2" },
						{ accountId: "C1" },
					],
					accounts,
				),
				buckets: [
					...controlBuckets(),
					...flatBuckets({
						accountId: "C1",
						prePerMinute: 4,
						postPerMinute: 6,
					}),
				],
			}),
		);
		const placebo = checks.deaths[0].wide?.placebo;
		expect(placebo?.requests.survivorRateRatio).toBeCloseTo(1.5, 12);
		expect(placebo?.requests.dyingPreShare).toBeNull();
		expect(placebo?.requests.alpha).toBeNull();
		expect(
			checks.groups.find(
				(row) =>
					row.population === ABSORPTION_POPULATION_LABELS.placeboWide &&
					row.basis === "requests",
			)?.measurements,
		).toBe(1);
	});
});

describe("the request-volume report section", () => {
	const reportWith = (absorption: AbsorptionChecks | null): string => {
		const fixture = pairFixture();
		const result = replayRange(
			fixture.rows,
			fixture.accounts,
			{ label: "test", fromMs: T0, toMs: T0 + 8 * DAY },
			6 * 60,
			20260823,
		);
		const cohorts = scoreCohorts(result);
		const verdict = evaluateVerdict(cohorts, result);
		return reportOf(result, cohorts, verdict, fixture.rows.length, absorption);
	};

	const measured = (): AbsorptionChecks =>
		absorptionChecks(absorptionInput({ buckets: controlBuckets() }));

	/** The whole section body, below its own `##` line. */
	const sectionBody = (markdown: string): string => {
		const heading = "\n## Absorption measurements\n";
		const start = markdown.indexOf(heading);
		expect(start).toBeGreaterThan(-1);
		const from = start + heading.length;
		const end = markdown.indexOf("\n## ", from);
		return markdown.slice(from, end === -1 ? undefined : end);
	};

	/** The subsection alone, so a claim about it is not read off another one. */
	const subsection = (markdown: string): string => {
		const start = markdown.indexOf(
			"### Request-volume changes around observed exhaustion",
		);
		expect(start).toBeGreaterThan(-1);
		const end = markdown.indexOf("\n## ", start);
		return markdown.slice(start, end === -1 ? undefined : end);
	};

	test("emits the renamed subsection and prints no hole", () => {
		const markdown = reportWith(measured());
		expect(markdown).toContain(
			"### Request-volume changes around observed exhaustion",
		);
		expect(markdown).not.toContain("undefined");
		expect(markdown).not.toContain("NaN");
		const heading = markdown.indexOf(
			"### Request-volume changes around observed exhaustion",
		);
		expect(heading).toBeGreaterThan(
			markdown.indexOf("### Time to first 100 %"),
		);
		expect(heading).toBeLessThan(
			markdown.indexOf("## Observation-lag mechanism check"),
		);
	});

	test("never states that the demand reached the survivors", () => {
		const body = sectionBody(reportWith(measured()));
		for (const phrase of [
			"lands on the survivors",
			"absorbing",
			"absorbed",
			"absorption of",
		]) {
			expect(body).not.toContain(phrase);
		}
		expect(body).toContain(
			"how fill durations and fill fractions differ between the exposure groups",
		);
		expect(body).toContain("whether demand moved is not identified here");
	});

	test("claims no causality and drops the pool-wide-surge sentence", () => {
		const section = subsection(reportWith(measured()));
		expect(section).not.toContain("causal");
		expect(section).not.toContain("Causal");
		expect(section).not.toContain("removes a pool-wide surge");
		expect(section).toContain("concurrent context");
		expect(section).toContain("substitute between providers");
	});

	test("states the timing misalignment rather than a signed bias", () => {
		const section = subsection(reportWith(measured()));
		expect(section).toContain("persistence lag");
		expect(section).toContain(
			"direction and magnitude of the resulting error are unmeasured",
		);
		expect(section).toContain("first sampled 100 % reading");
		expect(section).not.toContain("biases alpha upward");
	});

	test("states what alpha depends on and how the population was selected", () => {
		const section = subsection(reportWith(measured()));
		expect(section).toContain(
			"alpha = (ratio - 1) * preRateSurv / preRateDying",
		);
		expect(section).toContain(
			"does not measure a fraction of the dying account's demand",
		);
		expect(section).toContain("zero pre-death traffic");
		expect(section).toContain("rapid cascades");
		expect(section).toContain("sufficiently-isolated departures");
		expect(section).toContain(
			"largest account's share of positive rate increases",
		);
		expect(section).not.toContain("share of moved volume");
	});

	test("says the request table was unreadable when it could not be loaded", () => {
		const markdown = reportWith(null);
		expect(markdown).toContain(
			"### Request-volume changes around observed exhaustion",
		);
		expect(markdown).toContain("request table was unreadable");
		expect(markdown).not.toContain("undefined");
	});

	test("prints its zero rows rather than an empty table when no death is analysed", () => {
		const markdown = reportWith(
			absorptionChecks(absorptionInput({ buckets: [] })),
		);
		expect(markdown).toContain(
			`| ${ABSORPTION_POPULATION_LABELS.narrow} | requests | 0 |`,
		);
		expect(markdown).toContain("No death was analysed in this run");
	});

	test("prints the 60-minute row above the six-hour one, and the pairing as a row", () => {
		const markdown = reportWith(measured());
		const narrow = markdown.indexOf(
			`| ${ABSORPTION_POPULATION_LABELS.narrow} | requests |`,
		);
		const wide = markdown.indexOf(
			`| ${ABSORPTION_POPULATION_LABELS.wide} | requests |`,
		);
		const control = markdown.indexOf(
			`| ${ABSORPTION_POPULATION_LABELS.controlBeforeNarrow} | requests |`,
		);
		expect(narrow).toBeGreaterThan(-1);
		expect(narrow).toBeLessThan(wide);
		expect(wide).toBeLessThan(control);
		expect(markdown).toContain(
			"paired median of (ratio at death − mean ratio at eligible controls)",
		);
	});

	test("prints each survivor, each control and the excluded members", () => {
		const checks = absorptionChecks(
			absorptionInput({
				buckets: controlBuckets(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2", exhausted: [[ABS_FROM, ABS_TO + 1]] },
				]),
			}),
		);
		const markdown = reportWith(checks);
		expect(markdown).toContain("contribution");
		expect(markdown).toContain("excluded members: S2 (exhausted)");
		expect(markdown).toContain("control -7 d");
	});

	/** UUID-style ids with names that share no substring with them. */
	const namedAccounts = [
		account("1135d045-dying", { name: "acct-dying" }),
		account("2acdf5e9-surv", { name: "acct-survivor" }),
		account("3bd0e7aa-gone", { name: "acct-excluded" }),
	];

	const namedChecks = (): AbsorptionChecks =>
		absorptionChecks(
			absorptionInput({
				accounts: namedAccounts,
				events: [
					deathEvent({
						accountId: "1135d045-dying",
						accountName: "acct-dying",
					}),
				],
				series: absSeries(
					[
						{
							accountId: "1135d045-dying",
							exhausted: [[ABS_D, ABS_D + 12 * HOUR]],
						},
						{ accountId: "2acdf5e9-surv" },
						{ accountId: "3bd0e7aa-gone", exhausted: [[ABS_FROM, ABS_TO + 1]] },
					],
					namedAccounts,
				),
				buckets: [
					...flatBuckets({
						accountId: "1135d045-dying",
						prePerMinute: 10,
						postPerMinute: 0,
					}),
					...flatBuckets({
						accountId: "2acdf5e9-surv",
						prePerMinute: 5,
						postPerMinute: 10,
					}),
					...flatBuckets({
						accountId: "3bd0e7aa-gone",
						prePerMinute: 5,
						postPerMinute: 5,
					}),
				],
			}),
		);

	test("prints every account of the block by name rather than by id", () => {
		const checks = namedChecks();
		expect(checks.deaths).toHaveLength(1);
		const section = subsection(reportWith(checks));
		expect(section).toContain("S = `acct-survivor`");
		expect(section).toContain("- `acct-survivor`: requests pre");
		expect(section).toContain("excluded members: acct-excluded (exhausted)");
		expect(section).toContain("set by `acct-dying`");
		for (const accountId of namedAccounts.map((entry) => entry.accountId)) {
			expect(section).not.toContain(accountId);
		}
	});

	test("names the peers of a death that had no survivor at all", () => {
		const accounts = [
			account("1135d045-dying", { name: "acct-dying" }),
			account("2acdf5e9-surv", { name: "acct-survivor" }),
		];
		const checks = absorptionChecks(
			absorptionInput({
				accounts,
				events: [
					deathEvent({
						accountId: "1135d045-dying",
						accountName: "acct-dying",
					}),
				],
				series: absSeries(
					[
						{
							accountId: "1135d045-dying",
							exhausted: [[ABS_D, ABS_D + 12 * HOUR]],
						},
						{ accountId: "2acdf5e9-surv", exhausted: [[ABS_FROM, ABS_TO + 1]] },
					],
					accounts,
				),
				buckets: controlBuckets(),
			}),
		);
		expect(checks.excluded.noSurvivors).toBe(1);
		const section = subsection(reportWith(checks));
		expect(section).toContain("every peer was acct-survivor (exhausted)");
		expect(section).not.toContain("2acdf5e9-surv");
	});

	test("prints token rates as whole tokens and request rates to three decimals", () => {
		const section = subsection(reportWith(namedChecks()));
		const survivorLine = section
			.split("\n")
			.find((line) => line.includes("`acct-survivor`: requests"));
		expect(survivorLine).toBeDefined();
		expect(survivorLine).toMatch(
			/requests pre -?\d+\.\d{3}, post -?\d+\.\d{3}, delta -?\d+\.\d{3}, contribution/,
		);
		expect(survivorLine).toMatch(
			/tokens pre -?\d+, post -?\d+, delta -?\d+, contribution/,
		);

		// P, N and G on the tokens row are rate sums, and print as whole tokens.
		// Their columns are read off the header rather than counted by hand, so a
		// new column moves the check with the table instead of past it.
		const headerCells = section
			.split("\n")
			.find((line) => line.startsWith("| horizon | basis | W_pre (min) |"))
			?.split("|")
			.map((cell) => cell.trim());
		expect(headerCells).toBeDefined();
		const rateSumColumns = ["P", "N", "G"].map((column) => {
			const index = (headerCells ?? []).indexOf(column);
			expect(index).toBeGreaterThan(-1);
			return index;
		});

		const tokenRow = section
			.split("\n")
			.find((line) => line.startsWith("| W = 60 min | tokens |"));
		expect(tokenRow).toBeDefined();
		const cells = (tokenRow ?? "").split("|").map((cell) => cell.trim());
		for (const index of rateSumColumns) {
			expect(cells[index]).toMatch(/^-?\d+$/);
		}
		const requestRow = section
			.split("\n")
			.find((line) => line.startsWith("| W = 60 min | requests |"));
		const requestCells = (requestRow ?? "").split("|").map((c) => c.trim());
		for (const index of rateSumColumns) {
			expect(requestCells[index]).toMatch(/^-?\d+\.\d{3}$/);
		}
	});

	test("prints both bases without preferring either", () => {
		const section = subsection(reportWith(measured()));
		expect(section).toContain(
			"where the two disagree, both are printed, and neither is preferred here",
		);
		expect(section).not.toContain("that disagreement is the finding");
	});

	test("attributes a fill to the account's own demand, not to the class", () => {
		const section = subsection(reportWith(measured()));
		expect(section).toContain(
			"A window fills because its account was busy, and often its class with it.",
		);
		expect(section).not.toContain("Deaths happen because the class is busy");
		expect(section).toContain("not removable from observational data");
	});

	test("states what the matched control tests rather than a conclusion", () => {
		const section = subsection(reportWith(measured()));
		expect(section).toContain(
			"Whether the workload repeats at a one-week offset is what the control ratios show",
		);
		expect(section).not.toContain("not weekly-periodic");
		expect(section).toContain("so the reader can see which");
	});

	test("keeps the pairing out of the aggregate's ratio columns", () => {
		const section = subsection(reportWith(measured()));
		expect(section).toContain("| measurements in population |");
		const aggregate = section.indexOf("| population | basis |");
		const pairing = section.indexOf("| pairing | basis | n | median delta |");
		const pairedRow = section.indexOf(
			"| paired median of (ratio at death − mean ratio at eligible controls)",
		);
		expect(aggregate).toBeGreaterThan(-1);
		expect(pairing).toBeGreaterThan(aggregate);
		expect(pairedRow).toBeGreaterThan(pairing);
		// Four cells, so no ratio column is reused for the difference.
		const row = section.slice(pairedRow, section.indexOf("\n", pairedRow));
		expect(row.split("|").filter((cell) => cell.trim() !== "")).toHaveLength(4);
		expect(section).toContain("difference of two ratios rather than a ratio");
	});

	test("labels the horizon populations as caps and prints the actual widths", () => {
		expect(ABSORPTION_POPULATION_LABELS.narrow).toContain("W ≤ 60 min");
		expect(ABSORPTION_POPULATION_LABELS.wide).toContain("W ≤ 6 h");

		const checks = absorptionChecks(
			absorptionInput({
				buckets: controlBuckets(),
				series: absSeries([
					{ accountId: "D", exhausted: [[ABS_D, ABS_D + 12 * HOUR]] },
					{ accountId: "S1" },
					{ accountId: "S2", exhausted: [[ABS_D + 40 * MIN, ABS_TO + 1]] },
				]),
			}),
		);
		expect(checks.deaths[0].narrow.halfWidthMs).toBe(40 * MIN);
		const section = subsection(reportWith(checks));
		expect(section).toContain("| W = 40 min | requests |");
		expect(section).toContain("- Survivors, at W = 40 min (W_pre = 60 min):");
		expect(section).toContain(
			`| ${ABSORPTION_POPULATION_LABELS.narrow} | requests |`,
		);
		expect(section).toContain("| W_pre (min) |");
	});

	test("compares the two horizons on the deaths that carry both", () => {
		const section = subsection(reportWith(measured()));
		expect(section).toContain(
			`| ${ABSORPTION_POPULATION_LABELS.narrowWithWide} | requests |`,
		);
		expect(ABSORPTION_POPULATION_LABELS.narrowWithWide).toContain(
			"also measured at W ≤ 6 h",
		);
	});

	test("names the token-coverage and timing limits", () => {
		const { cohorts, replay } = verdictFixture(VERDICT_BASE);
		const limits = knownLimitsFor(
			replay,
			cohorts,
			evaluateVerdict(cohorts, replay),
			{ attributedRows: 807_705, zeroOrNullTokenRows: 14_769 },
		);
		expect(limits.some((limit) => limit.includes("persistence time"))).toBe(
			true,
		);
		expect(limits.some((limit) => limit.includes("are unmeasured"))).toBe(true);
		expect(limits.some((limit) => limit.includes("14769"))).toBe(true);
		expect(
			limits.some((limit) => limit.includes("no foreign key to `accounts`")),
		).toBe(true);
		expect(limits.some((limit) => limit.includes("Pause has no history"))).toBe(
			true,
		);
	});
});
