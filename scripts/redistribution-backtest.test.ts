import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluateVerdict,
	formatRedistributionReport,
	knownLimitsFor,
	replayRange,
	scoreCohorts,
} from "../packages/core/src/redistribution-backtest";
import {
	loadAccounts,
	loadRows,
	openBacktestDatabase,
	parseCliArgs,
	parseIso,
	readDataset,
	writeRecordsJsonl,
} from "./redistribution-backtest";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const T0 = Date.parse("2026-06-01T00:00:00.000Z");

const tempDir = mkdtempSync(join(tmpdir(), "redistribution-backtest-"));
const dbPath = join(tempDir, "fixture.db");

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/**
 * The two tables this tool reads, copied from
 * `packages/database/src/migrations.ts` without the foreign key (irrelevant to
 * a read-only reader).
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
			observed_at INTEGER,
			plan_tier TEXT,
			rate_limit_tier TEXT,
			PRIMARY KEY (account_id, sampled_at)
		)
	`);
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT,
			created_at INTEGER NOT NULL,
			identity_plan_tier TEXT,
			identity_rate_limit_tier TEXT
		)
	`);
}

/**
 * Two Anthropic accounts sharing one class. `B` burns nine times as fast and
 * hits 100 % on day 2, which is the peer-exhaustion episode the report is
 * supposed to find and score.
 */
function seedFixture(path: string): void {
	const db = new Database(path);
	createTables(db);
	const insertRow = db.prepare(
		`INSERT INTO usage_snapshots
		 (account_id, provider, sampled_at, five_hour_pct, five_hour_reset,
		  seven_day_pct, seven_day_reset, observed_at, plan_tier, rate_limit_tier)
		 VALUES (?, 'anthropic', ?, NULL, NULL, ?, ?, ?, 'max', '20x')`,
	);
	const insertAccount = db.prepare(
		`INSERT INTO accounts
		 (id, name, provider, created_at, identity_plan_tier, identity_rate_limit_tier)
		 VALUES (?, ?, 'anthropic', ?, 'max', '20x')`,
	);

	const windowStart = T0 - DAY_MS;
	const reset = windowStart + 7 * DAY_MS;
	const step = 30 * MIN_MS;
	for (let t = windowStart; t <= T0 + 6 * DAY_MS; t += step) {
		const elapsedDays = (t - windowStart) / DAY_MS;
		const a = Math.min(100, elapsedDays * 12);
		const b = Math.min(100, elapsedDays * 45);
		insertRow.run("A", t, a, reset, t);
		insertRow.run("B", t, b, reset, t);
	}
	insertAccount.run("A", "acct-a", T0 - 30 * DAY_MS);
	insertAccount.run("B", "acct-b", T0 - 30 * DAY_MS);
	// An add inside the range, with no snapshots of its own: it must reach the
	// event table without breaking the roster.
	insertAccount.run("N", "acct-n", T0 + 12 * HOUR_MS);
	db.close();
}

seedFixture(dbPath);

describe("parseCliArgs", () => {
	test("defaults", () => {
		const options = parseCliArgs([]);
		expect(options).toEqual({
			dbPath: null,
			fromIso: null,
			toIso: null,
			stepMinutes: 10,
			seed: 20260823,
			outPath: null,
			recordsOutPath: null,
		});
	});

	test("parses every flag", () => {
		const options = parseCliArgs([
			"--db=/tmp/x.db",
			"--from=2026-07-01T00:00:00Z",
			"--to=2026-09-06T00:00:00Z",
			"--step-minutes=30",
			"--seed=7",
			"--out=/tmp/report.md",
			"--records-out=/tmp/records.jsonl",
		]);
		expect(options.dbPath).toBe("/tmp/x.db");
		expect(options.stepMinutes).toBe(30);
		expect(options.seed).toBe(7);
		expect(options.outPath).toBe("/tmp/report.md");
		expect(options.recordsOutPath).toBe("/tmp/records.jsonl");
	});

	test("--records-out is not swallowed by the --out prefix", () => {
		const options = parseCliArgs(["--records-out=/tmp/records.jsonl"]);
		expect(options.outPath).toBeNull();
		expect(options.recordsOutPath).toBe("/tmp/records.jsonl");
	});

	test("rejects an unknown flag and a nonsense step", () => {
		expect(() => parseCliArgs(["--nope=1"])).toThrow(/Unknown argument/);
		expect(() => parseCliArgs(["--step-minutes=0"])).toThrow(
			/Invalid --step-minutes/,
		);
		expect(() => parseCliArgs(["--seed=1.5"])).toThrow(/Invalid --seed/);
	});

	test("rejects an unparseable timestamp", () => {
		expect(() => parseIso("not-a-date", "--from")).toThrow(/Invalid --from/);
		expect(parseIso("2026-07-01T00:00:00Z", "--from")).toBe(
			Date.parse("2026-07-01T00:00:00.000Z"),
		);
	});
});

