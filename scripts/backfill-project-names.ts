#!/usr/bin/env bun
/**
 * backfill-project-names.ts — ONE-OFF repair tool for historical
 * `requests.project` values. Run manually:
 *
 *     bun scripts/backfill-project-names.ts [--dry-run] [--batch-size=500]
 *
 * This is NOT a migration and is not wired into anything. It repairs
 * historical rows using the shared extractor that the live proxy now uses
 * (packages/proxy/src/project-extraction.ts).
 *
 * Run order (deliberate — gives the same final state as A-then-B-with-
 * exclusions, but is simpler):
 *
 *   Pass B — conservative string repair: for every distinct stored project
 *            value, `sanitizeProjectName(value)`; rewrite rows whose value
 *            changes (concatenated Claude Code env blocks, control chars).
 *            Sanitize ONLY — no normalizeProjectCandidate here; dot-leading
 *            historical junk is Pass C's explicit-list job.
 *   Pass A — authoritative re-derive: for every request that still has a
 *            stored payload, decrypt the envelope, rebuild headers + body,
 *            and recompute `extractProjectFromRequest(method, path, headers,
 *            body)`. Payload-derived values overwrite whatever B left.
 *            Rows whose envelope has `request.body: null` (capture-capped)
 *            are skipped untouched.
 *   Pass C — NULL an explicit, user-approved junk list ('.claude', '.codex',
 *            'projects', 'System', 'Harness') — EXCLUDING every row Pass A
 *            successfully re-derived (changed or not; a payload-derived value
 *            that happens to equal a junk entry is authoritative, e.g. a
 *            genuine cwd of /workspace/projects).
 *
 * Deep imports below are intentional: `decryptPayload` is deliberately not
 * exported from the @clankermux/database package barrel (it is an internal
 * concern of payload storage), and the extractor/sanitizer live in
 * packages/proxy/src. A one-off script importing source files directly is
 * acceptable; library code should not copy this pattern.
 *
 * NOTE: the payload envelope's own `meta.project` field is intentionally NOT
 * rewritten — nothing reads it, and rewriting would mean re-encrypting and
 * inflating every payload row for zero benefit.
 *
 * --dry-run opens the database READ-ONLY (mechanically incapable of writing)
 * and reports everything it would do. A normal run opens read-write with
 * `busy_timeout = 5000` so it coexists with the live service (WAL).
 */

import { Database } from "bun:sqlite";
import { resolveDbPath } from "../packages/database/src/paths";
import {
	decryptPayload,
	initPayloadEncryption,
	isEncryptionEnabled,
} from "../packages/database/src/payload-encryption";
import { extractProjectFromRequest } from "../packages/proxy/src/project-extraction";
import { sanitizeProjectName } from "../packages/proxy/src/project-name";
import type { RequestJsonBody } from "../packages/proxy/src/request-body-context";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const JUNK_PROJECT_VALUES = [
	".claude",
	".codex",
	"projects",
	"System",
	"Harness",
	"User's Current Configuration",
];
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
				"Usage: bun scripts/backfill-project-names.ts [--dry-run] [--batch-size=500]",
			);
			process.exit(1);
		}
	}
	return { dryRun, batchSize };
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PassARow {
	id: string;
	json: string;
	ts_key: number;
	method: string | null;
	path: string | null;
	project: string | null;
}

interface PayloadEnvelope {
	request?: {
		headers?: Record<string, string>;
		body?: string | null;
	} | null;
}

interface PassACounters {
	examined: number;
	changed: number;
	unchanged: number;
	skippedNoBody: number;
	failDecrypt: number;
	failEnvelopeJson: number;
	failBodyBase64: number;
	failBodyJson: number;
	failOther: number;
}

interface Sample {
	label: string;
	from: string;
	to: string;
}

function fmt(value: string | null): string {
	return value === null ? "NULL" : JSON.stringify(value);
}

function printSamples(title: string, samples: Sample[], total: number): void {
	if (samples.length === 0) return;
	console.log(`  ${title} (showing ${samples.length} of ${total}):`);
	for (const s of samples) {
		console.log(`    ${s.label}: ${s.from} -> ${s.to}`);
	}
}

// ---------------------------------------------------------------------------
// Pass B — conservative string repair (sanitize only) over distinct values
// ---------------------------------------------------------------------------

