import { Database } from "bun:sqlite";
import { isCorruptionError, isTransientLockError } from "./sqlite-error";

/**
 * Off-thread writer for the `request_payloads` table.
 *
 * `bun:sqlite` is synchronous, so every payload INSERT executed on the main
 * thread blocks the event loop for its whole duration. Payload rows are the
 * largest rows we write (hundreds of KiB on average, several MiB at the tail),
 * which made them the dominant contributor to event-loop freezes. This worker
 * owns its own SQLite connection and performs every payload write off the main
 * thread; the main thread only encrypts and hands the ciphertext over.
 *
 * Protocol (see the message types below):
 *   client → worker:  init → write* → close
 *   worker → client:  ready, ack*, closed (or error, when init fails)
 *
 * Durability contract:
 *   - Rows are written in bounded batches inside ONE transaction, each row
 *     under its own SAVEPOINT so a single bad row cannot poison the batch.
 *   - An `ack` with `status: "committed"` is posted ONLY after the batch COMMIT
 *     returned successfully. Before that point the client keeps the entry and
 *     will replay it after a crash/rotation — the INSERT is an upsert, so a
 *     replay after a commit whose ack was lost is idempotent.
 *   - If the COMMIT itself fails, EVERY row of the batch is NACKed. We never
 *     ack or drop a subset based on pre-commit insert results.
 */

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

/**
 * How a failed row is attributed:
 *  - `entry-permanent` — the row itself is unwritable (missing FK parent,
 *    NOT NULL/CHECK violation, malformed binding). Retrying cannot help, so the
 *    client drops it and counts it through the payload-drop counters. A missing
 *    FK parent is EXPECTED when retention deleted the request row before a
 *    replay landed.
 *  - `retryable` — lock contention or an explicitly-listed transient I/O error.
 *    The CLIENT owns the retry (backoff on its own timer); the worker keeps no
 *    state for it.
 *  - `writer-fatal` — database-wide failure (disk full, corruption, read-only,
 *    cannot open) or an unclassified COMMIT failure. The client retains pending
 *    entries, suspends admission and marks the writer unhealthy; these are never
 *    counted as ordinary payload drops.
 */
export type PayloadWriteErrorClass =
	| "entry-permanent"
	| "retryable"
	| "writer-fatal";

export interface PayloadWriteInitMessage {
	type: "init";
	generation: number;
	dbPath: string;
	busyTimeoutMs?: number;
}

export interface PayloadWriteRowMessage {
	type: "write";
	generation: number;
	seq: number;
	id: string;
	/** Stored form of the payload: ciphertext when encryption is on, else JSON. */
	ciphertext: string;
	/** Epoch ms written to `request_payloads.timestamp` (retention basis). */
	timestamp: number;
}

export interface PayloadWriteCloseMessage {
	type: "close";
	generation: number;
}

export type PayloadWriteRequest =
	| PayloadWriteInitMessage
	| PayloadWriteRowMessage
	| PayloadWriteCloseMessage;

export interface PayloadWriteAck {
	seq: number;
	id: string;
	status: "committed" | "failed";
	errorClass?: PayloadWriteErrorClass;
	detail?: string;
}

export type PayloadWriteResponse =
	| { type: "ready"; generation: number }
	| { type: "ack"; generation: number; results: PayloadWriteAck[] }
	| { type: "closed"; generation: number }
	| { type: "error"; generation: number; detail: string };

// ---------------------------------------------------------------------------
// Connection + batching constants
// ---------------------------------------------------------------------------

/**
 * Page cache for the payload connection, expressed as negative KiB (= 64 MiB).
 * Much larger than the maintenance workers' 2 MiB: this connection is
 * long-lived and writes continuously, so keeping the `request_payloads`
 * B-tree pages resident avoids cold-page disk I/O on every insert.
 */
export const PAYLOAD_WRITER_CACHE_SIZE_KIB = -65536;

/**
 * Real busy timeout — unlike the vacuum/integrity workers (which use 0/200 ms
 * and simply skip a contended tick) a payload write MUST land, so this
 * connection waits for the writer slot. Blocking here costs nothing: the worker
 * has no event loop to protect.
 */
export const PAYLOAD_WRITER_BUSY_TIMEOUT_MS = 10_000;

/**
 * Byte budget for one batch. A batch always admits at least one row, so a
 * single payload larger than this still forms a (one-row) batch rather than
 * wedging the queue.
 */
