import { EMBEDDED_STORAGE_USAGE_WORKER_CODE } from "./inline-storage-usage-worker";
import type {
	StorageUsageScanRequest,
	StorageUsageScanResult,
	StorageUsageTableResult,
} from "./storage-usage-worker";

/**
 * Hard cap on one scan. The full pass over a multi-GB DB with a cold OS page
 * cache has been observed around two minutes; the cap defends against the
 * worker hanging forever on a failing disk, which would otherwise pin the
 * in-flight dedup promise in `getRetentionStorageUsage` and report the
 * Settings card as permanently unavailable.
 */
const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;

const MIN_WORKER_TIMEOUT_MS = 1000;

/**
 * How long a path whose last scan failed stays refused. A policy floor on how
 * often a failing disk may be re-scanned, not a measured recovery time.
 */
const DEFAULT_FAILURE_COOLDOWN_MS = 60 * 1000;

/**
 * How long a path stays refused after a scan whose worker was terminated
 * without ever reporting. Equal to the failure cooldown today and kept
 * separate because the two answer different questions: one paces retries after
 * a failure that ended cleanly, the other waits out a thread that may still be
 * reading.
 *
 * The window expires on its timer and the next call is then admitted even
 * though nothing confirmed the old worker stopped — `Worker.terminate()`
 * returns `void`, so elapsed time is the only evidence available. An overlap
 * costs I/O contention: the scan is a reader, and SQLite permits concurrent
 * readers.
 */
const DEFAULT_QUARANTINE_MS = 60 * 1000;

export type StorageUsageScanOptions = {
	tables: StorageUsageScanRequest["tables"];
	busyTimeoutMs?: number;
	timeoutMs?: number;
	/** Defaults to {@link DEFAULT_FAILURE_COOLDOWN_MS}. */
	failureCooldownMs?: number;
	/** Defaults to {@link DEFAULT_QUARANTINE_MS}. */
	quarantineMs?: number;
};

function resolveTimeoutMs(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKER_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs)) return DEFAULT_WORKER_TIMEOUT_MS;
	return Math.max(MIN_WORKER_TIMEOUT_MS, Math.trunc(timeoutMs));
}

function resolveWindowMs(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.trunc(value));
}

type StorageUsageWorkerFactory = (url: string) => Worker;

/**
 * Test-only replacement for worker construction, consulted by every spawn.
 * Production never sets it; `null` means "construct a real worker".
 */
let workerFactoryForTests: StorageUsageWorkerFactory | null = null;

/** Test-only. See {@link workerFactoryForTests}. */
export function setStorageUsageWorkerFactoryForTests(
	factory: StorageUsageWorkerFactory | null,
): void {
	workerFactoryForTests = factory;
}

/** Test-only. Drops every path's slots and refusal windows. */
export function resetStorageUsageAdmissionStateForTests(): void {
	admissionByPath.clear();
}

function constructWorker(url: string, options?: WorkerOptions): Worker {
	if (workerFactoryForTests) return workerFactoryForTests(url);
	return new Worker(url, options);
}

type ScanSlot = { promise: Promise<StorageUsageScanResult> };

type PathAdmission = {
	/** The scan that owns the path; a successor waits on its promise. */
	active: ScanSlot | null;
	/** At most one waiting successor, shared by every caller behind it. */
	queued: ScanSlot | null;
	/** Epoch ms deadlines; `0` means no window is open. */
	cooldownUntil: number;
	quarantineUntil: number;
};

/**
 * Admission state, keyed on the `dbPath` string exactly as the caller passed
 * it — no canonicalization, so two spellings of one file would get two
 * independent entries. Production has a single producer passing one stable
 * string.
 */
const admissionByPath = new Map<string, PathAdmission>();

function admissionFor(dbPath: string): PathAdmission {
	const existing = admissionByPath.get(dbPath);
	if (existing) return existing;
	const created: PathAdmission = {
		active: null,
		queued: null,
		cooldownUntil: 0,
		quarantineUntil: 0,
	};
	admissionByPath.set(dbPath, created);
	return created;
}

function forgetIfIdle(dbPath: string, admission: PathAdmission): void {
	if (admission.active || admission.queued) return;
	const now = Date.now();
	if (admission.cooldownUntil > now || admission.quarantineUntil > now) return;
	admissionByPath.delete(dbPath);
}

