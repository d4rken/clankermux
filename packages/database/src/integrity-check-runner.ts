import { statSync } from "node:fs";
import { EMBEDDED_INTEGRITY_CHECK_WORKER_CODE } from "./inline-integrity-check-worker";
import type { IntegrityCheckKind } from "./integrity-check-worker";

export type { IntegrityCheckKind } from "./integrity-check-worker";

/**
 * Floor of the hard cap on a worker run. The cap exists to defend against the
 * worker hanging forever on a failing disk / unresponsive NFS / etc, which
 * would otherwise leave the scheduler mutex permanently set and silently
 * disable integrity checking for the lifetime of the process.
 */
const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Per-GiB budget for a full check, about twice the measured rate: the live
 * 17 GiB database took 8m44s idle (~31 s/GiB) and overran 10 min under load.
 */
const FULL_CHECK_MS_PER_GIB = 60 * 1000;

/**
 * Worker cap for one check. A full check on 17 GiB gets 17 min; quick checks
 * and anything under 10 GiB keep the 10-minute floor.
 */
export function integrityWorkerTimeoutMs(
	kind: IntegrityCheckKind,
	dbBytes: number | null,
): number {
	if (kind !== "full" || dbBytes === null) return DEFAULT_WORKER_TIMEOUT_MS;
	return Math.max(
		DEFAULT_WORKER_TIMEOUT_MS,
		Math.ceil((dbBytes / 1024 ** 3) * FULL_CHECK_MS_PER_GIB),
	);
}

/**
 * Spawn the `integrity-check-worker` against a given DB file, return the
 * verdict. Mirrors `runVacuumInWorker` in `database-operations.ts` (inline
 * blob URL when the compiled worker is embedded, file URL when running
 * source-mode from a checkout).
 *
 * The worker opens its own `bun:sqlite` handle — required because
 * `bun:sqlite` is synchronous and even `PRAGMA quick_check` on a multi-GB
 * DB blocks the JS event loop for tens of seconds. We don't want the
 * proxy stalled during that window — at ~30 s of frozen event loop,
 * downstream sockets get reset by the OS and clients see "socket
 * connection was closed unexpectedly". Both `quick` and `full` route
 * through the worker.
 *
 * Race the worker promise against a timeout ({@link integrityWorkerTimeoutMs},
 * overridable per-call via the `timeoutMs` option). On timeout the
 * worker is terminated and the runner returns
 * `{ ok: false, verdict: "timeout", error: "worker timed out …" }` — callers
 * translate that to a `skipped` result (NOT corrupt: a timeout is an
 * operational failure, not proven corruption), which releases the scheduler
 * mutex and keeps the next tick eligible to run. Without this cap a stuck I/O
 * syscall in the worker would freeze integrity checking for the entire
 * process lifetime (potentially weeks between restarts).
 *
 * The `verdict` discriminates the three non-ok cases so callers can map a real
 * corruption verdict to `corrupt` while treating `error`/`timeout` as
 * `skipped`:
 *  - `"corrupt"` — a pragma ran and reported a problem (from the worker).
 *  - `"error"` — the worker caught an exception (DB open failure, etc.).
 *  - `"timeout"` — the worker did not respond within the cap (added here).
 */
export async function runIntegrityCheckInWorker(
	dbPath: string,
	options: {
		kind: IntegrityCheckKind;
		busyTimeoutMs?: number;
		timeoutMs?: number;
	},
): Promise<
	| { ok: true }
	| { ok: false; verdict: "corrupt" | "error" | "timeout"; error: string }
> {
	let worker: Worker;
	if (EMBEDDED_INTEGRITY_CHECK_WORKER_CODE) {
		const workerCode = Buffer.from(
			EMBEDDED_INTEGRITY_CHECK_WORKER_CODE,
			"base64",
		).toString("utf8");
		const blob = new Blob([workerCode], { type: "text/javascript" });
		worker = new Worker(URL.createObjectURL(blob), { smol: true });
	} else {
		worker = new Worker(
			new URL("./integrity-check-worker.ts", import.meta.url).href,
		);
	}

	const timeoutMs = resolveTimeoutMs(options.timeoutMs, options.kind, dbPath);
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	try {
		const result = await new Promise<
			| { ok: true }
			| { ok: false; verdict: "corrupt" | "error" | "timeout"; error: string }
		>((resolve, reject) => {
			worker.onmessage = (event: MessageEvent) => resolve(event.data);
			worker.onerror = (event: ErrorEvent) =>
				reject(new Error(event.message ?? "integrity worker error"));
			timeoutHandle = setTimeout(() => {
				// resolve (not reject) — we want this to look like any other
				// "non-ok" result so callers (recordIntegrityResult, the
				// on-demand endpoint) treat it uniformly and release the mutex.
				// verdict:"timeout" tells callers this is NOT proven corruption.
				resolve({
					ok: false,
					verdict: "timeout",
					error: `worker timed out after ${timeoutMs}ms — the check did not finish within its cap (slow scan under load, or a hung disk)`,
				});
			}, timeoutMs);
			worker.postMessage({
				dbPath,
				busyTimeoutMs: options.busyTimeoutMs ?? 10_000,
				kind: options.kind,
			});
		});
		return result;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		worker.terminate();
	}
}

function resolveTimeoutMs(
	override: number | undefined,
	kind: IntegrityCheckKind,
	dbPath: string,
): number {
	if (override !== undefined && Number.isInteger(override) && override > 0) {
		return override;
	}
	let dbBytes: number | null = null;
	try {
		dbBytes = statSync(dbPath).size;
	} catch {
		dbBytes = null;
	}
	return integrityWorkerTimeoutMs(kind, dbBytes);
}