export const PAYLOAD_BATCH_MAX_BYTES = 4 * 1024 * 1024;

/** Row budget for one batch — bounds WAL growth and the writer-slot hold. */
export const PAYLOAD_BATCH_MAX_ROWS = 32;

/**
 * Linger before flushing a partially-filled batch. Short enough that a lone
 * payload commits promptly, long enough to coalesce a burst.
 */
export const PAYLOAD_BATCH_MAX_DELAY_MS = 25;

const INSERT_SQL = `INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)
	 ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, timestamp = EXCLUDED.timestamp`;

/**
 * SQLite primary result codes that are database-wide failures: the write path
 * is broken until an operator intervenes, so pending work must be retained
 * rather than dropped.
 */
const WRITER_FATAL_PRIMARY_CODES = new Set([
	8, // SQLITE_READONLY
	10, // SQLITE_IOERR — see classifyRowError for the transient exceptions
	11, // SQLITE_CORRUPT
	13, // SQLITE_FULL
	14, // SQLITE_CANTOPEN
	26, // SQLITE_NOTADB
]);

/**
 * The only I/O errors treated as transient. Everything else in the IOERR family
 * is a real device/filesystem failure and classifies as writer-fatal — an
 * explicit list, never a blanket "IOERR is retryable".
 */
const RETRYABLE_EXTENDED_CODES = new Set([
	"SQLITE_IOERR_LOCK",
	"SQLITE_IOERR_RDLOCK",
	"SQLITE_IOERR_UNLOCK",
	"SQLITE_IOERR_CHECKRESERVEDLOCK",
	"SQLITE_IOERR_ACCESS",
	"SQLITE_PROTOCOL",
]);

/** Primary result codes attributable to the row being written. */
const ENTRY_PERMANENT_PRIMARY_CODES = new Set([
	18, // SQLITE_TOOBIG
	19, // SQLITE_CONSTRAINT (incl. FOREIGN KEY / NOT NULL / CHECK)
	20, // SQLITE_MISMATCH
	25, // SQLITE_RANGE (bad binding index)
]);

function primaryCode(err: unknown): number | null {
	if (typeof err !== "object" || err === null) return null;
	const errno = (err as { errno?: unknown }).errno;
	return typeof errno === "number" ? errno & 0xff : null;
}

function symbolicCode(err: unknown): string | null {
	if (typeof err !== "object" || err === null) return null;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" ? code : null;
}

export function errorDetail(err: unknown): string {
	if (err instanceof Error) {
		const code = symbolicCode(err);
		return code ? `${code}: ${err.message}` : err.message;
	}
	return String(err);
}

/**
 * Classify a row-level insert failure. Order matters: the transient-lock and
 * corruption families are checked through the shared helpers first, then the
 * explicit code lists. Anything unrecognised is attributed to the ROW
 * (`entry-permanent`) — an unknown row error that keeps failing must not pin
 * the queue forever. Database-wide failure modes are all in the explicit
 * writer-fatal list above, and any that slip through still surface at COMMIT,
 * where the default is writer-fatal.
 */
export function classifyRowError(err: unknown): PayloadWriteErrorClass {
	if (isTransientLockError(err)) return "retryable";

	const extended = symbolicCode(err);
	if (extended && RETRYABLE_EXTENDED_CODES.has(extended)) return "retryable";

	if (isCorruptionError(err)) return "writer-fatal";

	const primary = primaryCode(err);
	if (primary !== null && WRITER_FATAL_PRIMARY_CODES.has(primary)) {
		return "writer-fatal";
	}
	if (primary !== null && ENTRY_PERMANENT_PRIMARY_CODES.has(primary)) {
		return "entry-permanent";
	}
	return "entry-permanent";
}

/**
 * Classify a COMMIT failure. Only lock contention is retryable; everything else
 * (including unrecognised errors) is database-wide — the batch's rows are all
 * still unwritten, so guessing "permanent" here would silently lose payloads.
 */
export function classifyCommitError(err: unknown): PayloadWriteErrorClass {
	if (isTransientLockError(err)) return "retryable";
	const extended = symbolicCode(err);
	if (extended && RETRYABLE_EXTENDED_CODES.has(extended)) return "retryable";
	return "writer-fatal";
}