/**
 * The refusal this path currently owes, or `null` when a scan may spawn.
 *
 * Called where the worker would be constructed rather than where the caller
 * arrived, so a successor that waited out its predecessor is judged against
 * the windows that predecessor just opened.
 */
function currentRefusal(
	admission: PathAdmission,
): StorageUsageScanResult | null {
	const now = Date.now();
	if (admission.quarantineUntil > now) {
		return {
			ok: false,
			error: `scan refused: the previous worker was terminated without reporting and may still be reading — quarantine ends in ${admission.quarantineUntil - now}ms`,
		};
	}
	if (admission.cooldownUntil > now) {
		return {
			ok: false,
			error: `scan refused: the previous scan failed — cooldown ends in ${admission.cooldownUntil - now}ms`,
		};
	}
	return null;
}

function recordOutcome(
	admission: PathAdmission,
	attempt: ScanAttempt,
	options: StorageUsageScanOptions,
): void {
	if (attempt.result.ok) {
		admission.cooldownUntil = 0;
		admission.quarantineUntil = 0;
		return;
	}
	const now = Date.now();
	admission.cooldownUntil =
		now +
		resolveWindowMs(options.failureCooldownMs, DEFAULT_FAILURE_COOLDOWN_MS);
	if (attempt.unconfirmedStop) {
		admission.quarantineUntil =
			now + resolveWindowMs(options.quarantineMs, DEFAULT_QUARANTINE_MS);
	}
}

/**
 * Hand the path on: the queued successor becomes the active scan and the queue
 * empties, so a caller arriving from here on queues a fresh successor instead
 * of joining a scan that is already running.
 */
function releaseSlot(
	dbPath: string,
	admission: PathAdmission,
	slot: ScanSlot,
): void {
	if (admission.active !== slot) return;
	admission.active = admission.queued;
	admission.queued = null;
	forgetIfIdle(dbPath, admission);
}

async function admitAndScan(
	dbPath: string,
	admission: PathAdmission,
	slot: ScanSlot,
	predecessor: Promise<StorageUsageScanResult> | null,
	options: StorageUsageScanOptions,
): Promise<StorageUsageScanResult> {
	try {
		if (predecessor) await predecessor.catch(() => undefined);
		const refusal = currentRefusal(admission);
		// Returned as-is: a refusal neither opens nor extends a window, or a
		// stream of refused callers would push the deadline out for ever.
		if (refusal) return refusal;
		const attempt = await spawnScan(dbPath, options);
		recordOutcome(admission, attempt, options);
		return attempt.result;
	} finally {
		releaseSlot(dbPath, admission, slot);
	}
}

/**
 * Check a worker result against the tables that were asked for, returning a
 * reason string when it cannot be trusted and `null` when it can.
 *
 * The runner is the boundary the caller's `available` flag is derived at, and
 * the failure mode being guarded is a result that LOOKS measured: a missing
 * entry, a mismatched one, or a non-numeric total all become zeros by the time
 * they reach the card, where a zero is rendered as a real size. A genuinely
 * empty table measuring zero rows and zero bytes is a valid result and passes.
 */
export function validateScanTables(
	requested: StorageUsageScanRequest["tables"],
	measured: readonly StorageUsageTableResult[],
): string | null {
	if (measured.length !== requested.length) {
		return `scan measured ${measured.length} of ${requested.length} tables`;
	}
	const seen = new Set<string>();
	for (const [index, want] of requested.entries()) {
		const got = measured[index];
		if (got.key !== want.key || got.table !== want.table) {
			return `scan entry ${index} is ${got.key}/${got.table}, expected ${want.key}/${want.table}`;
		}
		if (seen.has(got.table)) return `table "${got.table}" measured twice`;
		seen.add(got.table);
		for (const [field, value] of [
			["rowCount", got.rowCount],
			["approxBytes", got.approxBytes],
		] as const) {
			if (!Number.isFinite(value) || value < 0) {
				return `table "${got.table}" reported ${field} = ${value}`;
			}
		}
	}
	return null;
}

/**
 * Measure per-table storage usage for one database file, under per-path
 * admission control.
 *
 * A scan is a full pass over a possibly multi-GB file, so at most one runs per
 * path. A caller arriving while one is active waits for it and then runs a
 * fresh scan of its own — it must not adopt the predecessor's numbers, which
 * are the pre-invalidation snapshot it asked to replace. Only one such
 * successor is queued; later callers share that one's result.
 *
 * A failed scan opens a cooldown on the path and a scan whose worker had to be
 * terminated opens a quarantine; calls inside either window return `ok: false`
 * naming it and construct nothing.
 */