interface PassBResult {
	distinctExamined: number;
	valuesChanged: number;
	rowsChanged: number;
	samples: Sample[];
	/** original value -> cleaned value, only for values that change */
	repairs: Map<string, string | null>;
}

function runPassB(db: Database, dryRun: boolean): PassBResult {
	const distinct = db
		.query<{ project: string }, []>(
			"SELECT DISTINCT project FROM requests WHERE project IS NOT NULL",
		)
		.all();

	const repairs = new Map<string, string | null>();
	for (const { project } of distinct) {
		const cleaned = sanitizeProjectName(project) ?? null;
		if (cleaned !== project) {
			repairs.set(project, cleaned);
		}
	}

	const samples: Sample[] = [];
	let rowsChanged = 0;

	const countStmt = db.query<{ n: number }, [string]>(
		"SELECT COUNT(*) AS n FROM requests WHERE project = ?",
	);
	const updateStmt = dryRun
		? null
		: db.query("UPDATE requests SET project = ? WHERE project = ?");

	if (dryRun) {
		// Readonly connection: just count what would change.
		for (const [original, cleaned] of repairs) {
			rowsChanged += countStmt.get(original)?.n ?? 0;
			if (samples.length < SAMPLE_LIMIT) {
				samples.push({ label: "value", from: fmt(original), to: fmt(cleaned) });
			}
		}
	} else {
		const applyAll = db.transaction(() => {
			for (const [original, cleaned] of repairs) {
				const result = updateStmt?.run(cleaned, original);
				rowsChanged += Number(result?.changes ?? 0);
				if (samples.length < SAMPLE_LIMIT) {
					samples.push({
						label: "value",
						from: fmt(original),
						to: fmt(cleaned),
					});
				}
			}
		});
		applyAll();
	}

	return {
		distinctExamined: distinct.length,
		valuesChanged: repairs.size,
		rowsChanged,
		samples,
		repairs,
	};
}

// ---------------------------------------------------------------------------
// Pass A — re-derive from stored payloads
// ---------------------------------------------------------------------------

interface PassAResult {
	counters: PassACounters;
	samples: Sample[];
	/**
	 * ids of every row whose payload was successfully decoded and re-derived
	 * (changed or unchanged). These values are payload-authoritative and must
	 * be excluded from Pass C. Rows that failed decode/parse or had no stored
	 * body are NOT included — their project value was never verified.
	 */
	derivedIds: Set<string>;
	/**
	 * Per (post-B) project value: how many successfully re-derived rows
	 * carried it. Used by dry-run Pass C to subtract A-claimed rows without
	 * writes.
	 */
	derivedByPostBValue: Map<string | null, number>;
}

