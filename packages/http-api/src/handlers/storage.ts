import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import {
	runIntegrityCheckOnDemand,
	startFullIntegrityCheckBackground,
} from "@clankermux/proxy";
import type { StorageUsageResponse } from "../types";

export function createStorageHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const metrics = await dbOps.getStorageMetrics();
		const integrity = dbOps.getIntegrityStatus();

		const response = {
			db_bytes: metrics.dbBytes,
			wal_bytes: metrics.walBytes,
			integrity_status: integrity.status,
			integrity_running_kind: integrity.runningKind,
			last_integrity_check_at: integrity.lastCheckAt
				? new Date(integrity.lastCheckAt).toISOString()
				: null,
			last_integrity_error: integrity.lastError,
			last_quick_check_at: integrity.lastQuickCheckAt
				? new Date(integrity.lastQuickCheckAt).toISOString()
				: null,
			last_quick_result: integrity.lastQuickResult,
			last_full_check_at: integrity.lastFullCheckAt
				? new Date(integrity.lastFullCheckAt).toISOString()
				: null,
			last_full_result: integrity.lastFullResult,
			orphan_pages: metrics.orphanPages,
			last_retention_sweep_at: metrics.lastRetentionSweepAt
				? new Date(metrics.lastRetentionSweepAt).toISOString()
				: null,
			null_account_rows_24h: metrics.nullAccountRows,
		};

		return jsonResponse(response);
	};
}

/**
 * `GET /api/storage/usage` — per-data-type storage breakdown for the retention
 * settings card (payloads / requests / usage snapshots), plus the whole-file
 * and WAL sizes.
 *
 * Kept off the frequently-polled `/api/storage` endpoint because the byte sums
 * require full-table scans; the DB layer caches the measurement for a few
 * minutes (`getRetentionStorageUsage`), so repeated Settings opens are cheap.
 * Sits behind the same `/api/*` API-key auth as the other storage routes.
 */
export function createStorageUsageHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const usage = await dbOps.getRetentionStorageUsage();
		const response: StorageUsageResponse = {
			available: usage.available,
			measuredAt: new Date(usage.measuredAt).toISOString(),
			dbBytes: usage.dbBytes,
			walBytes: usage.walBytes,
			types: usage.types,
		};
		return jsonResponse(response);
	};
}

/**
 * On-demand integrity check trigger. Body: `{ kind: "quick" | "full" }`.
 *
 *  - **quick** runs synchronously and returns 200 with `{kind, result, error}`.
 *    A `quick_check` is fast enough (sub-second on most DBs, a few seconds
 *    on multi-GB ones) that holding the HTTP connection open is fine.
 *
 *  - **full** kicks off the integrity-check worker in the background and
 *    returns 202 with `{kind: "full", queued: true}` immediately. The
 *    full check (`integrity_check` + `foreign_key_check`) takes tens of
 *    seconds and could hit the worker timeout (10 min by default), which
 *    would exceed common reverse-proxy `proxy_read_timeout` values
 *    (nginx 60s, AWS ALB 60s, Caddy 5 min) — the proxy would drop the
 *    connection and the dashboard would surface a false-negative
 *    "Could not trigger check" even though the check is succeeding.
 *    Clients poll `/api/storage` (`runningKind === "full"` while
 *    in-flight, then `last_full_check_at` / `last_full_result` once
 *    complete) to discover the outcome.
 *
 * Both kinds return 409 if another probe is already in flight.
 *
 * Sits behind the existing `/api/*` API-key auth middleware. The
 * scheduler-tracked status visible at `/api/storage` and `/health` reflects
 * the result identically whether triggered by the scheduler or this route.
 */
export function createIntegrityCheckHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		let body: { kind?: unknown } = {};
		try {
			body = (await req.json()) as { kind?: unknown };
		} catch {
			// Empty body / non-JSON is fine — default below
		}
		const kind = body.kind === "full" ? "full" : "quick";

		if (kind === "full") {
			const started = startFullIntegrityCheckBackground(dbOps);
			if (!started.ok) {
				return jsonResponse(
					{
						error: "integrity check already running",
						reason: started.reason,
					},
					409,
				);
			}
			return jsonResponse({ kind: "full", queued: true }, 202);
		}

		const outcome = await runIntegrityCheckOnDemand(dbOps, "quick");
		if (!outcome.ok) {
			return jsonResponse(
				{
					error: "integrity check already running",
					reason: outcome.reason,
				},
				409,
			);
		}

		return jsonResponse({
			kind: "quick",
			result: outcome.result,
			error: outcome.error,
		});
	};
}
