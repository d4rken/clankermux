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
 * Rows per batch for the "cleanup" kind's retention DELETEs. Deliberately small
 * (vs the repositories' old 2000): payload rows are large blobs (multi-MB), so
 * delete cost scales with bytes freed, not row count. A small batch keeps each
 * committed transaction's writer-slot hold short so a colliding main-thread
 * write waits at most briefly. The old single synchronous main-thread delete of
 * a batch of payloads froze the event loop for seconds — this runs off-thread
 * AND in small slices.
 */
export const CLEANUP_DELETE_BATCH_ROWS = 50;

/** Yield between cleanup delete batches so main-thread writes can grab the slot. */
const CLEANUP_DELETE_YIELD_MS = 25;

/**
 * Rows per batch for the snapshot-table retention DELETEs (usage_snapshots /
 * memory_snapshots). Larger than CLEANUP_DELETE_BATCH_ROWS because these rows are
 * tiny fixed-width numeric records (no multi-MB blobs), so a 5000-row batch still
 * commits fast. Batching matters on the FIRST prune after the usage-snapshot
 * retention default dropped 3650 → 90 days: that one tick can delete millions of
 * rows, and a single `DELETE ... WHERE sampled_at < ?` would hold SQLite's writer
 * slot for the whole delete and balloon the WAL. Each bounded, auto-committed
 * batch releases the slot and lets the off-thread checkpointer truncate the WAL.
 */
export const SNAPSHOT_DELETE_BATCH_ROWS = 5000;

/**
 * Row cap for `PRAGMA optimize`'s internal ANALYZE, set via `PRAGMA
 * analysis_limit` before it. Without a limit (SQLite's default of 0 = unbounded)
 * ANALYZE does a full index scan on every table it deems stale — on our multi-GB
 * tables that holds SQLite's single writer slot for SECONDS, during which every
 * main-thread write parks in the busy handler (up to
 * MAIN_CONNECTION_BUSY_TIMEOUT_MS = 250 ms), freezing the event loop. 400 is
 * SQLite's documented value (https://sqlite.org/lang_analyze.html): it samples
 * ~400 rows per index for near-identical planner statistics while bounding each
 * ANALYZE to milliseconds, so the writer-slot hold — and the parks it caused —
 * effectively vanish.
 */
const ANALYZE_ANALYSIS_LIMIT = 400;

/**
 * Off-thread DB-maintenance worker: incremental vacuum, the periodic
 * optimize/checkpoint tick, and the hourly retention cleanup (all the mutating
 * maintenance that would otherwise freeze the main event loop).
 *
 * Three kinds (discriminated by `kind`, defaulting to "vacuum" for backward
 * compatibility with kind-less messages):
 *   - "vacuum"   — the original incremental_vacuum behavior (below).
 *   - "cleanup"  — runs the retention DELETEs (payloads/requests/snapshots/
 *     claim observations) in
 *     small slot-releasing batches. Previously synchronous on the main thread,
 *     where deleting a batch of large payload blobs froze the loop for seconds.
 *   - "optimize" — runs `PRAGMA optimize` + `PRAGMA wal_checkpoint(TRUNCATE)`
 *     with `busy_timeout = 0`. This is the ONLY WAL reclaimer: the main
 *     connection runs with `wal_autocheckpoint = 0` (see database-operations.ts)
 *     so all checkpointing happens here, off-thread, where it can't freeze the
 *     event loop. Previously this ran synchronously on the main
 *     thread via `DatabaseOperations.optimize()`; when the vacuum kind (or
 *     any other writer) held SQLite's single writer slot, `PRAGMA optimize`'s
 *     internal ANALYZE blocked inside SQLite's C-level busy handler for the
 *     full busy_timeout (10 s), freezing the entire event loop, then threw
 *     "database is locked". In the worker the main thread never blocks, and
 *     `busy_timeout = 0` turns contention into an instant, explicit skip
 *     (`{ ok: true, skipped: true }`) — missing one 5-minute cycle while
 *     maintenance contends is normal and harmless; the next tick retries.
 *     Conversely, when THIS worker's ANALYZE runs, `PRAGMA analysis_limit`
 *     (ANALYZE_ANALYSIS_LIMIT) bounds its writer-slot hold to ~ms so it can't
 *     park main-thread writes — see the const's comment for the full rationale.
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
	  }
	| {
			kind: "cleanup";
			dbPath: string;
			// Epoch-ms cutoffs; rows older than each are deleted. requestCutoff is
			// null when request-row retention is disabled (payloads still purged).
			payloadCutoff: number;
			requestCutoff: number | null;
			usageSnapshotCutoff: number;
			memorySnapshotCutoff: number;
			/**
			 * Cutoff for `unified_claim_observations`. Derived from a FIXED
			 * retention, not from an operator control — see
			 * UNIFIED_CLAIM_OBSERVATION_RETENTION_MS in database-operations.ts.
			 */
			unifiedClaimObservationCutoff: number;
			// Byte budget for retained payload CONTENT (not file size); 0 disables
			// the size pass. Applied on top of payloadCutoff — whichever rule
			// deletes more wins.
			payloadMaxBytes: number;
	  };

