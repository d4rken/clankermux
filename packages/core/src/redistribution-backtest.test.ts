import { describe, expect, test } from "bun:test";
import type { BacktestMetrics } from "./prediction-backtest";
import { scoreRecords } from "./prediction-backtest";
import {
	buildRosterAtInstant,
	type CohortScores,
	type CohortSet,
	churnRows,
	detectTransitions,
	evaluateVerdict,
	formatRedistributionReport,
	headroomShareRule,
	knownLimitsFor,
	lifecycleBalanced,
	OBSERVATION_AGE_BUCKETS,
	OVERALL_BOOTSTRAP_LABEL,
	observationLagChecks,
	PEER_LOSS_PREFIX_MS,
	pairedAbsMedian,
	pairedSignedMedian,
	prepareSeries,
	READING_STALE_MS,
	REPLAY_MODELS,
	type RedistributionRecord,
	type ReplayModel,
	type ReplayRange,
	type ReplayResult,
	type RosterAccount,
	type RosterSnapshotRow,
	redistributionRecordToJson,
	replayInstant,
	replayRange,
	SCENARIO_MODEL_IDS,
	SCENARIO_MODELS,
	SINCE_DEATH_BUCKETS,
	scoreCohorts,
	survivorSlopeTrajectory,
	TRANSITION_BOOTSTRAP_LABEL,
	type TransitionEvent,
	tallyWindowFills,
	transitionsAt,
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
		const records = [
			...perModel("A", [T0, T0 + HOUR]),
			...perModel("B", [T0, T0 + HOUR]),
		];
		const cohorts = scoreCohorts(replayOf(records));
		expect(records.every((entry) => ["A", "B"].includes(entry.accountId))).toBe(
			true,
		);
		// Three statistics, two cohorts, two baselines.
		expect(cohorts.bootstrap).toHaveLength(12);
		expect(
			cohorts.bootstrap.filter(
				(entry) => entry.label === OVERALL_BOOTSTRAP_LABEL,
			),
		).toHaveLength(6);
		expect(new Set(cohorts.bootstrap.map((entry) => entry.baseline))).toEqual(
			new Set(["current", "scenario-equal-original"]),
		);
		expect(cohorts.bootstrap.map((entry) => entry.statistic)).toContain(
			"medianSignedErrorMinutes",
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

const cohort = (
	label: string,
	rows: Array<[ReplayModel, Partial<BacktestMetrics>]>,
	pairedBias: CohortScores["pairedBias"],
	vsOriginal?: {
		bias?: CohortScores["pairedBias"];
		abs?: CohortScores["pairedAbsVsOriginal"];
	},
): CohortScores => ({
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
	pairedBias,
	pairedBiasVsOriginal: vsOriginal?.bias ?? {
		n: 0,
		medianA: null,
		medianB: null,
	},
	pairedAbsVsOriginal: vsOriginal?.abs ?? { n: 0, medianDeltaMinutes: null },
});

function verdictFixture(options: {
	scenarioBias: number | null;
	currentBias: number | null;
	scenarioRecall: number | null;
	currentRecall: number | null;
	scenarioF1: number | null;
	currentF1: number | null;
	/** F1 of the pre-correction scan, criterion D's comparison. */
	originalF1?: number | null;
	originalRecall?: number | null;
	/** Paired median of |err corrected| - |err original|, in minutes. */
	pairedAbsVsOriginal?: number | null;
	p97_5: number | null;
	/** p97.5 of the entry whose baseline is the ORIGINAL scan. */
	p97_5Original?: number | null;
	/** Drop the current-baseline bootstrap entry, leaving only the original one. */
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
}): { cohorts: CohortSet; replay: ReplayResult } {
	const transition = cohort(
		"Any transition",
		[
			["current", { recall: options.currentRecall, f1: options.currentF1 }],
			[
				"scenario-equal",
				{ recall: options.scenarioRecall, f1: options.scenarioF1 },
			],
			[
				"scenario-equal-original",
				{
					recall: options.originalRecall ?? 0.75,
					f1: options.originalF1 === undefined ? 0.6 : options.originalF1,
				},
			],
			["scenario-headroom", {}],
		],
		{ n: 4, medianA: options.scenarioBias, medianB: options.currentBias },
		{
			bias: {
				n: 4,
				medianA: options.scenarioBias,
				medianB: options.scenarioBias,
			},
			abs: {
				n: 4,
				medianDeltaMinutes:
					options.pairedAbsVsOriginal === undefined
						? -3
						: options.pairedAbsVsOriginal,
			},
		},
	);
	const overall = cohort("Overall", [], { n: 0, medianA: null, medianB: null });
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
		byTag: [cohort("add", [], { n: 0, medianA: null, medianB: null })],
		peerExhaustionBySinceDeath: [],
		slopeTrajectory: [],
		churn: [],
		byClassAndKind: [],
		scenarioExtra: cohort("Scenario-only", [], {
			n: 0,
			medianA: null,
			medianB: null,
		}),
		bootstrap: [
			...(options.originalBaselineOnly
				? []
				: [
						{
							label: OVERALL_BOOTSTRAP_LABEL,
							statistic: "f1",
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
				baseline: "scenario-equal-original" as const,
				p2_5: -0.4,
				p50: -0.3,
				p97_5:
					options.p97_5Original === undefined ? -0.2 : options.p97_5Original,
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
			model: "scenario-equal",
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
		expect(names).toContain("recall, scenario-equal");
		expect(names).toContain("recall, scenario-equal-original");
		// A worse recall than the original does not fail D: an ETA moved earlier
		// never leaves the before-reset set.
		expect(verdict.criteria[3].pass).toBe(true);
	});

	test("criterion C reads the CURRENT-baseline bootstrap entry only", () => {
		// The original-baseline entry is entirely below zero; C must not see it.
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
});

/** One report, from parts the caller controls. */
function reportOf(
	result: ReplayResult,
	cohorts: CohortSet,
	verdict: Verdict,
	rows: number,
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

		for (const heading of [
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
			"## Known limits",
			"## Notes",
		]) {
			expect(markdown).toContain(heading);
		}
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
		expect(first?.pairedBias.n).toBeGreaterThanOrEqual(0);
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
	test("carries the pre-correction scan beside the corrected one", () => {
		expect([...REPLAY_MODELS]).toEqual([
			"current",
			"scenario-equal",
			"scenario-equal-original",
			"scenario-headroom",
		]);
		expect([...SCENARIO_MODEL_IDS]).toEqual([
			"scenario-equal",
			"scenario-equal-original",
			"scenario-headroom",
		]);
		expect(SCENARIO_MODELS["scenario-equal"].observationLag).toBe("advance");
		expect(SCENARIO_MODELS["scenario-equal-original"].observationLag).toBe(
			"ignore",
		);
		expect(SCENARIO_MODELS["scenario-headroom"].observationLag).toBe("advance");
		// The two equal-split models differ ONLY in the lag treatment.
		expect(SCENARIO_MODELS["scenario-equal-original"].shareRule).toBe(
			SCENARIO_MODELS["scenario-equal"].shareRule,
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
	firstSampleMs: T0,
	firstSampleUtilization: 0,
	lastSampleMs: T0 + 4 * HOUR,
	firstHundredMs: T0 + HOUR,
	resolutionMs: 10 * MIN,
	peerLostInPrefix: false,
	peerLostDuringFill: false,
	exposureObservable: true,
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

	test("an empty cell carries counts and nulls rather than NaN", () => {
		const tally = tallyWindowFills([]);
		const cell = rowOf(tally, "peer lost in prefix", "seven_day");
		expect(cell.fills).toBe(0);
		expect(cell.censored).toBe(0);
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
			"| peer lost in prefix | five_hour | 0 | 0 | — | — | — | — | — | — |",
		);
		expect(markdown).toContain("(0 fills): —");
	});

	test("states the censoring bias and the length bias", () => {
		const { markdown } = absorptionReport();
		expect(markdown).toContain(
			"understates typical time-to-fill, and it understates it more in whichever cell censors more",
		);
		expect(markdown).toContain(
			"length-biased in the direction of longer fills",
		);
		expect(markdown).toContain(
			"equally consistent with absorption and with common cause",
		);
	});

	test("reconciles every lifecycle it saw", () => {
		const { markdown } = absorptionReport();
		expect(markdown).toMatch(
			/Reconciliation: \d+ filled \+ \d+ censored \+ \d+ with no reset on the segment \+ \d+ already full at the first sample \+ \d+ placeholder lifecycles skipped = \d+ window lifecycles\./,
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
