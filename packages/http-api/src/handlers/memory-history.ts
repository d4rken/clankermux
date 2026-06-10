import type { DatabaseOperations } from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type { MemoryHistoryResponse } from "@clankermux/types";
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
 * Direct (non-worker) handler for the Overview-tab "Memory Usage" chart. Reads
 * the small memory_snapshots table via dbOps.getMemorySnapshots (already
 * bucketed MAX-per-bucket) and returns it as a single global series. The table
 * is tiny (one row per sample tick), so this stays off the heavy analytics
 * worker like the usage-history handler.
 */
export function createMemoryHistoryHandler(dbOps: DatabaseOperations) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			// "all" scans from sinceMs 0 — the memory_snapshots table is small and
			// retention-capped, so an unbounded lookback stays cheap.
			const { bucketMs, windowMs } = getRangeConfig(range);
			const sinceMs = windowMs === null ? 0 : Date.now() - windowMs;

			const points = await dbOps.getMemorySnapshots({ sinceMs, bucketMs });

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
