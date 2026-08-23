import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSafeOutPath,
	buildRanges,
	openBacktestDatabase,
	parseCliArgs,
	runBacktest,
	shellQuoteArg,
} from "./prediction-backtest";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const T0 = Date.parse("2026-06-01T00:00:00.000Z");

const tempDir = mkdtempSync(join(tmpdir(), "prediction-backtest-"));
const dbPath = join(tempDir, "fixture.db");
const boundaryDbPath = join(tempDir, "boundary.db");

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
		// Spacing is enforced INSIDE a window series (resetAtMs identifies one).
		const byWindow = new Map<string, number[]>();
		for (const r of records) {
			const key = `${r.accountId} ${r.resetAtMs}`;
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
