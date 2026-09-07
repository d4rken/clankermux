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
	ABSORPTION_CONTROL_OFFSET_MS,
	ABSORPTION_HALF_WIDTH_MS,
	type AbsorptionChecks,
	absorptionChecks,
	evaluateFailoverLine,
	evaluateVerdict,
	formatRedistributionReport,
	knownLimitsFor,
	prepareSeries,
	type RedistributionRecord,
	redistributionRecordToJson,
	REQUEST_BUCKET_MS,
	type ReplayRange,
	replayRange,
	type RequestBucket,
	type RequestTokenCoverage,
	type RosterAccount,
	type RosterSnapshotRow,
	scoreCohorts,
	scoreFailoverLine,
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

/**
 * A matched control sits a week off the death and reads a half-window either
 * side of itself, so the padded span has to contain both or a control would
 * silently read outside the loaded data instead of being rejected.
 */
if (ABSORPTION_CONTROL_OFFSET_MS + ABSORPTION_HALF_WIDTH_MS > LOAD_PAD_MS) {
	throw new Error(
		"LOAD_PAD_MS is too small for a matched absorption control at +/- 7 d",
	);
}

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

/**
 * The per-account request scan behind the causal absorption measurement.
 *
 * Two-sided and bounded on `account_used`, so it plans as a SEARCH on
 * `idx_requests_account_timestamp` rather than a scan; the script test asserts
 * that plan, and a degradation to a table scan is a defect on a multi-gigabyte
 * file rather than a slowdown. All measured on 2026-09-07 against the live
 * database:
 *
 * - Selecting `total_tokens` demotes the plan from a covering index scan to an
 *   index search with table lookups, because the index carries only
 *   `(account_used, timestamp)`. The whole history, all seven accounts, with
 *   the token sum, takes 3.0 s. That is nothing in an offline backtest, and
 *   request count alone is a weak proxy for quota burn: the scenario
 *   redistributes capacity units, not requests. Both volumes are measured.
 * - `total_tokens` is null or zero on 14,769 of 807,705 attributed rows
 *   (1.8 %). {@link loadRequestTokenCoverage} counts them for the report
 *   rather than letting them sum silently as zeros.
 * - No `success` or `model` filter: 118 of 376 k recent rows are 429s and 580
 *   have any failover, so filtering would move counts by under 0.3 % while
 *   costing another column.
 * - One row per client request, not per upstream attempt (`failover_attempts`
 *   is a column, not a row multiplier), so a failover storm near a death does
 *   not double-count.
 */
export const REQUEST_BUCKET_SQL = `SELECT (timestamp / ?1) * ?1 AS bucket_start,
       COUNT(*) AS n,
       SUM(COALESCE(total_tokens, 0)) AS tokens
FROM requests
WHERE account_used = ?2 AND timestamp >= ?3 AND timestamp < ?4
GROUP BY bucket_start
ORDER BY bucket_start`;

/** How much of the token basis is actually populated, for the known limits. */
export const REQUEST_TOKEN_COVERAGE_SQL = `SELECT COUNT(*) AS n,
       SUM(CASE WHEN COALESCE(total_tokens, 0) = 0 THEN 1 ELSE 0 END) AS zero_rows
FROM requests
WHERE account_used = ?1 AND timestamp >= ?2 AND timestamp < ?3`;

/**
 * Whether this database has a `requests` table at all.
 *
 * An older or trimmed file has none, and the report has to say the table was
 * unreadable rather than print an empty absorption section as if it had
 * measured silence.
 */
export function requestsTableExists(db: Database): boolean {
	const row = db
		.query<{ n: number }, []>(
			`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='requests'`,
		)
		.get();
	return (row?.n ?? 0) > 0;
}

/**
 * Minute buckets of request volume per account over `[fromMs, toMs)`.
 *
 * One statement per account, never a single `WHERE timestamp BETWEEN` over all
 * of them: that plans on `idx_requests_timestamp`, which does not carry
 * `account_used`, and would do a table lookup per row of the whole span.
 */
export function loadRequestBuckets(
	db: Database,
	accountIds: readonly string[],
	fromMs: number,
	toMs: number,
): RequestBucket[] {
	if (!requestsTableExists(db)) return [];
	const statement = db.query<
		{ bucket_start: number; n: number; tokens: number | null },
		[number, string, number, number]
	>(REQUEST_BUCKET_SQL);
	const out: RequestBucket[] = [];
	for (const accountId of accountIds) {
		for (const row of statement.all(
			REQUEST_BUCKET_MS,
			accountId,
			fromMs,
			toMs,
		)) {
			out.push({
				accountId,
				bucketStartMs: row.bucket_start,
				requests: row.n,
				tokens: row.tokens ?? 0,
			});
		}
	}
	return out;
}

