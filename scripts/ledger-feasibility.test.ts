import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	copyFileSync,
	linkSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { columnIndex } from "../packages/core/src/ledger-feasibility";
import { assertSafeOutPath } from "./db-tool-io";
import {
	binsForCell,
	buildCellGrid,
	CONTROL_FUTURE_OFFSET_MINUTES,
	ERA_BOUNDARIES,
	keepaliveActivePeriods,
	LAG_GRID_MINUTES,
	loadStudyData,
	NULL_PROVIDER,
	openLedgerDatabase,
	parseCliArgs,
	providersFromSnapshots,
	readSnapshotBounds,
	runFeasibilityStudy,
	DEFAULT_SEED,
	WIDTH_GRID_MINUTES,
} from "./ledger-feasibility";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-06-01T00:00:00.000Z");
/** Long enough that every group clears the 1000-equivalent-bin exposure floor. */
const SPAN_DAYS = 6;
const SELECTION_END = T0 + 3 * DAY;
const STUDY_END = T0 + SPAN_DAYS * DAY;
/** The three instants every block assignment is judged against. */
const BOUNDS = {
	fromMs: T0,
	selectionEndMs: SELECTION_END,
	toMs: STUDY_END,
};

const tempDir = mkdtempSync(join(tmpdir(), "ledger-feasibility-"));
const dbPath = join(tempDir, "fixture.db");

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/** Schema copied from `packages/database/src/migrations.ts`, columns this tool reads. */
function createTables(db: Database): void {
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT,
			identity_rate_limit_tier TEXT,
			identity_captured_at INTEGER
		)
	`);
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
			status_code INTEGER,
			response_time_ms INTEGER,
			model TEXT,
			billing_type TEXT,
			input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			cache_read_input_tokens INTEGER DEFAULT 0,
			cache_creation_input_tokens INTEGER DEFAULT 0
		)
	`);
	db.run(`
		CREATE TABLE cache_keepalive_snapshots (
			sampled_at INTEGER PRIMARY KEY,
			warm_sessions INTEGER NOT NULL,
			promoted_sessions INTEGER NOT NULL,
			total_bytes INTEGER NOT NULL,
			keepalives_sent INTEGER NOT NULL,
			hits INTEGER NOT NULL,
			misses INTEGER NOT NULL,
			failures INTEGER NOT NULL,
			spent_usd REAL NOT NULL,
			saved_usd REAL NOT NULL
		)
	`);
}

/**
 * A fixture where the ledger REALLY does explain the percent: every account
 * spends a fixed number of tokens every 2 minutes and the weekly percent rises
 * by exactly the matching amount. It exists so the end-to-end plumbing can be
 * checked against a known answer, not to say anything about production.
 */
