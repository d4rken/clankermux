import { Database } from "bun:sqlite";
import { BunSqlAdapter } from "@clankermux/database";
import type { APIContext } from "../types";
import { createAnalyticsHandler } from "./analytics-direct";
import { createAnalyticsFilterOptionsHandler } from "./analytics-filter-options-direct";
import { createCacheEffectivenessHandler } from "./cache-effectiveness-direct";
import { createCacheKeepaliveHistoryHandler } from "./cache-keepalive-history-direct";
import { createMemoryHistoryHandler } from "./memory-history-direct";
import { createPaymentsSummaryDataHandler } from "./payments-summary-direct";
import { createQuotaDriftHandler } from "./quota-drift-direct";
import { createStatsHandler } from "./stats-direct";
import { createStopsHistoryHandler } from "./stops-history-direct";
import { createUsageHistoryHandler } from "./usage-history-direct";
import { createUsageScopedHistoryHandler } from "./usage-scoped-history-direct";

/**
 * Read-only dashboard worker: executes the synchronous bun:sqlite dashboard
 * queries (analytics + stats + usage/memory history + payments summary) off
 * the main thread. The `kind` discriminator selects which direct handler
 * runs; it defaults to "analytics" for backward compatibility.
 */
export type DashboardWorkerKind =
	| "analytics"
	| "stats"
	| "usage-history"
	| "usage-scoped-history"
	| "stops-history"
	| "memory-history"
	| "cache-keepalive-history"
	| "cache-effectiveness"
	| "payments-summary"
	| "filter-options"
	| "quota-drift";

export interface AnalyticsWorkerRequest {
	id: string;
	kind?: DashboardWorkerKind;
	dbPath: string;
	params: string;
	busyTimeoutMs: number;
}

export interface AnalyticsWorkerResponse {
	id: string;
	ok: boolean;
	status: number;
	body: string;
	error?: string;
	timings?: {
		totalMs: number;
	};
}

self.onmessage = async (event: MessageEvent<AnalyticsWorkerRequest>) => {
	const startedAt = performance.now();
	const { id, dbPath, params, busyTimeoutMs } = event.data;
	const kind: DashboardWorkerKind = event.data.kind ?? "analytics";
	let db: Database | undefined;

	try {
		db = new Database(dbPath, { readonly: true });
		db.exec(
			`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(Number(busyTimeoutMs) || 10000))}`,
		);
		db.exec("PRAGMA query_only = ON");

		const adapter = new BunSqlAdapter(db);
		const context = {
			db: adapter,
			config: {},
			dbOps: {
				getAdapter: () => adapter,
			},
		} as APIContext;

		// Table rather than a ternary chain: this was eleven nested arms, where
		// adding a kind meant re-indenting every one below it and the compiler
		// could not tell you that a kind had been missed. `satisfies Record<...>`
		// makes an unhandled kind a type error at the point it is added.
		const HANDLER_BY_KIND = {
			stats: createStatsHandler,
			"usage-history": createUsageHistoryHandler,
			"usage-scoped-history": createUsageScopedHistoryHandler,
			"stops-history": createStopsHistoryHandler,
			"memory-history": createMemoryHistoryHandler,
			"cache-keepalive-history": createCacheKeepaliveHistoryHandler,
			"cache-effectiveness": createCacheEffectivenessHandler,
			"payments-summary": createPaymentsSummaryDataHandler,
			"filter-options": createAnalyticsFilterOptionsHandler,
			"quota-drift": createQuotaDriftHandler,
			analytics: createAnalyticsHandler,
		} satisfies Record<
			DashboardWorkerKind,
			(context: APIContext) => (params: URLSearchParams) => Promise<Response>
		>;

		const handler = HANDLER_BY_KIND[kind](context);
		const response = await handler(new URLSearchParams(params));
		const body = await response.text();
		db.close();
		db = undefined;

		self.postMessage({
			id,
			ok: response.ok,
			status: response.status,
			body,
			timings: { totalMs: performance.now() - startedAt },
		} satisfies AnalyticsWorkerResponse);
	} catch (error) {
		db?.close();
		self.postMessage({
			id,
			ok: false,
			status: 500,
			body: JSON.stringify({ error: `Failed to fetch ${kind} data` }),
			error: error instanceof Error ? error.message : String(error),
			timings: { totalMs: performance.now() - startedAt },
		} satisfies AnalyticsWorkerResponse);
	}
};
