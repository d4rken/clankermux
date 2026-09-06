#!/usr/bin/env bun
/**
 * redistribution-backtest.ts — survivor-conditioned replay of the
 * demand-conserving runway scenario against the model that ships, on recorded
 * `usage_snapshots`. A DEVELOPMENT TOOL: never wired into the server, never on
 * the request path.
 *
 *     bun scripts/redistribution-backtest.ts [--db=<path>] [--from=<ISO>] [--to=<ISO>]
 *                                            [--step-minutes=10] [--seed=N] [--out=<path>]
 *                                            [--records-out=<path.jsonl>]
 *
 * The database is opened STRICTLY read-only (`openReadOnlyDatabase`, SQLite
 * `readonly: true`); the live file is multi-gigabyte and serves the running
 * proxy. There is no write path of any kind, and `--out` refuses to resolve to
 * the database file or any of its sidecars.
 *
 * All scoring lives in `packages/core/src/redistribution-backtest.ts` (pure,
 * unit-tested); this file does I/O and orchestration only. Sibling of
 * `scripts/prediction-backtest.ts`, whose CLI shape, guards and read-only
 * handle it reuses.
 */

import type { Database } from "bun:sqlite";
import {
	evaluateVerdict,
	formatRedistributionReport,
	knownLimitsFor,
	type RedistributionRecord,
	redistributionRecordToJson,
	type ReplayRange,
	replayRange,
	type RosterAccount,
	type RosterSnapshotRow,
	scoreCohorts,
} from "../packages/core/src/redistribution-backtest";
import { resolveDbPath } from "../packages/database/src/paths";
import {
	assertSafeOutPath,
	openReadOnlyDatabase,
	shellQuoteArg,
} from "./db-tool-io";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows this far outside the scoring range are loaded too: eight days before it
 * so the first instant already has a full weekly window of history behind it,
 * and eight days after it so the window an instant sits in can be seen to end
 * (the label horizon inside the module then decides what is scorable).
 */
const LOAD_PAD_MS = 8 * DAY_MS;

const DEFAULT_SEED = 20260823;
const DEFAULT_STEP_MINUTES = 10;

const USAGE = `Usage: bun scripts/redistribution-backtest.ts [--db=<path>] [--from=<ISO>] [--to=<ISO>]
       [--step-minutes=${DEFAULT_STEP_MINUTES}] [--seed=${DEFAULT_SEED}] [--out=<path>]
       [--records-out=<path.jsonl>]`;

export interface CliOptions {
	dbPath: string | null;
	fromIso: string | null;
	toIso: string | null;
	stepMinutes: number;
	seed: number;
	outPath: string | null;
	/**
	 * Where to dump one JSON line per replay record. Optional: the report is the
	 * product, this is the raw material a follow-up analysis would otherwise
	 * have to re-run the multi-minute replay to get.
	 */
	recordsOutPath: string | null;
}

export function parseCliArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		dbPath: null,
		fromIso: null,
		toIso: null,
		stepMinutes: DEFAULT_STEP_MINUTES,
		seed: DEFAULT_SEED,
		outPath: null,
		recordsOutPath: null,
	};
	for (const arg of argv) {
		if (arg.startsWith("--db=")) options.dbPath = arg.slice(5);
		else if (arg.startsWith("--from=")) options.fromIso = arg.slice(7);
		else if (arg.startsWith("--to=")) options.toIso = arg.slice(5);
		else if (arg.startsWith("--step-minutes=")) {
			const n = Number(arg.slice(15));
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error(`Invalid --step-minutes: ${arg}`);
			}
			options.stepMinutes = n;
		} else if (arg.startsWith("--seed=")) {
			const n = Number(arg.slice(7));
			if (!Number.isInteger(n)) throw new Error(`Invalid --seed: ${arg}`);
			options.seed = n;
		} else if (arg.startsWith("--records-out=")) {
			options.recordsOutPath = arg.slice(14);
		} else if (arg.startsWith("--out=")) options.outPath = arg.slice(6);
		else if (arg === "--help" || arg === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
	}
	return options;
}

