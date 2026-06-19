import {
	CacheKeepaliveSnapshotRepository,
	type CacheKeepaliveWindowTotals,
	UsageSnapshotRepository,
} from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type { CacheEffectivenessResponse } from "@clankermux/types";
import type { APIContext } from "../types";
import { getRangeConfig } from "./range-config";

export type { CacheEffectivenessResponse } from "@clankermux/types";

const log = new Logger("CacheEffectivenessHandler");

const ALLOWED_RANGES = ["1h", "6h", "24h", "7d", "30d", "all"] as const;
type Range = (typeof ALLOWED_RANGES)[number];
const DEFAULT_RANGE: Range = "7d";

function normalizeRange(raw: string | null): Range {
	if (raw && (ALLOWED_RANGES as readonly string[]).includes(raw)) {
		return raw as Range;
	}
	return DEFAULT_RANGE;
}

/** Per-account quota peak over the window (true MAX, from SQL). */
export interface AccountUsagePeak {
	accountId: string;
	peakFiveHourPct: number;
	peakSevenDayPct: number;
}

/** Aggregate token/request volume of REAL work in the window (keepalive replays
 * are excluded from the requests table, so they don't inflate this). */
export interface WorkTotals {
	totalRequests: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}

/**
 * Data the effectiveness report reads through. In production these are repos on
 * the dashboard worker's read-only connection; tests supply plain mocks so the
 * join/normalization math stays unit-testable without a worker or real DB.
 */
export interface CacheEffectivenessSources {
	/** Summed bridge counter activity over the window (window TOTAL, reset-safe). */
	getBridgeTotals(sinceMs: number): Promise<CacheKeepaliveWindowTotals>;
	/** Per-account peak (MAX) 5h/7d utilization over the window. */
	getUsagePeaks(sinceMs: number): Promise<AccountUsagePeak[]>;
	/** Real-work request/token volume over the window. */
	getWorkTotals(sinceMs: number): Promise<WorkTotals>;
	/** id → name for labelling the per-account peaks. */
	getAllAccounts(): Promise<Array<{ id: string; name: string }>>;
}

/**
 * Pure report assembler: join the bridge ledger totals, per-account quota peaks,
 * and real work volume over the window into the effectiveness summary. The
 * headline net is the CONSERVATIVE (5m-counterfactual) figure.
 */
export function buildCacheEffectiveness(
	range: string,
	sinceMs: number,
	bridge: CacheKeepaliveWindowTotals,
	peaks: AccountUsagePeak[],
	work: WorkTotals,
	accounts: Array<{ id: string; name: string }>,
): CacheEffectivenessResponse {
	const decided = bridge.hits + bridge.misses;

	const nameById = new Map(accounts.map((a) => [a.id, a.name]));
	const accountPeaks = peaks
		.map((p) => ({
			accountId: p.accountId,
			name: nameById.get(p.accountId) ?? p.accountId,
			peakFiveHourPct: p.peakFiveHourPct,
			peakSevenDayPct: p.peakSevenDayPct,
		}))
		.sort((a, b) => b.peakSevenDayPct - a.peakSevenDayPct);

	const poolPeakFiveHourPct = accountPeaks.reduce(
		(m, a) => Math.max(m, a.peakFiveHourPct),
		0,
	);
	const poolPeakSevenDayPct = accountPeaks.reduce(
		(m, a) => Math.max(m, a.peakSevenDayPct),
		0,
	);

	const totalPromptTokens =
		work.inputTokens + work.cacheReadTokens + work.cacheCreationTokens;
	const sevenDayPeakPer1MTokens =
		totalPromptTokens > 0
			? poolPeakSevenDayPct / (totalPromptTokens / 1_000_000)
			: 0;

	return {
		range,
		sinceMs,
		keepalivesSent: bridge.keepalivesSent,
		hits: bridge.hits,
		misses: bridge.misses,
		hitRate: decided > 0 ? bridge.hits / decided : 0,
		warmResumes: bridge.warmResumes,
		spentUsd: bridge.spentUsd,
		savedUsd: bridge.savedUsd,
		savedUsdConservative: bridge.savedUsd5m,
		netUsd: bridge.savedUsd - bridge.spentUsd,
		netUsdConservative: bridge.savedUsd5m - bridge.spentUsd,
		totalRequests: work.totalRequests,
		inputTokens: work.inputTokens,
		cacheReadTokens: work.cacheReadTokens,
		cacheCreationTokens: work.cacheCreationTokens,
		totalPromptTokens,
		accounts: accountPeaks,
		poolPeakFiveHourPct,
		poolPeakSevenDayPct,
		sevenDayPeakPer1MTokens,
	};
}

/**
 * Direct (in-process) /api/analytics/cache-effectiveness implementation. Runs
 * inside the read-only dashboard worker (see analytics-runner / analytics-worker)
 * so the multi-table read never blocks the main event loop.
 */
export function createCacheEffectivenessHandler(context: APIContext) {
	const adapter = context.dbOps.getAdapter();
	const bridge = new CacheKeepaliveSnapshotRepository(adapter);
	const usage = new UsageSnapshotRepository(adapter);
	return createCacheEffectivenessHandlerFromSources({
		getBridgeTotals: (sinceMs) => bridge.getWindowCounterTotals(sinceMs),
		getUsagePeaks: (sinceMs) => usage.getPeaksSince(sinceMs),
		getWorkTotals: async (sinceMs) => {
			const r = await adapter.get<{
				total_requests: number;
				input_tokens: number;
				cache_read_tokens: number;
				cache_creation_tokens: number;
			}>(
				`SELECT COUNT(*) AS total_requests,
				        COALESCE(SUM(input_tokens), 0) AS input_tokens,
				        COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
				        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens
				 FROM requests
				 WHERE timestamp >= ?`,
				[sinceMs],
			);
			return {
				totalRequests: Number(r?.total_requests ?? 0),
				inputTokens: Number(r?.input_tokens ?? 0),
				cacheReadTokens: Number(r?.cache_read_tokens ?? 0),
				cacheCreationTokens: Number(r?.cache_creation_tokens ?? 0),
			};
		},
		// Narrow id/name read — the report never needs account credentials.
		getAllAccounts: async () => {
			const rows = await adapter.query<{ id: string; name: string }>(
				`SELECT id, name FROM accounts`,
			);
			return rows.map((a) => ({ id: a.id, name: a.name }));
		},
	});
}

export function createCacheEffectivenessHandlerFromSources(
	sources: CacheEffectivenessSources,
) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			const { windowMs } = getRangeConfig(range);
			const sinceMs = windowMs === null ? 0 : Date.now() - windowMs;

			const [bridge, peaks, work, accounts] = await Promise.all([
				sources.getBridgeTotals(sinceMs),
				sources.getUsagePeaks(sinceMs),
				sources.getWorkTotals(sinceMs),
				sources.getAllAccounts(),
			]);

			return jsonResponse(
				buildCacheEffectiveness(range, sinceMs, bridge, peaks, work, accounts),
			);
		} catch (error) {
			log.error("Cache effectiveness error:", error);
			return errorResponse(
				InternalServerError("Failed to compute cache effectiveness report"),
			);
		}
	};
}
