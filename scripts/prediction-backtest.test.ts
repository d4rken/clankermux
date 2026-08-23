import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Estimator } from "../packages/core/src/prediction-backtest";
import {
	deploymentCohort,
	scoreRecords,
	scoreRedRule,
} from "../packages/core/src/prediction-backtest";
import type { PredictionPoint } from "../packages/types/src/usage-prediction";
import {
	assertSafeOutPath,
	buildRanges,
	buildSelectionBlock,
	ESTIMATOR_REGISTRY,
	estimatorsForWindow,
	loadPadForEstimators,
	openBacktestDatabase,
	parseCliArgs,
	parseEstimatorList,
	runBacktest,
	shellQuoteArg,
} from "./prediction-backtest";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const T0 = Date.parse("2026-06-01T00:00:00.000Z");

const tempDir = mkdtempSync(join(tmpdir(), "prediction-backtest-"));
const dbPath = join(tempDir, "fixture.db");
const boundaryDbPath = join(tempDir, "boundary.db");
const weeklyDbPath = join(tempDir, "weekly.db");
const driftDbPath = join(tempDir, "drift.db");
const dowDbPath = join(tempDir, "dow.db");

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

interface SnapshotFixture {
	accountId: string;
	provider: string;
	sampledAt: number;
	fiveHourPct: number | null;
	fiveHourReset: number | null;
}

/**
 * Schema copied from `packages/database/src/migrations.ts` for the two tables
 * this tool reads (without the accounts foreign key, which is irrelevant to a
 * read-only tool).
 */
function createTables(db: Database): void {
	db.run(`
		CREATE TABLE usage_snapshots (
			account_id TEXT NOT NULL,
			provider TEXT,
			sampled_at INTEGER NOT NULL,
			five_hour_pct REAL,
			five_hour_reset INTEGER,
			seven_day_pct REAL,
			seven_day_reset INTEGER,
			PRIMARY KEY (account_id, sampled_at)
		)
	`);
	db.run(`
		CREATE TABLE requests (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			account_used TEXT,
			status_code INTEGER
		)
	`);
}

