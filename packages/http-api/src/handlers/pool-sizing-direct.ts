import {
	computePoolSizing,
	POOL_SIZING_LOOKBACK_MS,
	type PoolSizingBurstTickRow,
	type PoolSizingPresenceRow,
	type PoolSizingResetPeakRow,
	type PoolSizingScopedPresenceRow,
	type PoolSizingScopedResetPeakRow,
	type PoolSizingStopRow,
} from "@clankermux/core";
import {
	AccountRepository,
	RequestRepository,
	UsageScopedSnapshotRepository,
	UsageSnapshotRepository,
} from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import { LIVENESS_RESERVE_HEADROOM_PCT } from "@clankermux/proxy";
import type { Account } from "@clankermux/types";
import {
	POOL_SIZING_REJECTED_ATTEMPT_LABELS,
	POOL_SIZING_SEPARATE_STOP_LABELS,
	POOL_SIZING_TERMINAL_STOP_LABELS,
} from "@clankermux/types";
import type { APIContext } from "../types";

const log = new Logger("PoolSizingHandler");

/** Every stop label the computation can place, in one predicate. */
const STOP_LABELS: readonly string[] = [
	...POOL_SIZING_TERMINAL_STOP_LABELS,
	...POOL_SIZING_REJECTED_ATTEMPT_LABELS,
	...POOL_SIZING_SEPARATE_STOP_LABELS,
];

/**
 * Data sources for the pool-sizing read. Same seam as the other analytics
 * handlers: repositories in production, plain mocks in the unit tests.
 */
export interface PoolSizingSources {
	getResetPeakRows(sinceMs: number): Promise<PoolSizingResetPeakRow[]>;
	getScopedResetPeakRows(
		sinceMs: number,
	): Promise<PoolSizingScopedResetPeakRow[]>;
	getDailyPresence(sinceMs: number): Promise<PoolSizingPresenceRow[]>;
	getScopedDailyPresence(
		sinceMs: number,
	): Promise<PoolSizingScopedPresenceRow[]>;
	getFiveHourSpentTicks(sinceMs: number): Promise<PoolSizingBurstTickRow[]>;
	getStopRows(
		sinceMs: number,
		labels: readonly string[],
	): Promise<PoolSizingStopRow[]>;
	getAllAccounts(): Promise<
		Array<Pick<Account, "id" | "name" | "provider" | "created_at">>
	>;
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?(): number;
}

export function createPoolSizingHandler(context: APIContext) {
	const adapter = context.dbOps.getAdapter();
	const snapshots = new UsageSnapshotRepository(adapter);
	const scoped = new UsageScopedSnapshotRepository(adapter);
	const requests = new RequestRepository(adapter);
	const accounts = new AccountRepository(adapter);
	return createPoolSizingHandlerFromSources({
		getResetPeakRows: (sinceMs) => snapshots.getResetPeakRows(sinceMs),
		getScopedResetPeakRows: (sinceMs) => scoped.getResetPeakRows(sinceMs),
		getDailyPresence: (sinceMs) => snapshots.getDailyPresence(sinceMs),
		getScopedDailyPresence: (sinceMs) => scoped.getDailyPresence(sinceMs),
		getFiveHourSpentTicks: (sinceMs) =>
			snapshots.getFiveHourSpentTicks(sinceMs),
		getStopRows: (sinceMs, labels) => requests.getStopRows(sinceMs, labels),
		getAllAccounts: () => accounts.findAll(),
	});
}

/**
 * Direct (in-process) `/api/analytics/pool-sizing` implementation: account-weeks
 * consumed per completed weekly cycle, per servable class and Anthropic scoped
 * family.
 *
 * Takes NO parameters. The lookback is a fixed 15 weeks and the unit is a
 * completed cycle, so a range picker could only either do nothing or silently
 * change which cycles a verdict rests on — the same reason the Quota tab's
 * other endpoint takes none.
 *
 * The reserve threshold is passed IN rather than re-derived here: the add
 * signal has to fire at exactly the headroom the routing gate actually holds
 * back, so both read one constant.
 */
export function createPoolSizingHandlerFromSources(
	sources: PoolSizingSources,
	reserveHeadroomPct: number = LIVENESS_RESERVE_HEADROOM_PCT,
) {
	return async (_params: URLSearchParams): Promise<Response> => {
		try {
			const now = sources.now?.() ?? Date.now();
			const sinceMs = now - POOL_SIZING_LOOKBACK_MS;

			const [
				resetPeaks,
				scopedResetPeaks,
				presence,
				scopedPresence,
				burstTicks,
				stops,
				accounts,
			] = await Promise.all([
				sources.getResetPeakRows(sinceMs),
				sources.getScopedResetPeakRows(sinceMs),
				sources.getDailyPresence(sinceMs),
				sources.getScopedDailyPresence(sinceMs),
				sources.getFiveHourSpentTicks(sinceMs),
				sources.getStopRows(sinceMs, STOP_LABELS),
				sources.getAllAccounts(),
			]);

			return jsonResponse(
				computePoolSizing({
					accounts: accounts.map((account) => ({
						id: account.id,
						name: account.name,
						provider: account.provider,
						createdAt: account.created_at,
					})),
					resetPeaks,
					scopedResetPeaks,
					presence,
					scopedPresence,
					burstTicks,
					stops,
					reserveHeadroomPct,
					now,
				}),
			);
		} catch (error) {
			log.error("Pool sizing error:", error);
			return errorResponse(
				InternalServerError("Failed to compute pool sizing"),
			);
		}
	};
}
