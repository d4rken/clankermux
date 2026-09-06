import { describe, expect, test } from "bun:test";
import type { BacktestMetrics } from "./prediction-backtest";
import { scoreRecords } from "./prediction-backtest";
import {
	buildRosterAtInstant,
	type CohortScores,
	type CohortSet,
	detectTransitions,
	evaluateVerdict,
	formatRedistributionReport,
	headroomShareRule,
	knownLimitsFor,
	lifecycleBalanced,
	pairedSignedMedian,
	prepareSeries,
	READING_STALE_MS,
	type RedistributionRecord,
	type ReplayModel,
	type ReplayRange,
	type ReplayResult,
	type RosterAccount,
	type RosterSnapshotRow,
	replayInstant,
	replayRange,
	scoreCohorts,
	type TransitionEvent,
	transitionsAt,
	type Verdict,
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
			observedAt: spec.observed === false ? null : t,
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
		expect(anthropic).toHaveLength(3);
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
		...overrides,
	};
}

/** One record per model at each of `instants`, for one account. */
function triple(
	accountId: string,
	instants: number[],
	perModel: Partial<
		Record<ReplayModel, (T: number) => Partial<RedistributionRecord>>
	> = {},
): RedistributionRecord[] {
	const out: RedistributionRecord[] = [];
	for (const T of instants) {
		for (const model of [
			"current",
			"scenario-equal",
			"scenario-headroom",
		] as const) {
			out.push(
				record({ model, accountId, T, ...(perModel[model]?.(T) ?? {}) }),
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
});

describe("scoreCohorts", () => {
	test("keeps one record per lifecycle, at the group's median instant", () => {
		const instants = [T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR];
		const balanced = lifecycleBalanced(triple("A", instants));
		expect(balanced).toHaveLength(3);
		// Four instants -> the LOWER median, so the pick is deterministic.
		expect(new Set(balanced.map((entry) => entry.T))).toEqual(
			new Set([T0 + HOUR]),
		);
	});

	test("the common cohort drops an instant one model could not answer", () => {
		const records = [
			...triple("A", [T0, T0 + HOUR]),
			...triple("B", [T0], {
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
		const records = triple("A", [T0, T0 + HOUR], {
			"scenario-equal": (T) => ({ predictedEtaMs: T + DAY + 30 * MIN }),
		});
		records.push(
			...triple("B", [T0], {
				current: () => ({ predictsExhaust: false, predictedEtaMs: null }),
			}),
		);
		const bias = pairedSignedMedian(records, "scenario-equal", "current");
		expect(bias.n).toBe(2);
		expect(bias.medianA).toBeCloseTo(30, 6);
		expect(bias.medianB).toBeCloseTo(0, 6);
	});

	test("scores the instants the current model withholds as a cohort of their own", () => {
		const records = triple("A", [T0, T0 + HOUR], {
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
			...triple("A", [T0, T0 + HOUR]),
			...triple("B", [T0, T0 + HOUR]),
		];
		const cohorts = scoreCohorts(replayOf(records));
		expect(records.every((entry) => ["A", "B"].includes(entry.accountId))).toBe(
			true,
		);
		expect(cohorts.bootstrap).toHaveLength(6);
		expect(
			cohorts.bootstrap.filter((entry) => entry.label.startsWith("Overall")),
		).toHaveLength(3);
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
});

function verdictFixture(options: {
	scenarioBias: number | null;
	currentBias: number | null;
	scenarioRecall: number | null;
	currentRecall: number | null;
	scenarioF1: number | null;
	currentF1: number | null;
	p97_5: number | null;
	unlabelled?: boolean;
	/** What the codex account's own event (and its record) is tagged with. */
	codexEvent?: "add" | "peer-exhaustion";
	/** Weekly windows the label horizon dropped, per `${tag}::${class}`. */
	pendingWeekly?: Record<string, number>;
}): { cohorts: CohortSet; replay: ReplayResult } {
	const transition = cohort(
		"Any transition",
		[
			["current", { recall: options.currentRecall, f1: options.currentF1 }],
			[
				"scenario-equal",
				{ recall: options.scenarioRecall, f1: options.scenarioF1 },
			],
			["scenario-headroom", {}],
		],
		{ n: 4, medianA: options.scenarioBias, medianB: options.currentBias },
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
		byClassAndKind: [],
		scenarioExtra: cohort("Scenario-only", [], {
			n: 0,
			medianA: null,
			medianB: null,
		}),
		bootstrap: [
			{
				label: "Overall (block = window lifecycle)",
				statistic: "f1",
				p2_5: -0.1,
				p50: 0.01,
				p97_5: options.p97_5,
				samples: 1000,
			},
		],
		common: options.unlabelled
			? [weeklyRecord]
			: [weeklyRecord, codexWeeklyRecord],
	};
	return {
		cohorts,
		replay: replayOf(
			[weeklyRecord, codexWeeklyRecord],
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
		expect(verdict.criteria.map((entry) => entry.pass)).toEqual([
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
			"`anthropic` supplies 100.0 % of the overall common-cohort records, so the overall numbers are close to that class's numbers.",
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
			"PROVISIONAL: the add (codex) cohort has no completed weekly window inside the replay interval",
		);
		expect(pendingMarkdown).not.toContain(
			"No tagged survivor weekly record in this data for:",
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
			"No tagged survivor weekly record in this data for: peer-exhaustion (codex); a later run cannot label these without a roster change.",
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
			"Every scored cohort has completed windows in both kinds.",
		);
		expect(labelledMarkdown).not.toContain("PROVISIONAL:");
		expect(labelledMarkdown).not.toContain(
			"No tagged survivor weekly record in this data for:",
		);
	});
});
