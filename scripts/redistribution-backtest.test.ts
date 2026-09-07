import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	REQUEST_BUCKET_MS,
	absorptionChecks,
	evaluateVerdict,
	formatRedistributionReport,
	knownLimitsFor,
	prepareSeries,
	replayRange,
	scoreCohorts,
} from "../packages/core/src/redistribution-backtest";
import {
	REQUEST_BUCKET_SQL,
	loadAccounts,
	loadedRequestSpan,
	loadRequestBuckets,
	loadRequestTokenCoverage,
	loadRows,
	openBacktestDatabase,
	parseCliArgs,
	parseIso,
	readDataset,
	requestsTableExists,
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
	// The absorption loader reads this one, and reads it through the index:
	// without `idx_requests_account_timestamp` the plan assertion below cannot
	// distinguish a bounded search from a table scan.
	db.run(`
		CREATE TABLE requests (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			account_used TEXT,
			total_tokens INTEGER
		)
	`);
	db.run(`
		CREATE INDEX idx_requests_account_timestamp
		ON requests(account_used, timestamp DESC)
	`);
}

/** One seeded `requests` row, so the loader tests can state their own truth. */
interface SeededRequest {
	accountId: string;
	timestamp: number;
	tokens: number | null;
}

interface Fixture {
	/** The instant `B` first reads 100 %, i.e. the peer-exhaustion event. */
	deathAt: number;
	requests: SeededRequest[];
}

/** The request span, matching the padded window the tool loads rows over. */
const REQ_FROM = T0 - 8 * DAY_MS;
const REQ_TO = T0 + 14 * DAY_MS;

/**
 * Two Anthropic accounts sharing one class. `B` burns nine times as fast and
 * hits 100 % on day 2, which is the peer-exhaustion episode the report is
 * supposed to find and score.
 *
 * Request traffic runs across the whole padded span: `B` stops at its death and
 * `A` triples, which is the step the absorption section measures. Every third
 * row of the step carries a null `total_tokens`, so the token basis meets the
 * same hole the live table has.
 */
function seedFixture(path: string): Fixture {
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
	const insertRequest = db.prepare(
		`INSERT INTO requests (id, timestamp, method, path, account_used, total_tokens)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, ?)`,
	);

	const windowStart = T0 - DAY_MS;
	const reset = windowStart + 7 * DAY_MS;
	const step = 30 * MIN_MS;
	// Inside the ten-minute staleness bar the availability history reads
	// under: a wider snapshot grid would leave every account `unknown`
	// between samples and no death would have a survivor set at all.
	const snapshotStep = 10 * MIN_MS;
	let deathAt: number | null = null;
	for (let t = windowStart; t <= T0 + 6 * DAY_MS; t += snapshotStep) {
		const elapsedDays = (t - windowStart) / DAY_MS;
		const a = Math.min(100, elapsedDays * 12);
		const b = Math.min(100, elapsedDays * 45);
		insertRow.run("A", t, a, reset, t);
		insertRow.run("B", t, b, reset, t);
		if (b >= 100 && deathAt == null) deathAt = t;
	}
	insertAccount.run("A", "acct-a", T0 - 30 * DAY_MS);
	insertAccount.run("B", "acct-b", T0 - 30 * DAY_MS);
	// An add inside the range, with no snapshots of its own: it must reach the
	// event table without breaking the roster.
	insertAccount.run("N", "acct-n", T0 + 12 * HOUR_MS);

	if (deathAt == null) throw new Error("fixture never reaches 100 %");
	const requests: SeededRequest[] = [];
	let id = 0;
	// Offsets inside the minute, so the loader has to truncate to the grid
	// rather than pass the raw timestamp through.
	for (let t = REQ_FROM; t < REQ_TO; t += step) {
		const rows: SeededRequest[] = [
			{ accountId: "A", timestamp: t + 17_000, tokens: 1000 },
		];
		if (t < deathAt) {
			rows.push({ accountId: "B", timestamp: t + 17_000, tokens: 1000 });
		} else {
			rows.push({ accountId: "A", timestamp: t + 29_000, tokens: 1000 });
			rows.push({ accountId: "A", timestamp: t + 41_000, tokens: null });
		}
		for (const row of rows) {
			insertRequest.run(
				`r-${id++}`,
				row.timestamp,
				row.accountId,
				row.tokens,
			);
			requests.push(row);
		}
	}
	db.close();
	return { deathAt, requests };
}