export type CleanupCounts = {
	removedRequests: number;
	/** TOTAL payload rows removed: age pass + orphan sweep + size pass. */
	removedPayloads: number;
	/** Detail: how many of `removedPayloads` the byte-budget pass evicted. */
	removedPayloadsBySize: number;
	removedSnapshots: number;
	removedMemorySnapshots: number;
	/**
	 * Reported on its own rather than folded into `removedSnapshots`: the claim
	 * series is governed by a fixed retention of its own, and attributing its
	 * deletions to the usage-snapshot control would misreport what that knob does.
	 */
	removedUnifiedClaimObservations: number;
};

export type IncrementalVacuumResult =
	| { ok: true; mode: number }
	| { ok: true; skipped: boolean }
	| { ok: true; cleanup: CleanupCounts }
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

		// Bound ANALYZE's writer-slot hold to ~ms. Must be set on THIS connection
		// before `PRAGMA optimize` runs its internal ANALYZE. See
		// ANALYZE_ANALYSIS_LIMIT — without it, ANALYZE full-scans indexes on the
		// multi-GB tables and holds the slot for seconds, parking main-thread
		// writes in their busy handler (the residual event-loop stall source).
		//
		// The limit and the mask below are a PAIR. `0x00002` is the default
		// behaviour (ANALYZE the tables that would benefit); `0x10000` widens the
		// candidate set from "tables this connection has itself queried" to every
		// table. Without it a bare `PRAGMA optimize` here is close to a no-op — a
		// maintenance connection queries nothing — which is how the live DB kept
		// `request_routing` recorded at 71 rows against 362k real ones and had the
		// planner drive the activeSessions join off it. Considering every table is
		// only affordable because analysis_limit caps each index at ~400 sampled
		// rows; dropping either half breaks the other.
		db.exec(`PRAGMA analysis_limit = ${ANALYZE_ANALYSIS_LIMIT}`);
		db.exec("PRAGMA optimize = 0x10002");
		// TRUNCATE (not PASSIVE): actively reclaim and zero the WAL off-thread so
		// it stays bounded now that the main connection's autocheckpoint is
		// disabled (see `PRAGMA wal_autocheckpoint = 0` in database-operations.ts).
		// With busy_timeout=0 a concurrent reader/writer yields either a partial
		// checkpoint (busy>0, WAL not truncated, no throw) or a transient-lock
		// skip — it never blocks. When no reader holds frames, TRUNCATE copies all
		// frames back to the DB file and truncates the WAL to zero bytes; over
		// successive ticks that keeps the WAL bounded to ~one reader-idle window
		// of writes.
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

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