async function runPassA(
	db: Database,
	options: CliOptions,
	bRepairs: Map<string, string | null>,
): Promise<PassAResult> {
	const counters: PassACounters = {
		examined: 0,
		changed: 0,
		unchanged: 0,
		skippedNoBody: 0,
		failDecrypt: 0,
		failEnvelopeJson: 0,
		failBodyBase64: 0,
		failBodyJson: 0,
		failOther: 0,
	};
	const samples: Sample[] = [];
	const derivedIds = new Set<string>();
	const derivedByPostBValue = new Map<string | null, number>();

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
		return { counters, samples, derivedIds, derivedByPostBValue }; // empty table
	}

	const pageStmt = db.query<PassARow, [number, string, number, string, number]>(
		`SELECT p.id AS id, p.json AS json,
		        COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) AS ts_key,
		        r.method AS method, r.path AS path, r.project AS project
		 FROM request_payloads p
		 JOIN requests r ON r.id = p.id
		 WHERE (COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) > ?1
		        OR (COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) = ?1 AND p.id > ?2))
		   AND (COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) < ?3
		        OR (COALESCE(p.timestamp, ${NULL_TS_SENTINEL}) = ?3 AND p.id <= ?4))
		 ORDER BY ts_key ASC, p.id ASC
		 LIMIT ?5`,
	);
	const updateStmt = options.dryRun
		? null
		: db.query("UPDATE requests SET project = ? WHERE id = ?");

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

		const pending: Array<{ id: string; newProject: string | null }> = [];

		for (const row of rows) {
			counters.examined++;

			// Encrypted history without a key is a hard abort — silently skipping
			// would leave an unexplained partial repair.
			if (row.json.startsWith("enc:") && !isEncryptionEnabled()) {
				console.error(
					`\nABORT: payload ${row.id} is encrypted ('enc:' prefix) but ` +
						"PAYLOAD_ENCRYPTION_KEY is not set. Set the key and re-run. " +
						"Pass A stops here and Pass C was not run; Pass B (conservative " +
						"string repair) may already be applied — it is idempotent and safe.",
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
					continue;
				}
			} catch {
				counters.failDecrypt++;
				continue;
			}

			if (
				typeof envelope !== "object" ||
				envelope === null ||
				typeof envelope.request !== "object" ||
				envelope.request === null
			) {
				counters.failEnvelopeJson++;
				continue;
			}

			const rawBody = envelope.request.body;
			if (rawBody === null || rawBody === undefined) {
				// Capture-capped row: body was not stored. Leave project untouched.
				counters.skippedNoBody++;
				continue;
			}

			let bodyText: string;
			try {
				bodyText = Buffer.from(rawBody, "base64").toString("utf-8");
			} catch {
				counters.failBodyBase64++;
				continue;
			}

			let parsedBody: RequestJsonBody;
			try {
				const parsed = JSON.parse(bodyText);
				if (typeof parsed !== "object" || parsed === null) {
					counters.failBodyJson++;
					continue;
				}
				parsedBody = parsed as RequestJsonBody;
			} catch {
				counters.failBodyJson++;
				continue;
			}

			let newProject: string | null;
			try {
				const headers = new Headers(envelope.request.headers ?? {});
				newProject = extractProjectFromRequest(
					row.method ?? "",
					row.path ?? "",
					headers,
					parsedBody,
				);
			} catch {
				counters.failOther++;
				continue;
			}

			// In a real run, B already rewrote the DB so row.project is post-B.
			// In dry-run nothing was written; simulate B's effect first.
			let currentProject = row.project ?? null;
			if (options.dryRun && currentProject !== null) {
				const repaired = bRepairs.get(currentProject);
				if (repaired !== undefined) currentProject = repaired;
			}

			// The payload decoded and the extractor ran: this row's project value
			// is now payload-authoritative whether it changed or not, so Pass C
			// must never touch it.
			derivedIds.add(row.id);
			derivedByPostBValue.set(
				currentProject,
				(derivedByPostBValue.get(currentProject) ?? 0) + 1,
			);

			if (newProject !== currentProject) {
				counters.changed++;
				pending.push({ id: row.id, newProject });
				if (samples.length < SAMPLE_LIMIT) {
					samples.push({
						label: `id=${row.id}`,
						from: fmt(currentProject),
						to: fmt(newProject),
					});
				}
			} else {
				counters.unchanged++;
			}
		}

		if (!options.dryRun && pending.length > 0) {
			const applyBatch = db.transaction(() => {
				for (const update of pending) {
					updateStmt?.run(update.newProject, update.id);
				}
			});
			applyBatch();
		}

		const last = rows[rows.length - 1];
		cursorTs = last.ts_key;
		cursorId = last.id;
		if (rows.length < options.batchSize) break;
	}

	return { counters, samples, derivedIds, derivedByPostBValue };
}

// ---------------------------------------------------------------------------
// Pass C — NULL the explicit junk list, excluding Pass-A-derived rows
// ---------------------------------------------------------------------------

interface PassCResult {
	rowsNulled: number;
	samples: Sample[];
}

