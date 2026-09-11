#!/usr/bin/env bun
/**
 * Repair historical NULL request costs using today's pricing catalogue.
 *
 * bun scripts/backfill-request-costs.ts --dry-run --model=gpt-5.6-luna --provider=codex
 *
 * --provider names the account provider (codex, not openai). Routing history
 * supplies it first, with the current account as a fallback for older requests.
 * Repairs set cost_usd and estimated_cost_usd together with cost_source=estimated.
 *
 * --dry-run opens SQLite read-only. Live runs update only costs still NULL,
 * in batches with a busy timeout so the tool can coexist with the service.
 * Missing prices and missing provider provenance remain NULL for a later run.
 */

import { Database } from "bun:sqlite";
import { estimateCostUSD, loadPricingCatalogue } from "@clankermux/core";
import { resolveDbPath } from "../packages/database/src/paths";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SAMPLE_LIMIT = 15;

const USAGE =
	"Usage: bun scripts/backfill-request-costs.ts [--dry-run] [--batch-size=500] [--allow-stale-catalogue] [--model=MODEL] [--provider=PROVIDER]";

interface CliOptions {
	dryRun: boolean;
	batchSize: number;
	allowStaleCatalogue: boolean;
	model: string | null;
	provider: string | null;
}

function parseArgs(argv: string[]): CliOptions {
	let dryRun = false;
	let batchSize = 500;
	let allowStaleCatalogue = false;
	let model: string | null = null;
	let provider: string | null = null;
	for (const arg of argv) {
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--allow-stale-catalogue") {
			allowStaleCatalogue = true;
		} else if (arg.startsWith("--model=") || arg.startsWith("--provider=")) {
			const value = arg.slice(arg.indexOf("=") + 1).trim();
			if (!value) {
				console.error(`Invalid filter value: ${arg}`);
				process.exit(1);
			}
			if (arg.startsWith("--model=")) model = value;
			else provider = value;
		} else if (arg.startsWith("--batch-size=")) {
			const parsed = Number(arg.slice("--batch-size=".length));
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
	return { dryRun, batchSize, allowStaleCatalogue, model, provider };
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface CandidateRow {
	id: string;
	timestamp: number;
	model: string;
	provider: string | null;
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
	SELECT * FROM (
		SELECT r.id, r.timestamp, r.model,
		       COALESCE((
		         SELECT ra.provider FROM routing_attempts ra
		          WHERE ra.request_id = r.id AND ra.kind = 'upstream_send'
		            AND (r.account_used IS NULL OR ra.account_id = r.account_used)
		            AND ra.provider IS NOT NULL AND ra.provider != ''
		          ORDER BY ra.started_at DESC, ra.id DESC LIMIT 1
		       ), NULLIF(a.provider, '')) AS provider,
		       r.input_tokens, r.output_tokens,
		       r.cache_read_input_tokens, r.cache_creation_input_tokens
		  FROM requests r
		  LEFT JOIN accounts a ON a.id = r.account_used
		 WHERE r.cost_usd IS NULL
		   AND r.model IS NOT NULL AND r.model != ''
		   AND (?1 IS NULL OR r.model = ?1)
		   AND COALESCE(r.input_tokens, 0)
		     + COALESCE(r.output_tokens, 0)
		     + COALESCE(r.cache_read_input_tokens, 0)
		     + COALESCE(r.cache_creation_input_tokens, 0) > 0
	) WHERE (?2 IS NULL OR provider = ?2)
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
	if (options.model) console.log(`Model filter: ${options.model}`);
	if (options.provider) console.log(`Provider filter: ${options.provider}`);

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
		: new Database(dbPath, { readwrite: true, create: false });
	try {
		if (!options.dryRun) {
			db.run("PRAGMA busy_timeout = 5000");
		}

		// Ordered here rather than in SQL: the candidate set is small (hundreds),
		// and an ORDER BY would make SQLite build a temporary B-tree over the whole
		// scan just to make the sample output read chronologically.
		const candidates = db
			.query<CandidateRow, [string | null, string | null]>(CANDIDATE_SQL)
			.all(options.model, options.provider)
			.sort((a, b) => a.timestamp - b.timestamp);
		console.log(`Candidate rows (NULL cost, model set, tokens > 0): ${candidates.length}`);
		if (candidates.length === 0) {
			console.log("\nNothing to do.");
			return;
		}

		const updateStmt = options.dryRun
			? null
			: db.query<unknown, [number, string]>(
					"UPDATE requests SET cost_usd = ?1, estimated_cost_usd = ?1, cost_source = 'estimated' WHERE id = ?2 AND cost_usd IS NULL",
				);

		const byModel = new Map<string, ModelOutcome>();
		const samples: string[] = [];
		let priced = 0;
		let unpriced = 0;
		let missingProvider = 0;
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

			if (!row.provider) missingProvider++;
			const cost = row.provider
				? await estimateCostUSD(row.model, {
					inputTokens: row.input_tokens ?? 0,
					outputTokens: row.output_tokens ?? 0,
					cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
					cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
				}, { provider: row.provider })
				: null;

			// A measured zero is priced; only NULL means the lookup failed.
			if (cost !== null) {
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
		if (unpriced > missingProvider) {
			console.log(
				`Rows left NULL (missing price): ${unpriced - missingProvider} — re-run once pricing lands.`,
			);
		}

		if (missingProvider > 0) console.log(`Rows without provider provenance: ${missingProvider}`);

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
