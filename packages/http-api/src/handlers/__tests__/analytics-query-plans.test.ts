import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	RequestRepository,
	ratedOutcomeSql,
	StatsRepository,
	withoutUnratedRequestSinceSql,
} from "@clankermux/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";
import { createCacheEffectivenessHandler } from "../cache-effectiveness-direct";
import { createPaymentsSummaryDataHandler } from "../payments-summary-direct";
import {
	ACCOUNT_A,
	ACCOUNT_B,
	FIXED_NOW,
	seedAnalyticsFixture,
} from "./analytics-section-fixture";

let db: Database;
let context: APIContext;
let statements: { sql: string; binds: SQLQueryBindings[] }[];

beforeEach(() => {
	setSystemTime(new Date(FIXED_NOW));
	db = new Database(":memory:");
	ensureSchema(db);
	seedAnalyticsFixture(db);
	// Production cardinality estimates favor scanning tool tables before
	// checking the request timestamp. Reproduce that planner choice locally.
	db.exec("ANALYZE");
	for (const [table, count] of Object.entries({
		requests: 740116,
		request_tool_calls: 89111,
		request_tool_errors: 3974,
	})) {
		db.run(
			"UPDATE sqlite_stat1 SET stat = ? || substr(stat, instr(stat, ' ')) WHERE tbl = ?",
			[String(count), table],
		);
	}
	db.exec("ANALYZE sqlite_schema");
	statements = [];
	const adapter = new BunSqlAdapter(db);
	// Recorded per method rather than in a loop over both: the two carry
	// different generic signatures, and one wrapper cannot satisfy both.
	const originalGet = adapter.get.bind(adapter);
	const originalQuery = adapter.query.bind(adapter);
	function recordingGet<R>(sql: string, binds?: unknown[]): Promise<R | null>;
	async function recordingGet(
		sql: string,
		binds: unknown[] = [],
	): Promise<unknown> {
		statements.push({ sql, binds: binds as SQLQueryBindings[] });
		return originalGet(sql, binds);
	}
	function recordingQuery<R>(sql: string, binds?: unknown[]): Promise<R[]>;
	async function recordingQuery(
		sql: string,
		binds: unknown[] = [],
	): Promise<unknown[]> {
		statements.push({ sql, binds: binds as SQLQueryBindings[] });
		return originalQuery(sql, binds);
	}
	adapter.get = recordingGet;
	adapter.query = recordingQuery;
	context = {
		db: adapter,
		config: {},
		dbOps: { getAdapter: () => adapter },
	} as APIContext;
});

afterEach(() => {
	db.close();
	setSystemTime();
});

async function fetch(query: string) {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams(query),
	);
	expect(response.status).toBe(200);
	return response.json();
}

function firstStatement() {
	const statement = statements[0];
	if (!statement) throw new Error("analytics did not execute a query");
	return statement;
}

function plan(statement: (typeof statements)[number]): string[] {
	return db
		.query<{ detail: string }, SQLQueryBindings[]>(
			`EXPLAIN QUERY PLAN ${statement.sql}`,
		)
		.all(...statement.binds)
		.map((row) => row.detail);
}

