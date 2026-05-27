import { Database } from "bun:sqlite";
import { BunSqlAdapter } from "@clankermux/database";
import type { APIContext } from "@clankermux/types";
import { createAnalyticsHandler } from "./analytics-direct";

export interface AnalyticsWorkerRequest {
	id: string;
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

		const response = await createAnalyticsHandler(context)(
			new URLSearchParams(params),
		);
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
			body: JSON.stringify({ error: "Failed to fetch analytics data" }),
			error: error instanceof Error ? error.message : String(error),
			timings: { totalMs: performance.now() - startedAt },
		} satisfies AnalyticsWorkerResponse);
	}
};
