import { statSync } from "node:fs";
import { TIME_CONSTANTS } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import {
	isCorruptionError,
	runIntegrityCheckInWorker,
} from "@clankermux/database";
import { Logger } from "@clankermux/logger";

/**
 * Periodic integrity scheduler. Two probes run on independent timers:
 *
 *  - **quick** (`PRAGMA quick_check`) every `DEFAULT_QUICK_INTERVAL_HOURS`
 *    (6h). Catches page-structure corruption and most freelist issues.
 *  - **full** (`PRAGMA integrity_check` + `PRAGMA foreign_key_check`) every
 *    `DEFAULT_FULL_INTERVAL_HOURS` (24h). Catches the silent-wrong-results
 *    class that `quick_check` misses (index/table cross-checks, UNIQUE/CHECK,
 *    foreign-key violations). Both intervals are overridable per call via the
 *    `overrides` argument.
 *
 * Both probes run in a dedicated `bun:sqlite` worker (see
 * `integrity-check-worker.ts`) when a SQLite path is available. `bun:sqlite`
 * is synchronous, so even `PRAGMA quick_check` on a multi-GB DB blocks the
 * JS event loop for tens of seconds (~30 s observed on a 7.6 GiB DB),
 * during which the proxy can't accept connections or flush in-flight
 * streaming responses — downstream sockets get reset and clients see
 * "socket connection was closed unexpectedly". When no SQLite file path is
 * resolvable (e.g. an in-memory DB), the probe falls back to a direct
 * `DatabaseOperations` call.
 *
 * Mutex: only one probe runs at a time. If a probe is in flight, the next
 * tick logs and skips rather than queueing — checks are idempotent reads,
 * so dropping a tick is harmless.
 *
 * Setting either interval override to `0` disables that probe; the
 * corresponding status field stays at its last value (or `null` if never run).
 */

const DEFAULT_QUICK_INTERVAL_HOURS = 6;
const DEFAULT_FULL_INTERVAL_HOURS = 24;
const QUICK_INITIAL_DELAY_MS = 30 * TIME_CONSTANTS.SECOND;
/** Delay full check past startup spike of disk I/O (dashboard build, schema
 *  migrations, performance index creation) so it doesn't compound with
 *  startup latency. */
const FULL_INITIAL_DELAY_MS = 30 * TIME_CONSTANTS.MINUTE;

export function startIntegrityScheduler(
	dbOps: DatabaseOperations,
	overrides?: { quickIntervalHours?: number; fullIntervalHours?: number },
): () => void {
	const logger = new Logger("IntegrityScheduler");

	// An explicit `0` override disables the probe. Without this branch, a `0`
	// would multiply to 0ms and pass the `!== null` guard, scheduling
	// `setInterval(runQuick, 0)` — a tight loop hammering the DB every tick.
	// `undefined` falls back to the default interval.
	const resolveInterval = (
		override: number | undefined,
		defaultHours: number,
	): number | null => {
		const hours = override ?? defaultHours;
		if (hours === 0) return null;
		return hours * TIME_CONSTANTS.HOUR;
	};

	const quickInterval = resolveInterval(
		overrides?.quickIntervalHours,
		DEFAULT_QUICK_INTERVAL_HOURS,
	);

	const fullInterval = resolveInterval(
		overrides?.fullIntervalHours,
		DEFAULT_FULL_INTERVAL_HOURS,
	);

	if (quickInterval === null && fullInterval === null) {
		logger.info("Integrity scheduler fully disabled");
		return () => {};
	}

	const runQuick = async () => {
		if (!dbOps.markIntegrityCheckRunning("quick")) {
			logger.debug("Skipping quick check — another check is already running");
			return;
		}
		logger.debug("Running quick integrity check...");
		const { result, error } = await runCheckLocked(dbOps, "quick");
		if (result === "ok") {
			logger.debug("Quick integrity check passed");
		} else if (result === "skipped") {
			logger.warn(
				`Quick integrity check skipped: ${error}; will retry next tick`,
			);
		} else {
			logger.error(`Quick integrity check FAILED: ${error}`);
			logger.error(
				"Database corruption detected. Check database integrity from the dashboard (Overview → Storage / Integrity) or review these server logs for details.",
			);
		}
	};

	const runFull = async () => {
		if (!dbOps.markIntegrityCheckRunning("full")) {
			logger.debug("Skipping full check — another check is already running");
			return;
		}
		logger.info("Running full integrity check...");
		const { result, error } = await runCheckLocked(dbOps, "full");
		if (result === "ok") {
			logger.info("Full integrity check passed");
		} else if (result === "skipped") {
			logger.warn(
				`Full integrity check skipped: ${error}; will retry next tick`,
			);
		} else {
			logger.error(`Full integrity check FAILED: ${error}`);
			logger.error(
				"Database corruption detected. Check database integrity from the dashboard (Overview → Storage / Integrity) or review these server logs for details.",
			);
		}
	};

	const handles: ReturnType<typeof setTimeout>[] = [];
	const intervals: ReturnType<typeof setInterval>[] = [];

	if (quickInterval !== null) {
		handles.push(setTimeout(runQuick, QUICK_INITIAL_DELAY_MS));
		intervals.push(setInterval(runQuick, quickInterval));
	} else {
		logger.info("Quick integrity check disabled (interval override = 0)");
	}

	if (fullInterval !== null) {
		handles.push(setTimeout(runFull, FULL_INITIAL_DELAY_MS));
		intervals.push(setInterval(runFull, fullInterval));
	} else {
		logger.info("Full integrity check disabled (interval override = 0)");
	}

	return () => {
		for (const h of handles) clearTimeout(h);
		for (const i of intervals) clearInterval(i);
		logger.info("Integrity scheduler stopped");
	};
}

