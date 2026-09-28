/**
 * Analytics count requests with an outcome. A pre-head client abort (success
 * NULL, 499, `client_closed_request`) has none, so adding one to the fixture
 * must leave every section of the response exactly as it was, however much
 * of the row the section reads (account, model, key, project, routing, tool
 * calls). And a range holding nothing but aborts reads as empty.
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

function insertClientClosed(id: string, timestamp: number): void {
	db.run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			error_message, response_time_ms, failover_attempts, model,
			requested_model, api_key_id, api_key_name, project,
			project_attribution_source, billing_type, context_messages_chars,
			context_message_count, context_largest_tool_name,
			context_largest_tool_chars, client_harness
		) VALUES (?, ?, 'POST', '/v1/messages', ?, 499, NULL, ?, 90000, 1,
			'claude-opus-4-8', 'claude-opus-4-8', ?, 'live-key', ?, 'header',
			'plan', 5000, 4, 'Read', 700, 'pi')`,
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
	db.run(
		`INSERT INTO request_tool_calls (request_id, tool_name, call_count, error_count) VALUES (?, 'Read', 3, 1)`,
		[id],
	);
	db.run(
		`INSERT INTO request_tool_errors (request_id, tool_name, error_text) VALUES (?, 'Read', 'boom')`,
		[id],
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
	});
});