function insertSnapshots(db: Database, rows: SnapshotFixture[]): void {
	const insert = db.prepare(
		`INSERT INTO usage_snapshots
		 (account_id, provider, sampled_at, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset)
		 VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
	);
	for (const r of rows) {
		insert.run(
			r.accountId,
			r.provider,
			r.sampledAt,
			r.fiveHourPct,
			r.fiveHourReset,
		);
	}
}

/** Builds the fixture database ONCE. */
function buildFixtureDb(): void {
	const db = new Database(dbPath, { create: true });
	createTables(db);

	const rows: SnapshotFixture[] = [];
	const push = (
		accountId: string,
		sampledAt: number,
		pct: number | null,
		reset: number | null,
	) =>
		rows.push({
			accountId,
			provider: accountId === "codex-1" ? "codex" : "anthropic",
			sampledAt,
			fiveHourPct: pct,
			fiveHourReset: reset,
		});

	// --- account "exhauster": window A rises to 100%, window B survives. ------
	// Window A: reset at T0 + 5 h, sampled every 10 min from T0 - 2 h and
	// reaching 100% at T0 + 3 h 50 m.
	const resetA = T0 + 5 * HOUR_MS;
	for (let i = -12; i <= 29; i++) {
		const t = T0 + i * 10 * MIN_MS;
		push("exhauster", t, Math.min(100, 30 + (i + 12) * 2), resetA);
	}
	// Window B: a new reset, flat and safe, sampled up to 5 min before its end.
	const startB = T0 + 4 * HOUR_MS + 55 * MIN_MS;
	const resetB = T0 + 9 * HOUR_MS + 55 * MIN_MS;
	for (let i = 0; i <= 29; i++) {
		push("exhauster", startB + i * 10 * MIN_MS, 5 + i, resetB);
	}
	// Window C exists only so window B has an observed successor.
	const startC = T0 + 9 * HOUR_MS + 50 * MIN_MS;
	const resetC = T0 + 14 * HOUR_MS + 50 * MIN_MS;
	for (let i = 0; i <= 6; i++) {
		push("exhauster", startC + i * 10 * MIN_MS, 2 + i, resetC);
	}

	// --- account "gappy": sampling stops long before the reset -> censored. ---
	const gapReset = T0 + 5 * HOUR_MS;
	for (let i = 0; i <= 12; i++) {
		push("gappy", T0 + i * 10 * MIN_MS, 20 + i, gapReset);
	}
	// The next window IS observed, but a 3 h hole sits before the reset.
	const gapStart2 = T0 + 5 * HOUR_MS + 5 * MIN_MS;
	const gapReset2 = T0 + 10 * HOUR_MS + 5 * MIN_MS;
	for (let i = 0; i <= 12; i++) {
		push("gappy", gapStart2 + i * 10 * MIN_MS, 3 + i, gapReset2);
	}

	// --- account "codex-1": a second provider, steady and safe. ---------------
	const codexReset = T0 + 4 * HOUR_MS;
	for (let i = 0; i <= 23; i++) {
		push("codex-1", T0 + i * 10 * MIN_MS, 10 + i, codexReset);
	}
	const codexStart2 = T0 + 3 * HOUR_MS + 55 * MIN_MS;
	const codexReset2 = T0 + 8 * HOUR_MS + 55 * MIN_MS;
	for (let i = 0; i <= 3; i++) {
		push("codex-1", codexStart2 + i * 10 * MIN_MS, 1 + i, codexReset2);
	}

	insertSnapshots(db, rows);

	const insertRequest = db.prepare(
		`INSERT INTO requests (id, timestamp, method, path, account_used, status_code)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, ?)`,
	);
	// A 429 inside "exhauster"'s SURVIVED window B (a label-quality signal), and
	// a 200 that must never be counted.
	insertRequest.run("r1", resetA + 60 * MIN_MS, "exhauster", 429);
	insertRequest.run("r2", resetA + 61 * MIN_MS, "exhauster", 200);
	insertRequest.run("r3", T0 + 60 * MIN_MS, "codex-1", 429);
	db.close();
}

buildFixtureDb();

/**
 * Instants whose outcome lands EXACTLY on a range end. Ranges are half-open, so
 * such an outcome belongs to the next range and must not label this one — and
 * real resets land on exact clock boundaries, which is how a report split at
 * midnight UTC meets this case.
 */
const EXHAUST_AT = T0 + 3 * HOUR_MS;
const SURVIVE_END = T0 + 8 * HOUR_MS;

function buildBoundaryDb(): void {
	const db = new Database(boundaryDbPath, { create: true });
	createTables(db);

	const rows: SnapshotFixture[] = [];
	const push = (
		accountId: string,
		sampledAt: number,
		pct: number,
		reset: number,
	) =>
		rows.push({
			accountId,
			provider: "anthropic",
			sampledAt,
			fiveHourPct: pct,
			fiveHourReset: reset,
		});

	// "edge-exh": rises to 100% exactly at EXHAUST_AT and stays there.
	const exhReset = T0 + 5 * HOUR_MS;
	for (let i = 0; i <= 29; i++) {
		const t = T0 + i * 10 * MIN_MS;
		push("edge-exh", t, t < EXHAUST_AT ? Math.min(99, 30 + 2 * i) : 100, exhReset);
	}

	// "edge-surv": a flat window whose reset AND whose successor's first sample
	// both land exactly on SURVIVE_END, so its survival boundary is that instant.
	for (let t = T0 + 5 * MIN_MS; t <= SURVIVE_END - 5 * MIN_MS; t += 10 * MIN_MS) {
		push("edge-surv", t, 10, SURVIVE_END);
	}
	const nextReset = SURVIVE_END + 5 * HOUR_MS;
	for (let i = 0; i <= 5; i++) {
		push("edge-surv", SURVIVE_END + i * 10 * MIN_MS, 4 + i, nextReset);
	}

	insertSnapshots(db, rows);
	db.close();
}

buildBoundaryDb();

/**
 * A WEEKLY fixture. The five-hour fixtures above are too short to say anything
 * about an estimator's input horizon: a weekly instant has to be able to see
 * days of history behind it.
 */
const WEEKLY_T0 = Date.parse("2026-05-04T00:00:00.000Z");
const WEEKLY_RANGE = {
	label: "Weekly",
	fromMs: WEEKLY_T0 + 2 * 24 * HOUR_MS,
	toMs: WEEKLY_T0 + 8 * 24 * HOUR_MS,
};

function buildWeeklyDb(): void {
	const db = new Database(weeklyDbPath, { create: true });
	createTables(db);
	const insert = db.prepare(
		`INSERT INTO usage_snapshots
		 (account_id, provider, sampled_at, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset)
		 VALUES (?, 'anthropic', ?, NULL, NULL, ?, ?)`,
	);
	const step = 30 * MIN_MS;
	// One 7-day window rising 10 points a day, then its successor.
	const reset = WEEKLY_T0 + 7 * 24 * HOUR_MS;
	for (let t = WEEKLY_T0; t < reset; t += step) {
		insert.run("weekly-1", t, ((t - WEEKLY_T0) / (24 * HOUR_MS)) * 10, reset);
	}
	const nextReset = reset + 7 * 24 * HOUR_MS;
	for (let t = reset; t <= reset + 24 * HOUR_MS; t += step) {
		insert.run("weekly-1", t, ((t - reset) / (24 * HOUR_MS)) * 10, nextReset);
	}
	db.close();
}

buildWeeklyDb();

/**
 * A DENSE weekly fixture: five 7-day windows sampled every 10 minutes, burning
 * faster on weekdays than at the weekend.
 *
 * The 30-minute fixture above is too sparse for the burn-rate estimators — a
 * 30-minute step is wider than the 15-minute gap they accept as observed, so
 * they abstain on every instant and prove nothing. This one is inside the
 * tolerance and long enough to give every UTC day of week its day of exposure,
 * so `trailing-*` and `dow-seasonal` actually answer.
 */
const DAY_MS = 24 * HOUR_MS;
const DOW_T0 = Date.parse("2026-04-06T00:00:00.000Z"); // a Monday
const DOW_RANGE = {
	label: "Dense weekly",
	fromMs: DOW_T0 + 28 * DAY_MS,
	toMs: DOW_T0 + 35 * DAY_MS + HOUR_MS,
};

function buildDowDb(): void {
	const db = new Database(dowDbPath, { create: true });
	createTables(db);
	const insert = db.prepare(
		`INSERT INTO usage_snapshots
		 (account_id, provider, sampled_at, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset)
		 VALUES ('dense-1', 'anthropic', ?, NULL, NULL, ?, ?)`,
	);
	const step = 10 * MIN_MS;
	// Weekdays burn four times as fast as the weekend, which is the rhythm a
	// day-of-week profile exists to pick up. The window being SCORED burns far
	// harder than the profile, so the estimators project real exhaustion times
	// instead of a flat "will not run out" on every instant.
	const perDay = (windowIndex: number, dow: number) => {
		if (windowIndex === 4) return 40;
		return dow === 0 || dow === 6 ? 3 : 12;
	};
	db.run("BEGIN");
	for (let w = 0; w < 6; w++) {
		const windowStart = DOW_T0 + w * 7 * DAY_MS;
		const reset = windowStart + 7 * DAY_MS;
		let pct = 0;
		// The sixth window only needs its first day: it exists so the fifth has an
		// observed successor.
		const end = w === 5 ? windowStart + DAY_MS : reset;
		for (let t = windowStart; t < end; t += step) {
			insert.run(t, Math.min(99, Number(pct.toFixed(4))), reset);
			pct += (perDay(w, new Date(t).getUTCDay()) * step) / DAY_MS;
		}
	}
	db.run("COMMIT");
	db.close();
}

buildDowDb();

/**
 * A window whose `resets_at` DRIFTS forward sample by sample, each step inside
 * the 60 s jitter tolerance so the whole thing stays ONE window.
 *
 * At `DRIFT_T` the newest sample carries a reset that has already passed, while
 * the window's final sample carries one that is still ahead of `DRIFT_T`. That
 * is the real shape behind the point-in-time/ground-truth split: a deployment
 * at `DRIFT_T` would have rendered nothing, but the finished window's reset says
 * otherwise.
 */
const DRIFT_T = T0 + 60 * MIN_MS;
const DRIFT_KNOWN_RESET = T0 + 59 * MIN_MS;
const DRIFT_LABEL_RESET = T0 + 61 * MIN_MS;

function buildDriftDb(): void {
	const db = new Database(driftDbPath, { create: true });
	createTables(db);
	const rows: SnapshotFixture[] = [];
	const push = (sampledAt: number, pct: number, reset: number) =>
		rows.push({
			accountId: "drifty",
			provider: "anthropic",
			sampledAt,
			fiveHourPct: pct,
			fiveHourReset: reset,
		});

	// Ten-minute samples up to DRIFT_T, the reset creeping forward 60 s a step
	// and crossing the sample time between the last two.
	for (let i = 0; i <= 6; i++) {
		push(T0 + i * 10 * MIN_MS, 20 + i, T0 + (53 + i) * MIN_MS);
	}
	// Two more samples, still the same window: the reset creeps past DRIFT_T.
	push(T0 + 62 * MIN_MS, 27, T0 + 60 * MIN_MS);
	push(T0 + 64 * MIN_MS, 28, DRIFT_LABEL_RESET);
	// The successor window, so the drifting one has an observed end.
	const nextReset = T0 + 6 * HOUR_MS;
	for (let i = 0; i <= 5; i++) {
		push(T0 + (66 + i * 10) * MIN_MS, 3 + i, nextReset);
	}

	insertSnapshots(db, rows);
	db.close();
}

buildDriftDb();

const FULL_RANGE = {
	label: "All",
	fromMs: T0,
	toMs: T0 + 15 * HOUR_MS,
};

function run(overrides: Partial<Parameters<typeof runBacktest>[1]> = {}) {
	return runBacktest(dbPath, {
		ranges: [FULL_RANGE],
		stepMinutes: 10,
		windows: ["five_hour"],
		...overrides,
	});
}

describe("runBacktest", () => {
	test("opens the database read-only: a write through the handle throws", () => {
		const db = openBacktestDatabase(dbPath);
		try {
			expect(() =>
				db.run(
					"INSERT INTO usage_snapshots (account_id, sampled_at) VALUES ('x', 1)",
				),
			).toThrow();
			expect(() => db.run("CREATE TABLE scratch (a INTEGER)")).toThrow();
			expect(() => db.run("DELETE FROM usage_snapshots")).toThrow();
		} finally {
			db.close();
		}
		// And the fixture is untouched.
		const check = openBacktestDatabase(dbPath);
		const count = check
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_snapshots")
			.get();
		check.close();
		expect(count?.n).toBeGreaterThan(0);
	});

	test("reports the dataset summary from the whole table", () => {
		const result = run();
		expect(result.dataset.accounts).toBe(3);
		expect(result.dataset.providers.sort()).toEqual(["anthropic", "codex"]);
		expect(result.dataset.rows).toBeGreaterThan(100);
	});

	test("is deterministic: two runs produce identical records", () => {
		const a = run();
		const b = run();
		const flatten = (r: ReturnType<typeof run>) =>
			r.ranges[0].windows[0].recordsByEstimator.get("ols");
		expect(flatten(a)).toEqual(flatten(b));
	});

	test("groups by window: the rise-to-100 window is labelled exhausted, the flat one survived", () => {
		const records =
			run().ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];
		const exhauster = records.filter((r) => r.accountId === "exhauster");
		const kinds = new Set(exhauster.map((r) => r.outcome.kind));
		expect(kinds.has("exhausted")).toBe(true);
		expect(kinds.has("survived")).toBe(true);
		// Every exhausted record points at the SAME first >=100 sample.
		const atMs = new Set(
			exhauster
				.filter((r) => r.outcome.kind === "exhausted")
				.map((r) => (r.outcome as { atMs: number }).atMs),
		);
		expect(atMs.size).toBe(1);
	});

	test("a sampling gap before the next window censors instead of claiming survival", () => {
		const records =
			run().ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];
		const gappy = records.filter((r) => r.accountId === "gappy");
		expect(gappy.length).toBeGreaterThan(0);
		expect(gappy.every((r) => r.outcome.kind === "censored")).toBe(true);
	});

	test("candidate instants are actual samples, spaced by at least --step-minutes", () => {
		const coarse = runBacktest(dbPath, {
			ranges: [FULL_RANGE],
			stepMinutes: 60,
			windows: ["five_hour"],
		});
		const records =
			coarse.ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];
		// Spacing is enforced INSIDE a window series (its final reset identifies
		// one).
		const byWindow = new Map<string, number[]>();
		for (const r of records) {
			const key = `${r.accountId} ${r.labelResetAtMs}`;
			const list = byWindow.get(key) ?? [];
			list.push(r.T);
			byWindow.set(key, list);
		}
		for (const stamps of byWindow.values()) {
			const unique = [...new Set(stamps)].sort((a, b) => a - b);
			for (let i = 1; i < unique.length; i++) {
				expect(unique[i] - unique[i - 1]).toBeGreaterThanOrEqual(60 * MIN_MS);
			}
		}
		// Every instant is a stored snapshot timestamp for THAT account, never a
		// synthetic wall-clock step.
		const db = openBacktestDatabase(dbPath);
		const stored = new Set(
			db
				.query<{ account_id: string; sampled_at: number }, []>(
					"SELECT account_id, sampled_at FROM usage_snapshots",
				)
				.all()
				.map((r) => `${r.account_id} ${r.sampled_at}`),
		);
		db.close();
		for (const r of records) {
			expect(stored.has(`${r.accountId} ${r.T}`)).toBe(true);
		}
	});

	test("range padding: rows BEFORE the range feed its first instant", () => {
		// The exhauster series starts 2 h before T0. Scored from T0, the very
		// first instant already has a usable OLS fit, which is only possible if
		// the loader padded backwards: on its own, T0 is a single point.
		const narrow = runBacktest(dbPath, {
			ranges: [{ label: "Narrow", fromMs: T0, toMs: T0 + 4 * HOUR_MS }],
			stepMinutes: 10,
			windows: ["five_hour"],
		});
		const records =
			narrow.ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];
		const firstExhauster = records
			.filter((r) => r.accountId === "exhauster")
			.sort((a, b) => a.T - b.T)[0];
		expect(firstExhauster.T).toBe(T0);
		expect(firstExhauster.usable).toBe(true);
	});

	test("range padding: outcomes come from rows AFTER the range end", () => {
		const narrow = runBacktest(dbPath, {
			ranges: [{ label: "Narrow", fromMs: T0, toMs: T0 + 6 * HOUR_MS }],
			stepMinutes: 10,
			windows: ["five_hour"],
		});
		const records =
			narrow.ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];
		const exhausted = records.filter(
			(r) => r.accountId === "exhauster" && r.outcome.kind === "exhausted",
		);
		expect(exhausted.length).toBeGreaterThan(0);
		// The exhaustion sample lies inside the range; its window's survival check
		// would need rows past it, which is exactly what the load padding provides.
		for (const r of exhausted) {
			expect((r.outcome as { atMs: number }).atMs).toBeGreaterThan(r.T);
		}
	});

	test("label horizon: a candidate whose outcome lands past the range end is dropped", () => {
		// Cut the range off in the middle of the exhauster's first window, before
		// its exhaustion sample: no instant may be labelled from beyond the cut.
		const cut = runBacktest(dbPath, {
			ranges: [{ label: "Cut", fromMs: T0, toMs: T0 + 2 * HOUR_MS }],
			stepMinutes: 10,
			windows: ["five_hour"],
		});
		const records =
			cut.ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];
		expect(records.some((r) => r.accountId === "exhauster")).toBe(false);
	});

	test("label horizon: an exhaustion landing exactly on the range end is dropped", () => {
		const olsRecords = (toMs: number) =>
			runBacktest(boundaryDbPath, {
				ranges: [{ label: "Edge", fromMs: T0, toMs }],
				stepMinutes: 10,
				windows: ["five_hour"],
			}).ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];

		// The range is half-open, so an outcome at `toMs` is held-out evidence.
		const onBoundary = olsRecords(EXHAUST_AT);
		expect(onBoundary.some((r) => r.accountId === "edge-exh")).toBe(false);
		// One millisecond wider and the same instants are labelled: the drop above
		// is the horizon rule, not an empty fixture.
		const justPast = olsRecords(EXHAUST_AT + 1).filter(
			(r) => r.accountId === "edge-exh",
		);
		expect(justPast.length).toBeGreaterThan(0);
		expect(
			justPast.every(
				(r) =>
					r.outcome.kind === "exhausted" &&
					(r.outcome as { atMs: number }).atMs === EXHAUST_AT,
			),
		).toBe(true);
	});

	test("label horizon: a survival boundary landing exactly on the range end is dropped", () => {
		const olsRecords = (toMs: number) =>
			runBacktest(boundaryDbPath, {
				ranges: [{ label: "Edge", fromMs: T0, toMs }],
				stepMinutes: 10,
				windows: ["five_hour"],
			}).ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];

		const onBoundary = olsRecords(SURVIVE_END);
		expect(onBoundary.some((r) => r.accountId === "edge-surv")).toBe(false);
		const justPast = olsRecords(SURVIVE_END + 1).filter(
			(r) => r.accountId === "edge-surv",
		);
		expect(justPast.length).toBeGreaterThan(0);
		expect(justPast.every((r) => r.outcome.kind === "survived")).toBe(true);
	});

	test("all estimators produce a record for every instant", () => {
		const window = run().ranges[0].windows[0];
		const counts = [...window.recordsByEstimator.values()].map((r) => r.length);
		expect(new Set(counts).size).toBe(1);
		expect(counts[0]).toBeGreaterThan(0);
		expect([...window.recordsByEstimator.keys()].sort()).toEqual([
			"lifetime",
			"naive",
			"ols",
		]);
	});

	test("per-account contributions sum to the record count", () => {
		const window = run().ranges[0].windows[0];
		const total = window.byAccount.reduce((a, b) => a + b.instants, 0);
		expect(total).toBe(window.recordsByEstimator.get("ols")?.length ?? -1);
	});

	test("429 diagnostic counts only 429s inside SURVIVED windows", () => {
		const result = run();
		const rows = result.rateLimitDiagnostic;
		const exhauster = rows.find((r) => r.accountId === "exhauster");
		expect(exhauster?.requests429).toBe(1);
		expect(exhauster?.survivedWindowsWith429).toBe(1);
		expect(exhauster?.windowKind).toBe("five_hour");
		// gappy has no survived window at all, so it contributes no row.
		expect(rows.some((r) => r.accountId === "gappy")).toBe(false);
	});

	test("multiple ranges are scored independently", () => {
		const split = runBacktest(dbPath, {
			ranges: [
				{ label: "First", fromMs: T0, toMs: T0 + 5 * HOUR_MS },
				{ label: "Second", fromMs: T0 + 5 * HOUR_MS, toMs: T0 + 15 * HOUR_MS },
			],
			stepMinutes: 10,
			windows: ["five_hour"],
		});
		expect(split.ranges).toHaveLength(2);
		const first = split.ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];
		const second =
			split.ranges[1].windows[0].recordsByEstimator.get("ols") ?? [];
		expect(first.every((r) => r.T < T0 + 5 * HOUR_MS)).toBe(true);
		expect(second.every((r) => r.T >= T0 + 5 * HOUR_MS)).toBe(true);
	});

	test("buildRanges renders report blocks with a common cohort", () => {
		const result = run();
		const ranges = buildRanges(result, 20260823, ["ols"]);
		expect(ranges).toHaveLength(1);
		const block = ranges[0].windows[0];
		expect(block.windowKind).toBe("five_hour");
		expect(block.conditional.map((c) => c.estimator).sort()).toEqual([
			"lifetime",
			"naive",
			"ols",
		]);
		expect(block.commonCohort.length).toBe(3);
		expect(block.byProvider.length).toBeGreaterThan(0);
		expect(block.bootstrap?.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Point-in-time reset knowledge
// ---------------------------------------------------------------------------

describe("known vs label reset", () => {
	const driftRecords = () =>
		runBacktest(driftDbPath, {
			ranges: [{ label: "Drift", fromMs: T0, toMs: T0 + 3 * HOUR_MS }],
			stepMinutes: 10,
			windows: ["five_hour"],
			estimatorsFor: (w) => estimatorsForWindow(["ols"], w),
		}).ranges[0].windows[0].recordsByEstimator.get("ols") ?? [];

	test("the two resets are stamped from different samples", () => {
		const records = driftRecords();
		const at = records.find((r) => r.T === DRIFT_T);
		expect(at).toBeDefined();
		expect(at?.knownResetAtMs).toBe(DRIFT_KNOWN_RESET);
		expect(at?.labelResetAtMs).toBe(DRIFT_LABEL_RESET);
		// Every instant of the drifting window shares its final reset.
		expect(
			records
				.filter((r) => r.T <= DRIFT_T)
				.every((r) => r.labelResetAtMs === DRIFT_LABEL_RESET),
		).toBe(true);
	});

	test("an instant whose known reset has expired is out of the deployment cohort", () => {
		const records = driftRecords();
		const cohort = deploymentCohort(records);
		expect(cohort.some((r) => r.T === DRIFT_T)).toBe(false);
		// The window's final reset IS ahead of that instant, so the exclusion is
		// the point-in-time rule and not the outcome or the range.
		expect(DRIFT_LABEL_RESET).toBeGreaterThan(DRIFT_T);
		// An earlier instant of the SAME window, whose known reset is still ahead,
		// stays in the cohort.
		expect(cohort.some((r) => r.T === T0 + 50 * MIN_MS)).toBe(true);
	});

	test("the excluded instant cannot be scored by the red rule either", () => {
		const records = driftRecords().filter((r) => r.T === DRIFT_T);
		expect(records).toHaveLength(1);
		expect(scoreRedRule(deploymentCohort(records)).scored).toBe(0);
	});

	test("its ground-truth label is unaffected", () => {
		const at = driftRecords().find((r) => r.T === DRIFT_T);
		expect(at?.outcome.kind).toBe("survived");
	});
});

// ---------------------------------------------------------------------------
// Estimator registry and the --estimators allowlist
// ---------------------------------------------------------------------------

describe("estimator registry", () => {
	test("every registry entry names at least one window it applies to", () => {
		for (const entry of ESTIMATOR_REGISTRY) {
			expect(entry.windows.length).toBeGreaterThan(0);
		}
	});

	test("the allowlist accepts known names and rejects everything else", () => {
		expect(parseEstimatorList("ols,dow-seasonal")).toEqual([
			"ols",
			"dow-seasonal",
		]);
		expect(parseEstimatorList(" ols , naive ")).toEqual(["ols", "naive"]);
		expect(parseEstimatorList("ols,ols")).toEqual(["ols"]);
		expect(() => parseEstimatorList("ewls-15m")).toThrow(/Unknown estimator/);
		expect(() => parseEstimatorList("")).toThrow();
	});

	test("a five-hour candidate never runs on the weekly window, and vice versa", () => {
		const all = ESTIMATOR_REGISTRY.map((e) => e.name);
		expect([...estimatorsForWindow(all, "five_hour").keys()]).toEqual([
			"ols",
			"lifetime",
			"naive",
			"endpoint-seg-30m",
			"endpoint-seg-1h",
			"endpoint-seg-2h",
			"ols-1h",
		]);
		expect([...estimatorsForWindow(all, "seven_day").keys()]).toEqual([
			"ols",
			"lifetime",
			"naive",
			"trailing-3d",
			"trailing-7d",
			"dow-seasonal",
		]);
	});

	test("selecting a subset scores only that subset", () => {
		const window = runBacktest(dbPath, {
			ranges: [FULL_RANGE],
			stepMinutes: 10,
			windows: ["five_hour"],
			estimatorsFor: (w) => estimatorsForWindow(["naive", "endpoint-seg-1h"], w),
		}).ranges[0].windows[0];
		expect([...window.recordsByEstimator.keys()]).toEqual([
			"naive",
			"endpoint-seg-1h",
		]);
	});

	test("the load pad widens only for estimators that learn from weeks", () => {
		expect(loadPadForEstimators(["ols", "lifetime", "naive"])).toBe(
			24 * HOUR_MS,
		);
		expect(loadPadForEstimators(["endpoint-seg-2h", "ols-1h"])).toBe(
			24 * HOUR_MS,
		);
		for (const deep of ["trailing-3d", "trailing-7d", "dow-seasonal"]) {
			expect(loadPadForEstimators(["ols", deep])).toBe(28 * 24 * HOUR_MS);
		}
	});
});

// ---------------------------------------------------------------------------
// The estimator input contract
// ---------------------------------------------------------------------------

/** Records what each estimator call actually saw. */
function spyEstimator(seen: PredictionPoint[][]): Estimator {
	return (points, _T, _window) => {
		seen.push([...points]);
		return {
			predictedEtaMs: null,
			predictsExhaust: false,
			usable: true,
			unusableReason: null,
		};
	};
}

describe("estimator input contract", () => {
	test("an estimator sees the WHOLE history up to T, not the production lookback", () => {
		const seen: PredictionPoint[][] = [];
		runBacktest(weeklyDbPath, {
			ranges: [WEEKLY_RANGE],
			stepMinutes: 240,
			windows: ["seven_day"],
			estimatorsFor: () => new Map([["spy", spyEstimator(seen)]]),
		});
		expect(seen.length).toBeGreaterThan(0);
		let oldestAgeMs = 0;
		for (const points of seen) {
			expect(points.length).toBeGreaterThan(0);
			const T = points[points.length - 1].t;
			// Point-in-time honesty survives the wider input: nothing after T.
			expect(points.every((p) => p.t <= T)).toBe(true);
			oldestAgeMs = Math.max(oldestAgeMs, T - points[0].t);
		}
		// The weekly production lookback is 24 h; the estimator gets more.
		expect(oldestAgeMs).toBeGreaterThan(24 * HOUR_MS);
	});

	test("the deep-history pad reaches further back than the default one", () => {
		const oldestWith = (padMs: number) => {
			const seen: PredictionPoint[][] = [];
			runBacktest(weeklyDbPath, {
				ranges: [WEEKLY_RANGE],
				stepMinutes: 240,
				windows: ["seven_day"],
				estimatorsFor: () => new Map([["spy", spyEstimator(seen)]]),
				loadPadBeforeMs: padMs,
			});
			return Math.min(...seen.map((points) => points[0].t));
		};
		const shallow = oldestWith(loadPadForEstimators(["ols"]));
		const deep = oldestWith(loadPadForEstimators(["dow-seasonal"]));
		expect(deep).toBeLessThan(shallow);
		expect(deep).toBe(WEEKLY_T0);
	});

	test("the baselines are unmoved by the wider input: they slice it themselves", () => {
		// Re-impose the OLD contract around each baseline. If the removal of the
		// pre-slice changed anything the baselines see, these two runs diverge.
		const preSliced = (inner: Estimator): Estimator => (points, T, window) => {
			const from = T - window.lookbackMs;
			return inner(
				points.filter((p) => p.t >= from && p.t <= T),
				T,
				window,
			);
		};
		const wrapped = runBacktest(dbPath, {
			ranges: [FULL_RANGE],
			stepMinutes: 10,
			windows: ["five_hour"],
			estimatorsFor: (w) => {
				const out = new Map<string, Estimator>();
				for (const [name, estimator] of estimatorsForWindow(
					["ols", "lifetime", "naive"],
					w,
				)) {
					out.set(name, preSliced(estimator));
				}
				return out;
			},
		}).ranges[0].windows[0];
		const plain = run().ranges[0].windows[0];
		for (const name of ["ols", "lifetime", "naive"]) {
			expect(wrapped.recordsByEstimator.get(name)).toEqual(
				plain.recordsByEstimator.get(name) as never,
			);
		}
	});

	test("the shared growing prefix is equivalent to a fresh slice per instant", () => {
		// Replay hands every estimator ONE append-only array instead of copying an
		// ever-growing prefix per instant (which was quadratic). Wrapping each
		// estimator so it receives a private copy re-creates the old contract: if
		// sharing the array changed any estimator's answer, these runs diverge.
		// The weekly fixture is the one that matters here, because the day-of-week
		// estimator carries a prefix cache across calls.
		const copying =
			(inner: Estimator): Estimator =>
			(points, T, window) =>
				inner(points.slice(), T, window);
		const replay = (
			path: string,
			range: typeof FULL_RANGE,
			windowKind: "five_hour" | "seven_day",
			names: string[],
			wrap: boolean,
		) =>
			runBacktest(path, {
				ranges: [range],
				stepMinutes: 60,
				windows: [windowKind],
				estimatorsFor: (w) => {
					const out = new Map<string, Estimator>();
					for (const [name, estimator] of estimatorsForWindow(names, w)) {
						out.set(name, wrap ? copying(estimator) : estimator);
					}
					return out;
				},
				loadPadBeforeMs: loadPadForEstimators(names),
			}).ranges[0].windows[0];

		const cases: [string, typeof FULL_RANGE, "five_hour" | "seven_day", string[]][] =
			[
				// Real answers: this fixture's 10-minute sampling is inside every
				// estimator's gap tolerance.
				[
					dbPath,
					FULL_RANGE,
					"five_hour",
					["ols", "lifetime", "naive", "endpoint-seg-1h", "ols-1h"],
				],
				// The cache-carrying estimators, which are the ones a shared array
				// could actually corrupt.
				[
					dowDbPath,
					DOW_RANGE,
					"seven_day",
					["ols", "trailing-3d", "trailing-7d", "dow-seasonal"],
				],
			];
		for (const [path, range, windowKind, names] of cases) {
			const shared = replay(path, range, windowKind, names, false);
			const sliced = replay(path, range, windowKind, names, true);
			// The comparison is only worth anything if the estimators answered.
			const answered = names.filter((name) =>
				(shared.recordsByEstimator.get(name) ?? []).some(
					(r) => r.usable && r.predictedEtaMs != null,
				),
			);
			expect(answered).toEqual(names);
			for (const name of names) {
				expect(shared.recordsByEstimator.get(name)).toEqual(
					sliced.recordsByEstimator.get(name) as never,
				);
			}
		}
	});

	test("baseline metrics on the fixture are the ones the harness landed with", () => {
		// Captured from the committed harness before per-horizon candidates were
		// added. These numbers are the regression fence around the input-contract
		// change: candidates may move, the shipped baselines may not.
		const window = run().ranges[0].windows[0];
		const summary = (name: string) => {
			const m = scoreRecords(window.recordsByEstimator.get(name) ?? []);
			return {
				instants: m.instants,
				scored: m.scored,
				censored: m.censored,
				coverage: m.coverage,
				confusion: m.confusion,
				f1: m.f1,
			};
		};
		expect(summary("ols")).toEqual({
			instants: 114,
			scored: 73,
			censored: 37,
			coverage: {
				usable: 102,
				insufficient_data: 12,
				low_confidence: 0,
				no_slope: 0,
				no_reset: 0,
			},
			confusion: { tp: 23, fp: 0, tn: 50, fn: 0 },
			f1: 1,
		});
		expect(summary("lifetime")).toEqual({
			instants: 114,
			scored: 75,
			censored: 37,
			coverage: {
				usable: 108,
				insufficient_data: 0,
				low_confidence: 0,
				no_slope: 6,
				no_reset: 0,
			},
			confusion: { tp: 22, fp: 2, tn: 51, fn: 0 },
			f1: 0.9565217391304348,
		});
		expect(summary("naive")).toEqual({
			instants: 114,
			scored: 76,
			censored: 37,
			coverage: {
				usable: 111,
				insufficient_data: 3,
				low_confidence: 0,
				no_slope: 0,
				no_reset: 0,
			},
			confusion: { tp: 23, fp: 0, tn: 53, fn: 0 },
			f1: 1,
		});
	});
});

// ---------------------------------------------------------------------------
// Selection, the gate and locking
// ---------------------------------------------------------------------------

describe("selection block", () => {
	const withCandidate = () =>
		runBacktest(dbPath, {
			ranges: [FULL_RANGE],
			stepMinutes: 10,
			windows: ["five_hour"],
			estimatorsFor: (w) =>
				estimatorsForWindow(
					["ols", "lifetime", "naive", "endpoint-seg-1h"],
					w,
				),
		}).ranges[0].windows[0];

	test("is deterministic for identical input, bootstrap included", () => {
		const opts = { lockedOnLabel: "All" };
		expect(buildSelectionBlock(withCandidate(), 20260823, opts)).toEqual(
			buildSelectionBlock(withCandidate(), 20260823, opts),
		);
	});

	test("scores every estimator on the same instants", () => {
		const block = buildSelectionBlock(withCandidate(), 20260823, {
			lockedOnLabel: "All",
		});
		expect(block.rows).toHaveLength(4);
		expect(new Set(block.rows.map((r) => r.instants)).size).toBe(1);
		// The deployment cohort is narrower than the raw instant count: censored
		// instants and windows without a live reset are not deployment decisions.
		expect(block.rows[0].instants).toBeLessThan(114);
		expect(block.winner).not.toBeNull();
		expect(block.winnerLockedOn).toBe("All");
	});

	test("the gate covers the winner and every candidate, and names ols as the reference", () => {
		const block = buildSelectionBlock(withCandidate(), 20260823, {
			lockedOnLabel: "All",
		});
		expect(block.gate.some((g) => g.estimator === "endpoint-seg-1h")).toBe(
			true,
		);
		expect(block.gate.some((g) => g.estimator === block.winner)).toBe(true);
		for (const g of block.gate) {
			expect(g.criteria).toHaveLength(3);
			expect(g.pass).toBe(g.criteria.every((c) => c.pass));
		}
		expect(block.redRule.some((r) => r.estimator === "ols")).toBe(true);
	});

	test("a baseline missing from the run FAILS the gate and is named", () => {
		// `--estimators=ols,endpoint-seg-1h` leaves the lifetime and naive
		// baselines unmeasured. The gate says "F1 at least every baseline", so it
		// must compare against all three regardless of what the run scored.
		const partial = runBacktest(dbPath, {
			ranges: [FULL_RANGE],
			stepMinutes: 10,
			windows: ["five_hour"],
			estimatorsFor: (w) => estimatorsForWindow(["ols", "endpoint-seg-1h"], w),
		}).ranges[0].windows[0];
		const block = buildSelectionBlock(partial, 20260823, {
			lockedOnLabel: "All",
		});
		expect(block.gate.length).toBeGreaterThan(0);
		for (const g of block.gate) {
			const f1Criterion = g.criteria[0];
			expect(f1Criterion.name).toContain("every baseline");
			expect(f1Criterion.pass).toBe(false);
			expect(f1Criterion.detail).toContain("lifetime");
			expect(f1Criterion.detail).toContain("naive");
			expect(g.pass).toBe(false);
		}
	});

	test("the winner is locked from the first range, never re-picked on the second", () => {
		const split = runBacktest(dbPath, {
			ranges: [
				{ label: "Tuning range", fromMs: T0, toMs: T0 + 5 * HOUR_MS },
				{
					label: "Held-out range",
					fromMs: T0 + 5 * HOUR_MS,
					toMs: T0 + 15 * HOUR_MS,
				},
			],
			stepMinutes: 10,
			windows: ["five_hour"],
			estimatorsFor: (w) =>
				estimatorsForWindow(["ols", "lifetime", "naive"], w),
		});
		const ranges = buildRanges(split, 20260823, ["ols"]);
		const tuning = ranges[0].windows[0].selection;
		const heldOut = ranges[1].windows[0].selection;
		expect(tuning?.winnerLockedOn).toBe("Tuning range");
		expect(heldOut?.winnerLockedOn).toBe("Tuning range");
		expect(heldOut?.winner).toBe(tuning?.winner as string);
	});

	test("bootstrap compares the winner with ols and with the best baseline", () => {
		const block = buildSelectionBlock(withCandidate(), 20260823, {
			lockedOnLabel: "All",
		});
		const labels = new Set(block.bootstrap.map((b) => b.label));
		for (const label of labels) {
			expect(label.startsWith(`${block.winner} minus `)).toBe(true);
		}
		// Two statistics per reference, and never a comparison with itself.
		expect(block.bootstrap.length % 2).toBe(0);
		expect(labels.has(`${block.winner} minus ${block.winner} (selection)`)).toBe(
			false,
		);
	});

	test("buildRanges attaches a selection block to every window", () => {
		const ranges = buildRanges(run(), 20260823, ["ols"]);
		expect(ranges[0].windows[0].selection).toBeDefined();
		expect(ranges[0].windows[0].selection?.rows).toHaveLength(3);
	});
});

describe("CLI parsing", () => {
	test("defaults", () => {
		const o = parseCliArgs([]);
		expect(o).toEqual({
			dbPath: null,
			fromIso: null,
			toIso: null,
			splitIso: null,
			stepMinutes: 10,
			window: "both",
			estimators: ["ols", "lifetime", "naive"],
			seed: 20260823,
			outPath: null,
		});
	});

	test("parses every flag", () => {
		const o = parseCliArgs([
			"--db=/tmp/x.db",
			"--from=2026-06-01T00:00:00Z",
			"--to=2026-08-01T00:00:00Z",
			"--split=2026-07-01T00:00:00Z",
			"--step-minutes=30",
			"--window=seven_day",
			"--seed=7",
			"--out=/tmp/report.md",
		]);
		expect(o.dbPath).toBe("/tmp/x.db");
		expect(o.stepMinutes).toBe(30);
		expect(o.window).toBe("seven_day");
		expect(o.seed).toBe(7);
		expect(o.outPath).toBe("/tmp/report.md");
		expect(o.splitIso).toBe("2026-07-01T00:00:00Z");
	});

	test("rejects nonsense", () => {
		expect(() => parseCliArgs(["--step-minutes=0"])).toThrow();
		expect(() => parseCliArgs(["--window=weekly"])).toThrow();
		expect(() => parseCliArgs(["--nope"])).toThrow();
	});
});

describe("assertSafeOutPath", () => {
	test("refuses the database path and its sidecars", () => {
		expect(() => assertSafeOutPath(dbPath, dbPath)).toThrow(/database path/);
		expect(() => assertSafeOutPath(`${dbPath}-wal`, dbPath)).toThrow(/sidecar/);
		expect(() => assertSafeOutPath(`${dbPath}-shm`, dbPath)).toThrow(/sidecar/);
	});

	test("allows an ordinary file, including an existing one", () => {
		expect(() =>
			assertSafeOutPath(join(tempDir, "report.md"), dbPath),
		).not.toThrow();
		const existing = join(tempDir, "existing-report.md");
		writeFileSync(existing, "# old report\n");
		expect(() => assertSafeOutPath(existing, dbPath)).not.toThrow();
	});

	test("refuses a symlink that points at the database", () => {
		const link = join(tempDir, "innocent-report.md");
		symlinkSync(dbPath, link);
		expect(() => assertSafeOutPath(link, dbPath)).toThrow(/database path/);
	});

	test("refuses a hard link to the database", () => {
		const alias = join(tempDir, "hardlink-report.md");
		linkSync(dbPath, alias);
		expect(() => assertSafeOutPath(alias, dbPath)).toThrow(/hard link/);
	});
});

describe("shellQuoteArg", () => {
	test("leaves ordinary flag arguments bare", () => {
		expect(shellQuoteArg("--from=2026-06-02T00:00:00Z")).toBe(
			"--from=2026-06-02T00:00:00Z",
		);
		expect(shellQuoteArg("--out=docs/prediction-backtest-baseline.md")).toBe(
			"--out=docs/prediction-backtest-baseline.md",
		);
	});

	test("quotes whitespace and shell metacharacters", () => {
		expect(shellQuoteArg("--db=/tmp/my db.sqlite")).toBe(
			"'--db=/tmp/my db.sqlite'",
		);
		expect(shellQuoteArg("--db=$(rm -rf /)")).toBe("'--db=$(rm -rf /)'");
		expect(shellQuoteArg("")).toBe("''");
	});

	test("closes and reopens the quote around an embedded single quote", () => {
		expect(shellQuoteArg("--db=/tmp/it's.db")).toBe("'--db=/tmp/it'\\''s.db'");
	});
});