/**
 * Defensive ceiling on the DB size we'll attempt a *full* integrity check on.
 * Our full check completes in ~tens of seconds even at 15 GiB (well under the
 * 10-min = 600 s worker cap), so this is NOT a normal-operation gate — it's
 * headroom against pathological growth where a full `integrity_check` could
 * exceed the worker timeout. Sizing: at a pessimistic ~4 s/GiB, 64 GiB ≈ 256 s
 * — comfortably under the 600 s cap — and it's >4× our current ~15 GiB, so a
 * healthy green stays reachable across realistic growth while still guarding
 * the genuinely pathological case. Set it too low and the surface pins
 * permanently amber, because a quick `ok` never clears a full skip. Above the
 * ceiling we run the (much cheaper) quick check instead and mark the full
 * probe `skipped`, so the surface stays honest (amber "couldn't complete")
 * rather than falsely red. Deliberately a fixed inline constant — no env var
 * (single-operator deploy-from-source).
 */
const FULL_CHECK_MAX_DB_BYTES = 64 * 1024 ** 3;

/**
 * Map a worker/runner result to the `(result, detail)` pair
 * `recordIntegrityResult` expects:
 *  - `{ ok: true }` → `ok` (no detail).
 *  - `verdict: "error" | "timeout"` → `skipped` (the check could not complete;
 *    an operational failure is NOT proven corruption).
 *  - anything else non-ok → `corrupt`.
 *
 * The default is DELIBERATELY `corrupt`, not `skipped`. Only an explicit
 * operational failure (`error`/`timeout`) downgrades to amber. A non-ok result
 * with a missing or unrecognized `verdict` — e.g. a stale embedded worker still
 * on the old `{ ok: false, error }` protocol during the brief window before
 * `build:db-workers` regenerates it — must fail safe toward red rather than
 * silently masking real corruption. `verdict?` is intentionally optional so
 * such a legacy shape type-checks and hits the safe default. (Masking real
 * corruption as `skipped` is the dangerous false-negative direction.)
 */
function mapVerdict(
	r:
		| { ok: true }
		| { ok: false; verdict?: "corrupt" | "error" | "timeout"; error: string },
): { result: "ok" | "corrupt" | "skipped"; detail: string | null } {
	if (r.ok) return { result: "ok", detail: null };
	if (r.verdict === "error" || r.verdict === "timeout") {
		return { result: "skipped", detail: r.error };
	}
	return { result: "corrupt", detail: r.error };
}

/**
 * Run a check (`quick` or `full`) once the caller has already claimed the
 * mutex via `markIntegrityCheckRunning(kind)`. Routes through the
 * `integrity-check-worker` when a SQLite path is resolvable so the
 * (synchronous) `bun:sqlite` pragma doesn't freeze the proxy event loop;
 * falls back to `DatabaseOperations.run{Quick,Full}IntegrityCheck` when no
 * file path is resolvable (e.g. an in-memory DB — lightweight there, so
 * blocking is fine).
 *
 * Verdict handling: a real PRAGMA verdict maps to `ok`/`corrupt`; a worker
 * timeout / worker exception / defensive size-skip maps to `skipped`, which
 * preserves the last verified verdict rather than falsely flagging corruption.
 *
 * Records the result and (implicitly) releases the mutex via
 * `recordIntegrityResult`.
 */
