/**
 * Analytics count requests with an outcome. A pre-head client abort (success
 * NULL, 499, `client_closed_request`) has none, so adding one to the fixture
 * must leave every section of the response exactly as it was, however much
 * of the row the section reads (account, key, project, routing, fallback
 * credit). And a range holding nothing but aborts reads as empty.
 */
import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import { CLIENT_CLOSED_REQUEST } from "@clankermux/types";
import type { AnalyticsResponse, APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";
import {
	ACCOUNT_A,
	API_KEY_LIVE,
	FIXED_NOW,
	PROJECT_ALPHA,
	seedAnalyticsFixture,
} from "./analytics-section-fixture";

const HOUR = 60 * 60 * 1000;

let db: Database;
let context: APIContext;

beforeEach(() => {
	setSystemTime(new Date(FIXED_NOW));
	db = new Database(":memory:");
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	context = {
		db: adapter,
		config: {},
		dbOps: { getAdapter: () => adapter },
	} as unknown as APIContext;
});

afterEach(() => {
	db.close();
	setSystemTime();
});

/**
 * An abort row as the recorder writes it: the ingress facts (account, key,
 * project, requested model, a claimed fallback credit, routing) and none of
 * the response ones. No usage means no model, tokens or cost, and no context
 * or tool-call rows are written for it; request-recorder.test.ts and
 * pre-head-client-abort.test.ts pin that shape. Several analytics reads rely
 * on it instead of reading `success`.
 */
function insertClientClosed(id: string, timestamp: number): void {
	db.run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			error_message, response_time_ms, failover_attempts, model,
			requested_model, api_key_id, api_key_name, project,
			project_attribution_source, billing_type, client_harness,
			fallback_credit_claimed, fallback_from_model, usage_source
		) VALUES (?, ?, 'POST', '/v1/messages', ?, 499, NULL, ?, 90000, 1,
			NULL, 'claude-opus-4-8', ?, 'live-key', ?, 'header', 'plan', 'pi',
			1, 'claude-opus-4-8', 'none')`,
		[
			id,
			timestamp,
			ACCOUNT_A,
			CLIENT_CLOSED_REQUEST,
			API_KEY_LIVE,
			PROJECT_ALPHA,
		],
	);
	db.run(
		`INSERT INTO request_routing (
			request_id, strategy, decision, affinity_scope, affinity_key_hash,
			selected_account_id, previous_account_id, candidates_count,
			failover_attempts, failover_reason, created_at
		) VALUES (?, 'session', 'affinity_hit', 'client_session', 'hash-abort', ?, NULL, 2, 1, NULL, ?)`,
		[id, ACCOUNT_A, timestamp],
	);
}

async function fetchAnalytics(query: string): Promise<AnalyticsResponse> {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams(query),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as AnalyticsResponse & {
		meta: Record<string, unknown>;
	};
	// Phase timings are wall-clock measurements, never part of the answer.
	const { timings: _timings, ...meta } = body.meta;
	return { ...body, meta } as AnalyticsResponse;
}

describe("analytics leave out requests without an outcome", () => {
	it.each([
		"range=all",
		"range=24h",
		`range=7d&accounts=${ACCOUNT_A}`,
		`range=7d&projects=${PROJECT_ALPHA}`,
	])("returns the same response with an abort added (%s)", async (query) => {
		seedAnalyticsFixture(db);
		const before = await fetchAnalytics(query);
		insertClientClosed("abort-1", FIXED_NOW - 2 * HOUR);
		insertClientClosed("abort-2", FIXED_NOW - 30 * HOUR);
		const after = await fetchAnalytics(query);
		expect(after).toEqual(before);
	});

	it("reads an abort-only range as empty", async () => {
		insertClientClosed("abort-1", FIXED_NOW - 2 * HOUR);
		const body = await fetchAnalytics("range=24h");
		expect(body.totals?.requests).toBe(0);
		expect(body.totals?.activeAccounts).toBe(0);
		expect(body.timeSeries).toEqual([]);
		expect(body.modelDistribution).toEqual([]);
		expect(body.accountPerformance).toEqual([]);
		expect(body.apiKeyPerformance).toEqual([]);
		expect(body.projectBreakdown).toEqual([]);
		expect(body.accountModelUsage).toEqual([]);
		expect(body.apiKeyModelUsage).toEqual([]);
		expect(body.costByModel).toEqual([]);
		expect(body.modelPerformance).toEqual([]);
		expect(body.cacheFlow).toEqual([]);
		expect(body.activeSessions?.totalDistinctSessions).toBe(0);
		expect(body.activeSessions?.perAccount).toEqual([]);
		expect(body.refusalFallbacks?.totals).toEqual({
			refusals: 0,
			fallbackRetries: 0,
			eligibleRequests: 0,
		});
		expect(body.contextComposition?.growthCurve).toEqual([]);
		expect(body.clientEfficiency?.rows).toEqual([]);
	});

	it("does not let an older abort stretch the burn-rate averages", async () => {
		const DAY = 24 * HOUR;
		const insert = (
			id: string,
			timestamp: number,
			billing: "plan" | "api",
			cost: number,
			rated: boolean,
		) =>
			db.run(
				`INSERT INTO requests (
					id, timestamp, method, path, status_code, success, error_message,
					cost_usd, billing_type
				) VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?, ?)`,
				[
					id,
					timestamp,
					rated ? 200 : 499,
					rated ? 1 : null,
					rated ? null : CLIENT_CLOSED_REQUEST,
					cost,
					billing,
				],
			);
		insert("plan-ok", FIXED_NOW - HOUR, "plan", 2, true);
		insert("api-ok", FIXED_NOW - HOUR, "api", 3, true);
		insert("plan-abort", FIXED_NOW - 20 * DAY, "plan", 0, false);
		insert("api-abort", FIXED_NOW - 20 * DAY, "api", 0, false);

		// The averages divide by the age of the data; only rated rows date it.
		for (const query of ["range=24h", "range=24h&models=absent-model"]) {
			const body = await fetchAnalytics(query);
			expect(body.totals).toMatchObject({
				avgDailyPlanCostUsd: 2,
				avgWeeklyPlanCostUsd: 14,
				avgDailyApiCostUsd: 3,
				avgWeeklyApiCostUsd: 21,
			});
		}
	});
});
