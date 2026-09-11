import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";
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
	for (const method of ["get", "query"] as const) {
		const original = adapter[method].bind(adapter);
		adapter[method] = (async (sql: string, binds: unknown[] = []) => {
			statements.push({ sql, binds: binds as SQLQueryBindings[] });
			return original(sql, binds);
		}) as (typeof adapter)[typeof method];
	}
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
			`INSERT INTO requests (id, timestamp, model, billing_type, cost_usd, cost_source, method, path) VALUES (?, ?, ?, ?, ?, ?, 'POST', '/v1/messages')`,
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
