#!/usr/bin/env bun
/**
 * prediction-backtest.ts — offline replay of the usage-exhaustion estimators
 * against recorded `usage_snapshots`. A DEVELOPMENT TOOL: it is never wired
 * into the server and must never run on the request path.
 *
 *     bun scripts/prediction-backtest.ts [--db=<path>] [--from=<ISO>] [--to=<ISO>]
 *                                        [--split=<ISO>] [--step-minutes=10]
 *                                        [--window=five_hour|seven_day|both]
 *                                        [--seed=N] [--out=<path>]
 *
 * The database is opened STRICTLY read-only. The live database is ~9.6 GB and
 * serves the running proxy; this script has no write path of any kind, and
 * `--out` refuses to resolve to the database file.
 *
 * All scoring logic lives in `packages/core/src/prediction-backtest.ts` (pure,
 * unit-tested). This file does I/O and orchestration only. The deep imports
 * below follow the precedent set by `scripts/backfill-request-costs.ts`:
 * one-off scripts may import source directly. The harness is deliberately NOT
 * re-exported from `@clankermux/core`'s barrel so nothing in the running
 * service can reach it.
 */

import { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	type BacktestRecord,
	type BacktestWindowKind,
	bootstrapDelta,
	commonCohort,
	deriveOutcome,
	type Estimator,
	FIVE_HOUR_WINDOW_MS,
	formatBacktestReport,
	type ReportAccountContribution,
	type ReportBootstrapEntry,
	type ReportDatasetSummary,
	type ReportEstimatorMetrics,
	type ReportProviderMetrics,
	type ReportRange,
	type ReportRateLimitDiagnosticRow,
	type ReportWindowBlock,
	SEVEN_DAY_WINDOW_MS,
	lifetimeAverageEstimator,
	macroAverageByAccount,
	makeOlsEstimator,
	naivePersistenceEstimator,
	scoreRecords,
} from "../packages/core/src/prediction-backtest";
import { isResetBoundary, splitSeries } from "../packages/core/src/usage-prediction";
import { resolveDbPath } from "../packages/database/src/paths";
import type { PredictionPoint } from "../packages/types/src/usage-prediction";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Production lookbacks, mirrored from
 * `packages/http-api/src/services/build-account-predictions.ts`. The replay is
 * only meaningful if it feeds the estimator what the server feeds it.
 */
const WINDOW_SPECS: Record<
	BacktestWindowKind,
	{ windowMs: number; lookbackMs: number }
> = {
	five_hour: { windowMs: FIVE_HOUR_WINDOW_MS, lookbackMs: 6 * HOUR_MS },
	seven_day: { windowMs: SEVEN_DAY_WINDOW_MS, lookbackMs: 24 * HOUR_MS },
};

/** Widest production lookback: rows this far before a range still feed its first instant. */
const LOAD_PAD_BEFORE_MS = 24 * HOUR_MS;
/** Longest window plus slack: enough to see the end of any window a candidate sits in. */
const LOAD_PAD_AFTER_MS = 8 * 24 * HOUR_MS;

const DEFAULT_SEED = 20260823;
const BOOTSTRAP_ITERATIONS = 1000;

export const BASELINE_ESTIMATORS = ["ols", "lifetime", "naive"] as const;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * The ONLY database handle this tool ever opens, and it is read-only:
 * `bun:sqlite` opens the file with SQLITE_OPEN_READONLY, so a write is
 * rejected by SQLite itself rather than by a convention someone can forget.
 */
export function openBacktestDatabase(dbPath: string): Database {
	return new Database(dbPath, { readonly: true });
}

interface SnapshotRow {
	account_id: string;
	provider: string | null;
	sampled_at: number;
	five_hour_pct: number | null;
	five_hour_reset: number | null;
	seven_day_pct: number | null;
	seven_day_reset: number | null;
}

interface AccountSeries {
	accountId: string;
	provider: string | null;
	points: Record<BacktestWindowKind, PredictionPoint[]>;
}

