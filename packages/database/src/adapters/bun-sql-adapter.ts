import type { Database, SQLQueryBindings } from "bun:sqlite";
import {
	type LockContentionStats,
	lockContentionStats,
} from "../lock-contention-stats";
import { isTransientLockError } from "../sqlite-error";

/**
 * busy_timeout for the shutdown `wal_checkpoint(TRUNCATE)` in `close()`.
 *
 * The main connection runs with a deliberately small busy_timeout (see
 * MAIN_CONNECTION_BUSY_TIMEOUT_MS in database-operations.ts) so SQLITE_BUSY
 * fails fast instead of freezing the event loop. At shutdown that protection
 * is counterproductive: blocking a couple of seconds is fine, and giving the
 * checkpoint a real chance to truncate the WAL beats leaving a fat WAL behind.
 * If the lock is still held past this window the truncate is skipped with a
 * log — shutdown must never crash on a busy checkpoint.
 */
const CLOSE_CHECKPOINT_BUSY_TIMEOUT_MS = 2000;

/** Longest SQL prefix kept when labelling a timed statement. */
const SQL_FINGERPRINT_MAX_CHARS = 80;

/**
 * Collapse a statement to a short, stable label for the contention log.
 *
 * Whitespace is normalised so the same statement written across several lines
 * produces one label, and the text is truncated because the label only has to
 * identify which statement stalled, not reproduce it.
 *
 * On safety: every current caller binds values as parameters rather than
 * interpolating them, and the dynamic SQL in DatabaseOperations composes only
 * structural fragments (table names, fixed limits, placeholder lists). So no
 * caller leaks user data today. Note that truncation is NOT redaction though —
 * a future caller that interpolated a literal into the first 80 characters
 * would put it in the log, and this function cannot prevent that.
 */
function sqlFingerprint(sqlStr: string): string {
	const flat = sqlStr.replace(/\s+/g, " ").trim();
	return flat.length > SQL_FINGERPRINT_MAX_CHARS
		? `${flat.slice(0, SQL_FINGERPRINT_MAX_CHARS)}…`
		: flat;
}

/**
 * SQL adapter that wraps bun:sqlite behind an async, Promise-returning API.
 *
 * The `query`, `get`, `run`, `runWithChanges` methods return Promises so that
 * repositories can `await` them uniformly — the SQLite calls resolve
 * synchronously under the hood (with an async busy-retry when the writer slot
 * is held by another connection, e.g. a VACUUM running on a Worker).
 */
export class BunSqlAdapter {
	/** The underlying bun:sqlite Database. */
	private sqliteDb: Database;
	/**
	 * Where timing and contention counters go. Defaults to the process-wide
	 * singleton the periodic reporter drains; injectable so a test can assert on
	 * its own accumulator instead of racing everything else in the isolate for
	 * one piece of global state.
	 */
	private readonly stats: LockContentionStats;

	constructor(
		sqliteDb: Database,
		stats: LockContentionStats = lockContentionStats,
	) {
		this.sqliteDb = sqliteDb;
		this.stats = stats;
	}

	/** Return the underlying bun:sqlite Database. */
	getSQLiteDb(): Database {
		return this.sqliteDb;
	}

