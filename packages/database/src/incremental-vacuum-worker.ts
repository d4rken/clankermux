import { Database } from "bun:sqlite";
import { isTransientLockError } from "./sqlite-error";

/**
 * Reclaim the freelist in batches of this many pages, releasing SQLite's single
 * writer slot between each batch. A whole-budget `incremental_vacuum(N)` runs as
 * one transaction that holds the writer slot for its full duration — on a large
 * or fragmented DB that is multiple seconds, and any main-thread write that
 * lands during it stalls the event loop on `busy_timeout`. Per-batch
 * transactions cap each contended stall to one batch's hold (2000 pages ≈ 8 MiB,
 * sub-second) regardless of how large the per-tick budget is. Smaller = shorter
 * holds at the cost of more per-batch overhead; total pages/tick is the caller's
 * `pages` argument, independent of this.
 */
export const INCREMENTAL_VACUUM_BATCH_PAGES = 2000;

/**
 * Pause between batches so a main-thread write blocked in `busy_timeout` can
 * acquire the just-released writer slot before the worker re-grabs it for the
 * next batch. Negligible against the hourly cadence; only applied when another
 * batch will actually follow.
 */
const INCREMENTAL_VACUUM_BATCH_YIELD_MS = 25;

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
 *   moves up to N free pages back to the OS. For our hourly retention tick
 *   (N≈40000, ~160 MiB, reclaimed in slot-releasing batches — see below) the
 *   per-batch operation is usually fast on local SSD, but under load or on a
 *   fragmented file it can climb into hundreds of milliseconds. Off-thread
 *   keeps the proxy's HTTP loop responsive.
 *
 * Locking: this takes SQLite's single writer slot, so any concurrent write
 * from main or post-processor connections waits on `busy_timeout` while the
 * slot is held. Rather than reclaim the whole per-tick budget in one
 * transaction (a multi-second slot-hold on a large/fragmented DB that stalls
 * the event loop for every main-thread write that lands during it), we reclaim
 * in `INCREMENTAL_VACUUM_BATCH_PAGES`-sized batches — each its own transaction
 * that commits and releases the slot — with a short yield between so a waiting
 * writer slips through the gap. This decouples the per-tick throughput (set by
 * the caller) from the worst-case slot-hold (one batch), so the caller can pass
 * a large budget to drain a freelist backlog fast without proportionally
 * lengthening any single contended stall.
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

async function runIncrementalVacuum(
	dbPath: string,
	pages: number,
): Promise<void> {
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
			self.postMessage({
				ok: false,
				error: `auto_vacuum=${mode}; expected 2 (INCREMENTAL). Run startup bootstrap migration first.`,
			} satisfies IncrementalVacuumResult);
			return;
		}

		// Reclaim up to `pages` free pages this tick, in batches that each commit
		// and release the writer slot (see INCREMENTAL_VACUUM_BATCH_PAGES). Break
		// early once the freelist is drained so a high per-tick budget costs
		// nothing when there's no backlog — it then only reclaims the pages this
		// hour's deletes actually freed.
		let remaining = Math.max(1, Math.trunc(Number(pages) || 1));
		let reclaimedBatches = 0;
		while (remaining > 0) {
			const free = (
				db.query("PRAGMA freelist_count").get() as { freelist_count: number }
			).freelist_count;
			if (free <= 0) break;

			const batch = Math.min(INCREMENTAL_VACUUM_BATCH_PAGES, remaining, free);
			try {
				db.exec(`PRAGMA incremental_vacuum(${batch})`);
			} catch (err) {
				// Writer-slot contention on this batch (busy_timeout=200 already
				// gave it a brief wait). If earlier batches committed, this tick
				// still reclaimed real pages — stop and let the next hourly tick
				// resume, reporting success so a partial tick doesn't trip the
				// consecutive-skip escalation. If NOTHING was reclaimed yet, fall
				// through to the outer catch's { ok: false }, preserving the
				// pre-batching single-call semantics that feed the skip counter.
				if (isTransientLockError(err) && reclaimedBatches > 0) break;
				throw err;
			}
			reclaimedBatches++;
			remaining -= batch;

			// Yield the just-released writer slot so a main-thread write blocked
			// in busy_timeout can acquire it before the next batch re-grabs it.
			// The early-break above handles the now-drained case on the next
			// iteration, at the cost of one harmless trailing sleep.
			if (remaining > 0) await Bun.sleep(INCREMENTAL_VACUUM_BATCH_YIELD_MS);
		}

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
		// Fire-and-forget: runIncrementalVacuum posts its own result and never
		// rejects (all failures are caught and reported as { ok: false }).
		void runIncrementalVacuum(request.dbPath, request.pages);
	}
};