export function parseIso(value: string, flag: string): number {
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) {
		throw new Error(`Invalid ${flag} timestamp: ${value}`);
	}
	return ms;
}

/** The ONLY database handle this tool ever opens, and it is read-only. */
export function openBacktestDatabase(dbPath: string): Database {
	return openReadOnlyDatabase(dbPath);
}

interface SnapshotRow {
	account_id: string;
	provider: string | null;
	sampled_at: number;
	observed_at: number | null;
	five_hour_pct: number | null;
	five_hour_reset: number | null;
	seven_day_pct: number | null;
	seven_day_reset: number | null;
	plan_tier: string | null;
	rate_limit_tier: string | null;
}

interface AccountRow {
	id: string;
	name: string | null;
	provider: string | null;
	created_at: number;
	identity_plan_tier: string | null;
	identity_rate_limit_tier: string | null;
}

export interface DatasetSummary {
	rows: number;
	accounts: number;
	providers: string[];
	firstSampleIso: string;
	lastSampleIso: string;
}

export function readDataset(db: Database): {
	summary: DatasetSummary;
	firstMs: number | null;
	lastMs: number | null;
} {
	const agg = db
		.query<
			{
				rows: number;
				first_ms: number | null;
				last_ms: number | null;
				accounts: number;
			},
			[]
		>(
			`SELECT COUNT(*) AS rows, MIN(sampled_at) AS first_ms,
			        MAX(sampled_at) AS last_ms, COUNT(DISTINCT account_id) AS accounts
			 FROM usage_snapshots`,
		)
		.get();
	const providers = db
		.query<{ provider: string | null }, []>(
			`SELECT DISTINCT provider FROM usage_snapshots ORDER BY provider`,
		)
		.all()
		.map((row) => row.provider ?? "(null)");
	const firstMs = agg?.first_ms ?? null;
	const lastMs = agg?.last_ms ?? null;
	return {
		summary: {
			rows: agg?.rows ?? 0,
			accounts: agg?.accounts ?? 0,
			providers,
			firstSampleIso: firstMs != null ? new Date(firstMs).toISOString() : "—",
			lastSampleIso: lastMs != null ? new Date(lastMs).toISOString() : "—",
		},
		firstMs,
		lastMs,
	};
}

export function loadRows(
	db: Database,
	fromMs: number,
	toMs: number,
): RosterSnapshotRow[] {
	return db
		.query<SnapshotRow, [number, number]>(
			`SELECT account_id, provider, sampled_at, observed_at,
			        five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset,
			        plan_tier, rate_limit_tier
			 FROM usage_snapshots
			 WHERE sampled_at >= ? AND sampled_at <= ?
			 ORDER BY account_id, sampled_at`,
		)
		.all(fromMs, toMs)
		.map((row) => ({
			accountId: row.account_id,
			provider: row.provider,
			sampledAt: row.sampled_at,
			observedAt: row.observed_at,
			fiveHourPct: row.five_hour_pct,
			fiveHourReset: row.five_hour_reset,
			sevenDayPct: row.seven_day_pct,
			sevenDayReset: row.seven_day_reset,
			planTier: row.plan_tier,
			rateLimitTier: row.rate_limit_tier,
		}));
}

export function loadAccounts(db: Database): RosterAccount[] {
	return db
		.query<AccountRow, []>(
			`SELECT id, name, provider, created_at,
			        identity_plan_tier, identity_rate_limit_tier
			 FROM accounts`,
		)
		.all()
		.map((row) => ({
			accountId: row.id,
			name: row.name ?? row.id,
			provider: row.provider ?? "anthropic",
			createdAtMs: row.created_at,
			currentPlanTier: row.identity_plan_tier,
			currentRateLimitTier: row.identity_rate_limit_tier,
		}));
}

/**
 * One JSON line per record, streamed rather than joined: a full-range replay
 * produces hundreds of thousands of records, and building one string of them
 * would hold the whole dump in memory for no reason.
 */
