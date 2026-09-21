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

function resolveTimeoutMs(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKER_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs)) return DEFAULT_WORKER_TIMEOUT_MS;
	return Math.max(MIN_WORKER_TIMEOUT_MS, Math.trunc(timeoutMs));
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
 * Spawn `storage-usage-worker` against a DB file and return the per-table
 * measurement. Mirrors `runIntegrityCheckInWorker` (inline blob URL when the
 * compiled worker is embedded, file URL when running source-mode from a
 * checkout), including the timeout race: on timeout the worker is terminated
 * and an `ok: false` result is returned, which the caller reports as
 * `available: false` rather than blocking or throwing.
 */
export async function runStorageUsageScanInWorker(
	dbPath: string,
	options: {
		tables: StorageUsageScanRequest["tables"];
		busyTimeoutMs?: number;
		timeoutMs?: number;
	},
): Promise<StorageUsageScanResult> {
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
			worker = new Worker(blobUrl, { smol: true });
		} else {
			worker = new Worker(
				new URL("./storage-usage-worker.ts", import.meta.url).href,
			);
		}
	} catch (err) {
		// A synchronous spawn failure is an operational error like any other:
		// it must come back as `ok: false`, not escape the result contract.
		if (blobUrl !== undefined) URL.revokeObjectURL(blobUrl);
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	const timeoutMs = resolveTimeoutMs(options.timeoutMs);
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	try {
		const result = await new Promise<StorageUsageScanResult>(
			(resolve, reject) => {
				worker.onmessage = (event: MessageEvent) => resolve(event.data);
				worker.onerror = (event: ErrorEvent) =>
					reject(new Error(event.message ?? "storage-usage worker error"));
				// resolve (not reject) — a timeout is an operational failure the
				// caller maps to `available: false`, same as any other scan error.
				timeoutHandle = setTimeout(() => {
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
			if (problem) return { ok: false, error: problem };
		}
		return result;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		worker.terminate();
		if (blobUrl !== undefined) URL.revokeObjectURL(blobUrl);
	}
}
