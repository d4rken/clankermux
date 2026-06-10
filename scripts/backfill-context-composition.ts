#!/usr/bin/env bun
/**
 * backfill-context-composition.ts — ONE-OFF repair tool for historical
 * `requests.context_*` composition columns. Run manually:
 *
 *     bun scripts/backfill-context-composition.ts [--dry-run] [--batch-size=500]
 *
 * This is NOT a migration and is not wired into anything. It backfills the
 * eight context-composition columns (NULL = "not recorded") for historical
 * rows that still have a stored payload, using the SAME pure function the
 * live proxy now runs at ingest time
 * (packages/proxy/src/context-composition.ts).
 *
 * For every `request_payloads` row whose joined `requests` row has
 * `context_messages_chars IS NULL`: decrypt the envelope, base64-decode the
 * captured request body, JSON.parse it, run `computeContextComposition`, and
 * UPDATE the eight `context_*` columns. Rows are left untouched (NULL = honest
 * coverage marker) when the envelope has `request.body: null` (capture-capped),
 * when decrypt/base64/JSON decoding fails, or when the body is shapeless (no
 * `messages` array — composition is null).
 *
 * Numeric columns are bound directly: a computed 0 (e.g. no tools defined) is
 * stored as 0, never coerced to NULL. Only `context_largest_tool_name` may be
 * NULL within an otherwise-recorded row.
 *
 * Deep imports below are intentional: `decryptPayload` is deliberately not
 * exported from the @clankermux/database package barrel (it is an internal
 * concern of payload storage), and the composition walk lives in
 * packages/proxy/src. A one-off script importing source files directly is
 * acceptable; library code should not copy this pattern.
 *
 * --dry-run opens the database READ-ONLY (mechanically incapable of writing)
 * and reports everything it would do. A normal run opens read-write with
 * `busy_timeout = 5000` so it coexists with the live service (WAL).
 */

import { Database } from "bun:sqlite";
import {
	decryptPayload,
	initPayloadEncryption,
	isEncryptionEnabled,
} from "../packages/database/src/payload-encryption";
import { resolveDbPath } from "../packages/database/src/paths";
import { computeContextComposition } from "../packages/proxy/src/context-composition";
import type { RequestJsonBody } from "../packages/proxy/src/request-body-context";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SAMPLE_LIMIT = 15;
// Sentinel for NULL payload timestamps in keyset pagination: NULLs sort as
// "oldest" (real timestamps are positive ms-epoch values).
const NULL_TS_SENTINEL = -1;

interface CliOptions {
	dryRun: boolean;
	batchSize: number;
}

function parseArgs(argv: string[]): CliOptions {
	let dryRun = false;
	let batchSize = 500;
	for (const arg of argv) {
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg.startsWith("--batch-size=")) {
			const parsed = Number.parseInt(arg.slice("--batch-size=".length), 10);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				console.error(`Invalid --batch-size value: ${arg}`);
				process.exit(1);
			}
			batchSize = parsed;
		} else {
			console.error(`Unknown argument: ${arg}`);
			console.error(
				"Usage: bun scripts/backfill-context-composition.ts [--dry-run] [--batch-size=500]",
			);
			process.exit(1);
		}
	}
	return { dryRun, batchSize };
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface BackfillRow {
	id: string;
	json: string;
	ts_key: number;
}

interface PayloadEnvelope {
	request?: {
		headers?: Record<string, string>;
		body?: string | null;
	} | null;
}

interface Counters {
	scanned: number;
	updated: number;
	skippedNoBody: number;
	/** decrypt / envelope-JSON / body-base64 / body-JSON failures combined */
	skippedParseFailure: number;
	failDecrypt: number;
	failEnvelopeJson: number;
	failBodyBase64: number;
	failBodyJson: number;
	/** computeContextComposition returned null (no `messages` array) */
	skippedShapeless: number;
}

interface Sample {
	label: string;
	summary: string;
}

function printSamples(title: string, samples: Sample[], total: number): void {
	if (samples.length === 0) return;
	console.log(`  ${title} (showing ${samples.length} of ${total}):`);
	for (const s of samples) {
		console.log(`    ${s.label}: ${s.summary}`);
	}
}