export async function writeRecordsJsonl(
	path: string,
	records: readonly RedistributionRecord[],
): Promise<void> {
	const writer = Bun.file(path).writer();
	try {
		for (const record of records) {
			writer.write(`${JSON.stringify(redistributionRecordToJson(record))}\n`);
		}
	} finally {
		await writer.end();
	}
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const dbPath = options.dbPath ?? resolveDbPath();
	// Before a single row is read, so a mistyped `--out` cannot be discovered
	// after a multi-minute replay.
	if (options.outPath) assertSafeOutPath(options.outPath, dbPath);
	if (options.recordsOutPath) {
		assertSafeOutPath(options.recordsOutPath, dbPath);
	}

	const db = openBacktestDatabase(dbPath);
	let dataset: ReturnType<typeof readDataset>;
	let rows: RosterSnapshotRow[];
	let accounts: RosterAccount[];
	let range: ReplayRange;
	try {
		dataset = readDataset(db);
		if (dataset.firstMs == null || dataset.lastMs == null) {
			throw new Error("usage_snapshots is empty — nothing to backtest");
		}
		const fromMs = options.fromIso
			? parseIso(options.fromIso, "--from")
			: dataset.firstMs;
		const toMs = options.toIso
			? parseIso(options.toIso, "--to")
			: dataset.lastMs;
		if (toMs <= fromMs) throw new Error("--to must be after --from");
		range = { label: "Replay range", fromMs, toMs };
		rows = loadRows(db, fromMs - LOAD_PAD_MS, toMs + LOAD_PAD_MS);
		accounts = loadAccounts(db);
	} finally {
		db.close();
	}

	const startedAt = Date.now();
	const replay = replayRange(
		rows,
		accounts,
		range,
		options.stepMinutes,
		options.seed,
	);
	const replayMs = Date.now() - startedAt;
	console.error(
		`Replay: ${replay.instants} instants, ${replay.records.length} records, ${replay.events.length} transitions in ${(replayMs / 1000).toFixed(1)} s`,
	);

	if (options.recordsOutPath) {
		await writeRecordsJsonl(options.recordsOutPath, replay.records);
		console.error(
			`Wrote ${replay.records.length} records to ${options.recordsOutPath}`,
		);
	}

	const scoringStartedAt = Date.now();
	const cohorts = scoreCohorts(replay);
	const verdict = evaluateVerdict(cohorts, replay);
	const scoringMs = Date.now() - scoringStartedAt;
	console.error(
		`Scoring and bootstrap: ${(scoringMs / 1000).toFixed(1)} s; verdict ${verdict.verdict}${verdict.provisional ? " (provisional)" : ""}`,
	);

	const command = [
		"bun scripts/redistribution-backtest.ts",
		...process.argv.slice(2).map(shellQuoteArg),
	].join(" ");

	const markdown = formatRedistributionReport({
		title: "ClankerMux runway redistribution backtest",
		generatedAtIso: new Date().toISOString(),
		command,
		config: {
			stepMinutes: options.stepMinutes,
			seed: options.seed,
			from: new Date(range.fromMs).toISOString(),
			to: new Date(range.toMs).toISOString(),
			loadPadDays: LOAD_PAD_MS / DAY_MS,
		},
		dataset: dataset.summary,
		replay,
		cohorts,
		verdict,
		knownLimits: knownLimitsFor(replay, cohorts, verdict),
		notes: [
			`Replay took ${(replayMs / 1000).toFixed(1)} s over ${replay.instants} instants; scoring and bootstrap ${(scoringMs / 1000).toFixed(1)} s.`,
			`Grid step ${options.stepMinutes} min; rows loaded ${LOAD_PAD_MS / DAY_MS} days either side of the replay interval.`,
		],
	});

	if (options.outPath) {
		await Bun.write(options.outPath, markdown);
		console.error(`Wrote ${options.outPath}`);
	} else {
		console.log(markdown);
	}
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}

// Re-exported so this file is the single import surface its own tests use, the
// same arrangement `scripts/prediction-backtest.ts` has.
export { assertSafeOutPath, shellQuoteArg };