export interface BacktestRange {
	label: string;
	fromMs: number;
	toMs: number;
}

export interface BacktestRunOptions {
	ranges: BacktestRange[];
	stepMinutes: number;
	windows: BacktestWindowKind[];
	/** Estimators to score, per window. Defaults to the three baselines. */
	estimatorsFor?: (window: BacktestWindowKind) => Map<string, Estimator>;
}

export interface WindowRunResult {
	windowKind: BacktestWindowKind;
	recordsByEstimator: Map<string, BacktestRecord[]>;
	byAccount: ReportAccountContribution[];
}

export interface RangeRunResult {
	range: BacktestRange;
	windows: WindowRunResult[];
}

export interface BacktestRunResult {
	dataset: ReportDatasetSummary;
	datasetFirstMs: number | null;
	datasetLastMs: number | null;
	ranges: RangeRunResult[];
	rateLimitDiagnostic: ReportRateLimitDiagnosticRow[];
}

function defaultEstimators(): Map<string, Estimator> {
	return new Map<string, Estimator>([
		["ols", makeOlsEstimator()],
		["lifetime", lifetimeAverageEstimator],
		["naive", naivePersistenceEstimator],
	]);
}

function readDataset(db: Database): {
	summary: ReportDatasetSummary;
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
		.map((r) => r.provider ?? "(null)");
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

function loadSeries(
	db: Database,
	fromMs: number,
	toMs: number,
): Map<string, AccountSeries> {
	const rows = db
		.query<SnapshotRow, [number, number]>(
			`SELECT account_id, provider, sampled_at, five_hour_pct, five_hour_reset,
			        seven_day_pct, seven_day_reset
			 FROM usage_snapshots
			 WHERE sampled_at >= ? AND sampled_at <= ?
			 ORDER BY account_id, sampled_at`,
		)
		.all(fromMs, toMs);
	const byAccount = new Map<string, AccountSeries>();
	for (const row of rows) {
		let entry = byAccount.get(row.account_id);
		if (!entry) {
			entry = {
				accountId: row.account_id,
				provider: row.provider,
				points: { five_hour: [], seven_day: [] },
			};
			byAccount.set(row.account_id, entry);
		}
		if (row.five_hour_pct != null) {
			entry.points.five_hour.push({
				t: row.sampled_at,
				utilization: row.five_hour_pct,
				resetsAt: row.five_hour_reset,
			});
		}
		if (row.seven_day_pct != null) {
			entry.points.seven_day.push({
				t: row.sampled_at,
				utilization: row.seven_day_pct,
				resetsAt: row.seven_day_reset,
			});
		}
	}
	return byAccount;
}

/** 429s are a LABEL-QUALITY signal only; they never decide an outcome. */
function load429sByAccount(
	db: Database,
	fromMs: number,
	toMs: number,
): Map<string, number[]> {
	const rows = db
		.query<{ account_used: string | null; timestamp: number }, [number, number]>(
			`SELECT account_used, timestamp FROM requests
			 WHERE status_code = 429 AND timestamp >= ? AND timestamp <= ?
			 ORDER BY timestamp`,
		)
		.all(fromMs, toMs);
	const out = new Map<string, number[]>();
	for (const row of rows) {
		if (row.account_used == null) continue;
		const list = out.get(row.account_used);
		if (list) list.push(row.timestamp);
		else out.set(row.account_used, [row.timestamp]);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** First index with `points[i].t >= t`. */
function lowerBound(points: PredictionPoint[], t: number): number {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (points[mid].t < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** First index with `points[i].t > t`. */
function upperBound(points: PredictionPoint[], t: number): number {
	let lo = 0;
	let hi = points.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (points[mid].t <= t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

interface SurvivedWindow {
	accountId: string;
	windowKind: BacktestWindowKind;
	fromMs: number;
	toMs: number;
}

function accountContributions(
	records: BacktestRecord[],
	providerByAccount: Map<string, string | null>,
): ReportAccountContribution[] {
	const byAccount = new Map<string, ReportAccountContribution>();
	for (const r of records) {
		let entry = byAccount.get(r.accountId);
		if (!entry) {
			entry = {
				accountId: r.accountId,
				provider: providerByAccount.get(r.accountId) ?? null,
				instants: 0,
				scored: 0,
				positives: 0,
			};
			byAccount.set(r.accountId, entry);
		}
		entry.instants++;
		if (r.outcome.kind === "censored") continue;
		entry.scored++;
		if (
			r.outcome.kind === "exhausted" &&
			(r.resetAtMs == null || r.outcome.atMs < r.resetAtMs)
		) {
			entry.positives++;
		}
	}
	return [...byAccount.values()].sort((a, b) =>
		a.accountId.localeCompare(b.accountId),
	);
}

/**
 * Replay one window over one range.
 *
 * Candidate instants are ACTUAL snapshot timestamps, downsampled to at least
 * `stepMs` apart inside each window series, so the newest input point is never
 * more than one sampler tick old — the same freshness production sees. An
 * instant whose newest reading is already at the cap is skipped: there is
 * nothing left to predict.
 *
 * A candidate is dropped when its outcome region reaches the end of the scoring
 * range (the LABEL HORIZON): otherwise a tuning-range instant would be labelled
 * with evidence from the held-out range. Ranges are half-open `[from, to)`, so
 * an outcome landing exactly ON `to` already belongs to the next range, and
 * resets routinely land on exact clock boundaries.
 */
function replayWindow(
	windowKind: BacktestWindowKind,
	range: BacktestRange,
	stepMs: number,
	accounts: Map<string, AccountSeries>,
	estimators: Map<string, Estimator>,
	survived: SurvivedWindow[],
): WindowRunResult {
	const spec = WINDOW_SPECS[windowKind];
	const recordsByEstimator = new Map<string, BacktestRecord[]>();
	for (const name of estimators.keys()) recordsByEstimator.set(name, []);

	for (const account of [...accounts.values()].sort((a, b) =>
		a.accountId.localeCompare(b.accountId),
	)) {
		const all = account.points[windowKind];
		if (all.length === 0) continue;
		const windows = splitSeries(all, isResetBoundary);
		for (let wi = 0; wi < windows.length; wi++) {
			const series = windows[wi];
			const resetAtMs = series[series.length - 1].resetsAt;
			const next = wi + 1 < windows.length ? windows[wi + 1] : null;
			const nextWindowStartsMs = next ? next[0].t : null;

			let lastCandidate: number | null = null;
			let sawSurvivor = false;
			for (const point of series) {
				const T = point.t;
				if (T < range.fromMs || T >= range.toMs) continue;
				if (lastCandidate != null && T - lastCandidate < stepMs) continue;
				// Already at the cap: nothing to forecast.
				if (point.utilization >= 100) continue;
				lastCandidate = T;

				const outcome = deriveOutcome(
					series,
					T,
					resetAtMs,
					nextWindowStartsMs,
				);
				const outcomeEndMs =
					outcome.kind === "exhausted"
						? outcome.atMs
						: Math.min(
								resetAtMs ?? Number.POSITIVE_INFINITY,
								nextWindowStartsMs ?? Number.POSITIVE_INFINITY,
							);
				if (outcomeEndMs >= range.toMs) continue;
				if (outcome.kind === "survived") sawSurvivor = true;

				const lo = lowerBound(all, T - spec.lookbackMs);
				const hi = upperBound(all, T);
				const input = all.slice(lo, hi);
				for (const [name, estimator] of estimators) {
					const out = estimator(input, T, spec);
					recordsByEstimator.get(name)?.push({
						T,
						windowKind,
						accountId: account.accountId,
						provider: account.provider,
						usable: out.usable,
						unusableReason: out.unusableReason,
						predictsExhaust: out.predictsExhaust,
						predictedEtaMs: out.predictedEtaMs,
						outcome,
						resetAtMs,
						windowMs: spec.windowMs,
					});
				}
			}
			if (sawSurvivor) {
				const endMs = Math.min(
					resetAtMs ?? Number.POSITIVE_INFINITY,
					nextWindowStartsMs ?? Number.POSITIVE_INFINITY,
				);
				survived.push({
					accountId: account.accountId,
					windowKind,
					fromMs: series[0].t,
					toMs: Number.isFinite(endMs) ? endMs : series[series.length - 1].t,
				});
			}
		}
	}

	const providerByAccount = new Map(
		[...accounts.values()].map((a) => [a.accountId, a.provider] as const),
	);
	const first = recordsByEstimator.values().next();
	return {
		windowKind,
		recordsByEstimator,
		byAccount: accountContributions(
			first.done ? [] : first.value,
			providerByAccount,
		),
	};
}

/**
 * Replay every requested window over every range. Opens the database
 * read-only and closes it before returning.
 */
export function runBacktest(
	dbPath: string,
	options: BacktestRunOptions,
): BacktestRunResult {
	const db = openBacktestDatabase(dbPath);
	try {
		const dataset = readDataset(db);
		const loadFrom =
			Math.min(...options.ranges.map((r) => r.fromMs)) - LOAD_PAD_BEFORE_MS;
		const loadTo =
			Math.max(...options.ranges.map((r) => r.toMs)) + LOAD_PAD_AFTER_MS;
		const accounts = loadSeries(db, loadFrom, loadTo);
		const rateLimits = load429sByAccount(db, loadFrom, loadTo);
		const stepMs = options.stepMinutes * MINUTE_MS;
		const estimatorsFor = options.estimatorsFor ?? (() => defaultEstimators());

		const survived: SurvivedWindow[] = [];
		const ranges: RangeRunResult[] = options.ranges.map((range) => ({
			range,
			windows: options.windows.map((windowKind) =>
				replayWindow(
					windowKind,
					range,
					stepMs,
					accounts,
					estimatorsFor(windowKind),
					survived,
				),
			),
		}));

		return {
			dataset: dataset.summary,
			datasetFirstMs: dataset.firstMs,
			datasetLastMs: dataset.lastMs,
			ranges,
			rateLimitDiagnostic: buildRateLimitDiagnostic(
				survived,
				rateLimits,
				accounts,
			),
		};
	} finally {
		db.close();
	}
}

function buildRateLimitDiagnostic(
	survived: SurvivedWindow[],
	rateLimits: Map<string, number[]>,
	accounts: Map<string, AccountSeries>,
): ReportRateLimitDiagnosticRow[] {
	const byKey = new Map<string, ReportRateLimitDiagnosticRow>();
	for (const w of survived) {
		const key = `${w.accountId} ${w.windowKind}`;
		let row = byKey.get(key);
		if (!row) {
			row = {
				accountId: w.accountId,
				provider: accounts.get(w.accountId)?.provider ?? null,
				windowKind: w.windowKind,
				survivedWindows: 0,
				survivedWindowsWith429: 0,
				requests429: 0,
			};
			byKey.set(key, row);
		}
		row.survivedWindows++;
		const stamps = rateLimits.get(w.accountId) ?? [];
		let hits = 0;
		for (const t of stamps) {
			if (t >= w.fromMs && t <= w.toMs) hits++;
		}
		if (hits > 0) {
			row.survivedWindowsWith429++;
			row.requests429 += hits;
		}
	}
	return [...byKey.values()].sort(
		(a, b) =>
			a.accountId.localeCompare(b.accountId) ||
			a.windowKind.localeCompare(b.windowKind),
	);
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

function providerBreakdown(
	cohort: Map<string, BacktestRecord[]>,
): ReportProviderMetrics[] {
	const out: ReportProviderMetrics[] = [];
	const providers = new Set<string>();
	for (const records of cohort.values()) {
		for (const r of records) providers.add(r.provider ?? "(null)");
	}
	for (const provider of [...providers].sort()) {
		for (const [estimator, records] of cohort) {
			out.push({
				provider,
				estimator,
				metrics: scoreRecords(
					records.filter((r) => (r.provider ?? "(null)") === provider),
				),
			});
		}
	}
	return out;
}

function metricsRows(
	byEstimator: Map<string, BacktestRecord[]>,
): ReportEstimatorMetrics[] {
	return [...byEstimator].map(([estimator, records]) => ({
		estimator,
		metrics: scoreRecords(records),
	}));
}

export function buildWindowBlock(
	window: WindowRunResult,
	seed: number,
	bootstrapAgainst: string[] = [],
): ReportWindowBlock {
	const cohort = commonCohort(window.recordsByEstimator);
	const bootstrap: ReportBootstrapEntry[] = [];
	const reference = bootstrapAgainst[0];
	if (reference != null) {
		const referenceRecords = cohort.get(reference) ?? [];
		for (const [estimator, records] of cohort) {
			if (estimator === reference) continue;
			for (const statistic of ["f1", "medianAbsErrorMinutes"] as const) {
				const ci = bootstrapDelta(records, referenceRecords, {
					iterations: BOOTSTRAP_ITERATIONS,
					seed,
					statistic,
				});
				bootstrap.push({
					label: `${estimator} minus ${reference}`,
					statistic,
					p2_5: ci.p2_5,
					p50: ci.p50,
					p97_5: ci.p97_5,
					samples: ci.samples,
				});
			}
		}
	}
	return {
		windowKind: window.windowKind,
		conditional: metricsRows(window.recordsByEstimator),
		commonCohort: metricsRows(cohort),
		byProvider: providerBreakdown(cohort),
		byAccount: window.byAccount,
		macroF1: [...cohort].map(([estimator, records]) => ({
			estimator,
			macroF1: macroAverageByAccount(records),
		})),
		bootstrap: bootstrap.length > 0 ? bootstrap : undefined,
	};
}

export function buildRanges(
	result: BacktestRunResult,
	seed: number,
	bootstrapAgainst: string[] = [],
): ReportRange[] {
	return result.ranges.map((range) => ({
		label: range.range.label,
		fromIso: new Date(range.range.fromMs).toISOString(),
		toIso: new Date(range.range.toMs).toISOString(),
		windows: range.windows.map((w) =>
			buildWindowBlock(w, seed, bootstrapAgainst),
		),
	}));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: bun scripts/prediction-backtest.ts [--db=<path>] [--from=<ISO>] [--to=<ISO>]
       [--split=<ISO>] [--step-minutes=10] [--window=five_hour|seven_day|both]
       [--seed=N] [--out=<path>]`;

export interface CliOptions {
	dbPath: string | null;
	fromIso: string | null;
	toIso: string | null;
	splitIso: string | null;
	stepMinutes: number;
	window: BacktestWindowKind | "both";
	seed: number;
	outPath: string | null;
}

export function parseCliArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		dbPath: null,
		fromIso: null,
		toIso: null,
		splitIso: null,
		stepMinutes: 10,
		window: "both",
		seed: DEFAULT_SEED,
		outPath: null,
	};
	for (const arg of argv) {
		if (arg.startsWith("--db=")) options.dbPath = arg.slice(5);
		else if (arg.startsWith("--from=")) options.fromIso = arg.slice(7);
		else if (arg.startsWith("--to=")) options.toIso = arg.slice(5);
		else if (arg.startsWith("--split=")) options.splitIso = arg.slice(8);
		else if (arg.startsWith("--step-minutes=")) {
			const n = Number(arg.slice(15));
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error(`Invalid --step-minutes: ${arg}`);
			}
			options.stepMinutes = n;
		} else if (arg.startsWith("--window=")) {
			const w = arg.slice(9);
			if (w !== "five_hour" && w !== "seven_day" && w !== "both") {
				throw new Error(`Invalid --window: ${arg}`);
			}
			options.window = w;
		} else if (arg.startsWith("--seed=")) {
			const n = Number(arg.slice(7));
			if (!Number.isInteger(n)) throw new Error(`Invalid --seed: ${arg}`);
			options.seed = n;
		} else if (arg.startsWith("--out=")) options.outPath = arg.slice(6);
		else if (arg === "--help" || arg === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
	}
	return options;
}

function parseIso(value: string, flag: string): number {
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw new Error(`Invalid ${flag} timestamp: ${value}`);
	return ms;
}

/**
 * Data-quality caveats a reader needs in order not to misread the tables.
 * Derived from what the run actually saw, never assumed.
 */
function dataQualityNotes(result: BacktestRunResult): string[] {
	const notes: string[] = [];
	const codexFiveHour = result.ranges.some((range) =>
		range.windows.some(
			(w) =>
				w.windowKind === "five_hour" &&
				w.byAccount.some((a) => a.provider === "codex" && a.instants > 0),
		),
	);
	if (codexFiveHour) {
		notes.push(
			"Codex accounts contribute `five_hour` instants, but OpenAI retired that window: the stored `five_hour_reset` moves forward on every poll (stamped ~2 min in the PAST) while the percent stays 0. Each poll therefore forms its own one-sample window, which inflates codex's five-hour instant and survived-window counts. Those instants carry no exhaustion signal; codex drops out of the five-hour common cohort on its own because the lifetime baseline cannot answer at 0%.",
		);
	}
	return notes;
}

const DB_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** Canonical path of an EXISTING file, or null when it is not there. */
function canonicalExisting(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/**
 * Canonical form of a path that need not exist yet: resolve the file itself
 * when it does, otherwise resolve its DIRECTORY and re-attach the basename, so
 * a symlinked parent cannot hide the real target either.
 */
function canonicalTarget(path: string): string {
	const existing = canonicalExisting(path);
	if (existing != null) return existing;
	const absolute = resolve(path);
	const parent = canonicalExisting(dirname(absolute));
	return parent != null ? join(parent, basename(absolute)) : absolute;
}

/** `dev:ino` of an existing file, or null. Two paths sharing one is an alias. */
function fileIdentity(path: string): string | null {
	try {
		const stats = statSync(path);
		return `${stats.dev}:${stats.ino}`;
	} catch {
		return null;
	}
}

/**
 * Refuse to write the report anywhere near the database file.
 *
 * A lexical comparison is not enough. `Bun.write` follows symlinks and truncates
 * whatever is on the other end, and a hard link gives one inode two paths that
 * never converge no matter how they are resolved. So this compares CANONICAL
 * paths (which defeats symlinks, including a symlinked parent directory) and,
 * when the target already exists, its `(dev, ino)` pair against the database and
 * every sidecar present (which defeats hard links).
 */
export function assertSafeOutPath(outPath: string, dbPath: string): void {
	const dbBases = [canonicalTarget(dbPath), resolve(dbPath)];
	const out = canonicalTarget(outPath);

	// Canonical path -> how the refusal should describe it.
	const forbidden = new Map<string, string>();
	for (const base of dbBases) {
		if (!forbidden.has(base)) forbidden.set(base, "the database path");
		for (const suffix of DB_SIDECAR_SUFFIXES) {
			// A sidecar may be absent right now (SQLite creates and removes them),
			// so guard the name next to the database as well as, when it IS there,
			// its own canonical path.
			forbidden.set(`${base}${suffix}`, "a database sidecar");
			const real = canonicalExisting(`${base}${suffix}`);
			if (real != null) forbidden.set(real, "a database sidecar");
		}
	}
	const named = forbidden.get(out);
	if (named != null) {
		throw new Error(`--out refuses to write to ${named}: ${out}`);
	}

	const outIdentity = fileIdentity(out);
	if (outIdentity == null) return;
	for (const base of dbBases) {
		if (fileIdentity(base) === outIdentity) {
			throw new Error(
				`--out refuses to write to a hard link of the database: ${out}`,
			);
		}
		for (const suffix of DB_SIDECAR_SUFFIXES) {
			if (fileIdentity(`${base}${suffix}`) === outIdentity) {
				throw new Error(
					`--out refuses to write to a hard link of a database sidecar: ${out}`,
				);
			}
		}
	}
}

const SHELL_SAFE_ARG = /^[A-Za-z0-9_./:=,@+-]+$/;

/**
 * Quote one argument for a POSIX shell so the recorded command can be pasted
 * back verbatim. Bare when it holds only characters no shell touches, otherwise
 * single-quoted, with each embedded quote closed and reopened.
 */
export function shellQuoteArg(arg: string): string {
	if (SHELL_SAFE_ARG.test(arg)) return arg;
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const dbPath = options.dbPath ?? resolveDbPath();
	if (options.outPath) assertSafeOutPath(options.outPath, dbPath);

	const windows: BacktestWindowKind[] =
		options.window === "both" ? ["five_hour", "seven_day"] : [options.window];

	// Resolve the scoring interval against the recorded history.
	const probe = openBacktestDatabase(dbPath);
	let historyFirst: number | null;
	let historyLast: number | null;
	try {
		const dataset = readDataset(probe);
		historyFirst = dataset.firstMs;
		historyLast = dataset.lastMs;
	} finally {
		probe.close();
	}
	if (historyFirst == null || historyLast == null) {
		throw new Error("usage_snapshots is empty — nothing to backtest");
	}
	const fromMs = options.fromIso ? parseIso(options.fromIso, "--from") : historyFirst;
	const toMs = options.toIso ? parseIso(options.toIso, "--to") : historyLast + 1;
	if (toMs <= fromMs) throw new Error("--to must be after --from");

	const ranges: BacktestRange[] = [];
	if (options.splitIso) {
		const splitMs = parseIso(options.splitIso, "--split");
		if (splitMs <= fromMs || splitMs >= toMs) {
			throw new Error("--split must fall inside [--from, --to)");
		}
		ranges.push({ label: "Tuning range", fromMs, toMs: splitMs });
		ranges.push({ label: "Held-out range", fromMs: splitMs, toMs });
	} else {
		ranges.push({ label: "Scoring range", fromMs, toMs });
	}

	const started = Date.now();
	const result = runBacktest(dbPath, {
		ranges,
		stepMinutes: options.stepMinutes,
		windows,
	});
	const replayMs = Date.now() - started;
	const reportRanges = buildRanges(result, options.seed, ["ols"]);
	const elapsedMs = Date.now() - started;

	const command = [
		"bun scripts/prediction-backtest.ts",
		...process.argv.slice(2).map(shellQuoteArg),
	].join(" ");

	const markdown = formatBacktestReport({
		title: "ClankerMux usage-prediction backtest",
		generatedAtIso: new Date().toISOString(),
		command,
		config: {
			stepMinutes: options.stepMinutes,
			windows: windows.join(","),
			seed: options.seed,
			estimators: BASELINE_ESTIMATORS.join(","),
			bootstrapIterations: BOOTSTRAP_ITERATIONS,
			from: new Date(fromMs).toISOString(),
			to: new Date(toMs).toISOString(),
			split: options.splitIso ?? null,
		},
		dataset: result.dataset,
		ranges: reportRanges,
		rateLimitDiagnostic: result.rateLimitDiagnostic,
		notes: [
			...dataQualityNotes(result),
			`Replay took ${(replayMs / 1000).toFixed(1)} s; scoring and bootstrap ${((elapsedMs - replayMs) / 1000).toFixed(1)} s.`,
		],
	});

	if (options.outPath) {
		await Bun.write(options.outPath, markdown);
		console.log(`Wrote ${options.outPath} (${elapsedMs} ms)`);
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