/**
 * Delete rows matching `whereCond` from `table` in small committed batches,
 * releasing the writer slot between each. `whereCond` is the predicate on that
 * table (e.g. `timestamp < ?`), bound with `cutoff`; `table`/`whereCond` are
 * trusted internal constants, not caller input.
 *
 * TWO deletion modes, and the choice is a correctness decision per table:
 *
 *  - DEFAULT (`atomic` unset/false) — select the target ids first (LIMIT), then
 *    delete exactly those, so the returned count reflects rows *of this table*
 *    deleted, NOT the FK-cascade child rows that `.changes` would additionally
 *    include (which both inflates the count and breaks a `.changes < batchSize`
 *    termination test). REQUIRED for `requests`, whose four ON DELETE CASCADE
 *    children would otherwise be counted.
 *  - `atomic: true` — ONE statement per batch, with the predicate re-applied
 *    inside the delete's subquery. This closes a select-then-delete race: the
 *    id-only DELETE of the default mode does not re-check the predicate, so a
 *    concurrent upsert landing between the two statements (rewriting a row's
 *    json/bytes/timestamp) would have its FRESH payload deleted. Harmless for
 *    the 12h age pass (nothing that old is being upserted) but very much not for
 *    the byte-budget pass, whose cutoff targets recent rows. A single statement
 *    is atomic under autocommit. `.changes` is exact here ONLY because
 *    `request_payloads` has no FK children — never use this mode for a table
 *    that cascades.
 *
 * Loop ends when a batch removes fewer rows than the batch size. A transient
 * lock after progress stops early (deleted rows persist; the next hourly tick
 * resumes); a transient lock on the first batch, or any non-lock error,
 * propagates to the caller's { ok: false }.
 *
 * Exported for the eviction tests, which drive it against a wrapped handle to
 * simulate a concurrent upsert; production callers are in runCleanup().
 */
export async function deleteBatched(
	db: Database,
	table: string,
	whereCond: string,
	cutoff: number,
	opts?: { atomic?: boolean },
): Promise<number> {
	const selectSql = `SELECT id FROM ${table} WHERE ${whereCond} LIMIT ?`;
	const atomicSql = `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${whereCond} LIMIT ?)`;
	let total = 0;
	for (;;) {
		let removed: number;
		try {
			if (opts?.atomic) {
				removed = db.run(atomicSql, [
					cutoff,
					CLEANUP_DELETE_BATCH_ROWS,
				]).changes;
			} else {
				const ids = db
					.query(selectSql)
					.all(cutoff, CLEANUP_DELETE_BATCH_ROWS) as Array<{ id: string }>;
				if (ids.length > 0) {
					const placeholders = ids.map(() => "?").join(",");
					db.run(
						`DELETE FROM ${table} WHERE id IN (${placeholders})`,
						ids.map((r) => r.id),
					);
				}
				removed = ids.length;
			}
		} catch (err) {
			if (isTransientLockError(err) && total > 0) break;
			throw err;
		}
		total += removed;
		// A short batch means everything matching the predicate is drained.
		if (removed < CLEANUP_DELETE_BATCH_ROWS) break;
		await Bun.sleep(CLEANUP_DELETE_YIELD_MS);
	}
	return total;
}

/**
 * The time column each batched-prune table is aged by. A closed union, not a
 * free string: the column name is interpolated into SQL, so the set of legal
 * values is fixed here rather than trusted from a call site.
 */
type TimeColumn = "sampled_at" | "observed_at";

