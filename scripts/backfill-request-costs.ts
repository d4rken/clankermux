#!/usr/bin/env bun
/**
 * backfill-request-costs.ts — ONE-OFF repair tool for historical
 * `requests.cost_usd` values that were persisted as NULL. Run manually:
 *
 *     bun scripts/backfill-request-costs.ts [--dry-run] [--batch-size=500]
 *
 * This is NOT a migration and is not wired into anything. Two things wrote
 * those NULLs:
 *
 *   1. the cold-start catalogue race — a request finalizing before the
 *      models.dev catalogue replaced the 26-model bundled seed was priced
 *      against a table that could not contain its model. Fixed at the source:
 *      `estimateCostUSD` now waits on in-flight catalogue work before declaring
 *      a model unpriced;
 *   2. a model that genuinely had no catalogue entry at the time (e.g.
 *      `claude-sonnet-5` before its bundled entry was added, or the dated
 *      Codex snapshots that no catalogue lists — those now resolve via their
 *      base slug).
 *
 * Both leave the same residue: a successful, fully-metered request whose cost
 * is NULL, invisible to every cost analytic. This re-prices those rows with
 * today's catalogue.
 *
 * Rows are only ever written when a price actually resolves. A model that is
 * still unpriced (an unreleased model with no published rates) keeps its NULL —
 * that is the honest value, and re-running later picks it up once pricing lands.
 *
 * Selection scans the requests table: `idx_requests_cost_model` looks like it
 * would serve `cost_usd IS NULL`, but it is PARTIAL (`WHERE cost_usd > 0 AND
 * model IS NOT NULL`, performance-indexes.ts) so it indexes exactly the rows
 * this query excludes. Whatever the planner picks is a scan — measured at ~0.3s
 * over 385k rows on the live database, which is why no index is added for a
 * one-off. That cost is also why this is a manual tool rather than a startup
 * task, along with the more basic reason: a repair that rewrites historical rows
 * should be something you run and read the output of, not something that happens
 * silently on every boot.
 *
 * The deep import below is intentional — one-off scripts may import source
 * directly; library code should not copy this pattern.
 *
 * --dry-run opens the database READ-ONLY (mechanically incapable of writing)
 * and reports everything it would do. A normal run opens read-write with
 * `busy_timeout = 5000` so it coexists with the live service (WAL).
 */

import { Database } from "bun:sqlite";
import { estimateCostUSD, loadPricingCatalogue } from "@clankermux/core";
import { resolveDbPath } from "../packages/database/src/paths";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SAMPLE_LIMIT = 15;

const USAGE =
	"Usage: bun scripts/backfill-request-costs.ts [--dry-run] [--batch-size=500] [--allow-stale-catalogue]";

interface CliOptions {
	dryRun: boolean;
	batchSize: number;
	allowStaleCatalogue: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	let dryRun = false;
	let batchSize = 500;
	let allowStaleCatalogue = false;
	for (const arg of argv) {
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--allow-stale-catalogue") {
			allowStaleCatalogue = true;
		} else if (arg.startsWith("--batch-size=")) {
			const parsed = Number.parseInt(arg.slice("--batch-size=".length), 10);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				console.error(`Invalid --batch-size value: ${arg}`);
				process.exit(1);
			}
			batchSize = parsed;
		} else {
			console.error(`Unknown argument: ${arg}`);
			console.error(USAGE);
			process.exit(1);
		}
	}
	return { dryRun, batchSize, allowStaleCatalogue };
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface CandidateRow {
	id: string;
	timestamp: number;
	model: string;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
}

interface ModelOutcome {
	rows: number;
	priced: number;
	totalCost: number;
}

/**
 * Candidates: a NULL cost on a row that names a model and actually metered
 * tokens. Rows with no tokens (failed or aborted requests) are correctly NULL —
 * there is nothing to charge — and are left alone.
 */
const CANDIDATE_SQL = `
	SELECT id, timestamp, model,
	       input_tokens, output_tokens,
	       cache_read_input_tokens, cache_creation_input_tokens
	  FROM requests
	 WHERE cost_usd IS NULL
	   AND model IS NOT NULL
	   AND model != ''
	   AND COALESCE(input_tokens, 0)
	     + COALESCE(output_tokens, 0)
	     + COALESCE(cache_read_input_tokens, 0)
	     + COALESCE(cache_creation_input_tokens, 0) > 0
`;

