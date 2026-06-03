import type { DatabaseOperations } from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type { MemoryHistoryResponse } from "@clankermux/types";

const log = new Logger("MemoryHistoryHandler");

const ALLOWED_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
type Range = (typeof ALLOWED_RANGES)[number];
const DEFAULT_RANGE: Range = "7d";

/**
 * Map a range to its lookback window + bucket size. Mirrors getRangeConfig in
 * usage-history.ts so the memory chart bucketing matches the other time-series
 * charts: 1h→1m, 6h→5m, 24h/7d→1h, 30d→1d.
 */
function getRangeConfig(range: Range): { sinceMs: number; bucketMs: number } {
	const now = Date.now();
	const hour = 60 * 60 * 1000;
	const day = 24 * hour;

	switch (range) {
		case "1h":
			return { sinceMs: now - hour, bucketMs: 60 * 1000 };
		case "6h":
			return { sinceMs: now - 6 * hour, bucketMs: 5 * 60 * 1000 };
		case "24h":
			return { sinceMs: now - day, bucketMs: hour };
		case "7d":
			return { sinceMs: now - 7 * day, bucketMs: hour };
		case "30d":
			return { sinceMs: now - 30 * day, bucketMs: day };
	}
}

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
			const { sinceMs, bucketMs } = getRangeConfig(range);

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