/**
 * The span the request data ACTUALLY covers, not the span it was asked for.
 *
 * The loader queries a padded window either side of the replay interval, but
 * the table stops where the traffic stops. Passing the padded bound on would
 * let a matched control sit past the last row and read an empty interval as a
 * measured zero instead of being rejected as outside the loaded span. The
 * upper bound is the last bucket's END, since a bucket covers
 * `[start, start + REQUEST_BUCKET_MS)`.
 *
 * An empty load has no extent to state, so the query bound is returned
 * unchanged; every death is then excluded for want of request coverage.
 */
export function loadedRequestSpan(
	buckets: readonly RequestBucket[],
	queriedFromMs: number,
	queriedToMs: number,
): { fromMs: number; toMs: number } {
	if (buckets.length === 0) {
		return { fromMs: queriedFromMs, toMs: queriedToMs };
	}
	let first = buckets[0].bucketStartMs;
	let last = buckets[0].bucketStartMs;
	for (const bucket of buckets) {
		if (bucket.bucketStartMs < first) first = bucket.bucketStartMs;
		if (bucket.bucketStartMs > last) last = bucket.bucketStartMs;
	}
	// INTERSECTED with what was actually asked for. The bucket boundaries are
	// outer: a query over [30 s, 45 s) lands in the minute starting at 0 s, and
	// reporting that whole minute as observed would present a partial bucket as
	// a fully counted one to everything downstream that treats this as the span
	// the request table was read over.
	return {
		fromMs: Math.max(first, queriedFromMs),
		toMs: Math.min(last + REQUEST_BUCKET_MS, queriedToMs),
	};
}

/** The attributed rows in the span, and how many carry no token total. */
export function loadRequestTokenCoverage(
	db: Database,
	accountIds: readonly string[],
	fromMs: number,
	toMs: number,
): RequestTokenCoverage | null {
	if (!requestsTableExists(db)) return null;
	const statement = db.query<
		{ n: number; zero_rows: number | null },
		[string, number, number]
	>(REQUEST_TOKEN_COVERAGE_SQL);
	let attributedRows = 0;
	let zeroOrNullTokenRows = 0;
	for (const accountId of accountIds) {
		const row = statement.get(accountId, fromMs, toMs);
		attributedRows += row?.n ?? 0;
		zeroOrNullTokenRows += row?.zero_rows ?? 0;
	}
	return { attributedRows, zeroOrNullTokenRows };
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
	let requestsFromMs: number;
	let requestsToMs: number;
	let buckets: RequestBucket[];
	let requestsReadable: boolean;
	let tokenCoverage: RequestTokenCoverage | null;
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
		requestsFromMs = fromMs - LOAD_PAD_MS;
		requestsToMs = toMs + LOAD_PAD_MS;
		rows = loadRows(db, requestsFromMs, requestsToMs);
		accounts = loadAccounts(db);
		requestsReadable = requestsTableExists(db);
		const accountIds = accounts.map((account) => account.accountId);
		buckets = loadRequestBuckets(db, accountIds, requestsFromMs, requestsToMs);
		// The absorption measurement reads the extent the data has, not the
		// window it was queried over.
		const span = loadedRequestSpan(buckets, requestsFromMs, requestsToMs);
		requestsFromMs = span.fromMs;
		requestsToMs = span.toMs;
		tokenCoverage = loadRequestTokenCoverage(
			db,
			accountIds,
			requestsFromMs,
			requestsToMs,
		);
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
	const failoverScores = scoreFailoverLine(replay);
	const failoverVerdict = evaluateFailoverLine(failoverScores);
	// Precomputed by the caller, the way `cohorts` and `verdict` are. The
	// segmentation is rebuilt here rather than threaded out of `replayRange`,
	// which keeps that function's result the record of the replay alone.
	const absorption: AbsorptionChecks | null = requestsReadable
		? absorptionChecks({
				events: replay.events,
				accounts,
				series: prepareSeries(rows, accounts),
				buckets,
				range,
				requestsFromMs,
				requestsToMs,
			})
		: null;
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
		absorption,
		failoverLine: { scores: failoverScores, verdict: failoverVerdict },
		knownLimits: knownLimitsFor(replay, cohorts, verdict, tokenCoverage),
		notes: [
			`Replay took ${(replayMs / 1000).toFixed(1)} s over ${replay.instants} instants; scoring and bootstrap ${(scoringMs / 1000).toFixed(1)} s.`,
			`Grid step ${options.stepMinutes} min; rows loaded ${LOAD_PAD_MS / DAY_MS} days either side of the replay interval.`,
		requestsReadable
			? `Request buckets loaded: ${buckets.length} minute buckets over ${accounts.length} accounts, on a ${REQUEST_BUCKET_MS / 1000}-second grid, spanning ${new Date(requestsFromMs).toISOString()} to ${new Date(requestsToMs).toISOString()}.`
			: "No `requests` table in this database: the request-volume subsection reports it as unreadable.",
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