async function runCheckLocked(
	dbOps: DatabaseOperations,
	kind: "quick" | "full",
): Promise<{ result: "ok" | "corrupt" | "skipped"; error: string | null }> {
	try {
		const dbPath = dbOps.getResolvedDbPath();
		if (!dbPath) {
			// In-memory / unresolvable-path fallback: a direct pragma that
			// RETURNS a non-"ok" answer is a real verdict (corrupt). A THROW is
			// classified: a SQLITE_CORRUPT/SQLITE_NOTADB throw IS a corruption
			// verdict (record `corrupt`); any other throw propagates to the
			// outer catch → `skipped` (couldn't complete).
			let out: string;
			try {
				out =
					kind === "quick"
						? await dbOps.runQuickIntegrityCheck()
						: await dbOps.runFullIntegrityCheck();
			} catch (err) {
				if (isCorruptionError(err)) {
					const detail = err instanceof Error ? err.message : String(err);
					dbOps.recordIntegrityResult(kind, "corrupt", detail);
					return { result: "corrupt", error: detail };
				}
				throw err;
			}
			const result = out === "ok" ? "ok" : "corrupt";
			dbOps.recordIntegrityResult(
				kind,
				result,
				result === "corrupt" ? out : null,
			);
			return { result, error: result === "corrupt" ? out : null };
		}

		// Size-skip (full only): on a pathologically large DB a full
		// integrity_check could exceed the worker timeout. Run a quick check
		// instead — while still holding the mutex we already claimed (do NOT
		// re-claim) — and mark the full probe skipped. `statSync` failure just
		// falls through to the normal full-worker path.
		if (kind === "full") {
			let dbBytes: number | null = null;
			try {
				dbBytes = statSync(dbPath).size;
			} catch {
				dbBytes = null;
			}
			if (dbBytes !== null && dbBytes > FULL_CHECK_MAX_DB_BYTES) {
				const gib = (dbBytes / 1024 ** 3).toFixed(1);
				const ceilingGiB = (FULL_CHECK_MAX_DB_BYTES / 1024 ** 3).toFixed(0);
				const quickResult = await runIntegrityCheckInWorker(dbPath, {
					kind: "quick",
				});
				const mappedQuick = mapVerdict(quickResult);
				const skipReason = `DB ${gib}GiB exceeds full-check ceiling ${ceilingGiB}GiB — ran quick check instead`;
				// Record both synchronously (no await between) so the collapsed
				// status reflects the quick verdict + full skip atomically.
				dbOps.recordIntegrityResult(
					"quick",
					mappedQuick.result,
					mappedQuick.detail,
				);
				dbOps.recordIntegrityResult("full", "skipped", skipReason);
				// If the substitute quick check PROVED corruption, surface that as
				// the outcome (correct ERROR log + honest on-demand return) rather
				// than a benign "skipped" — the collapsed status is already corrupt
				// via the records above, but the awaited return/log must agree.
				if (mappedQuick.result === "corrupt") {
					return { result: "corrupt", error: mappedQuick.detail };
				}
				return { result: "skipped", error: skipReason };
			}
		}

		const workerResult = await runIntegrityCheckInWorker(dbPath, { kind });
		const mapped = mapVerdict(workerResult);
		dbOps.recordIntegrityResult(kind, mapped.result, mapped.detail);
		return { result: mapped.result, error: mapped.detail };
	} catch (error) {
		// A worker onerror / stat throw / unexpected exception is an
		// operational failure — NOT proven corruption. Record it as skipped so
		// the last verified verdict is preserved and the next tick retries.
		const msg = String(error);
		dbOps.recordIntegrityResult(kind, "skipped", msg);
		return { result: "skipped", error: msg };
	}
}

/**
 * Trigger an on-demand integrity probe. Used by the
 * `POST /api/storage/integrity/check` endpoint. Returns
 * `{ ok: false, reason: "already-running" }` if the mutex is held.
 *
 * Both kinds are awaited end-to-end here. The full check can take up to
 * the worker timeout (10 min by default). For HTTP handlers that sit
 * behind a reverse proxy with a short read_timeout, use
 * {@link startFullIntegrityCheckBackground} for the full kind to return
 * 202 immediately.
 */
export async function runIntegrityCheckOnDemand(
	dbOps: DatabaseOperations,
	kind: "quick" | "full",
): Promise<
	| { ok: true; result: "ok" | "corrupt" | "skipped"; error: string | null }
	| { ok: false; reason: "already-running" }
> {
	if (!dbOps.markIntegrityCheckRunning(kind)) {
		return { ok: false, reason: "already-running" };
	}
	const { result, error } = await runCheckLocked(dbOps, kind);
	return { ok: true, result, error };
}

/**
 * Claim the mutex for a full integrity check and kick off the worker
 * **without awaiting**. Intended for HTTP handlers — returning 202
 * immediately means a reverse proxy (nginx, Caddy, ALB) with a short
 * `proxy_read_timeout` won't drop the connection before the worker
 * finishes, which would otherwise make the dashboard show a false-
 * negative "Could not trigger check" even though the check is in
 * progress and will land in `/api/storage` once the worker completes.
 *
 * Returns synchronously:
 *  - `{ok: true}` — mutex claimed, worker kicked off in background. The
 *    eventual result is visible via `/api/storage` and `/health` once
 *    `recordIntegrityResult` releases the mutex.
 *  - `{ok: false, reason: "already-running"}` — another probe is in
 *    flight; nothing was started.
 *
 * Errors inside the background coroutine are recorded as
 * `skipped` with the message (an operational failure is not proven
 * corruption) — same handling as the awaited path.
 */
export function startFullIntegrityCheckBackground(
	dbOps: DatabaseOperations,
): { ok: true } | { ok: false; reason: "already-running" } {
	if (!dbOps.markIntegrityCheckRunning("full")) {
		return { ok: false, reason: "already-running" };
	}
	// Fire-and-forget. `runCheckLocked` catches its own errors and
	// always calls `recordIntegrityResult` to release the mutex.
	void runCheckLocked(dbOps, "full");
	return { ok: true };
}