function formatUsd(value: number): string {
	return `$${value.toFixed(4)}`;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const dbPath = resolveDbPath();
	const started = Date.now();

	console.log(
		`Backfill request costs — ${options.dryRun ? "DRY-RUN (read-only)" : "LIVE run"}`,
	);
	console.log(`Database: ${dbPath}`);

	// Preflight. This also settles the background refresh, so the catalogue
	// cannot change generation part-way through the row loop and price two rows
	// of the same model differently.
	//
	// Without a real catalogue only the bundled models can be priced, so the run
	// would quietly repair a fraction of the rows and look like it succeeded.
	const status = await loadPricingCatalogue();
	if (!status.loaded) {
		console.error(
			"\nCould not load the models.dev catalogue (no network, no usable snapshot).",
		);
		console.error(
			"Only the bundled models could be priced, so this run would under-repair.",
		);
		console.error("Aborting — re-run when the catalogue is reachable.");
		process.exit(1);
	}
	if (!status.stable) {
		console.error(
			"\nA catalogue load or refresh is still running after the wait timed out.",
		);
		console.error(
			"It could land mid-run and reprice later rows from a different catalogue",
		);
		console.error(
			"generation than earlier ones. Aborting — re-run when the network or the",
		);
		console.error("cache filesystem is responsive.");
		process.exit(1);
	}
	if (status.stale && !options.allowStaleCatalogue) {
		console.error(
			"\nThe catalogue came from a snapshot older than its 24h refresh window",
		);
		console.error(
			"(the remote was unreachable), so its prices may be out of date. These",
		);
		console.error("writes are durable — aborting rather than guessing.");
		console.error(
			"Re-run with a working network, or pass --allow-stale-catalogue to accept it.",
		);
		process.exit(1);
	}
	console.log(
		`Pricing catalogue: loaded${status.stale ? " (STALE snapshot — accepted via --allow-stale-catalogue)" : ""}`,
	);

	const db = options.dryRun
		? new Database(dbPath, { readonly: true })
		: new Database(dbPath);
	try {
		if (!options.dryRun) {
			db.run("PRAGMA busy_timeout = 5000");
		}

		// Ordered here rather than in SQL: the candidate set is small (hundreds),
		// and an ORDER BY would make SQLite build a temporary B-tree over the whole
		// scan just to make the sample output read chronologically.
		const candidates = db
			.query<CandidateRow, []>(CANDIDATE_SQL)
			.all()
			.sort((a, b) => a.timestamp - b.timestamp);
		console.log(`Candidate rows (NULL cost, model set, tokens > 0): ${candidates.length}`);
		if (candidates.length === 0) {
			console.log("\nNothing to do.");
			return;
		}

		const updateStmt = options.dryRun
			? null
			: db.query<unknown, [number, string]>(
					"UPDATE requests SET cost_usd = ? WHERE id = ? AND cost_usd IS NULL",
				);

		const byModel = new Map<string, ModelOutcome>();
		const samples: string[] = [];
		let priced = 0;
		let unpriced = 0;
		let totalCost = 0;
		let pending: Array<[number, string]> = [];

		const flush = (): void => {
			if (!updateStmt || pending.length === 0) return;
			const batch = pending;
			pending = [];
			db.transaction(() => {
				for (const [cost, id] of batch) updateStmt.run(cost, id);
			})();
		};

		for (const row of candidates) {
			const outcome = byModel.get(row.model) ?? {
				rows: 0,
				priced: 0,
				totalCost: 0,
			};
			outcome.rows++;

			const cost = await estimateCostUSD(row.model, {
				inputTokens: row.input_tokens ?? 0,
				outputTokens: row.output_tokens ?? 0,
				cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
				cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
			});

			// estimateCostUSD swallows lookup failures and returns 0. A genuinely
			// free request is indistinguishable from an unpriced one here, and both
			// are better left NULL than written as a fabricated 0.00.
			if (cost > 0) {
				priced++;
				outcome.priced++;
				outcome.totalCost += cost;
				totalCost += cost;
				if (samples.length < SAMPLE_LIMIT) {
					samples.push(
						`${new Date(row.timestamp).toISOString()}  ${row.model}  ${formatUsd(cost)}`,
					);
				}
				pending.push([cost, row.id]);
				if (pending.length >= options.batchSize) flush();
			} else {
				unpriced++;
			}

			byModel.set(row.model, outcome);
		}
		flush();

		console.log("\nPer model:");
		const ordered = [...byModel.entries()].sort(
			(a, b) => b[1].rows - a[1].rows || a[0].localeCompare(b[0]),
		);
		for (const [model, outcome] of ordered) {
			const still = outcome.rows - outcome.priced;
			console.log(
				`  ${model}: ${outcome.rows} candidate${outcome.rows === 1 ? "" : "s"}, ` +
					`${options.dryRun ? "would price" : "priced"} ${outcome.priced} ` +
					`(${formatUsd(outcome.totalCost)})` +
					(still > 0 ? `, ${still} still unpriced` : ""),
			);
		}

		if (samples.length > 0) {
			console.log(`\nSample (showing ${samples.length} of ${priced}):`);
			for (const s of samples) console.log(`  ${s}`);
		}

		console.log(
			`\nRows ${options.dryRun ? "that would be updated" : "updated"}: ${priced}` +
				` — total ${formatUsd(totalCost)}`,
		);
		if (unpriced > 0) {
			console.log(
				`Rows left NULL (model still has no price): ${unpriced} — re-run once pricing lands.`,
			);
		}

		const elapsed = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`\nDone in ${elapsed}s.`);
		if (options.dryRun) {
			console.log("DRY-RUN: no changes were written.");
		}
	} finally {
		db.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
