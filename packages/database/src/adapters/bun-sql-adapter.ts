import type { Database, SQLQueryBindings } from "bun:sqlite";

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

	constructor(sqliteDb: Database) {
		this.sqliteDb = sqliteDb;
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
	private async withBusyRetry<T>(fn: () => T): Promise<T> {
		const deadline = Date.now() + 10 * 60 * 1000; // retry for up to 10 minutes
		while (true) {
			try {
				return fn();
			} catch (err) {
				const isBusy =
					err instanceof Error &&
					"code" in err &&
					(err as { code?: string }).code === "SQLITE_BUSY";
				if (isBusy && Date.now() < deadline) {
					await new Promise<void>((resolve) => setTimeout(resolve, 500));
					continue;
				}
				throw err;
			}
		}
	}

	/**
	 * Execute a SELECT query returning multiple rows.
	 */
	async query<R>(sqlStr: string, params: unknown[] = []): Promise<R[]> {
		const db = this.sqliteDb;
		return this.withBusyRetry(() =>
			db
				.query<R, SQLQueryBindings[]>(sqlStr)
				.all(...(params as SQLQueryBindings[])),
		);
	}

	/**
	 * Execute a SELECT query returning a single row or null.
	 */
	async get<R>(sqlStr: string, params: unknown[] = []): Promise<R | null> {
		const db = this.sqliteDb;
		const result = await this.withBusyRetry(() =>
			db
				.query<R, SQLQueryBindings[]>(sqlStr)
				.get(...(params as SQLQueryBindings[])),
		);
		return (result as R) ?? null;
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE query with no return value.
	 */
	async run(sqlStr: string, params: unknown[] = []): Promise<void> {
		const db = this.sqliteDb;
		await this.withBusyRetry(() =>
			db.run(sqlStr, params as SQLQueryBindings[]),
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
		const result = await this.withBusyRetry(() =>
			db.run(sqlStr, params as SQLQueryBindings[]),
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