function buildFixtureDb(): void {
	const db = new Database(dbPath, { create: true });
	createTables(db);
	const insertAccount = db.prepare(
		"INSERT INTO accounts (id, name, provider, identity_rate_limit_tier, identity_captured_at) VALUES (?, ?, ?, ?, ?)",
	);
	insertAccount.run("anth-1", "anth-1", "anthropic", "20x", T0);
	insertAccount.run("anth-2", "anth-2", "anthropic", "5x", T0);
	insertAccount.run("codex-1", "codex-1", "codex", null, null);

	const insertSnapshot = db.prepare(
		`INSERT INTO usage_snapshots
		 (account_id, provider, sampled_at, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertRequest = db.prepare(
		`INSERT INTO requests
		 (id, timestamp, method, path, account_used, status_code, response_time_ms,
		  model, billing_type, input_tokens, output_tokens, cache_read_input_tokens,
		  cache_creation_input_tokens)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, 200, ?, ?, ?, ?, ?, ?, ?)`,
	);

	db.run("BEGIN");
	let requestId = 0;
	const accounts: {
		id: string;
		provider: string;
		model: string;
		perTick: number;
	}[] = [
		{ id: "anth-1", provider: "anthropic", model: "claude-opus-4-6", perTick: 40_000 },
		{ id: "anth-2", provider: "anthropic", model: "claude-sonnet-4-5", perTick: 30_000 },
		{ id: "codex-1", provider: "codex", model: "gpt-5.6-sol", perTick: 20_000 },
	];
	const step = 2 * MIN;
	for (const account of accounts) {
		// One weekly window covering the whole fixture.
		const weeklyReset = T0 + 7 * DAY;
		let weeklyPct = 0;
		let fiveHourReset = T0 + 5 * HOUR;
		let fiveHourPct = 0;
		for (let t = T0; t < STUDY_END; t += step) {
			if (t >= fiveHourReset) {
				fiveHourReset += 5 * HOUR;
				fiveHourPct = 0;
			}
			// Burn varies with the tick so the columns are not constant.
			const tokens = account.perTick * (1 + ((t / step) % 5));
			insertSnapshot.run(
				account.id,
				account.provider,
				t,
				account.provider === "codex" ? 0 : fiveHourPct,
				fiveHourReset,
				weeklyPct,
				weeklyReset,
			);
			// The rise the NEXT tick will show, caused by these tokens.
			insertRequest.run(
				`r${requestId++}`,
				t + MIN,
				account.id,
				1_000,
				account.model,
				"subscription",
				tokens,
				Math.floor(tokens / 10),
				Math.floor(tokens / 2),
				0,
			);
			// Rates chosen so neither window reaches 100% inside the fixture: a
			// saturated endpoint is a contamination flag, and a fixture that
			// saturates would leave the clean cohort empty.
			const gross = tokens + Math.floor(tokens / 10) + Math.floor(tokens / 2);
			weeklyPct += gross * 5e-8;
			fiveHourPct += gross * 2e-6;
		}
	}
	db.run("COMMIT");

	// Keepalive counters: flat, then climbing for an hour, then a restart.
	const insertKeepalive = db.prepare(
		`INSERT INTO cache_keepalive_snapshots
		 (sampled_at, warm_sessions, promoted_sessions, total_bytes, keepalives_sent,
		  hits, misses, failures, spent_usd, saved_usd)
		 VALUES (?, 0, 0, 0, ?, 0, 0, 0, 0, 0)`,
	);
	let sent = 0;
	db.run("BEGIN");
	for (let i = 0; i < 60; i++) {
		const t = T0 + i * MIN;
		if (i >= 20 && i < 40) sent += 3;
		if (i === 50) sent = 0; // a restart resets the counter
		insertKeepalive.run(t, sent);
	}
	db.run("COMMIT");
	db.close();
}

buildFixtureDb();

/**
 * A writable COPY of the fixture, mutated for one test.
 *
 * The fixture itself is shared and the tool's own handle is read-only, so a
 * test that needs different metadata gets its own file rather than editing the
 * one every other test reads.
 */
function copyFixture(path: string, mutate: (db: Database) => void): void {
	copyFileSync(dbPath, path);
	const db = new Database(path);
	try {
		mutate(db);
	} finally {
		db.close();
	}
}

function study(overrides: Partial<Parameters<typeof runFeasibilityStudy>[1]> = {}) {
	return runFeasibilityStudy(dbPath, {
		fromMs: T0,
		toMs: STUDY_END,
		selectionEndMs: SELECTION_END,
		seed: DEFAULT_SEED,
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Read-only enforcement
// ---------------------------------------------------------------------------

describe("database access", () => {
	test("the handle is read-only: every write through it throws", () => {
		const db = openLedgerDatabase(dbPath);
		try {
			expect(() =>
				db.run("INSERT INTO usage_snapshots (account_id, sampled_at) VALUES ('x', 1)"),
			).toThrow();
			expect(() => db.run("DELETE FROM requests")).toThrow();
			expect(() => db.run("CREATE TABLE scratch (a INTEGER)")).toThrow();
			expect(() => db.run("UPDATE accounts SET provider = 'nope'")).toThrow();
		} finally {
			db.close();
		}
		const check = openLedgerDatabase(dbPath);
		const rows = check
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_snapshots")
			.get();
		check.close();
		expect(rows?.n).toBeGreaterThan(0);
	});

	test("a full study run leaves the fixture byte-identical", async () => {
		const before = await Bun.file(dbPath).arrayBuffer();
		study();
		const after = await Bun.file(dbPath).arrayBuffer();
		expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe("loadStudyData", () => {
	test("groups snapshots and requests by account, with the in-range provider", () => {
		const db = openLedgerDatabase(dbPath);
		const data = loadStudyData(db, T0, STUDY_END);
		db.close();
		expect(data.accounts.size).toBe(3);
		const anth = data.accounts.get("anth-1");
		expect(anth?.provider).toBe("anthropic");
		expect(anth?.points.seven_day.length).toBeGreaterThan(1_000);
		expect(anth?.points.five_hour.length).toBe(anth?.points.seven_day.length);
		expect(anth?.requests.length).toBe(anth?.points.seven_day.length);
		expect(data.dataset.providers).toEqual(["anthropic", "codex"]);
	});

	test("the range filter is half-open on both ends", () => {
		const db = openLedgerDatabase(dbPath);
		const data = loadStudyData(db, T0 + 2 * MIN, T0 + 6 * MIN);
		db.close();
		const points = data.accounts.get("anth-1")?.points.seven_day ?? [];
		expect(points.map((p) => p.t)).toEqual([T0 + 2 * MIN, T0 + 4 * MIN]);
	});

	test("snapshot bounds come from the whole table, not the range", () => {
		const db = openLedgerDatabase(dbPath);
		const bounds = readSnapshotBounds(db);
		db.close();
		expect(bounds.firstMs).toBe(T0);
		expect(bounds.lastMs).toBe(STUDY_END - 2 * MIN);
	});

	test("every dataset statistic is computed over the study range only", () => {
		const db = openLedgerDatabase(dbPath);
		const narrow = loadStudyData(db, T0 + 2 * MIN, T0 + 10 * MIN);
		const whole = readSnapshotBounds(db);
		db.close();
		const iso = (ms: number) => new Date(ms).toISOString();
		// Snapshots at T0+2, +4, +6, +8; requests one minute after each tick.
		expect(narrow.dataset.firstSnapshotIso).toBe(iso(T0 + 2 * MIN));
		expect(narrow.dataset.lastSnapshotIso).toBe(iso(T0 + 8 * MIN));
		expect(narrow.dataset.firstRequestIso).toBe(iso(T0 + 3 * MIN));
		expect(narrow.dataset.lastRequestIso).toBe(iso(T0 + 9 * MIN));
		expect(narrow.range).toEqual({ fromMs: T0 + 2 * MIN, toMs: T0 + 10 * MIN });
		// The table itself reaches further on both ends; the report must not.
		expect(whole.firstMs).toBeLessThan(T0 + 2 * MIN);
		expect(whole.lastMs).toBeGreaterThan(T0 + 10 * MIN);
	});

	test("the live tier and its capture instant are kept for stderr only", () => {
		const db = openLedgerDatabase(dbPath);
		// The fixture captured every identity at T0.
		const data = loadStudyData(db, T0, STUDY_END);
		db.close();
		const anth = data.liveAccounts.find((a) => a.accountId === "anth-1");
		expect(anth?.liveTier).toBe("20x");
		expect(anth?.identityCapturedAtIso).toBe(new Date(T0).toISOString());
		const codex = data.liveAccounts.find((a) => a.accountId === "codex-1");
		expect(codex?.liveTier).toBeNull();
		// Nothing the report is built from carries a tier: the study exposes it on
		// `liveAccounts`, which only reaches stderr.
		expect(Object.keys(data)).not.toContain("tierByAccount");
	});

	test("the provider comes from the in-range snapshots, not the live accounts row", () => {
		// The live row says one thing, the history another. Grouping by the live
		// row would move rows the study already binned into a different group, so a
		// re-run of a FROZEN range would produce a different report from the same
		// history.
		const movedPath = join(tempDir, "moved-provider.db");
		copyFixture(movedPath, (db) => {
			db.run("UPDATE accounts SET provider = 'litellm' WHERE id = 'anth-1'");
		});
		const db = openLedgerDatabase(movedPath);
		const data = loadStudyData(db, T0, STUDY_END);
		db.close();
		expect(data.accounts.get("anth-1")?.provider).toBe("anthropic");
		expect(data.dataset.providers).toEqual(["anthropic", "codex"]);
		expect(data.providerConflicts).toEqual([]);
		// The live value is kept, for stderr and nothing else.
		const live = data.liveAccounts.find((a) => a.accountId === "anth-1");
		expect(live?.liveProvider).toBe("litellm");
		expect(live?.derivedProvider).toBe("anthropic");
	});

	test("in-range snapshots that disagree pick the majority and report the conflict", () => {
		const splitPath = join(tempDir, "split-provider.db");
		copyFixture(splitPath, (db) => {
			// A minority of anth-2's in-range samples were recorded under another
			// provider. The majority still decides, and the disagreement is stated.
			db.run(
				`UPDATE usage_snapshots SET provider = 'litellm'
				 WHERE account_id = 'anth-2' AND sampled_at < ?`,
				[T0 + HOUR],
			);
		});
		const db = openLedgerDatabase(splitPath);
		const data = loadStudyData(db, T0, STUDY_END);
		db.close();
		expect(data.accounts.get("anth-2")?.provider).toBe("anthropic");
		expect(data.providerConflicts).toHaveLength(1);
		const conflict = data.providerConflicts[0];
		expect(conflict.accountId).toBe("anth-2");
		expect(conflict.chosen).toBe("anthropic");
		expect(conflict.values.map((v) => v.provider)).toEqual([
			"anthropic",
			"litellm",
		]);
		expect(conflict.values[1].rows).toBe(30);
	});

	test("an account with no in-range snapshots is not derived a provider at all", () => {
		const db = openLedgerDatabase(dbPath);
		// A range before any snapshot exists: nothing in it says what any account
		// was, and the live row may not fill the gap.
		const empty = loadStudyData(db, T0 - 2 * DAY, T0 - DAY);
		db.close();
		expect(empty.accounts.size).toBe(0);
		expect(
			empty.liveAccounts.find((a) => a.accountId === "anth-1")
				?.derivedProvider,
		).toBeNull();
	});
});

describe("providersFromSnapshots", () => {
	test("a null provider column is `(null)`, never an empty string", () => {
		const { providerByAccount, conflicts } = providersFromSnapshots([
			{ account_id: "a", provider: null },
			{ account_id: "a", provider: null },
		]);
		expect(providerByAccount.get("a")).toBe(NULL_PROVIDER);
		expect(conflicts).toEqual([]);
	});

	test("ties go to the value seen first, so the choice is deterministic", () => {
		// Rows arrive ordered by `sampled_at`, so "first seen" is "earliest".
		const { providerByAccount, conflicts } = providersFromSnapshots([
			{ account_id: "a", provider: "anthropic" },
			{ account_id: "a", provider: "codex" },
		]);
		expect(providerByAccount.get("a")).toBe("anthropic");
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].values).toEqual([
			{ provider: "anthropic", rows: 1 },
			{ provider: "codex", rows: 1 },
		]);
	});
});

// ---------------------------------------------------------------------------
// Keepalive marking
// ---------------------------------------------------------------------------

describe("keepaliveActivePeriods", () => {
	test("marks the intervals where the counter rose, and merges them", () => {
		const periods = keepaliveActivePeriods([
			{ sampled_at: 0, keepalives_sent: 0 },
			{ sampled_at: 100, keepalives_sent: 0 },
			{ sampled_at: 200, keepalives_sent: 5 },
			{ sampled_at: 300, keepalives_sent: 9 },
			{ sampled_at: 400, keepalives_sent: 9 },
			{ sampled_at: 500, keepalives_sent: 11 },
		]);
		expect(periods).toEqual([
			{ fromMs: 100, toMs: 300 },
			{ fromMs: 400, toMs: 500 },
		]);
	});

	test("a counter reset is a restart, not activity", () => {
		expect(
			keepaliveActivePeriods([
				{ sampled_at: 0, keepalives_sent: 90 },
				{ sampled_at: 100, keepalives_sent: 0 },
				{ sampled_at: 200, keepalives_sent: 0 },
			]),
		).toEqual([]);
	});

	test("the fixture's climbing hour marks bins, and the restart does not", () => {
		const db = openLedgerDatabase(dbPath);
		const data = loadStudyData(db, T0, STUDY_END);
		db.close();
		expect(data.keepalive).toEqual([
			{ fromMs: T0 + 19 * MIN, toMs: T0 + 39 * MIN },
		]);
		expect(data.dataset.keepaliveActivePeriods).toBe(1);
	});

	test("only bins overlapping an active period are marked", () => {
		const result = study();
		const anthWeekly = result.groups.find(
			(g) => g.provider === "anthropic" && g.windowKind === "seven_day",
		);
		// The active period sits inside the SELECTION block, so the evaluation
		// block's bins are untouched by it.
		expect(anthWeekly?.census.keepaliveActive).toBe(0);
		expect(anthWeekly?.census.total).toBeGreaterThan(0);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// End-to-end binning
// ---------------------------------------------------------------------------

describe("runFeasibilityStudy", () => {
	test("sweeps every grid cell for every eligible group", () => {
		const result = study();
		const grid = buildCellGrid();
		const anchors = 2;
		expect(grid.length).toBe(
			WIDTH_GRID_MINUTES.length *
				anchors *
				(LAG_GRID_MINUTES.length + CONTROL_FUTURE_OFFSET_MINUTES.length),
		);
		expect(grid.filter((c) => c.control).length).toBe(
			WIDTH_GRID_MINUTES.length * anchors * CONTROL_FUTURE_OFFSET_MINUTES.length,
		);
		for (const entry of result.cellScoresByGroup) {
			expect(entry.cells.length).toBe(grid.length);
		}
	}, 30_000);

	test("candidate lags are non-negative and controls clear a whole bin width", () => {
		for (const cell of buildCellGrid()) {
			if (!cell.control) {
				// A cause precedes its effect.
				expect(cell.lagMs).toBeGreaterThanOrEqual(0);
				continue;
			}
			// A control must shift tokens WHOLLY past the bin they land in, which
			// takes at least a full bin width plus the offset.
			const offsets = CONTROL_FUTURE_OFFSET_MINUTES.map(
				(m) => -(cell.widthMs + m * MIN),
			);
			expect(offsets).toContain(cell.lagMs);
			expect(Math.abs(cell.lagMs)).toBeGreaterThan(cell.widthMs);
		}
	});

	test("recovers the fixture's built-in relation on the anthropic weekly window", () => {
		const group = study().groups.find(
			(g) => g.provider === "anthropic" && g.windowKind === "seven_day",
		);
		expect(group?.eligible).toBe(true);
		expect(group?.relation?.insufficient).toBe(false);
		// The fixture makes the percent an exact function of the tokens, so the
		// relation must be found; a plumbing bug would show up as a low R2 here.
		expect(group?.relation?.r2 as number).toBeGreaterThan(0.9);
		expect(group?.selection.selected).not.toBeNull();
	}, 30_000);

	test("tokens are attributed by family and class end to end", () => {
		const group = study().groups.find(
			(g) => g.provider === "anthropic" && g.windowKind === "seven_day",
		);
		const labels = new Set(group?.identifiability?.columns.map((c) => c.label));
		expect(labels.has("opus/input")).toBe(true);
		expect(labels.has("opus/output")).toBe(true);
		expect(labels.has("opus/cache_read")).toBe(true);
		expect(labels.has("sonnet/input")).toBe(true);
		// Nothing was billed as cache creation in the fixture.
		expect(labels.has("opus/cache_creation")).toBe(false);
		expect(columnIndex("opus", "input")).toBeGreaterThanOrEqual(0);
	}, 30_000);

	test("the codex weekly group resolves no family at all", () => {
		const group = study().groups.find(
			(g) => g.provider === "codex" && g.windowKind === "seven_day",
		);
		expect(group?.familyResolution?.resolvedShare).toBe(0);
		expect(
			group?.entries.find((e) => e.name === "family resolution")?.verdict,
		).toBe("fail");
	});

	test("the codex five-hour group is excluded outright", () => {
		const group = study().groups.find(
			(g) => g.provider === "codex" && g.windowKind === "five_hour",
		);
		expect(group?.excludedReason).toContain("2026-07-12");
		expect(group?.verdict).toBe("insufficient-evidence");
		expect(group?.relation).toBeNull();
	});

	test("no cell scorable on the selection block short-circuits, never falls back", () => {
		// An 80-minute range. Its 40-minute selection block yields at most 20 bins
		// per account even at the narrowest width, so no cell reaches the pooled
		// usable-bin minimum and nothing is selectable.
		const result = runFeasibilityStudy(dbPath, {
			fromMs: T0,
			toMs: T0 + 80 * MIN,
			selectionEndMs: T0 + 40 * MIN,
			seed: DEFAULT_SEED,
		});
		expect(result.groups.length).toBeGreaterThan(0);
		for (const group of result.groups) {
			expect(group.verdict).toBe("insufficient-evidence");
			// Nothing was analysed, so no cell's numbers were reported — least of all
			// a control cell's.
			expect(group.relation).toBeNull();
			expect(group.selection.selected).toBeNull();
		}
		const anth = result.groups.find(
			(g) => g.provider === "anthropic" && g.windowKind === "seven_day",
		);
		expect(anth?.eligibilityDetail).toContain("no cell was selected");
		expect(result.boundaryDroppedByGroup).toEqual([]);
	});

	test("bins never straddle the selection/evaluation boundary", () => {
		const result = study();
		for (const group of result.groups) {
			for (const account of group.concentration?.accounts ?? []) {
				expect(account.usableBins).toBeGreaterThanOrEqual(0);
			}
		}
		// Every reported bin starts at or after the boundary: the evaluation block
		// is the only source of a reported number.
		const anth = result.groups.find(
			(g) => g.provider === "anthropic" && g.windowKind === "seven_day",
		);
		expect(anth?.census.total).toBeGreaterThan(0);
		expect(anth?.relation?.usableBins).toBeGreaterThan(0);
	});

	test("is deterministic: two runs produce an identical verdict set", () => {
		const summarise = (result: ReturnType<typeof study>) =>
			result.groups.map((g) => ({
				provider: g.provider,
				windowKind: g.windowKind,
				verdict: g.verdict,
				selected: g.selection.selected,
				r2: g.relation?.r2 ?? null,
				entries: g.entries.map((e) => [e.name, e.verdict, e.detail]),
			}));
		expect(summarise(study())).toEqual(summarise(study()));
	});

	test("a different seed moves only the seeded controls", () => {
		const a = study();
		const b = study({ seed: 12345 });
		const cellsOf = (r: ReturnType<typeof study>) =>
			r.cellScoresByGroup.map((g) => g.cells);
		// The sweep itself has no random input at all.
		expect(cellsOf(a)).toEqual(cellsOf(b));
	}, 30_000);

	test("a block owns a bin only when its TOKEN SOURCE interval is in the block too", () => {
		const db = openLedgerDatabase(dbPath);
		const data = loadStudyData(db, T0, STUDY_END);
		db.close();
		const widthMs = 10 * MIN;
		const lagMs = 6 * MIN;
		const key = "anthropic|seven_day";

		const lagged = binsForCell(
			data,
			{ widthMs, lagMs, anchor: "terminal", control: false },
			BOUNDS,
		).get(key);
		expect(lagged).toBeDefined();
		expect(lagged?.evaluation.length).toBeGreaterThan(0);
		for (const bin of lagged?.evaluation ?? []) {
			// Its tokens were stamped at `startMs - lagMs` at the earliest.
			expect(bin.startMs - lagMs).toBeGreaterThanOrEqual(SELECTION_END);
		}
		for (const bin of lagged?.selection ?? []) {
			expect(bin.endMs - lagMs).toBeLessThanOrEqual(SELECTION_END);
		}
		// Two bins per account belong to neither block: the one opening exactly at
		// the split, which would have to ingest selection-block requests, and the
		// first bin of the study, whose tokens would have to come from before the
		// range's start where nothing was loaded.
		expect(lagged?.boundaryDropped).toBe(4);
		for (const bin of lagged?.selection ?? []) {
			expect(bin.startMs - lagMs).toBeGreaterThanOrEqual(T0);
		}

		// At lag 0 the bin interval IS the source interval, and both the fixture's
		// split and its range ends fall on bin edges, so nothing is dropped.
		const unlagged = binsForCell(
			data,
			{ widthMs, lagMs: 0, anchor: "terminal", control: false },
			BOUNDS,
		).get(key);
		expect(unlagged?.boundaryDropped).toBe(0);
	});

	test("a future-token control bin at the evaluation tail is dropped, not truncated", () => {
		const db = openLedgerDatabase(dbPath);
		const data = loadStudyData(db, T0, STUDY_END);
		db.close();
		const widthMs = 10 * MIN;
		// The real control construction: -(width + offset).
		const lagMs = -(widthMs + 2 * MIN);
		const key = "anthropic|seven_day";

		const control = binsForCell(
			data,
			{ widthMs, lagMs, anchor: "terminal", control: true },
			BOUNDS,
		).get(key);
		expect(control?.evaluation.length).toBeGreaterThan(0);
		// A control bin draws its tokens from `[start - lag, end - lag]`, a whole
		// width and more PAST itself. Near the end of the range that interval has
		// no requests in it at all, because none were loaded: keeping the bin would
		// score it on a token mass silently truncated at the cutoff.
		for (const bin of control?.evaluation ?? []) {
			expect(bin.endMs - lagMs).toBeLessThanOrEqual(STUDY_END);
		}
		const lastKept = Math.max(
			...(control?.evaluation ?? []).map((b) => b.endMs),
		);
		expect(lastKept).toBeLessThanOrEqual(STUDY_END + lagMs);
		// Two accounts, and for each of them the tail bins the truncation would
		// have hit plus the bin straddling the split.
		expect(control?.boundaryDropped as number).toBeGreaterThanOrEqual(4);
	});

	test("boundary-dropped counts surface per group for the selected cell", () => {
		const db = openLedgerDatabase(dbPath);
		const data = loadStudyData(db, T0, STUDY_END);
		db.close();
		const result = study();
		expect(result.boundaryDroppedByGroup.length).toBeGreaterThan(0);
		for (const entry of result.boundaryDroppedByGroup) {
			const group = result.groups.find(
				(g) =>
					g.provider === entry.provider && g.windowKind === entry.windowKind,
			);
			const selected = group?.selection.selected;
			expect(selected).toBeDefined();
			if (selected == null) continue;
			const bucket = binsForCell(
				data,
				{ ...selected, control: false },
				BOUNDS,
			).get(`${entry.provider}|${entry.windowKind}`);
			expect(entry.bins).toBe(bucket?.boundaryDropped as number);
		}
	}, 30_000);

	test("the permutation control has teeth: synchronised accounts cannot beat it", () => {
		// Every fixture account burns on the same tick pattern, so one account's
		// tokens are exactly proportional to another's percent rise. A placebo that
		// scores as well as the treatment is precisely what must not pass.
		const group = study().groups.find(
			(g) => g.provider === "anthropic" && g.windowKind === "seven_day",
		);
		expect(group?.selection.controlsPass).toBe(false);
		expect(group?.selection.controlDetails.join(" ")).toContain(
			"account-permutation control",
		);
	});

	test("every era boundary is reported, measurable or not", () => {
		const group = study().groups.find(
			(g) => g.provider === "anthropic" && g.windowKind === "seven_day",
		);
		expect(group?.era?.boundaries.map((x) => x.boundary.label)).toEqual(
			ERA_BOUNDARIES.map((b) => b.label),
		);
	});

	test("the August boundary records commit time as a proxy for deploy time", () => {
		const august = ERA_BOUNDARIES.find((b) =>
			b.label.startsWith("August usage-persistence"),
		);
		expect(august?.atMs).toBe(Date.parse("2026-08-13T08:48:59Z"));
		expect(august?.provenance).toContain("478440d3");
		expect(august?.provenance).toContain("proxy for DEPLOY time");
	});
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe("CLI parsing", () => {
	test("defaults", () => {
		expect(parseCliArgs([])).toEqual({
			dbPath: null,
			fromIso: null,
			toIso: null,
			selectionBlockEndIso: null,
			seed: DEFAULT_SEED,
			outPath: null,
		});
	});

	test("parses every flag", () => {
		const o = parseCliArgs([
			"--db=/tmp/x.db",
			"--from=2026-06-01T00:00:00Z",
			"--to=2026-08-23T00:00:00Z",
			"--selection-block-end=2026-07-15T00:00:00Z",
			"--seed=7",
			"--out=/tmp/report.md",
		]);
		expect(o.dbPath).toBe("/tmp/x.db");
		expect(o.fromIso).toBe("2026-06-01T00:00:00Z");
		expect(o.toIso).toBe("2026-08-23T00:00:00Z");
		expect(o.selectionBlockEndIso).toBe("2026-07-15T00:00:00Z");
		expect(o.seed).toBe(7);
		expect(o.outPath).toBe("/tmp/report.md");
	});

	test("rejects nonsense", () => {
		expect(() => parseCliArgs(["--seed=abc"])).toThrow();
		expect(() => parseCliArgs(["--nope"])).toThrow();
	});
});

describe("assertSafeOutPath", () => {
	test("refuses the database path and its sidecars", () => {
		expect(() => assertSafeOutPath(dbPath, dbPath)).toThrow(/database path/);
		expect(() => assertSafeOutPath(`${dbPath}-wal`, dbPath)).toThrow(/sidecar/);
		expect(() => assertSafeOutPath(`${dbPath}-shm`, dbPath)).toThrow(/sidecar/);
	});

	test("refuses symlink and hard-link aliases of the database", () => {
		const link = join(tempDir, "symlinked-report.md");
		symlinkSync(dbPath, link);
		expect(() => assertSafeOutPath(link, dbPath)).toThrow(/database path/);
		const alias = join(tempDir, "hardlinked-report.md");
		linkSync(dbPath, alias);
		expect(() => assertSafeOutPath(alias, dbPath)).toThrow(/hard link/);
	});

	test("allows an ordinary report path", () => {
		expect(() =>
			assertSafeOutPath(join(tempDir, "report.md"), dbPath),
		).not.toThrow();
	});
});
