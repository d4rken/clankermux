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

	const runQuick = () => runScheduledIntegrityCheck(dbOps, "quick", logger);
	const runFull = () => runScheduledIntegrityCheck(dbOps, "full", logger);

	const handles: ReturnType<typeof setTimeout>[] = [];
	const intervals: ReturnType<typeof setInterval>[] = [];

	// Timers discard the promise an async callback returns, and nothing installs
	// a process-level unhandledRejection handler, so an escaping rejection ends
	// the process. A failed integrity check must not do that.
	const guard = (run: () => Promise<void>, kind: string) => () => {
		void run().catch((error) => {
			logger.error(`${kind} integrity check threw`, error);
		});
	};
	const tickQuick = guard(runQuick, "Quick");
	const tickFull = guard(runFull, "Full");

	if (quickInterval !== null) {
		handles.push(setTimeout(tickQuick, QUICK_INITIAL_DELAY_MS));
		intervals.push(setInterval(tickQuick, quickInterval));
	} else {
		logger.info("Quick integrity check disabled (interval override = 0)");
	}

	if (fullInterval !== null) {
		handles.push(setTimeout(tickFull, FULL_INITIAL_DELAY_MS));
		intervals.push(setInterval(tickFull, fullInterval));
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
 * Defensive ceiling on the DB size an AUTOMATIC integrity check will scan.
 * Our full check completes in ~tens of seconds even at 15 GiB (well under the
 * 10-min = 600 s worker cap), so this is NOT a normal-operation gate — it's
 * headroom against pathological growth where a check could exceed the worker
 * timeout. Sizing: at a pessimistic ~4 s/GiB, 64 GiB ≈ 256 s — comfortably
 * under the 600 s cap — and it's >4× our current ~15 GiB, so a healthy green
 * stays reachable across realistic growth while still guarding the genuinely
 * pathological case. Set it too low and the surface pins permanently amber,
 * because a skip never clears to ok on its own.
 *
 * It governs BOTH timer-driven kinds. `quick_check` is cheaper per page than
 * `integrity_check`, but it still walks every b-tree page and the freelist, so
 * it reads essentially the whole file — substituting it above the ceiling
 * would only change which whole-file scan runs on a timer. Above the ceiling
 * the scheduled probe records `skipped` (amber "couldn't complete", never a
 * green verdict) and scans nothing.
 *
 * On-demand checks ignore it entirely: an operator asking for a scan has
 * chosen to pay for it, and leaving no way to check a large database would be
 * worse than the scan.
 *
 * Deliberately a fixed inline constant — no env var (single-operator
 * deploy-from-source).
 */
const AUTOMATIC_CHECK_MAX_DB_BYTES = 64 * 1024 ** 3;

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
 * `trigger` decides whether {@link AUTOMATIC_CHECK_MAX_DB_BYTES} applies: a
 * timer-driven check is skipped above it, an operator-triggered one is not.
 *
 * Records the result and (implicitly) releases the mutex via
 * `recordIntegrityResult`.
 */
async function runCheckLocked(
	dbOps: DatabaseOperations,
	kind: "quick" | "full",
	trigger: "scheduled" | "on-demand",
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

		// Size ceiling, timer-driven checks only: on a pathologically large DB a
		// scan could exceed the worker timeout, and both kinds read essentially
		// the whole file. Record `skipped` while still holding the mutex we
		// already claimed (do NOT re-claim) and scan nothing. A `statSync`
		// failure just falls through to the normal worker path.
		if (trigger === "scheduled") {
			let dbBytes: number | null = null;
			try {
				dbBytes = statSync(dbPath).size;
			} catch {
				dbBytes = null;
			}
			if (dbBytes !== null && dbBytes > AUTOMATIC_CHECK_MAX_DB_BYTES) {
				const gib = (dbBytes / 1024 ** 3).toFixed(1);
				const ceilingGiB = (AUTOMATIC_CHECK_MAX_DB_BYTES / 1024 ** 3).toFixed(
					0,
				);
				const skipReason = `DB ${gib}GiB exceeds the automatic-check ceiling ${ceilingGiB}GiB — trigger a check from the dashboard to scan anyway`;
				dbOps.recordIntegrityResult(kind, "skipped", skipReason);
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
 * Run one TIMER-driven probe: claim the mutex, run the check, log the outcome.
 *
 * Separate entry point from {@link runIntegrityCheckOnDemand} because the two
 * triggers differ on {@link AUTOMATIC_CHECK_MAX_DB_BYTES}: this one is skipped
 * above the ceiling, an operator-triggered one is not.
 */
export async function runScheduledIntegrityCheck(
	dbOps: DatabaseOperations,
	kind: "quick" | "full",
	logger: Logger = new Logger("IntegrityScheduler"),
): Promise<void> {
	const label = kind === "quick" ? "Quick" : "Full";
	if (!dbOps.markIntegrityCheckRunning(kind)) {
		logger.debug(`Skipping ${kind} check — another check is already running`);
		return;
	}
	// A full check is rare and slow enough to be worth an info line; a quick
	// one runs four times as often and stays at debug.
	const announce = (message: string) => {
		if (kind === "quick") logger.debug(message);
		else logger.info(message);
	};
	announce(`Running ${kind} integrity check...`);
	const { result, error } = await runCheckLocked(dbOps, kind, "scheduled");
	if (result === "ok") {
		announce(`${label} integrity check passed`);
	} else if (result === "skipped") {
		logger.warn(
			`${label} integrity check skipped: ${error}; will retry next tick`,
		);
	} else {
		logger.error(`${label} integrity check FAILED: ${error}`);
		logger.error(
			"Database corruption detected. Check database integrity from the dashboard (Overview → Storage / Integrity) or review these server logs for details.",
		);
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
	const { result, error } = await runCheckLocked(dbOps, kind, "on-demand");
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
	void runCheckLocked(dbOps, "full", "on-demand");
	return { ok: true };
}
