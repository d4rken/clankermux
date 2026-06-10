import { MemorySnapshotRepository } from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	MemoryHistoryPoint,
	MemoryHistoryResponse,
} from "@clankermux/types";
import type { APIContext } from "../types";
import { getRangeConfig } from "./range-config";

const log = new Logger("MemoryHistoryHandler");

const ALLOWED_RANGES = ["1h", "6h", "24h", "7d", "30d", "all"] as const;
type Range = (typeof ALLOWED_RANGES)[number];
const DEFAULT_RANGE: Range = "7d";

function normalizeRange(raw: string | null): Range {
	if (raw && (ALLOWED_RANGES as readonly string[]).includes(raw)) {
		return raw as Range;
	}
	return DEFAULT_RANGE;
}

/**
 * Data source the memory-history handler reads from. In production this is a
 * repository on the dashboard worker's read-only connection; tests supply a
 * plain mock so the range mapping/response shaping stays unit-testable
 * without a worker or a real database.
 */
export interface MemoryHistorySources {
	getMemorySnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<MemoryHistoryPoint[]>;
}

/**
 * Direct (in-process) /api/analytics/memory-history implementation for the
 * Overview-tab "Memory Usage" chart.
 *
 * Pure read path: runs against whatever connection the supplied context
 * exposes via `dbOps.getAdapter()`. In production this executes inside the
 * read-only dashboard worker (see analytics-runner.ts / analytics-worker.ts)
 * so the synchronous bun:sqlite queries never block the main event loop —
 * range=all scans the full memory_snapshots retention on one connection.
 */
export function createMemoryHistoryHandler(context: APIContext) {
	const memorySnapshots = new MemorySnapshotRepository(
		context.dbOps.getAdapter(),
	);
	return createMemoryHistoryHandlerFromSources({
		getMemorySnapshots: (opts) => memorySnapshots.getSnapshots(opts),
	});
}

/**
 * Map the requested range onto {sinceMs, bucketMs} and return the bucketed
 * (already MAX-per-bucket) points as a single global series.
 */
export function createMemoryHistoryHandlerFromSources(
	sources: MemoryHistorySources,
) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			// "all" scans from sinceMs 0 — full snapshot retention.
			const { bucketMs, windowMs } = getRangeConfig(range);
			const sinceMs = windowMs === null ? 0 : Date.now() - windowMs;

			const points = await sources.getMemorySnapshots({ sinceMs, bucketMs });

			const response: MemoryHistoryResponse = {
				range,
				bucketMs,
				points,
			};
			return jsonResponse(response);
		} catch (error) {
			log.error("Memory history error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch memory history data"),
			);
		}
	};
}