export function runStorageUsageScanInWorker(
	dbPath: string,
	options: StorageUsageScanOptions,
): Promise<StorageUsageScanResult> {
	const admission = admissionFor(dbPath);
	if (admission.queued) return admission.queued.promise;
	const predecessor = admission.active?.promise ?? null;
	const { promise, resolve } = Promise.withResolvers<StorageUsageScanResult>();
	const slot: ScanSlot = { promise };
	// Published before the scan starts: `admitAndScan` can reach its own
	// `finally` synchronously (a refusal with nothing to wait for), and that
	// hand-off has to find this slot already in place.
	if (predecessor) admission.queued = slot;
	else admission.active = slot;
	void admitAndScan(dbPath, admission, slot, predecessor, options).then(
		resolve,
		(err) =>
			resolve({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}),
	);
	return promise;
}

type ScanAttempt = {
	result: StorageUsageScanResult;
	/**
	 * The worker was terminated while it may still have been scanning: it never
	 * reported, and `Worker.terminate()` gives no completion signal.
	 */
	unconfirmedStop: boolean;
};

/**
 * Spawn `storage-usage-worker` against a DB file and return the per-table
 * measurement. Mirrors `runIntegrityCheckInWorker` (inline blob URL when the
 * compiled worker is embedded, file URL when running source-mode from a
 * checkout), including the timeout race: on timeout the worker is terminated
 * and an `ok: false` result is returned, which the caller reports as
 * `available: false` rather than blocking or throwing.
 */
async function spawnScan(
	dbPath: string,
	options: StorageUsageScanOptions,
): Promise<ScanAttempt> {
	let worker: Worker;
	let blobUrl: string | undefined;
	try {
		if (EMBEDDED_STORAGE_USAGE_WORKER_CODE) {
			const workerCode = Buffer.from(
				EMBEDDED_STORAGE_USAGE_WORKER_CODE,
				"base64",
			).toString("utf8");
			const blob = new Blob([workerCode], { type: "text/javascript" });
			// Revoked in the finally below, AFTER terminate — never synchronously
			// after `new Worker(url)`, which races the worker thread's own load
			// of the URL (see payload-write-client's transport for the details).
			// Without the revoke, one URL + blob would leak per scan for the
			// process lifetime.
			blobUrl = URL.createObjectURL(blob);
			worker = constructWorker(blobUrl, { smol: true });
		} else {
			worker = constructWorker(
				new URL("./storage-usage-worker.ts", import.meta.url).href,
			);
		}
	} catch (err) {
		// A synchronous spawn failure is an operational error like any other:
		// it must come back as `ok: false`, not escape the result contract.
		if (blobUrl !== undefined) URL.revokeObjectURL(blobUrl);
		return {
			result: {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			},
			unconfirmedStop: false,
		};
	}

	const timeoutMs = resolveTimeoutMs(options.timeoutMs);
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let unconfirmedStop = false;

	try {
		const result = await new Promise<StorageUsageScanResult>(
			(resolve, reject) => {
				worker.onmessage = (event: MessageEvent) => resolve(event.data);
				worker.onerror = (event: ErrorEvent) => {
					unconfirmedStop = true;
					reject(new Error(event.message ?? "storage-usage worker error"));
				};
				// resolve (not reject) — a timeout is an operational failure the
				// caller maps to `available: false`, same as any other scan error.
				timeoutHandle = setTimeout(() => {
					unconfirmedStop = true;
					resolve({
						ok: false,
						error: `worker timed out after ${timeoutMs}ms — bun:sqlite call likely hung on disk I/O; check filesystem health`,
					});
				}, timeoutMs);
				worker.postMessage({
					dbPath,
					busyTimeoutMs: options.busyTimeoutMs ?? 10000,
					tables: options.tables,
				} satisfies StorageUsageScanRequest);
			},
		).catch(
			(err): StorageUsageScanResult => ({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
		if (result.ok) {
			const problem = validateScanTables(options.tables, result.types);
			if (problem) {
				return { result: { ok: false, error: problem }, unconfirmedStop };
			}
		}
		return { result, unconfirmedStop };
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		worker.terminate();
		if (blobUrl !== undefined) URL.revokeObjectURL(blobUrl);
	}
}