	/**
	 * Retry a synchronous SQLite call asynchronously when the database is
	 * locked by another connection (SQLITE_BUSY / errno 5).
	 *
	 * SQLite's built-in busy_timeout retries at the C level via usleep(), which
	 * blocks the Bun event loop for the entire wait.  This wrapper instead lets
	 * the busy_timeout exhaust normally (giving the C layer a short chance to
	 * self-resolve), then catches the resulting error and re-schedules with
	 * setTimeout so the event loop stays free between attempts.  This is
	 * necessary when a long-running exclusive operation such as VACUUM is running
	 * on a separate Worker connection.
	 */
	private async withBusyRetry<T>(fn: () => T, label?: string): Promise<T> {
		const deadline = Date.now() + 10 * 60 * 1000; // retry for up to 10 minutes
		while (true) {
			// Time each synchronous attempt on its own. `fn()` is a synchronous
			// bun:sqlite call, so this span IS the time the event loop was frozen —
			// including any C-level busy wait the statement spent parked inside
			// SQLite. It deliberately excludes the async sleep below, which does
			// not block the loop; timing the whole retry lifecycle instead would
			// mix 500 ms of harmless sleep into a "blocking time" number.
			const startedAt = performance.now();
			try {
				const result = fn();
				this.stats.recordOperation(performance.now() - startedAt, label);
				return result;
			} catch (err) {
				this.stats.recordOperation(performance.now() - startedAt, label);
				const isBusy =
					err instanceof Error &&
					"code" in err &&
					(err as { code?: string }).code === "SQLITE_BUSY";
				if (isBusy) {
					// Counted HERE, before the error is swallowed by the retry below.
					// Nothing downstream ever sees it, so this is the only place the
					// occurrence can be observed at all. It proves a lock collision;
					// the duration recorded just above is the authority on how long
					// the loop was actually blocked by it.
					this.stats.recordBusyOccurrence();
				} else if (isTransientLockError(err)) {
					// Lock contention that the exact-match check above does not
					// recognise (extended codes such as SQLITE_BUSY_SNAPSHOT, or
					// SQLITE_LOCKED). It is about to be thrown rather than retried.
					// Counted, not acted on: instrumentation must not change the
					// behaviour it is measuring.
					this.stats.recordClassifierGap();
				}
				if (isBusy && Date.now() < deadline) {
					await new Promise<void>((resolve) => setTimeout(resolve, 500));
					continue;
				}
				if (isBusy) this.stats.recordBusyExhausted();
				throw err;
			}
		}
	}

	/**
	 * Execute a SELECT query returning multiple rows.
	 */
	async query<R>(sqlStr: string, params: unknown[] = []): Promise<R[]> {
		const db = this.sqliteDb;
		return this.withBusyRetry(
			() =>
				db
					.query<R, SQLQueryBindings[]>(sqlStr)
					.all(...(params as SQLQueryBindings[])),
			sqlFingerprint(sqlStr),
		);
	}

	/**
	 * Execute a SELECT query returning a single row or null.
	 */
	async get<R>(sqlStr: string, params: unknown[] = []): Promise<R | null> {
		const db = this.sqliteDb;
		const result = await this.withBusyRetry(
			() =>
				db
					.query<R, SQLQueryBindings[]>(sqlStr)
					.get(...(params as SQLQueryBindings[])),
			sqlFingerprint(sqlStr),
		);
		return (result as R) ?? null;
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE query with no return value.
	 */
	async run(sqlStr: string, params: unknown[] = []): Promise<void> {
		const db = this.sqliteDb;
		await this.withBusyRetry(
			() => db.run(sqlStr, params as SQLQueryBindings[]),
			sqlFingerprint(sqlStr),
		);
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE query and return the number of affected rows.
	 */
	async runWithChanges(
		sqlStr: string,
		params: unknown[] = [],
	): Promise<number> {
		const db = this.sqliteDb;
		const result = await this.withBusyRetry(
			() => db.run(sqlStr, params as SQLQueryBindings[]),
			sqlFingerprint(sqlStr),
		);
		return result.changes;
	}

	/**
	 * Close the database connection.
	 *
	 * Best-effort WAL truncate first: the main connection's busy_timeout is
	 * bounded (fail-fast for event-loop safety), so temporarily widen it for
	 * the shutdown checkpoint and tolerate a still-busy database — a skipped
	 * truncate only leaves WAL frames for the next open to checkpoint, whereas
	 * a thrown SQLITE_BUSY here would crash shutdown.
	 */
	async close(): Promise<void> {
		try {
			this.sqliteDb.exec(
				`PRAGMA busy_timeout = ${CLOSE_CHECKPOINT_BUSY_TIMEOUT_MS}`,
			);
			this.sqliteDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch (err) {
			console.warn(
				`[BunSqlAdapter] shutdown wal_checkpoint(TRUNCATE) skipped: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		this.sqliteDb.close();
	}
}