/**
 * Best-effort BATCHED delete of aged rows from a time-series table by its own
 * time column (`sampled_at` for the snapshot tables, `observed_at` for the
 * request-aligned claim observations). `table` is a trusted internal constant,
 * not caller input, and `timeColumn` is restricted to {@link TimeColumn}.
 *
 * Was a single `DELETE ... WHERE sampled_at < ?` — fine while the table stayed
 * tiny, but the usage-snapshot retention default dropped 3650 → 90 days, so the
 * first prune after that change can delete millions of rows. A single statement
 * would hold SQLite's one writer slot for the whole delete and balloon the WAL;
 * instead we delete in SNAPSHOT_DELETE_BATCH_ROWS-sized slices, each its own
 * auto-committed transaction (no explicit BEGIN), yielding the slot between
 * batches so a main-thread write can slip through and the off-thread
 * checkpointer can truncate the WAL.
 *
 * Portable delete pattern — `DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT
 * N)` works regardless of whether this SQLite build was compiled with
 * SQLITE_ENABLE_UPDATE_DELETE_LIMIT (DELETE ... LIMIT). Every table pruned this
 * way has an implicit rowid and no child tables, so `.changes` is an accurate
 * per-table count and a short batch reliably signals "drained".
 *
 * NOTE (disk): this deletes rows but does NOT run incremental_vacuum, so freed
 * pages return to the freelist for reuse, not to the OS — the DB file will not
 * shrink on disk after the one-time large prune. The hourly "vacuum" kind
 * reclaims the freelist back to the OS over subsequent ticks; page reuse keeps
 * the file from growing further in the meantime.
 *
 * Best-effort: snapshot volume is non-critical, so a transient lock (or any
 * error) mid-loop is swallowed with a warning rather than aborting a tick that
 * already reclaimed payload/request rows — rows deleted before the error persist
 * and the next tick resumes. Mirrors the old tryDelete's tolerance.
 */