function runPassC(
	db: Database,
	dryRun: boolean,
	passA: PassAResult,
	bRepairs: Map<string, string | null>,
): PassCResult {
	const samples: Sample[] = [];
	let rowsNulled = 0;

	if (!dryRun) {
		// Real run: temp table for the Pass-A derived-id exclusion
		// (connection-local).
		db.run("CREATE TEMP TABLE backfill_pass_a (id TEXT PRIMARY KEY)");
		const insertId = db.query("INSERT INTO backfill_pass_a (id) VALUES (?)");
		const fill = db.transaction(() => {
			for (const id of passA.derivedIds) insertId.run(id);
		});
		fill();

		// Per-value UPDATEs (still one transaction) so samples can report which
		// junk values actually matched rows.
		const nullStmt = db.query(
			`UPDATE requests SET project = NULL
			 WHERE project = ?
			   AND id NOT IN (SELECT id FROM backfill_pass_a)`,
		);
		const applyJunk = db.transaction(() => {
			for (const v of JUNK_PROJECT_VALUES) {
				const changes = Number(nullStmt.run(v).changes);
				rowsNulled += changes;
				if (changes > 0 && samples.length < SAMPLE_LIMIT) {
					samples.push({
						label: `value (${changes} rows)`,
						from: fmt(v),
						to: "NULL",
					});
				}
			}
		});
		applyJunk();
		db.run("DROP TABLE backfill_pass_a");
		return { rowsNulled, samples };
	}

	// Dry-run (readonly connection): nothing was written by B or A, so compute
	// the would-be count from the ORIGINAL stored values. A row would be junk
	// after B if its original value's post-B form is in the junk list; subtract
	// every row Pass A successfully re-derived (changed or not — those values
	// are payload-authoritative).
	const junkSet = new Set<string>(JUNK_PROJECT_VALUES);
	const countStmt = db.query<{ n: number }, [string]>(
		"SELECT COUNT(*) AS n FROM requests WHERE project = ?",
	);
	const distinct = db
		.query<{ project: string }, []>(
			"SELECT DISTINCT project FROM requests WHERE project IS NOT NULL",
		)
		.all();

	for (const { project: original } of distinct) {
		const postB = bRepairs.has(original)
			? bRepairs.get(original)
			: original;
		if (postB === null || postB === undefined || !junkSet.has(postB)) continue;
		const total = countStmt.get(original)?.n ?? 0;
		const claimedByA = passA.derivedByPostBValue.get(postB) ?? 0;
		const wouldNull = Math.max(0, total - claimedByA);
		rowsNulled += wouldNull;
		if (wouldNull > 0 && samples.length < SAMPLE_LIMIT) {
			samples.push({
				label: `value (${wouldNull} rows)`,
				from: fmt(original),
				to: "NULL",
			});
		}
	}

	return { rowsNulled, samples };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const dbPath = resolveDbPath();
	const started = Date.now();

	console.log(
		`Backfill project names — ${options.dryRun ? "DRY-RUN (read-only)" : "LIVE run"}`,
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

		// Pass B first: conservative string repair. Pass A then overwrites with
		// authoritative payload-derived values; Pass C nulls residual junk.
		console.log("\nPass B — string repair (sanitizeProjectName on distinct values)");
		const passB = runPassB(db, options.dryRun);
		console.log(
			`  distinct values examined: ${passB.distinctExamined}, ` +
				`values changed: ${passB.valuesChanged}, rows ${options.dryRun ? "would change" : "changed"}: ${passB.rowsChanged}`,
		);
		printSamples("sample repairs", passB.samples, passB.valuesChanged);

		console.log("\nPass A — re-derive from stored payloads");
		const passA = await runPassA(db, options, passB.repairs);
		const c = passA.counters;
		console.log(
			`  examined: ${c.examined}, ${options.dryRun ? "would change" : "changed"}: ${c.changed}, ` +
				`unchanged: ${c.unchanged}, skipped (no stored body): ${c.skippedNoBody}`,
		);
		console.log(
			`  failures — decrypt: ${c.failDecrypt}, envelope JSON: ${c.failEnvelopeJson}, ` +
				`body base64: ${c.failBodyBase64}, body JSON: ${c.failBodyJson}, other: ${c.failOther}`,
		);
		printSamples("sample changes", passA.samples, c.changed);

		console.log(
			"\nPass C — NULL explicit junk values (excluding Pass-A re-derived rows)",
		);
		console.log(`  junk list: ${JUNK_PROJECT_VALUES.join(", ")}`);
		const passC = runPassC(db, options.dryRun, passA, passB.repairs);
		console.log(
			`  rows ${options.dryRun ? "would be " : ""}set to NULL: ${passC.rowsNulled}`,
		);
		printSamples("sample nulls", passC.samples, passC.samples.length);

		const elapsed = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`\nDone in ${elapsed}s.`);
		if (options.dryRun) {
			console.log("Dry-run: NO changes were written (read-only connection).");
		} else {
			console.log(
				"Reminder: the dashboard reads requests.project directly — backfilled " +
					"data is visible immediately, no service restart needed.",
			);
		}
	} finally {
		db.close();
	}
}

await main();