const fixture = seedFixture(dbPath);

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
		const requestDb = openBacktestDatabase(dbPath);
		const loadedBuckets = loadRequestBuckets(
			requestDb,
			accounts.map((entry) => entry.accountId),
			REQ_FROM,
			REQ_TO,
		);
		const span = loadedRequestSpan(loadedBuckets, REQ_FROM, REQ_TO);
		const absorption = absorptionChecks({
			events: replay.events,
			accounts,
			series: prepareSeries(rows, accounts),
			buckets: loadedBuckets,
			range,
			requestsFromMs: span.fromMs,
			requestsToMs: span.toMs,
		});
		requestDb.close();
		expect(absorption.deaths.length).toBeGreaterThan(0);

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
			absorption,
			knownLimits: knownLimitsFor(replay, cohorts, verdict, null),
			notes: ["fixture run"],
		});
		expect(markdown).toContain("## Verdict");
		expect(markdown).toContain(
			"### Request-volume changes around observed exhaustion",
		);
		expect(markdown).toContain("## Transition events");
		expect(markdown).toContain("## Observation-lag mechanism check");
		// The rules beside the basis are scored under their own heading, after the
		// verdict rather than inside it, and the identity is the basis's own and
		// sits under the verdict.
		expect(markdown).toContain("## Share rules beside the basis");
		expect(markdown).toContain(
			"### Identity with the current model on the first assignment",
		);
		expect(markdown.indexOf("\n## Verdict\n")).toBeLessThan(
			markdown.indexOf(
				"\n### Identity with the current model on the first assignment\n",
			),
		);
		expect(
			markdown.indexOf(
				"\n### Identity with the current model on the first assignment\n",
			),
		).toBeLessThan(markdown.indexOf("\n## Share rules beside the basis\n"));
		expect(markdown.indexOf("\n## Share rules beside the basis\n")).toBeLessThan(
			markdown.indexOf("\n## Known limits\n"),
		);
		// Every scan is scored beside the basis, in every per-model table: both
		// pre-correction controls, the prior basis and the headroom rule.
		expect(markdown).toContain("| scenario-equal |");
		expect(markdown).toContain("| scenario-equal-original |");
		expect(markdown).toContain("| scenario-headroom |");
		expect(markdown).toContain("| scenario-proportional |");
		expect(markdown).toContain("| scenario-proportional-original |");
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