describe("analytics totals aggregate", () => {
	it("reads the filtered range once instead of once per metric", async () => {
		const body = await fetch("range=24h&sections=totals");
		expect(body.totals.requests).toBe(8);
		const details = plan(firstStatement());
		expect(
			details.filter((detail) => /^(SEARCH|SCAN) r\b/.test(detail)),
		).toHaveLength(1);
		expect(
			details.some((detail) => /SCALAR SUBQUERY|MATERIALIZE/.test(detail)),
		).toBe(false);
	});

	it("preserves NULL aggregates and zero counts for an empty filtered range", async () => {
		await fetch("range=24h&sections=totals&models=absent-model");
		const { sql, binds } = firstStatement();
		const raw = db
			.query<Record<string, number | null>, SQLQueryBindings[]>(sql)
			.get(...binds);
		if (!raw) throw new Error("empty aggregate must still return a row");
		for (const [key, value] of Object.entries(raw)) {
			expect(value).toBe(
				[
					"total_requests",
					"active_accounts",
					"priced_requests",
					"unpriced_requests",
					"reported_requests",
					"estimated_requests",
					"unknown_source_requests",
				].includes(key)
					? 0
					: null,
			);
		}
	});

	it("reports filtered API cost coverage without counting plan value or losing free requests", async () => {
		const insert = db.prepare(
			`INSERT INTO requests (id, timestamp, model, billing_type, cost_usd, cost_source, method, path, success) VALUES (?, ?, ?, ?, ?, ?, 'POST', '/v1/messages', 1)`,
		);
		for (const [id, model, billing, cost, source] of [
			["cost-reported", "cost-coverage-test", "api", 2, "reported"],
			["cost-free", "cost-coverage-test", "api", 0, "reported"],
			["cost-estimate", "cost-coverage-test", "overage", 3, "estimated"],
			["cost-legacy", "cost-coverage-test", null, 4, null],
			["cost-unknown", "cost-coverage-test", "api", null, "unknown"],
			["cost-plan", "cost-coverage-test", "plan", 99, "estimated"],
			["cost-excluded", "other-model", "api", 999, "reported"],
		] as const)
			insert.run(id, FIXED_NOW - 1000, model, billing, cost, source);
		const body = await fetch(
			"range=24h&sections=totals&models=cost-coverage-test",
		);
		expect(body.totals.apiCostCoverage).toEqual({
			reportedUsd: 2,
			estimatedUsd: 3,
			unknownSourceUsd: 4,
			pricedRequests: 4,
			unpricedRequests: 1,
			reportedRequests: 2,
			estimatedRequests: 1,
			unknownSourceRequests: 1,
		});
		const empty = await fetch("range=24h&sections=totals&models=absent-model");
		expect(Object.values(empty.totals.apiCostCoverage)).toEqual(
			Array(8).fill(0),
		);
	});

	it("keeps filter binds ahead of the no-account sentinel and counts NULL accounts", async () => {
		const body = await fetch(
			"range=24h&sections=totals&accountsNone=true&projectsNone=true&status=success",
		);
		expect(body.totals.requests).toBe(2);
		expect(body.totals.activeAccounts).toBe(1);
		expect(body.totals.totalTokens).toBe(1000);
	});
});