describe("end to end on a fixture database", () => {
	test("reads the dataset, replays it and writes a report with a verdict", () => {
		const db = openBacktestDatabase(dbPath);
		const dataset = readDataset(db);
		const rows = loadRows(db, T0 - 8 * DAY_MS, T0 + 14 * DAY_MS);
		const accounts = loadAccounts(db);
		db.close();

		expect(dataset.summary.accounts).toBe(2);
		expect(dataset.summary.providers).toEqual(["anthropic"]);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0].planTier).toBe("max");
		expect(rows[0].observedAt).toBe(rows[0].sampledAt);
		expect(accounts.map((account) => account.accountId).sort()).toEqual([
			"A",
			"B",
			"N",
		]);

		const range = { label: "Replay range", fromMs: T0, toMs: T0 + 6 * DAY_MS };
		const replay = replayRange(rows, accounts, range, 6 * 60, 20260823);
		const cohorts = scoreCohorts(replay);
		const verdict = evaluateVerdict(cohorts, replay);

		// The fixture's whole point: a peer death and an add, both detected.
		expect(
			replay.events.filter((event) => event.kind === "peer-exhaustion").length,
		).toBeGreaterThan(0);
		expect(replay.events.some((event) => event.kind === "add")).toBe(true);
		expect(replay.records.length).toBeGreaterThan(0);

		const markdown = formatRedistributionReport({
			title: "ClankerMux runway redistribution backtest",
			generatedAtIso: new Date(T0).toISOString(),
			command: "bun scripts/redistribution-backtest.ts --db=fixture.db",
			config: { stepMinutes: 360, seed: 20260823 },
			dataset: dataset.summary,
			replay,
			cohorts,
			verdict,
			knownLimits: knownLimitsFor(replay, cohorts, verdict),
			notes: ["fixture run"],
		});
		expect(markdown).toContain("## Verdict");
		expect(markdown).toContain("## Transition events");
		expect(markdown).toContain("## Observation-lag mechanism check");
		// The pre-correction scan is scored beside the corrected one.
		expect(markdown).toContain("| scenario-equal-original |");
		expect(markdown).toContain(`**Verdict: ${verdict.verdict}**`);
		expect(markdown).not.toContain("undefined");
	});

	test("the handle it opens cannot write", () => {
		const db = openBacktestDatabase(dbPath);
		try {
			expect(() =>
				db.run(`INSERT INTO accounts (id, name, created_at) VALUES ('z','z',1)`),
			).toThrow();
		} finally {
			db.close();
		}
	});
});

describe("writeRecordsJsonl", () => {
	test("writes one parseable JSON line per record, with ISO instants", async () => {
		const db = openBacktestDatabase(dbPath);
		const rows = loadRows(db, T0 - 8 * DAY_MS, T0 + 14 * DAY_MS);
		const accounts = loadAccounts(db);
		db.close();
		const replay = replayRange(
			rows,
			accounts,
			{ label: "Replay range", fromMs: T0, toMs: T0 + 6 * DAY_MS },
			6 * 60,
			20260823,
		);
		expect(replay.records.length).toBeGreaterThan(0);

		const path = join(tempDir, "records.jsonl");
		await writeRecordsJsonl(path, replay.records);
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(replay.records.length);

		const first = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(first.tIso).toBe(new Date(replay.records[0].T).toISOString());
		expect(first.model).toBe(replay.records[0].model);
		expect(first.lifecycleId).toBe(replay.records[0].lifecycleId);
		expect(Object.keys(first)).toContain("slopePctPerHour");
		expect(Object.keys(first)).toContain("sinceDeathMinutes");
		expect(Object.keys(first)).toContain("observationAgeMs");
		expect(Object.keys(first)).toContain("lagMs");
		expect(Object.keys(first)).toContain("estimatorSource");
		// Every line parses; a partially written dump is worse than none.
		for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
	});
});
