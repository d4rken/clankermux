import {
	type CacheKeepaliveHistoryPoint,
	CacheKeepaliveSnapshotRepository,
} from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	CacheKeepaliveHistoryPointDelta,
	CacheKeepaliveHistoryResponse,
} from "@clankermux/types";
import type { APIContext } from "../types";

// Wire shapes live in @clankermux/types so the dashboard can import them; re-export
// here for callers/tests that already import from this handler module.
export type {
	CacheKeepaliveHistoryPointDelta,
	CacheKeepaliveHistoryResponse,
} from "@clankermux/types";

import { getRangeConfig } from "./range-config";

const log = new Logger("CacheKeepaliveHistoryHandler");

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
 * Data source the cache-keepalive-history handler reads through. In production
 * this is a repository on the dashboard worker's read-only connection; tests
 * supply a plain mock so the delta/reset shaping stays unit-testable without a
 * worker or a real database.
 */
export interface CacheKeepaliveHistorySources {
	getSnapshots(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<CacheKeepaliveHistoryPoint[]>;
}

/**
 * Convert the repository's cumulative-counter buckets into per-bucket deltas,
 * clamping counter resets (process restart drops a counter to a smaller value):
 *
 *   delta = cur >= prev ? cur - prev : cur
 *
 * The FIRST bucket's counter delta is 0 (not its own absolute value): the
 * cumulative total at the first in-window bucket reflects activity that
 * accrued before the window opened, so emitting it as a delta would spike the
 * first point with a pre-window baseline. Reporting 0 keeps the first bucket
 * honest about "activity during this bucket". GAUGE fields are passed through
 * as-is. `hitRate` is hitsDelta / (hitsDelta + missesDelta), 0 when the
 * denominator is 0.
 */
function toDeltaPoints(
	rows: CacheKeepaliveHistoryPoint[],
): CacheKeepaliveHistoryPointDelta[] {
	const points: CacheKeepaliveHistoryPointDelta[] = [];
	for (let i = 0; i < rows.length; i++) {
		const cur = rows[i];
		const prev = i > 0 ? rows[i - 1] : null;
		const delta = (curVal: number, prevVal: number | undefined): number => {
			if (prev === null || prevVal === undefined) return 0;
			return curVal >= prevVal ? curVal - prevVal : curVal;
		};
		const hits = delta(cur.hits, prev?.hits);
		const misses = delta(cur.misses, prev?.misses);
		const decided = hits + misses;
		points.push({
			ts: cur.ts,
			warmSessions: cur.warmSessions,
			promotedSessions: cur.promotedSessions,
			totalBytes: cur.totalBytes,
			keepalivesSent: delta(cur.keepalivesSent, prev?.keepalivesSent),
			hits,
			misses,
			failures: delta(cur.failures, prev?.failures),
			spentUsd: delta(cur.spentUsd, prev?.spentUsd),
			savedUsd: delta(cur.savedUsd, prev?.savedUsd),
			hitRate: decided > 0 ? hits / decided : 0,
		});
	}
	return points;
}

/**
 * Direct (in-process) /api/analytics/cache-keepalive-history implementation for
 * the cache-keepalive analytics panel.
 *
 * Pure read path: runs against whatever connection the supplied context exposes
 * via `dbOps.getAdapter()`. In production this executes inside the read-only
 * dashboard worker (see analytics-runner.ts / analytics-worker.ts) so the
 * synchronous bun:sqlite bucketed scan never blocks the main event loop.
 */
export function createCacheKeepaliveHistoryHandler(context: APIContext) {
	const repo = new CacheKeepaliveSnapshotRepository(context.dbOps.getAdapter());
	return createCacheKeepaliveHistoryHandlerFromSources({
		getSnapshots: (opts) => repo.getSnapshots(opts),
	});
}

/**
 * Map the requested range onto {sinceMs, bucketMs}, fetch the bucketed
 * cumulative rows, and return per-bucket deltas (counters) + pass-through
 * gauges as a single global series.
 */
export function createCacheKeepaliveHistoryHandlerFromSources(
	sources: CacheKeepaliveHistorySources,
) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			// "all" scans from sinceMs 0 — full snapshot retention.
			const { bucketMs, windowMs } = getRangeConfig(range);
			const sinceMs = windowMs === null ? 0 : Date.now() - windowMs;

			const rows = await sources.getSnapshots({ sinceMs, bucketMs });

			const response: CacheKeepaliveHistoryResponse = {
				range,
				bucketMs,
				points: toDeltaPoints(rows),
			};
			return jsonResponse(response);
		} catch (error) {
			log.error("Cache keepalive history error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch cache keepalive history data"),
			);
		}
	};
}