describe("account performance aggregation", () => {
	it("joins account names only after aggregating requests", async () => {
		await fetch("range=7d&sections=accountPerformance");
		const details = plan(firstStatement());
		const grouped = details.findIndex((detail) => /CO-ROUTINE r$/.test(detail));
		const scanGroups = details.findIndex((detail) => /^SCAN r$/.test(detail));
		const accountLookup = details.findIndex((detail) =>
			/(?:SEARCH|SCAN) a .*LEFT-JOIN/.test(detail),
		);
		expect(grouped).toBeGreaterThanOrEqual(0);
		expect(scanGroups).toBeGreaterThan(grouped);
		expect(accountLookup).toBeGreaterThan(scanGroups);
	});

	it.each([
		"1h",
		"6h",
		"24h",
		"7d",
		"30d",
		"all",
	])("preserves account identity, null billing and filters for %s", async (range) => {
		db.run("UPDATE accounts SET name = 'same-name' WHERE id IN (?, ?)", [
			ACCOUNT_A,
			ACCOUNT_B,
		]);
		const insert = db.prepare(
			`INSERT INTO requests (id, timestamp, account_used, project, model, success, billing_type, cost_usd, method, path) VALUES (?, ?, ?, 'account-test', ?, ?, ?, ?, 'POST', '/v1/messages')`,
		);
		for (const [id, account, model, success, billing, cost] of [
			["ap-1", ACCOUNT_A, "model-a", 1, "plan", 2],
			["ap-2", ACCOUNT_A, "model-a", 0, null, 3],
			["ap-3", ACCOUNT_A, "model-a", 1, "api", null],
			["ap-4", ACCOUNT_B, "model-a", 1, "api", 7],
			["ap-5", "deleted-account", "model-a", 1, "plan", 11],
			["ap-6", null, "model-a", 1, null, 13],
			["ap-7", ACCOUNT_A, "excluded-model", 1, "plan", 99],
		] as const)
			insert.run(id, FIXED_NOW - 1000, account, model, success, billing, cost);
		const query = `range=${range}&sections=accountPerformance&projects=account-test&models=model-a`;
		const body = await fetch(query);
		expect(body.accountPerformance).toHaveLength(4);
		expect(body.accountPerformance[0]).toEqual({
			name: "same-name",
			requests: 3,
			successRate: 200 / 3,
			planCostUsd: 2,
			apiCostUsd: 3,
			totalCostUsd: 5,
		});
		expect(
			body.accountPerformance.filter(
				(row: { name: string }) => row.name === "same-name",
			),
		).toHaveLength(2);
		expect(body.accountPerformance).toContainEqual({
			name: "same-name",
			requests: 1,
			successRate: 100,
			planCostUsd: 0,
			apiCostUsd: 7,
			totalCostUsd: 7,
		});
		expect(body.accountPerformance).toContainEqual({
			name: "deleted-account",
			requests: 1,
			successRate: 100,
			planCostUsd: 11,
			apiCostUsd: 0,
			totalCostUsd: 11,
		});
		const nullAccount = await fetch(`${query}&accountsNone=true`);
		expect(nullAccount.accountPerformance).toHaveLength(1);
		expect(nullAccount.accountPerformance[0]).toMatchObject({
			requests: 1,
			apiCostUsd: 13,
			totalCostUsd: 13,
		});
		const selected = await fetch(
			`${query}&accounts=${ACCOUNT_A}&status=success`,
		);
		expect(selected.accountPerformance).toEqual([
			{
				name: "same-name",
				requests: 2,
				successRate: 100,
				planCostUsd: 2,
				apiCostUsd: 0,
				totalCostUsd: 2,
			},
		]);
		const empty = await fetch(`${query}&accounts=absent-account`);
		expect(empty.accountPerformance).toEqual([]);
	});
});

