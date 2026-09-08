#!/usr/bin/env bun
/**
 * alignment-study.ts — does the recorded request ledger line up with the quota
 * readings well enough to be worth building a capacity model on?
 *
 *     bun scripts/alignment-study.ts [--db=<path>] [--claim=5h]
 *                                    [--from=<ISO>] [--to=<ISO>]
 *                                    [--seed=N] [--out=<path>]
 *
 * THE GATE, not an estimator: see the module doc in
 * `packages/core/src/alignment-study.ts`. Nothing here is wired into the
 * server and no fitted weight leaves this report.
 *
 * The database is opened STRICTLY read-only — it serves the running proxy —
 * and `--out` refuses to resolve to it or any of its sidecars. All analysis
 * lives in the core module, which is pure and unit-tested; this file does I/O
 * and orchestration only, the same split `scripts/ledger-feasibility.ts` uses.
 */

import { join } from "node:path";
import {
	type AlignmentDatasetSummary,
	type AlignmentObservation,
	type AlignmentRequest,
	buildUnits,
	DEFAULT_SEED,
	evaluateAlignment,
	formatAlignmentReport,
	MANDATORY_CONTROL,
	pairedDifference,
	RequestIndex,
	scoreCohort,
	syntheticChecks,
} from "../packages/core/src/alignment-study";
// Deep imports, deliberately: `packages/database/src/paths` reaches the config
// barrel, which constructs the logger singleton — and that CREATES or truncates
// `app.log` at import time, before this script has parsed an argument. A study
// that states it only reads must not write a byte on the way in, so it composes
// the path from the two side-effect-free pieces instead.
import { getPlatformConfigDir } from "../packages/config/src/paths-common";
import { readEnv } from "../packages/core/src/env";
import {
	assertSafeOutPath,
	openReadOnlyDatabase,
	shellQuoteArg,
} from "./db-tool-io";

interface Options {
	dbPath: string | null;
	claim: string;
	fromMs: number | null;
	toMs: number | null;
	seed: number;
	outPath: string | null;
}

/** `resolveDbPath()` without the import that builds a logger. Same two rules. */
export function defaultDbPath(): string {
	const explicit = readEnv("DB_PATH");
	return explicit ? explicit : join(getPlatformConfigDir(), "clankermux.db");
}

const USAGE = `usage: bun scripts/alignment-study.ts [--db=<path>] [--claim=5h]
       [--from=<ISO>] [--to=<ISO>] [--seed=N] [--out=<path>]`;

export function parseArgs(argv: readonly string[]): Options {
	const options: Options = {
		dbPath: null,
		claim: "5h",
		fromMs: null,
		toMs: null,
		seed: DEFAULT_SEED,
		outPath: null,
	};
	for (const arg of argv) {
		if (arg.startsWith("--db=")) options.dbPath = arg.slice(5);
		else if (arg.startsWith("--claim=")) options.claim = arg.slice(8);
		else if (arg.startsWith("--from=")) options.fromMs = Date.parse(arg.slice(7));
		else if (arg.startsWith("--to=")) options.toMs = Date.parse(arg.slice(5));
		else if (arg.startsWith("--seed=")) options.seed = Number(arg.slice(7));
		else if (arg.startsWith("--out=")) options.outPath = arg.slice(6);
		else throw new Error(`unknown argument ${arg}\n${USAGE}`);
	}
	if (options.fromMs != null && !Number.isFinite(options.fromMs)) {
		throw new Error("--from must be an ISO instant");
	}
	if (options.toMs != null && !Number.isFinite(options.toMs)) {
		throw new Error("--to must be an ISO instant");
	}
	if (!Number.isFinite(options.seed)) throw new Error("--seed must be a number");
	return options;
}

interface ObservationRow {
	account_id: string;
	claim: string;
	observed_at: number;
	utilization: number | null;
	reset_at: number | null;
}
interface RequestRow {
	account_used: string;
	usage_finalized_at: number;
	i: number;
	o: number;
	cr: number;
	cc: number;
}
interface CoverageRow {
	rows: number;
	finalized_rows: number;
	tokens: number | null;
	finalized_tokens: number | null;
}

