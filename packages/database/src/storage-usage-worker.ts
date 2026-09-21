import { Database } from "bun:sqlite";

/**
 * Dedicated worker for the per-table storage-usage scan behind
 * `GET /api/storage/usage`.
 *
 * The byte sums are `SUM(LENGTH(col))` full-table scans, and `bun:sqlite` is
 * synchronous — run on the main thread against a multi-GB `request_payloads`
 * table with a cold OS page cache they block the event loop for minutes. That
 * is not hypothetical: the first dashboard load after a restart (cold TTL
 * cache) froze ALL HTTP serving for 94–130 s, observed 2026-08-24 as an exact
 * gap in the process log with Caddy timing out every API request in the
 * window.
 *
 * Mirrors `integrity-check-worker.ts`: the worker opens its own handle with
 * `readonly: true` — WAL mode supports concurrent readers alongside the
 * main-thread writer — runs the scans, posts one combined result, posts a
 * second message acknowledging that the handle closed, and is terminated by
 * the runner.
 */

export type StorageUsageScanRequest = {
	dbPath: string;
	busyTimeoutMs: number;
	/** The retention-governed tables to measure, in response order. */
	tables: ReadonlyArray<{ key: string; table: string }>;
};

export type StorageUsageTableResult = {
	key: string;
	table: string;
	rowCount: number;
	approxBytes: number;
};

export type StorageUsageScanResult =
	| { ok: true; types: StorageUsageTableResult[] }
	| { ok: false; error: string };

/**
 * Posted once the SQLite handle has been closed, whatever the scan did. It is
 * what separates "this thread is finished with the file" from "this thread was
 * terminated and may still be reading it": the runner has no other signal,
 * since `Worker.terminate()` reports nothing back.
 */
export type StorageUsageCloseAck =
	| { kind: "close"; closed: true }
	| { kind: "close"; closed: false; error: string };

/** Everything the worker posts. The runner routes on `kind`. */
export type StorageUsageWorkerMessage =
	| { kind: "result"; result: StorageUsageScanResult }
	| StorageUsageCloseAck;

function post(message: StorageUsageWorkerMessage): void {
	postMessage(message);
}

/**
 * Approximate logical byte size + row count of one table, computed as
 * `SUM(LENGTH(col))` over every column (discovered via `PRAGMA table_info`).
 * LENGTH counts the text representation of values (raw bytes for BLOBs), so
 * this undercounts SQLite's varint integer encoding and ignores index/page
 * overhead — an intentional "content bytes" approximation, labeled as such in
 * the UI.
 *
 * Throws, naming the table, when the table is absent or the scan errors. A
 * zero row count and a zero byte total are what an empty table measures to, so
 * they cannot also mean "this did not measure" — the caller reports the whole
 * scan as unavailable instead.
 */
function measureTable(
	db: Database,
	key: string,
	table: string,
): StorageUsageTableResult {
	try {
		// `table` comes from a hardcoded constant list in database-operations.ts
		// and the column names from the table's own schema (PRAGMA), never user
		// input — safe to inline.
		const cols = db
			.query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
			.all();
		if (cols.length === 0) {
			throw new Error("no such table (PRAGMA table_info returned no columns)");
		}
		const lengthExpr = cols
			.map((c) => `COALESCE(LENGTH("${c.name}"), 0)`)
			.join(" + ");
		const row = db
			.query<{ rowCount: number; approxBytes: number | null }, []>(
				`SELECT COUNT(*) AS rowCount, SUM(${lengthExpr}) AS approxBytes FROM "${table}"`,
			)
			.get();
		if (!row) throw new Error("the aggregate query returned no row");
		return {
			key,
			table,
			rowCount: row.rowCount ?? 0,
			approxBytes: row.approxBytes ?? 0,
		};
	} catch (err) {
		throw new Error(
			`table "${table}": ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

self.onmessage = (event: MessageEvent<StorageUsageScanRequest>) => {
	const { dbPath, busyTimeoutMs, tables } = event.data;
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		db.exec(
			`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(Number(busyTimeoutMs) || 10000))}`,
		);
		// Same bounded-memory settings as vacuum-worker: bun:sqlite's default
		// mmap maps roughly the whole file, which is invisible until something
		// walks every page — exactly what this scan does — and then the
		// resident set explodes and the cgroup OOM-kills the process.
		db.exec("PRAGMA mmap_size = 0");
		db.exec("PRAGMA cache_size = -2000");
		db.exec("PRAGMA temp_store = FILE");
		// WAL is what makes this scan safe: WAL readers never block the main
		// connection's writer. In rollback-journal mode a minutes-long SELECT
		// holds a shared lock that stalls every writer commit — the exact
		// event-loop damage this worker exists to prevent, just moved into
		// SQLite's busy handler. Refuse instead; the caller reports the
		// measurement as unavailable.
		const journalMode = db
			.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
			.get()
			?.journal_mode?.toLowerCase();
		if (journalMode !== "wal") {
			post({
				kind: "result",
				result: {
					ok: false,
					error: `journal_mode is ${journalMode ?? "unknown"} — the scan only runs against WAL, where readers cannot stall the writer`,
				},
			});
			return;
		}
		const types = tables.map(({ key, table }) =>
			measureTable(db as Database, key, table),
		);
		post({ kind: "result", result: { ok: true, types } });
	} catch (err) {
		post({
			kind: "result",
			result: {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			},
		});
	} finally {
		// Posted from inside the `finally`, not after the whole statement: the
		// journal-mode refusal above returns from inside the `try`, which runs
		// this block and then skips everything following it — an acknowledgement
		// placed after the statement would never be sent on that path, and the
		// runner would quarantine a refusal that ended perfectly cleanly.
		try {
			// `db` is undefined when the open itself threw: nothing was ever
			// held, which is a clean close.
			db?.close();
			post({ kind: "close", closed: true });
		} catch (err) {
			post({
				kind: "close",
				closed: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
};