// ---------------------------------------------------------------------------
// Backfill — keyset-paginated walk over payloads of NULL-covered requests
// ---------------------------------------------------------------------------

interface BackfillResult {
	counters: Counters;
	samples: Sample[];
}

async function runBackfill(
	db: Database,
	options: CliOptions,
): Promise<BackfillResult> {
	const counters: Counters = {
		scanned: 0,
		updated: 0,
		skippedNoBody: 0,
		skippedParseFailure: 0,
		failDecrypt: 0,
		failEnvelopeJson: 0,
		failBodyBase64: 0,
		failBodyJson: 0,
		skippedShapeless: 0,
	};
	const samples: Sample[] = [];

	// High-water mark: only process payload rows that existed when we started,
	// so concurrent live inserts can't make keyset pagination chase a moving
	// target. NULL timestamps map to a sentinel that sorts as oldest.
	const highWater = db
		.query<{ ts_key: number; id: string }, []>(
			`SELECT COALESCE(timestamp, ${NULL_TS_SENTINEL}) AS ts_key, id
			 FROM request_payloads
			 ORDER BY ts_key DESC, id DESC LIMIT 1`,
		)
		.get();
	if (!highWater) {
		return { counters, samples }; // empty table
	}

	const pageStmt = db.query<
		BackfillRow,
		[number, string, number, string, number]
	>(
		`SELECT p.id AS id, p.json AS json,
		        COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) AS ts_key
		 FROM request_payloads p
		 JOIN requests r ON r.id = p.id
		 WHERE r.context_messages_chars IS NULL
		   AND (COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) > ?1
		        OR (COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) = ?1 AND p.id > ?2))
		   AND (COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) < ?3
		        OR (COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) = ?3 AND p.id <= ?4))
		 ORDER BY ts_key ASC, p.id ASC
		 LIMIT ?5`,
	);
	const updateStmt = options.dryRun
		? null
		: db.query(
				`UPDATE requests SET
				   context_system_chars = ?,
				   context_tools_chars = ?,
				   context_tool_count = ?,
				   context_messages_chars = ?,
				   context_message_count = ?,
				   context_tool_result_chars = ?,
				   context_largest_tool_chars = ?,
				   context_largest_tool_name = ?
				 WHERE id = ?`,
			);

	// Cursor starts strictly below every possible (ts_key, id).
	let cursorTs = Number.MIN_SAFE_INTEGER;
	let cursorId = "";

	for (;;) {
		const rows = pageStmt.all(
			cursorTs,
			cursorId,
			highWater.ts_key,
			highWater.id,
			options.batchSize,
		);
		if (rows.length === 0) break;

		const pending: Array<{
			id: string;
			values: [number, number, number, number, number, number, number, string | null];
		}> = [];

		for (const row of rows) {
			counters.scanned++;

			// Encrypted history without a key is a hard abort — silently skipping
			// would leave an unexplained partial backfill.
			if (row.json.startsWith("enc:") && !isEncryptionEnabled()) {
				console.error(
					`\nABORT: payload ${row.id} is encrypted ('enc:' prefix) but ` +
						"PAYLOAD_ENCRYPTION_KEY is not set. Set the key and re-run. " +
						"Rows updated so far stay updated — the script is idempotent " +
						"(it only targets rows whose context columns are still NULL).",
				);
				process.exit(1);
			}

			let envelope: PayloadEnvelope;
			try {
				const plaintext = await decryptPayload(row.json);
				try {
					envelope = JSON.parse(plaintext) as PayloadEnvelope;
				} catch {
					counters.failEnvelopeJson++;
					counters.skippedParseFailure++;
					continue;
				}
			} catch {
				counters.failDecrypt++;
				counters.skippedParseFailure++;
				continue;
			}

			if (
				typeof envelope !== "object" ||
				envelope === null ||
				typeof envelope.request !== "object" ||
				envelope.request === null
			) {
				counters.failEnvelopeJson++;
				counters.skippedParseFailure++;
				continue;
			}

			const rawBody = envelope.request.body;
			if (rawBody === null || rawBody === undefined) {
				// Capture-capped row: body was not stored. Leave columns NULL.
				counters.skippedNoBody++;
				continue;
			}

			let bodyText: string;
			try {
				bodyText = Buffer.from(rawBody, "base64").toString("utf-8");
			} catch {
				counters.failBodyBase64++;
				counters.skippedParseFailure++;
				continue;
			}

			let parsedBody: RequestJsonBody;
			try {
				const parsed = JSON.parse(bodyText);
				if (typeof parsed !== "object" || parsed === null) {
					counters.failBodyJson++;
					counters.skippedParseFailure++;
					continue;
				}
				parsedBody = parsed as RequestJsonBody;
			} catch {
				counters.failBodyJson++;
				counters.skippedParseFailure++;
				continue;
			}

			const composition = computeContextComposition(parsedBody);
			if (composition === null) {
				// Shapeless body (no `messages` array): composition is honestly
				// unrecordable. Leave columns NULL.
				counters.skippedShapeless++;
				continue;
			}

			counters.updated++;
			// Bind numeric values directly — 0 stays 0; only largestToolName may
			// be NULL within an otherwise-recorded row.
			pending.push({
				id: row.id,
				values: [
					composition.systemChars,
					composition.toolsChars,
					composition.toolCount,
					composition.messagesChars,
					composition.messageCount,
					composition.toolResultChars,
					composition.largestToolResultChars,
					composition.largestToolName,
				],
			});
			if (samples.length < SAMPLE_LIMIT) {
				samples.push({
					label: `id=${row.id}`,
					summary:
						`system=${composition.systemChars} ` +
						`tools=${composition.toolsChars}(${composition.toolCount}) ` +
						`messages=${composition.messagesChars}(${composition.messageCount}) ` +
						`toolResults=${composition.toolResultChars} ` +
						`largest=${composition.largestToolResultChars}` +
						(composition.largestToolName !== null
							? ` (${composition.largestToolName})`
							: ""),
				});
			}
		}

		if (!options.dryRun && pending.length > 0) {
			const applyBatch = db.transaction(() => {
				for (const update of pending) {
					updateStmt?.run(...update.values, update.id);
				}
			});
			applyBatch();
		}

		const last = rows[rows.length - 1];
		cursorTs = last.ts_key;
		cursorId = last.id;
		if (rows.length < options.batchSize) break;
	}

	return { counters, samples };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const dbPath = resolveDbPath();
	const started = Date.now();

	console.log(
		`Backfill context composition — ${options.dryRun ? "DRY-RUN (read-only)" : "LIVE run"}`,
	);
	console.log(`Database: ${dbPath}`);
	console.log(`Batch size: ${options.batchSize}`);

	await initPayloadEncryption();
	console.log(
		`Payload encryption key: ${isEncryptionEnabled() ? "configured" : "not set (plaintext pass-through)"}`,
	);

	const db = options.dryRun
		? new Database(dbPath, { readonly: true })
		: new Database(dbPath);
	try {
		if (!options.dryRun) {
			db.run("PRAGMA busy_timeout = 5000");
		}

		console.log(
			"\nBackfill — recompute context composition from stored payloads " +
				"(requests with context_messages_chars IS NULL)",
		);
		const { counters: c, samples } = await runBackfill(db, options);
		console.log(
			`  scanned: ${c.scanned}, ${options.dryRun ? "would update" : "updated"}: ${c.updated}, ` +
				`skipped (no stored body): ${c.skippedNoBody}, ` +
				`skipped (parse failure): ${c.skippedParseFailure}, ` +
				`skipped (shapeless body): ${c.skippedShapeless}`,
		);
		if (c.skippedParseFailure > 0) {
			console.log(
				`  parse failures — decrypt: ${c.failDecrypt}, envelope JSON: ${c.failEnvelopeJson}, ` +
					`body base64: ${c.failBodyBase64}, body JSON: ${c.failBodyJson}`,
			);
		}
		printSamples(
			options.dryRun ? "sample would-be updates" : "sample updates",
			samples,
			c.updated,
		);

		const elapsed = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`\nDone in ${elapsed}s.`);
		if (options.dryRun) {
			console.log("Dry-run: NO changes were written (read-only connection).");
		} else {
			console.log(
				"Reminder: analytics reads the context_* columns directly — " +
					"backfilled data is visible immediately, no service restart needed.",
			);
		}
	} finally {
		db.close();
	}
}

await main();
