import type { Database, SQLQueryBindings } from "bun:sqlite";

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
	 */
	async close(): Promise<void> {
		this.sqliteDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		this.sqliteDb.close();
	}
}