describe("tool-error query plans", () => {
	it.each([
		"1h",
		"6h",
		"24h",
	])("uses request range scans and indexed tool probes for %s", async (range) => {
		await fetch(`range=${range}&sections=toolCallErrors`);
		expect(statements).toHaveLength(3);
		for (const statement of statements) {
			const details = plan(statement);
			expect(
				details.some((detail) =>
					/SEARCH r USING (?:COVERING )?INDEX \w+ \(timestamp>\?\)/.test(
						detail,
					),
				),
			).toBe(true);
			expect(
				details.some((detail) =>
					/SEARCH t[ce] USING (?:COVERING )?INDEX \w+ \(request_id=\?/.test(
						detail,
					),
				),
			).toBe(true);
			// The timeline has both a top-tools CTE and an outer aggregation.
			expect(
				details.filter((detail) => /^SCAN (tc|te)\b/.test(detail)),
			).toEqual([]);
		}
	});

	it.each([
		"7d",
		"30d",
		"all",
	])("leaves %s join order to SQLite, including filtered views", async (range) => {
		await fetch(`range=${range}&sections=toolCallErrors`);
		expect(statements).toHaveLength(3);
		for (const { sql } of statements) expect(sql).not.toContain("CROSS JOIN");
		statements = [];
		await fetch(
			`range=${range}&sections=toolCallErrors&accounts=${ACCOUNT_A}&projects=alpha`,
		);
		expect(statements).toHaveLength(3);
		for (const { sql } of statements) expect(sql).not.toContain("CROSS JOIN");
	});

	it.each([
		"24h",
		"7d",
		"30d",
		"all",
	])("retains tool totals, buckets and messages under combined filters for %s", async (range) => {
		const body = await fetch(
			`range=${range}&sections=toolCallErrors&accounts=${ACCOUNT_A}&projects=alpha&status=error`,
		);
		expect(body.toolCallErrors.byTool).toEqual([
			{ toolName: "Edit", totalCalls: 2, totalErrors: 2, errorRatePct: 100 },
		]);
		expect(body.toolCallErrors.timeSeries).toHaveLength(1);
		expect(body.toolCallErrors.timeSeries[0]).toMatchObject({
			toolName: "Edit",
			calls: 2,
			errors: 2,
		});
		expect(body.toolCallErrors.topMessages).toEqual([
			{ toolName: "Edit", errorText: "String not found", occurrences: 1 },
		]);
	});
});

describe("model performance reads the requested range once", () => {
	// Both percentile halves read the same filtered rows. Left to plan them
	// separately, SQLite drove the response-time half off
	// idx_requests_response_time (model, response_time_ms), which carries no
	// timestamp: it visited every request ever stored to keep the 7-day slice.
	function modelPerformancePlan(): string[] {
		const statement = statements.find(({ sql }) => sql.includes("resp_ranked"));
		if (!statement)
			throw new Error("model performance did not execute a query");
		return plan(statement);
	}

	it.each([
		["7d", ""],
		["7d", `&accounts=${ACCOUNT_A}&projects=alpha&status=success`],
		["all", ""],
	])("reads requests once for range=%s%s", async (range, filters) => {
		await fetch(`range=${range}&sections=modelPerformance${filters}`);
		const details = modelPerformancePlan();

		expect(
			details.some((detail) => detail.includes("idx_requests_response_time")),
		).toBe(false);
		const requestReads = details.filter((detail) =>
			/^(SEARCH|SCAN) r\b/.test(detail),
		);
		expect(requestReads).toHaveLength(1);
		if (range !== "all") expect(requestReads[0]).toContain("timestamp>?");
	});
});

describe("substitution origin stays one correlated read", () => {
	// The origin model and the provider that answered it both come out of a
	// single correlated subquery, driven off idx_routing_attempts_request once
	// per request in the range. The cheap-looking alternatives are what this
	// guards: a second correlated read for the provider doubles that work, and a
	// joined derived table materialises every mismatched attempt ever recorded —
	// 1.13s against 0.43s on the 15 GB production database over a 24h range.
	it.each([
		"modelDistribution",
		"costByModel",
	])("reads the answering attempt once for %s", async (section) => {
		const marker =
			section === "modelDistribution"
				? "'model_distribution'"
				: "'cost_by_model'";
		await fetch(`range=24h&sections=${section}`);
		const statement = statements.find(({ sql }) => sql.includes(marker));
		if (!statement) throw new Error(`${section} did not execute a query`);
		const details = plan(statement);

		expect(
			details.filter((detail) => detail.includes("CORRELATED SCALAR SUBQUERY")),
		).toHaveLength(1);
		expect(details).toContain(
			"SEARCH ra USING INDEX idx_routing_attempts_request (request_id=?)",
		);
	});
});

it("keeps payment range and per-account cost coverage scans covered by an index", async () => {
	const response = await createPaymentsSummaryDataHandler(context)(
		new URLSearchParams("range=24h"),
	);
	expect(response.status).toBe(200);
	const costQueries = statements.filter(({ sql }) =>
		sql.includes("AS priced_requests"),
	);
	expect(costQueries).toHaveLength(3);
	for (const statement of costQueries) {
		expect(
			plan(statement).some((detail) => detail.includes("USING COVERING INDEX")),
		).toBe(true);
	}
});

/**
 * `sqlite_stat1` of the production database for every table the analytics and
 * Overview reads touch, taken 2026-09-28 (1.09M requests). The planner reads
 * only these statistics and the schema, so with them loaded the fixture gets
 * the plans production gets from the same SQLite build.
 */
const PRODUCTION_STAT1: ReadonlyArray<readonly [string, string, string]> = [
	["requests", "idx_requests_account_timestamp", "1087289 401 1"],
	["requests", "idx_requests_account_used", "1087289 401"],
	[
		"requests",
		"idx_requests_analytics_covering",
		"1087289 1 1 1 1 1 1 1 1 1 1 1 1 1",
	],
	["requests", "idx_requests_api_key", "1084855 67"],
	["requests", "idx_requests_api_key_timestamp", "1084855 67 1"],
	["requests", "idx_requests_billing_type_timestamp", "1085364 401 1"],
	["requests", "idx_requests_cleanup", "1087289 1 1"],
	["requests", "idx_requests_correlation_tag", "73 1 1 1 1"],
	["requests", "idx_requests_cost_coverage", "1087289 1 1 1 1 1"],
	["requests", "idx_requests_cost_model", "1064840 2 2 1"],
	["requests", "idx_requests_id_timestamp", "1087289 1 1"],
	["requests", "idx_requests_model_timestamp", "1068443 401 1"],
	["requests", "idx_requests_project_timestamp", "995581 134 1"],
	["requests", "idx_requests_refusal_fallback", "23 1"],
	["requests", "idx_requests_response_time", "1068443 401 2"],
	["requests", "idx_requests_sdk_bridge_turn", "0 0"],
	["requests", "idx_requests_success_timestamp", "1087289 401 1"],
	[
		"requests",
		"idx_requests_summary_covering",
		"1087289 1 1 1 1 1 1 1 1 1 1 1 1 1 1",
	],
	["requests", "idx_requests_timestamp", "1087289 1"],
	["requests", "idx_requests_timestamp_account", "1087289 1 1"],
	["requests", "idx_requests_tokens", "1066430 1 1"],
	["requests", "sqlite_autoindex_requests_1", "1087289 1"],
	["request_routing", "idx_request_routing_affinity", "368419 201 1"],
	["request_routing", "idx_request_routing_decision", "368728 401 1"],
	["request_routing", "sqlite_autoindex_request_routing_1", "368728 1"],
	["request_tool_calls", "sqlite_autoindex_request_tool_calls_1", "89111 1 1"],
	["request_tool_errors", "idx_request_tool_errors_request_id", "3974 1"],
	["routing_attempts", "idx_routing_attempts_request", "75706 1 1"],
	["routing_attempts", "idx_routing_attempts_snapshot", "75706 37"],
	["routing_attempts", "idx_routing_attempts_started", "75706 1"],
	["routing_attempts", "sqlite_autoindex_routing_attempts_1", "75706 1"],
	["accounts", "idx_accounts_name", "4 1"],
	["accounts", "idx_accounts_paused", "4 4"],
	["accounts", "idx_accounts_priority", "4 2 1 1"],
	["accounts", "idx_accounts_rate_limited", "0 0"],
	["accounts", "idx_accounts_request_count", "4 1 1"],
	["accounts", "idx_accounts_session", "4 1 1"],
	["accounts", "sqlite_autoindex_accounts_1", "4 1"],
	["api_keys", "idx_api_keys_active", "4 4"],
	["api_keys", "idx_api_keys_hashed_key", "4 1"],
	["api_keys", "sqlite_autoindex_api_keys_1", "4 1"],
	["api_keys", "sqlite_autoindex_api_keys_2", "4 1"],
	["api_keys", "sqlite_autoindex_api_keys_3", "4 1"],
	["client_profiles", "sqlite_autoindex_client_profiles_1", "16 1"],
];

/**
 * The order the production database holds its `requests` indexes in, which is
 * the order they were added over time, not the order a fresh schema creates
 * them in. The planner breaks cost ties by that order: on the fresh order a
 * bare `success IS NOT NULL` at range=all reads the refusal partial index, on
 * production's it drives the read off `(success, timestamp)` instead.
 */
const PRODUCTION_REQUESTS_INDEX_ORDER = [
	"idx_requests_timestamp",
	"idx_requests_account_used",
	"idx_requests_timestamp_account",
	"idx_requests_model_timestamp",
	"idx_requests_success_timestamp",
	"idx_requests_account_timestamp",
	"idx_requests_cost_model",
	"idx_requests_response_time",
	"idx_requests_tokens",
	"idx_requests_api_key",
	"idx_requests_api_key_timestamp",
	"idx_requests_project_timestamp",
	"idx_requests_cleanup",
	"idx_requests_summary_covering",
	"idx_requests_analytics_covering",
	"idx_requests_billing_type_timestamp",
	"idx_requests_id_timestamp",
	"idx_requests_refusal_fallback",
	"idx_requests_cost_coverage",
	"idx_requests_correlation_tag",
	"idx_requests_sdk_bridge_turn",
];

function loadProductionStats(): void {
	const definitions = new Map(
		(
			db
				.query(
					"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requests' AND sql IS NOT NULL",
				)
				.all() as { name: string; sql: string }[]
		).map((row) => [row.name, row.sql]),
	);
	expect([...definitions.keys()].sort()).toEqual(
		[...PRODUCTION_REQUESTS_INDEX_ORDER].sort(),
	);
	for (const name of PRODUCTION_REQUESTS_INDEX_ORDER)
		db.exec(`DROP INDEX ${name}`);
	for (const name of PRODUCTION_REQUESTS_INDEX_ORDER)
		db.exec(definitions.get(name) as string);
	const tables = [...new Set(PRODUCTION_STAT1.map(([table]) => table))];
	db.run(
		`DELETE FROM sqlite_stat1 WHERE tbl IN (${tables.map(() => "?").join(",")})`,
		tables,
	);
	const insert = db.prepare(
		"INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)",
	);
	for (const row of PRODUCTION_STAT1) insert.run(...row);
	db.exec("ANALYZE sqlite_schema");
}

const RATED = [ratedOutcomeSql("r"), ratedOutcomeSql("requests")];
const UNRATED_REQUESTS = (() => {
	const clause = withoutUnratedRequestSinceSql("request_id");
	return clause.slice(clause.indexOf("(") + 1, -1);
})();

/**
 * The statement as it would read without excluding requests that have no
 * outcome. The routing exclusion keeps its bind but selects nothing.
 */
function withoutOutcomeExclusion(sql: string): string {
	let out = sql;
	for (const predicate of RATED) {
		out = out
			.split(`WHERE ${predicate} AND `)
			.join("WHERE ")
			.split(` AND ${predicate}`)
			.join("");
	}
	return out.split(UNRATED_REQUESTS).join("SELECT NULL WHERE ? IS NULL AND 0");
}

/** The plan lines that read `requests`, in plan order. */
function requestReads(sql: string, binds: SQLQueryBindings[]): string[] {
	return plan({ sql, binds })
		.filter((detail) => /^(SEARCH|SCAN) (r|requests)\b/.test(detail))
		.map((detail) => detail.replace(/^(SEARCH|SCAN) requests\b/, "$1 r"));
}

const covering = (read: string) => read.includes("COVERING INDEX");
const indexOf = (read: string) => /INDEX (\w+)/.exec(read)?.[1] ?? "table";
/** The one read the exclusion may add: the unrated rows, off (success, timestamp). */
const unratedLookup = (read: string) =>
	/USING INDEX idx_requests_success_timestamp \(success=\?/.test(read);

/**
 * Excluding requests without an outcome must cost no read its covering index,
 * and must not move a read onto another index unless both are covering. Each
 * statement is compared with its own text minus the exclusion, which is how
 * it read before the exclusion existed.
 */
function expectExclusionFree(): void {
	expect(statements.length).toBeGreaterThan(0);
	for (const { sql, binds } of statements) {
		const bare = withoutOutcomeExclusion(sql);
		if (bare === sql) continue;
		const before = requestReads(bare, binds);
		const after = requestReads(sql, binds).filter(
			(read) => !unratedLookup(read),
		);
		const context = `${sql.replace(/\s+/g, " ").slice(0, 160)}\nbefore: ${before.join(" | ")}\nafter:  ${after.join(" | ")}`;
		expect(after.length, context).toBe(before.length);
		before.forEach((read, i) => {
			const now = after[i] ?? "";
			if (covering(read)) expect(covering(now), context).toBe(true);
			else if (!covering(now))
				expect(indexOf(now), context).toBe(indexOf(read));
		});
	}
}

describe("excluding requests without an outcome keeps production plans", () => {
	beforeEach(loadProductionStats);

	it.each([
		"range=1h",
		"range=24h",
		"range=7d",
		"range=30d",
		"range=all",
		"range=7d&modelBreakdown=true",
		`range=7d&accounts=${ACCOUNT_A}&projects=alpha&status=error`,
		"range=all&models=model-a",
	])("analytics %s", async (query) => {
		await fetch(query);
		expectExclusionFree();
	});

	it.each([
		"24h",
		"7d",
	])("tool-error reads stay covered on the request side for %s", async (range) => {
		await fetch(`range=${range}&sections=toolCallErrors`);
		const reads = statements.flatMap(({ sql, binds }) =>
			requestReads(sql, binds),
		);
		expect(reads).toHaveLength(4);
		for (const read of reads) expect(read).toContain("COVERING INDEX");
	});

	it("ranks models off the covering model index", async () => {
		await fetch("range=7d&sections=modelDistribution");
		expect(
			requestReads(firstStatement().sql, firstStatement().binds),
		).toContain(
			"SEARCH r USING COVERING INDEX idx_requests_model_timestamp (ANY(model) AND timestamp>?)",
		);
	});

	it("reads refusals off their partial index at range=all", async () => {
		await fetch("range=all&sections=refusalFallbacks");
		const reads = statements
			.filter(({ sql }) => sql.includes("fallback_credit_claimed"))
			.flatMap(({ sql, binds }) => requestReads(sql, binds));
		expect(reads.length).toBeGreaterThan(0);
		for (const read of reads)
			expect(read).toContain("idx_requests_refusal_fallback");
	});

	it("cache effectiveness", async () => {
		await createCacheEffectivenessHandler(context)(
			new URLSearchParams("range=7d"),
		);
		expectExclusionFree();
	});

	it("Overview and stops-history reads", async () => {
		const adapter = context.dbOps.getAdapter();
		const stats = new StatsRepository(adapter);
		const requests = new RequestRepository(adapter);
		const since = FIXED_NOW - 7 * 24 * 60 * 60 * 1000;
		await stats.getAggregatedStats(since);
		await stats.getActiveSessionCounts(FIXED_NOW - 15 * 60 * 1000);
		await stats.getActiveSessionCountsByAccount(FIXED_NOW - 15 * 60 * 1000);
		await stats.getRecentErrorGroups(since);
		await stats.getApiKeyStats();
		await stats.getSessionStats([{ id: ACCOUNT_A, session_start: since }]);
		await requests.getRequestStats(since);
		await requests.getRequestStats();
		await requests.aggregateStats(7 * 24 * 60 * 60 * 1000);
		await requests.aggregateStats();
		await requests.getRequestsByAccount(since);
		await requests.countRequestsSince({ sinceMs: since });
		await requests.getCandidateCountDistribution({ sinceMs: since });
		await requests.getCandidateCountDistribution({
			sinceMs: since,
			filters: {
				accounts: [ACCOUNT_A],
				accountsNone: false,
				models: [],
				apiKeys: [],
				projects: [],
				projectsNone: false,
				status: "all",
			},
		});
		expectExclusionFree();
	});
});
