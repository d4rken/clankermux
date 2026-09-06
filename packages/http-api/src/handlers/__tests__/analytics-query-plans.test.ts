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
import {
	ACCOUNT_A,
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
				key === "total_requests" || key === "active_accounts" ? 0 : null,
			);
		}
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