// ---------------------------------------------------------------------------
// Engine (transport-free, so it can be unit-tested on the main thread)
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the SQLite handle the engine needs. Keeping it
 * structural lets tests wrap a real `Database` to force a COMMIT failure
 * without any production-only injection point.
 */
export interface PayloadWriteDb {
	exec(sql: string): void;
	prepare(sql: string): { run(id: string, json: string, ts: number): unknown };
	close(): void;
}

export interface PayloadWriteEngineOptions {
	db: PayloadWriteDb;
	generation: number;
	post: (message: PayloadWriteResponse) => void;
	maxBatchBytes?: number;
	maxBatchRows?: number;
	maxBatchDelayMs?: number;
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface PayloadWriteEngine {
	/** Queue a row; flushes immediately once a batch budget is reached. */
	accept(row: PayloadWriteRowMessage): void;
	/** Flush every queued row now (used by close and by the batch timer). */
	flush(): void;
	/** Flush, close the connection and post the close-ack. */
	close(): void;
}

/** Open + configure the payload connection. Never inherits SQLite defaults. */
export function openPayloadWriteDatabase(
	dbPath: string,
	busyTimeoutMs = PAYLOAD_WRITER_BUSY_TIMEOUT_MS,
): Database {
	const db = new Database(dbPath);
	// WAL: this connection writes concurrently with the main connection's reads.
	db.exec("PRAGMA journal_mode = WAL");
	// The payload row's FK to requests(id) must be enforced here too — this
	// connection is the ONLY writer of request_payloads, so without it a payload
	// for a request row that never committed would become an orphan.
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
	db.exec("PRAGMA synchronous = FULL");
	// mmap_size defaults to a non-zero value in some builds; on a multi-GiB DB
	// that mapped the whole file and OOM'd the process (see the mmap_size=0 fix).
	db.exec("PRAGMA mmap_size = 0");
	db.exec(`PRAGMA cache_size = ${PAYLOAD_WRITER_CACHE_SIZE_KIB}`);
	db.exec("PRAGMA temp_store = MEMORY");
	// Checkpointing stays owned by the off-thread checkpoint worker; a payload
	// commit must never pay for a WAL checkpoint.
	db.exec("PRAGMA wal_autocheckpoint = 0");
	return db;
}

export function createPayloadWriteEngine(
	options: PayloadWriteEngineOptions,
): PayloadWriteEngine {
	const {
		db,
		generation,
		post,
		maxBatchBytes = PAYLOAD_BATCH_MAX_BYTES,
		maxBatchRows = PAYLOAD_BATCH_MAX_ROWS,
		maxBatchDelayMs = PAYLOAD_BATCH_MAX_DELAY_MS,
		setTimer = (cb, ms) => setTimeout(cb, ms),
		clearTimer = (handle) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
	} = options;

	const insert = db.prepare(INSERT_SQL);
	const pending: PayloadWriteRowMessage[] = [];
	let pendingBytes = 0;
	let timer: unknown = null;
	let fatal: string | null = null;
	let closed = false;

	function cancelTimer(): void {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
	}

	function armTimer(): void {
		if (timer !== null) return;
		timer = setTimer(() => {
			timer = null;
			flush();
		}, maxBatchDelayMs);
	}

	function takeBatch(): PayloadWriteRowMessage[] {
		const batch: PayloadWriteRowMessage[] = [];
		let bytes = 0;
		while (pending.length > 0) {
			const next = pending[0];
			const nextBytes = next.ciphertext.length;
			// Always take at least one row so an over-budget payload still moves.
			if (batch.length > 0) {
				if (batch.length >= maxBatchRows) break;
				if (bytes + nextBytes > maxBatchBytes) break;
			}
			pending.shift();
			pendingBytes -= nextBytes;
			bytes += nextBytes;
			batch.push(next);
		}
		return batch;
	}

	function nackAll(
		batch: PayloadWriteRowMessage[],
		errorClass: PayloadWriteErrorClass,
		detail: string,
	): void {
		post({
			type: "ack",
			generation,
			results: batch.map((row) => ({
				seq: row.seq,
				id: row.id,
				status: "failed" as const,
				errorClass,
				detail,
			})),
		});
	}

	function rollbackQuietly(): void {
		try {
			db.exec("ROLLBACK");
		} catch {
			// Already rolled back (or never begun) — nothing to recover here.
		}
	}

	function writeBatch(batch: PayloadWriteRowMessage[]): void {
		if (batch.length === 0) return;

		if (fatal) {
			// The connection is known-broken; do not touch it again. The client
			// retains these entries and stays suspended.
			nackAll(batch, "writer-fatal", fatal);
			return;
		}

		try {
			db.exec("BEGIN IMMEDIATE");
		} catch (err) {
			const errorClass = classifyCommitError(err);
			if (errorClass === "writer-fatal") fatal = errorDetail(err);
			nackAll(batch, errorClass, errorDetail(err));
			return;
		}

		const results: PayloadWriteAck[] = [];
		let fatalRow: {
			errorClass: PayloadWriteErrorClass;
			detail: string;
		} | null = null;

		for (const row of batch) {
			try {
				db.exec("SAVEPOINT payload_row");
				insert.run(row.id, row.ciphertext, row.timestamp);
				db.exec("RELEASE payload_row");
				results.push({ seq: row.seq, id: row.id, status: "committed" });
			} catch (err) {
				try {
					db.exec("ROLLBACK TO payload_row");
					db.exec("RELEASE payload_row");
				} catch {
					// The savepoint itself is gone — the transaction is unusable;
					// the classification below decides what happens to the batch.
				}
				const errorClass = classifyRowError(err);
				if (errorClass === "writer-fatal") {
					fatalRow = { errorClass, detail: errorDetail(err) };
					break;
				}
				results.push({
					seq: row.seq,
					id: row.id,
					status: "failed",
					errorClass,
					detail: errorDetail(err),
				});
			}
		}

		if (fatalRow) {
			// Database-wide failure mid-batch: abandon the whole transaction and
			// hand every row back, including the ones that inserted cleanly.
			rollbackQuietly();
			fatal = fatalRow.detail;
			nackAll(batch, "writer-fatal", fatalRow.detail);
			return;
		}

		try {
			db.exec("COMMIT");
		} catch (err) {
			rollbackQuietly();
			const errorClass = classifyCommitError(err);
			if (errorClass === "writer-fatal") fatal = errorDetail(err);
			// Every row of the batch is unwritten — including rows that failed
			// their savepoint, whose "permanent" verdict came from a transaction
			// that no longer exists. Nothing may be acked or dropped here.
			nackAll(batch, errorClass, errorDetail(err));
			return;
		}

		post({ type: "ack", generation, results });
	}

	function flush(): void {
		cancelTimer();
		while (pending.length > 0) {
			writeBatch(takeBatch());
		}
	}

	return {
		accept(row: PayloadWriteRowMessage): void {
			if (closed) return;
			pending.push(row);
			pendingBytes += row.ciphertext.length;
			if (pending.length >= maxBatchRows || pendingBytes >= maxBatchBytes) {
				flush();
				return;
			}
			armTimer();
		},
		flush,
		close(): void {
			if (closed) return;
			closed = true;
			flush();
			cancelTimer();
			try {
				db.close();
			} catch {
				// A close failure changes nothing for the client — the generation
				// is terminated right after the close-ack either way.
			}
			post({ type: "closed", generation });
		},
	};
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

let engine: PayloadWriteEngine | null = null;
let workerGeneration = -1;

function post(message: PayloadWriteResponse): void {
	self.postMessage(message);
}

self.onmessage = (event: MessageEvent<PayloadWriteRequest>) => {
	const message = event.data;

	if (message.type === "init") {
		workerGeneration = message.generation;
		try {
			const db = openPayloadWriteDatabase(
				message.dbPath,
				message.busyTimeoutMs,
			);
			engine = createPayloadWriteEngine({
				db,
				generation: message.generation,
				post,
			});
			post({ type: "ready", generation: message.generation });
		} catch (err) {
			post({
				type: "error",
				generation: message.generation,
				detail: errorDetail(err),
			});
		}
		return;
	}

	if (!engine) {
		// A message before init (or after a failed init) cannot be honored. Only
		// writes carry an entry the client is waiting on, so only they are NACKed.
		if (message.type === "write") {
			post({
				type: "ack",
				generation: workerGeneration,
				results: [
					{
						seq: message.seq,
						id: message.id,
						status: "failed",
						errorClass: "writer-fatal",
						detail: "payload writer received a write before init",
					},
				],
			});
		}
		return;
	}

	if (message.type === "write") {
		engine.accept(message);
		return;
	}

	// close
	engine.close();
	engine = null;
};
