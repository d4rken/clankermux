import { Database } from "bun:sqlite";
import { isTransientLockError } from "./sqlite-error";

/**
 * Dedicated worker for `PRAGMA incremental_vacuum(N)` and the periodic
 * `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)` maintenance tick.
 *
 * Two kinds (discriminated by `kind`, defaulting to "vacuum" for backward
 * compatibility with kind-less messages):
 *   - "vacuum"   — the original incremental_vacuum behavior (below).
 *   - "optimize" — runs `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)`
 *     with `busy_timeout = 0`. Previously this ran synchronously on the main
 *     thread via `DatabaseOperations.optimize()`; when the vacuum kind (or
 *     any other writer) held SQLite's single writer slot, `PRAGMA optimize`'s
 *     internal ANALYZE blocked inside SQLite's C-level busy handler for the
 *     full busy_timeout (10 s), freezing the entire event loop, then threw
 *     "database is locked". In the worker the main thread never blocks, and
 *     `busy_timeout = 0` turns contention into an instant, explicit skip
 *     (`{ ok: true, skipped: true }`) — missing one 5-minute cycle while
 *     maintenance contends is normal and harmless; the next tick retries.
 *
 * Why a worker, not the main `sqliteDb` handle:
 *   `bun:sqlite` is synchronous (blocks the JS event loop for the duration of
 *   any call). `PRAGMA incremental_vacuum(N)` is a write transaction that
 *   moves up to N free pages back to the OS. For our hourly hourly retention
 *   tick (N≈8000, ~32 MiB) the operation is usually fast on local SSD, but
 *   under load or on a fragmented file it can climb into hundreds of
 *   milliseconds. Off-thread keeps the proxy's HTTP loop responsive.
 *
 * Locking: this still takes SQLite's single writer slot, so any concurrent
 * write from main or post-processor connections will wait on `busy_timeout`
 * until this finishes. That's expected and bounded by the chunk size we pass
 * in (small N → short hold).
 *
 * Memory knobs applied inside the worker connection:
 *  - `cache_size = -2000` (2 MiB): keep SQLite's page cache small; the worker
 *    is short-lived and doesn't need a big cache for one PRAGMA.
 *  - `temp_store = FILE`: never spill temp tables to RAM under cgroup pressure.
 *  - `mmap_size = 0`: no mmap; reads go through the page cache (still
 *    reclaimable by the kernel under MemoryHigh pressure).
 *  - `busy_timeout = 200`: small wait to absorb a brief write burst from the
 *    post-processor flushing a batched insert. Long enough to cover the
 *    common case (sub-100 ms commits), short enough that the worker can't
 *    extend the writer-slot hold meaningfully. Bumped from 0 after Greptile
 *    flagged that a zero timeout would silently skip every tick during
 *    sustained write activity — see the consecutive-skip counter in
 *    `incrementalVacuum()` for the escalation path. (Greptile #230)
 *
 * Refuses if `auto_vacuum != 2` — the operation is a no-op there and would
 * mask a misconfigured DB. Callers should have gated already via the same
 * check on the main connection, but the worker double-checks since it
 * opens its own handle.
 */

export type IncrementalVacuumRequest =
	| {
			kind?: "vacuum";
			dbPath: string;
			pages: number;
	  }
	| {
			kind: "optimize";
			dbPath: string;
	  };

export type IncrementalVacuumResult =
	| { ok: true; mode: number }
	| { ok: true; skipped: boolean }
	| { ok: false; error: string };

/**
 * Connection hygiene shared by both kinds — small page cache, no RAM temp
 * spill, no mmap (see the per-PRAGMA rationale in the header comment).
 * `busy_timeout` deliberately differs per kind and is set by the caller.
 */
function applyWorkerPragmas(db: Database): void {
	db.exec("PRAGMA cache_size = -2000");
	db.exec("PRAGMA temp_store = FILE");
	db.exec("PRAGMA mmap_size = 0");
}

function runIncrementalVacuum(dbPath: string, pages: number): void {
	let db: Database | undefined;
	try {
		db = new Database(dbPath);
		// Small wait to absorb a brief write burst from the post-processor
		// flushing a batched insert — see the header comment. (Greptile #230)
		db.exec("PRAGMA busy_timeout = 200");
		applyWorkerPragmas(db);

		const mode = (
			db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
		).auto_vacuum;
		if (mode !== 2) {
			db.close();
			db = undefined;
			self.postMessage({
				ok: false,
				error: `auto_vacuum=${mode}; expected 2 (INCREMENTAL). Run startup bootstrap migration first.`,
			} satisfies IncrementalVacuumResult);
			return;
		}

		const n = Math.max(1, Math.trunc(Number(pages) || 1));
		db.exec(`PRAGMA incremental_vacuum(${n})`);

		db.close();
		db = undefined;
		self.postMessage({ ok: true, mode } satisfies IncrementalVacuumResult);
	} catch (err) {
		self.postMessage({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		} satisfies IncrementalVacuumResult);
	} finally {
		db?.close();
	}
}

function runOptimize(dbPath: string): void {
	let db: Database | undefined;
	try {
		db = new Database(dbPath);
		// Zero wait: if another connection (e.g. the hourly vacuum kind or a
		// large retention DELETE) holds the writer slot, skip this cycle
		// instead of parking the worker in SQLite's busy handler. Do NOT
		// inherit the vacuum kind's busy_timeout here — the 5-minute cadence
		// makes a skipped cycle free, whereas any wait is wasted time.
		db.exec("PRAGMA busy_timeout = 0");
		applyWorkerPragmas(db);

		db.exec("PRAGMA optimize");
		db.exec("PRAGMA wal_checkpoint(PASSIVE)");

		self.postMessage({
			ok: true,
			skipped: false,
		} satisfies IncrementalVacuumResult);
	} catch (err) {
		if (isTransientLockError(err)) {
			// Contention during maintenance is normal — report a clean skip,
			// the next 5-minute tick retries. Matches the whole BUSY/LOCKED
			// family, including the extended `SQLITE_BUSY_SNAPSHOT` (517) that a
			// WAL snapshot-vs-checkpoint race throws — an exact `SQLITE_BUSY`
			// match would mislabel that benign skip as a WARN. See sqlite-error.ts.
			self.postMessage({
				ok: true,
				skipped: true,
			} satisfies IncrementalVacuumResult);
		} else {
			self.postMessage({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			} satisfies IncrementalVacuumResult);
		}
	} finally {
		db?.close();
	}
}

self.onmessage = (event: MessageEvent<IncrementalVacuumRequest>) => {
	const request = event.data;
	if (request.kind === "optimize") {
		runOptimize(request.dbPath);
	} else {
		// kind "vacuum" or absent (backward compat: kind-less messages
		// predate the discriminator and always meant incremental_vacuum).
		runIncrementalVacuum(request.dbPath, request.pages);
	}
};
