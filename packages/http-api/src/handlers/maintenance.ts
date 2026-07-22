import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import type { CleanupResponse } from "../types";

export function createCleanupHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (): Promise<Response> => {
		const DAY_MS = 24 * 60 * 60 * 1000;
		const requestDays = config.getRequestRetentionDays();
		const requestMs = requestDays * DAY_MS;
		// When payload storage is disabled, delete all existing payloads (cutoff = now).
		// When enabled, honour the configured retention window.
		const payloadMs = config.getStorePayloads()
			? config.getDataRetentionDays() * DAY_MS
			: 0;
		// Thread the configured usage- and memory-snapshot windows through too.
		// The previous 2-arg call let cleanupOldRequests fall back to its 90d/14d
		// defaults, silently IGNORING a user-configured snapshot retention on a
		// manual "Clean up now". Pass them explicitly so the manual path matches
		// the hourly maintenance tick.
		// TODO: cleanupOldRequests()/the cleanup worker have no cache-keepalive
		// snapshot param, so "Clean up now" does not prune cache_keepalive_snapshots
		// (getCacheKeepaliveSnapshotRetentionDays); wiring that needs a new worker
		// cutoff + delete pass — out of scope here.
		const usageSnapshotMs = config.getUsageSnapshotRetentionDays() * DAY_MS;
		const memorySnapshotMs = config.getMemorySnapshotRetentionDays() * DAY_MS;
		const { removedRequests, removedPayloads } = await dbOps.cleanupOldRequests(
			payloadMs,
			requestMs,
			usageSnapshotMs,
			memorySnapshotMs,
		);
		const now = Date.now();
		const payload: CleanupResponse = {
			removedRequests,
			removedPayloads,
			// null signals "all payloads removed" (storage disabled); avoids
			// rendering a misleading "older than [right now]" timestamp in the UI.
			payloadCutoffIso: config.getStorePayloads()
				? new Date(now - payloadMs).toISOString()
				: null,
			requestCutoffIso: new Date(now - requestMs).toISOString(),
		};
		return jsonResponse(payload);
	};
}