async function tryDeleteSnapshotsBatched(
	db: Database,
	table: string,
	cutoff: number,
	timeColumn: TimeColumn = "sampled_at",
): Promise<number> {
	const sql = `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${timeColumn} < ? LIMIT ?)`;
	let total = 0;
	try {
		for (;;) {
			const changes = db.run(sql, [cutoff, SNAPSHOT_DELETE_BATCH_ROWS]).changes;
			total += changes;
			// A short batch means everything older than the cutoff is drained.
			if (changes < SNAPSHOT_DELETE_BATCH_ROWS) break;
			await Bun.sleep(CLEANUP_DELETE_YIELD_MS);
		}
	} catch (err) {
		console.warn(
			`[cleanup-worker] snapshot batched delete on ${table} stopped early: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return total;
}

/**
 * How many precomputed quota-drift payloads survive a cleanup pass. Only the
 * newest is ever read; the spares exist so an in-flight read cannot race the
 * prune, and so a bad pass can be compared against its predecessor by hand.
 */
const QUOTA_DRIFT_RESULTS_KEEP = 3;

/**
 * Retention DELETEs, off the main thread. Previously these ran synchronously on
 * the main connection inside the hourly tick; deleting a batch of large payload
 * blobs froze the event loop for seconds. Here the heavy payload/request deletes
 * are chunked with slot-releasing yields (see CLEANUP_DELETE_BATCH_ROWS) so this
 * can't monopolize SQLite's single writer slot. The main thread still nulls its
 * in-process retentionUsageCache after this resolves — the worker can't.
 *
 * Payloads are bounded by TWO independent rules and both apply, whichever
 * deletes more: the age cutoff (`payloadCutoff`) and, when enabled, the byte
 * budget (`payloadMaxBytes`) enforced by the final oldest-first eviction pass.
 */
async function runCleanup(
	dbPath: string,
	payloadCutoff: number,
	requestCutoff: number | null,
	usageSnapshotCutoff: number,
	memorySnapshotCutoff: number,
	unifiedClaimObservationCutoff: number,
	payloadMaxBytes: number,
): Promise<void> {
	let db: Database | undefined;
	try {
		db = new Database(dbPath);
		// Enable FK enforcement so deleting an aged `requests` row cascades to its
		// children (request_payloads / request_routing / request_tool_calls /
		// request_tool_errors, all ON DELETE CASCADE). Only request_payloads has
		// its own age/orphan pass; the other three rely entirely on cascade, so
		// without this they'd orphan and grow unbounded. bun:sqlite defaults FK
		// OFF, and the old main-thread path ran with FK ON (configureSqlite).
		db.exec("PRAGMA foreign_keys = ON");
		// Wait politely for the writer slot when the main thread holds it; the
		// small per-batch deletes + yields release it promptly in return.
		db.exec("PRAGMA busy_timeout = 200");
		applyWorkerPragmas(db);

		// atomic: request_payloads has no FK children, and using one deletion
		// semantic for the whole table keeps the next reader from picking the
		// racy one for the size pass below (see deleteBatched).
		const removedPayloadsByAge = await deleteBatched(
			db,
			"request_payloads",
			"timestamp IS NOT NULL AND timestamp < ?",
			payloadCutoff,
			{ atomic: true },
		);

		// Orphaned payloads (request row already gone). Typically ~0; a NOT IN
		// subquery has no natural LIMIT, so run it as a single statement.
		// (request_payloads has no children, so .changes here is accurate.)
		const removedOrphans = db.run(
			`DELETE FROM request_payloads WHERE id NOT IN (SELECT id FROM requests)`,
		).changes;

		let removedRequests = 0;
		if (requestCutoff !== null) {
			// FK ON cascades child rows (routing/tool_calls/tool_errors/payloads);
			// deleteBatched counts request rows only.
			removedRequests = await deleteBatched(
				db,
				"requests",
				"timestamp < ?",
				requestCutoff,
			);
		}

		// Batched (see tryDeleteSnapshotsBatched): the first prune after the
		// usage-snapshot retention default dropped 3650 → 90 days can remove
		// millions of rows, so it must not run as one writer-slot-holding
		// statement. Deletes rows only — page reclamation to disk is the hourly
		// "vacuum" kind's job.
		//
		// `usage_scoped_snapshots` is pruned on the SAME cutoff and its deletions
		// are FOLDED INTO removedSnapshots. Both tables are the per-account usage
		// series and are governed by the one `usage_snapshot_retention_days`
		// control, so splitting the report would offer a second number for a knob
		// that has only one.
		const removedSnapshots =
			(await tryDeleteSnapshotsBatched(
				db,
				"usage_snapshots",
				usageSnapshotCutoff,
			)) +
			(await tryDeleteSnapshotsBatched(
				db,
				"usage_scoped_snapshots",
				usageSnapshotCutoff,
			));
		const removedMemorySnapshots = await tryDeleteSnapshotsBatched(
			db,
			"memory_snapshots",
			memorySnapshotCutoff,
		);

		// The request-aligned claim series, aged by `observed_at` on its own FIXED
		// cutoff (see UNIFIED_CLAIM_OBSERVATION_RETENTION_MS). Same batching
		// rationale as the snapshot tables and then some: this table grows with
		// REQUEST volume times claims-per-response, not with a poll cadence.
		const removedUnifiedClaimObservations = await tryDeleteSnapshotsBatched(
			db,
			"unified_claim_observations",
			unifiedClaimObservationCutoff,
			"observed_at",
		);

		// Precomputed quota-drift payloads: keep the most recent few, drop the
		// rest. Age is the wrong rule here — a scheduler that has been down for a
		// week must not have its one surviving result aged out from under the
		// panel, and a single blob is small enough that "a few" is the whole
		// budget. Not counted in any reported figure: it is a cache, not data.
		try {
			db.run(
				`DELETE FROM quota_drift_results
				 WHERE computed_at NOT IN (
					SELECT computed_at FROM quota_drift_results
					ORDER BY computed_at DESC LIMIT ?
				 )`,
				[QUOTA_DRIFT_RESULTS_KEEP],
			);
		} catch (err) {
			console.warn(
				`[cleanup-worker] quota_drift_results prune failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Byte-budget pass — LAST, deliberately: it must run AFTER the `requests`
		// age pass and its FK cascades. A payload whose parent request row is
		// about to be deleted still counts toward the budget until that cascade
		// happens, so evicting earlier would remove survivors unnecessarily.
		//
		// Governing invariant: the budget counts EXACTLY the rows this pass can
		// evict. Both the running sum and the delete predicate are qualified by
		// `bytes IS NOT NULL AND timestamp IS NOT NULL`. Any other pairing is a
		// defect: counting a row the pass cannot delete lets it pin the total over
		// budget forever (every tick evicts collectable rows without converging),
		// and deleting a row the count ignores throws away data that contributed
		// nothing to the overage.
		let removedPayloadsBySize = 0;
		if (payloadMaxBytes > 0) {
			// ONE query resolves everything — no separate SELECT SUM(bytes)
			// pre-check: two reads on separate autocommit snapshots can disagree,
			// and the pre-check buys nothing because "no qualifying row" already
			// means "under budget". The running sum walks newest-first and the
			// first row whose cumulative total exceeds the budget marks the cutoff;
			// everything at or older than it goes. The inner scan is already
			// ordered by idx_request_payloads_size, so the first qualifying row IS
			// the answer — an outer ORDER BY would force a temp B-tree.
			const cutoffRow = db
				.query(
					`SELECT timestamp FROM (
						SELECT timestamp,
						       SUM(bytes) OVER (ORDER BY timestamp DESC) AS running
						FROM request_payloads
						WHERE bytes IS NOT NULL AND timestamp IS NOT NULL
					)
					WHERE running > ?
					LIMIT 1`,
				)
				.get(payloadMaxBytes) as { timestamp: number } | null | undefined;
			if (cutoffRow) {
				// `timestamp <= cutoff` deletes rows tied on the cutoff millisecond
				// as a whole bucket, which can land marginally UNDER budget. That is
				// deliberate: measured live, 1741 rows spanned 1739 distinct
				// timestamps (at most 2 sharing a millisecond), so the worst case is
				// ~one extra row — far cheaper than tuple-cutoff complexity.
				removedPayloadsBySize = await deleteBatched(
					db,
					"request_payloads",
					"bytes IS NOT NULL AND timestamp IS NOT NULL AND timestamp <= ?",
					cutoffRow.timestamp,
					{ atomic: true },
				);
			}
		}

		// Close the worker's connection BEFORE signalling completion. The caller
		// terminates the worker on receipt and may immediately open its own
		// connection to the DB; closing first releases our write lock so that
		// access can't race a half-torn-down worker connection.
		db.close();
		db = undefined;
		self.postMessage({
			ok: true,
			cleanup: {
				removedRequests,
				// TOTAL across all three payload rules — reporting the size
				// evictions only in the detail field would make "Clean up now" say
				// "Removed 0 payloads" right after a large size eviction.
				removedPayloads:
					removedPayloadsByAge + removedOrphans + removedPayloadsBySize,
				removedPayloadsBySize,
				removedSnapshots,
				removedMemorySnapshots,
				removedUnifiedClaimObservations,
			},
		} satisfies IncrementalVacuumResult);
	} catch (err) {
		self.postMessage({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		} satisfies IncrementalVacuumResult);
	} finally {
		db?.close();
	}
}

self.onmessage = (event: MessageEvent<IncrementalVacuumRequest>) => {
	const request = event.data;
	if (request.kind === "optimize") {
		runOptimize(request.dbPath);
	} else if (request.kind === "cleanup") {
		// Fire-and-forget: runCleanup posts its own result and never rejects.
		void runCleanup(
			request.dbPath,
			request.payloadCutoff,
			request.requestCutoff,
			request.usageSnapshotCutoff,
			request.memorySnapshotCutoff,
			request.unifiedClaimObservationCutoff,
			request.payloadMaxBytes,
		);
	} else {
		// kind "vacuum" or absent (backward compat: kind-less messages
		// predate the discriminator and always meant incremental_vacuum).
		// Fire-and-forget: runIncrementalVacuum posts its own result and never
		// rejects (all failures are caught and reported as { ok: false }).
		void runIncrementalVacuum(request.dbPath, request.pages);
	}
};