async function main(): Promise<void> {
	const options = parseArgs(Bun.argv.slice(2));
	const dbPath = options.dbPath ?? defaultDbPath();
	if (options.outPath) assertSafeOutPath(options.outPath, dbPath);
	const db = openReadOnlyDatabase(dbPath);

	const fromMs = options.fromMs ?? 0;
	const toMs = options.toMs ?? Number.MAX_SAFE_INTEGER;

	const observations = db
		.query<ObservationRow, [string, number, number]>(
			`SELECT account_id, claim, observed_at, utilization, reset_at
			 FROM unified_claim_observations
			 WHERE claim = ? AND observed_at >= ? AND observed_at < ?
			 ORDER BY account_id, observed_at`,
		)
		.all(options.claim, fromMs, toMs)
		.flatMap((row): AlignmentObservation[] =>
			row.utilization == null
				? []
				: [
						{
							accountId: row.account_id,
							claim: row.claim,
							observedAt: row.observed_at,
							utilization: row.utilization,
							resetAt: row.reset_at,
						},
					],
		);
	if (observations.length === 0) {
		throw new Error(
			`no \`${options.claim}\` claim observations in the requested range`,
		);
	}

	const requests = db
		.query<RequestRow, [number, number]>(
			`SELECT account_used, usage_finalized_at,
			        COALESCE(input_tokens, 0) AS i,
			        COALESCE(output_tokens, 0) AS o,
			        COALESCE(cache_read_input_tokens, 0) AS cr,
			        COALESCE(cache_creation_input_tokens, 0) AS cc
			 FROM requests
			 WHERE usage_finalized_at IS NOT NULL AND account_used IS NOT NULL
			   AND usage_finalized_at >= ? AND usage_finalized_at < ?
			 ORDER BY account_used, usage_finalized_at`,
		)
		.all(fromMs, toMs)
		.map(
			(row): AlignmentRequest => ({
				accountId: row.account_used,
				finalizedAt: row.usage_finalized_at,
				inputTokens: row.i,
				outputTokens: row.o,
				cacheReadInputTokens: row.cr,
				cacheCreationInputTokens: row.cc,
			}),
		);

	// Coverage by TOKEN MASS, not by row count: a study that drops the biggest
	// requests is not 99 % covered however many small rows it kept.
	const firstObservation = observations[0].observedAt;
	const lastObservation = observations.reduce(
		(max, o) => Math.max(max, o.observedAt),
		firstObservation,
	);
	const coverage = db
		.query<CoverageRow, [number, number]>(
			`SELECT COUNT(*) AS rows,
			        SUM(CASE WHEN usage_finalized_at IS NOT NULL THEN 1 ELSE 0 END) AS finalized_rows,
			        SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
			            + COALESCE(cache_read_input_tokens,0)
			            + COALESCE(cache_creation_input_tokens,0)) AS tokens,
			        SUM(CASE WHEN usage_finalized_at IS NOT NULL
			                 THEN COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
			                      + COALESCE(cache_read_input_tokens,0)
			                      + COALESCE(cache_creation_input_tokens,0)
			                 ELSE 0 END) AS finalized_tokens
			 FROM requests
			 WHERE timestamp >= ? AND timestamp < ? AND account_used IS NOT NULL`,
		)
		.get(firstObservation, lastObservation);
	db.close();

	const built = buildUnits(observations, options.claim);
	const units = built.units;
	if (units.length === 0) throw new Error("no scorable intervals");
	const index = new RequestIndex(requests);
	const splitAtMs =
		units[0].fromMs + (units[units.length - 1].toMs - units[0].fromMs) / 2;

	const primary = scoreCohort(
		"Primary cohort",
		"Every interval whose source carries traffic under every scored alignment. This is the cohort the verdict is taken on.",
		units,
		index,
		splitAtMs,
	);
	// Reported, never gated: near the cap the provider's own behaviour changes
	// (warnings, throttling), so a study that pooled it with ordinary burn would
	// hide whichever way that cuts.
	const saturated = scoreCohort(
		"Saturation cohort",
		"Intervals whose reading reached 90 % or more. Reported only: near the cap the provider's behaviour changes, and pooling it with ordinary burn would hide that either way.",
		units.filter((unit) => unit.peakUtilization >= 0.9),
		index,
		splitAtMs,
	);

	const evaluationUnits = units.filter((unit) => unit.fromMs >= splitAtMs);
	// The controls the cohort actually scored, in its own order — including the
	// permutation, which the cohort builds rather than the caller.
	const differences = primary.scores
		.filter((score) => score.control)
		.map((score) =>
			pairedDifference(primary, score.name, evaluationUnits, options.seed),
		);
	const mandatory =
		differences.find((d) => d.control === MANDATORY_CONTROL) ??
		differences[0];
	const synthetic = syntheticChecks(options.seed);
	const verdict = evaluateAlignment(primary, mandatory, synthetic);

	// A control with no paired units at all did not lose; it was never measured,
	// and the report says which and why rather than leaving a dash to read as a
	// beaten control.
	const unmeasurable = differences
		.filter((difference) => difference.n === 0)
		.map((difference) => ({
			name: difference.control,
			reason:
				"no unit of the primary cohort carried a paired error for it, so it was never scored. The cohort admits a unit only when EVERY scored alignment's source carries traffic, so this says the intersection was empty, not that this control alone had no overlap with the real alignment.",
		}));

	const accounts = new Set(observations.map((o) => o.accountId)).size;
	const dataset: AlignmentDatasetSummary = {
		claim: options.claim,
		observations: observations.length,
		requests: requests.length,
		accounts,
		firstObservationIso: new Date(firstObservation).toISOString(),
		lastObservationIso: new Date(lastObservation).toISOString(),
		splitAtIso: new Date(splitAtMs).toISOString(),
		finalizedCoverage:
			coverage && coverage.rows > 0
				? coverage.finalized_rows / coverage.rows
				: null,
		finalizedTokenCoverage:
			coverage && (coverage.tokens ?? 0) > 0
				? (coverage.finalized_tokens ?? 0) / (coverage.tokens ?? 1)
				: null,
	};

	const command = [
		"bun scripts/alignment-study.ts",
		`--db=${shellQuoteArg(dbPath)}`,
		`--claim=${options.claim}`,
		options.fromMs != null
			? `--from=${new Date(options.fromMs).toISOString()}`
			: null,
		options.toMs != null ? `--to=${new Date(options.toMs).toISOString()}` : null,
		`--seed=${options.seed}`,
		options.outPath ? `--out=${shellQuoteArg(options.outPath)}` : null,
	]
		.filter((part): part is string => part != null)
		.join(" ");

	const markdown = formatAlignmentReport({
		title: "ClankerMux request-alignment gate",
		generatedAtIso: new Date().toISOString(),
		command,
		dataset,
		build: built,
		cohorts: [primary, saturated],
		differences,
		synthetic,
		verdict,
		unmeasurable,
		notes: [
			"The donor-account control is NOT CONSTRUCTED by this study, so no row below reports on it and this run measured nothing about it. It was dropped as the mandatory control on 2026-09-08 after a separate read-only check found no ten-minute interval in which two accounts were both busy — the proxy spreads load — and that finding is about that data, not a property this run re-established. The within-account permutation is the mandatory control in its place: same account, same intervals, same token distribution, only the pairing broken.",
			"`usage_finalized_at` keeps the instant a token vector FIRST became known, so a later revision of that vector is placed at the earlier instant. Requests are also concurrent and provider accounting is delayed, so no timestamp here identifies a causal instant.",
			"Weights are reported so the fit can be inspected, not because any of them is a price. A class fitted to zero means the fit could not separate it from the others on this data, which is not the same as it being free.",
		],
	});

	if (options.outPath) {
		await Bun.write(options.outPath, markdown);
		process.stderr.write(`Wrote ${options.outPath}\n`);
	} else {
		process.stdout.write(markdown);
	}
	process.stderr.write(
		`verdict ${verdict.verdict}; ${primary.evaluationUnits} evaluation units\n`,
	);
}

if (import.meta.main) {
	await main();
}