describe("loadRequestBuckets", () => {
	test("groups into minute buckets over a half-open span", () => {
		// Around the death, so the step the absorption section measures is inside
		// the span rather than either side of it.
		const from = fixture.deathAt - 2 * HOUR_MS;
		const to = fixture.deathAt + 2 * HOUR_MS;
		const db = openBacktestDatabase(dbPath);
		const loaded = loadRequestBuckets(db, ["A", "B"], from, to);
		db.close();

		const seeded = fixture.requests.filter(
			(row) => row.timestamp >= from && row.timestamp < to,
		);
		expect(seeded.length).toBeGreaterThan(0);
		expect(loaded.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(
			seeded.length,
		);
		expect(loaded.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(
			seeded.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
		);
		for (const bucket of loaded) {
			expect(bucket.bucketStartMs % REQUEST_BUCKET_MS).toBe(0);
			expect(bucket.bucketStartMs).toBeGreaterThanOrEqual(
				from - REQUEST_BUCKET_MS,
			);
			expect(bucket.bucketStartMs).toBeLessThan(to);
		}
		// The step is in there: after the death `A` posts three rows a minute.
		expect(
			loaded.some((bucket) => bucket.accountId === "A" && bucket.requests === 3),
		).toBe(true);
	});

	test("excludes the upper bound and includes the lower one", () => {
		const boundary = fixture.requests[10].timestamp;
		const atBoundary = fixture.requests.filter(
			(row) => row.timestamp === boundary,
		).length;
		expect(atBoundary).toBeGreaterThan(0);
		const db = openBacktestDatabase(dbPath);
		const included = loadRequestBuckets(db, ["A", "B"], boundary, boundary + 1);
		const excluded = loadRequestBuckets(
			db,
			["A", "B"],
			boundary + 1,
			boundary + 2,
		);
		db.close();
		expect(included.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(
			atBoundary,
		);
		expect(excluded).toEqual([]);
	});

	test("a database with no requests table reads as no coverage, not a throw", () => {
		const bare = new Database(":memory:");
		bare.run(`CREATE TABLE accounts (id TEXT PRIMARY KEY)`);
		expect(requestsTableExists(bare)).toBe(false);
		expect(loadRequestBuckets(bare, ["A"], 0, T0)).toEqual([]);
		bare.close();
	});

	test("counts the attributed rows whose token total is null or zero", () => {
		const db = openBacktestDatabase(dbPath);
		const coverage = loadRequestTokenCoverage(db, ["A", "B"], REQ_FROM, REQ_TO);
		db.close();
		expect(coverage).not.toBeNull();
		expect(coverage?.attributedRows).toBe(fixture.requests.length);
		expect(coverage?.zeroOrNullTokenRows).toBe(
			fixture.requests.filter((row) => (row.tokens ?? 0) === 0).length,
		);
	});
});

describe("loadedRequestSpan", () => {
	test("bounds the span at the last loaded bucket, not the padded query bound", () => {
		const db = openBacktestDatabase(dbPath);
		const loaded = loadRequestBuckets(db, ["A", "B"], REQ_FROM, REQ_TO);
		db.close();

		const span = loadedRequestSpan(loaded, REQ_FROM, REQ_TO);
		const starts = loaded.map((bucket) => bucket.bucketStartMs);
		expect(span.fromMs).toBe(Math.min(...starts));
		expect(span.toMs).toBe(Math.max(...starts) + REQUEST_BUCKET_MS);
		// The seeded traffic stops well inside the padded bound.
		expect(span.toMs).toBeLessThan(REQ_TO);
	});

	test("a non-minute-aligned query clips the extent to the query bounds", () => {
		// The SQL counted only [30 s, 45 s) of this minute; the outer bucket
		// boundaries would report the whole of it as observed.
		const bucketStartMs = 1_000 * REQUEST_BUCKET_MS;
		const loaded = [
			{ accountId: "A", bucketStartMs, requests: 1, tokens: 10 },
		];
		expect(
			loadedRequestSpan(loaded, bucketStartMs + 30_000, bucketStartMs + 45_000),
		).toEqual({
			fromMs: bucketStartMs + 30_000,
			toMs: bucketStartMs + 45_000,
		});
	});

	test("a query wider than the loaded data still bounds at the buckets", () => {
		const bucketStartMs = 1_000 * REQUEST_BUCKET_MS;
		const loaded = [
			{ accountId: "A", bucketStartMs, requests: 1, tokens: 10 },
		];
		expect(
			loadedRequestSpan(
				loaded,
				bucketStartMs - 5 * REQUEST_BUCKET_MS,
				bucketStartMs + 5 * REQUEST_BUCKET_MS,
			),
		).toEqual({
			fromMs: bucketStartMs,
			toMs: bucketStartMs + REQUEST_BUCKET_MS,
		});
	});

	test("an empty load falls back to the query bound rather than an empty span", () => {
		const span = loadedRequestSpan([], REQ_FROM, REQ_TO);
		expect(span).toEqual({ fromMs: REQ_FROM, toMs: REQ_TO });
	});

	test("a control past the last loaded bucket is rejected, not measured", () => {
		const db = openBacktestDatabase(dbPath);
		const rows = loadRows(db, REQ_FROM, REQ_TO);
		const accounts = loadAccounts(db);
		const loaded = loadRequestBuckets(
			db,
			accounts.map((entry) => entry.accountId),
			REQ_FROM,
			REQ_TO,
		);
		db.close();

		// Traffic that stops a day after the death, so the +7 d control reads an
		// empty span unless the loader bounds it.
		const truncated = loaded.filter(
			(bucket) => bucket.bucketStartMs < fixture.deathAt + DAY_MS,
		);
		const span = loadedRequestSpan(truncated, REQ_FROM, REQ_TO);
		const range = { label: "Replay range", fromMs: T0, toMs: T0 + 6 * DAY_MS };
		const replay = replayRange(rows, accounts, range, 6 * 60, 20260823);
		const absorption = absorptionChecks({
			events: replay.events,
			accounts,
			series: prepareSeries(rows, accounts),
			buckets: truncated,
			range,
			requestsFromMs: span.fromMs,
			requestsToMs: span.toMs,
		});

		const controls = absorption.deaths.flatMap((death) =>
			death.narrow.controls.filter((control) => control.label === "+7 d"),
		);
		expect(controls.length).toBeGreaterThan(0);
		for (const control of controls) {
			expect(control.eligible).toBe(false);
			expect(control.rejection).toBe("outside-loaded-span");
			expect(control.measurements).toBeNull();
		}
	});
});

describe("the request bucket scan", () => {
	test("uses the account/timestamp index rather than scanning requests", () => {
		// A table scan here is a defect on a multi-gigabyte file, not a slowdown.
		const db = openBacktestDatabase(dbPath);
		const plan = db
			.prepare<{ detail: string }, [number, string, number, number]>(
				`EXPLAIN QUERY PLAN ${REQUEST_BUCKET_SQL}`,
			)
			.all(REQUEST_BUCKET_MS, "A", REQ_FROM, REQ_TO);
		db.close();
		const detail = plan.map((row) => row.detail).join(" | ");

		expect(detail).toContain("idx_requests_account_timestamp");
		expect(detail).not.toContain("SCAN requests");
	});
});
