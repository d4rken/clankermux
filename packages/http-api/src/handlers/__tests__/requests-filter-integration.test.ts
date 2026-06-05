import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { BunSqlAdapter } from "@clankermux/database";
import {
	createRequestsCountHandler,
	createRequestsSummaryHandler,
} from "../requests";

/**
 * Real-SQLite integration test: exercises the dynamically-built WHERE clause
 * against an actual SQLite engine (not a mock), so a malformed clause or a wrong
 * column name fails here even though the param-capture unit tests would pass.
 */

type Row = {
	id: string;
	timestamp: number;
	status_code: number | null;
	account_used: string | null;
	api_key_name: string | null;
};

function makeDb(rows: Row[]): BunSqlAdapter {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT);
		CREATE TABLE requests (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			method TEXT,
			path TEXT,
			account_used TEXT,
			status_code INTEGER,
			success INTEGER,
			error_message TEXT,
			response_time_ms INTEGER,
			api_key_name TEXT
		);
	`);
	db.run("INSERT INTO accounts (id, name) VALUES ('acc1', 'Primary')");
	const insert = db.prepare(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success, api_key_name)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?)`,
	);
	for (const r of rows) {
		insert.run(
			r.id,
			r.timestamp,
			r.account_used,
			r.status_code,
			r.status_code != null && r.status_code < 300 ? 1 : 0,
			r.api_key_name,
		);
	}
	return {
		query: async <T>(sql: string, params: unknown[] = []) =>
			db.prepare(sql).all(...(params as never[])) as T[],
	} as unknown as BunSqlAdapter;
}

const rows: Row[] = [
	{
		id: "ok-new",
		timestamp: 5000,
		status_code: 200,
		account_used: "acc1",
		api_key_name: "k1",
	},
	{
		id: "ok-old",
		timestamp: 1000,
		status_code: 200,
		account_used: "acc1",
		api_key_name: null,
	},
	{
		id: "err-429",
		timestamp: 4000,
		status_code: 429,
		account_used: "acc1",
		api_key_name: "k1",
	},
	{
		id: "err-500",
		timestamp: 3000,
		status_code: 500,
		account_used: null,
		api_key_name: null,
	},
	{
		id: "err-404",
		timestamp: 2000,
		status_code: 404,
		account_used: "acc1",
		api_key_name: "k2",
	},
];

async function ids(res: Response): Promise<string[]> {
	const body = (await res.json()) as Array<{ id: string }>;
	return body.map((r) => r.id);
}

describe("requests filtering — real SQLite", () => {
	it("returns all rows newest-first with no filter", async () => {
		const res = await createRequestsSummaryHandler(makeDb(rows))(50, 0, {});
		expect(await ids(res)).toEqual([
			"ok-new",
			"err-429",
			"err-500",
			"err-404",
			"ok-old",
		]);
	});

	it("status=error returns only non-2xx, newest-first", async () => {
		const res = await createRequestsSummaryHandler(makeDb(rows))(50, 0, {
			status: "error",
		});
		expect(await ids(res)).toEqual(["err-429", "err-500", "err-404"]);
	});

	it("status=success returns only 2xx", async () => {
		const res = await createRequestsSummaryHandler(makeDb(rows))(50, 0, {
			status: "success",
		});
		expect(await ids(res)).toEqual(["ok-new", "ok-old"]);
	});

	it("specific codes filter to exactly those codes", async () => {
		const res = await createRequestsSummaryHandler(makeDb(rows))(50, 0, {
			codes: [429, 500],
		});
		expect(await ids(res)).toEqual(["err-429", "err-500"]);
	});

	it("time bounds restrict the window (inclusive)", async () => {
		const res = await createRequestsSummaryHandler(makeDb(rows))(50, 0, {
			from: 2000,
			to: 4000,
		});
		expect(await ids(res)).toEqual(["err-429", "err-500", "err-404"]);
	});

	it("account filter matches by joined name", async () => {
		const res = await createRequestsSummaryHandler(makeDb(rows))(50, 0, {
			account: "Primary",
		});
		expect(await ids(res)).toEqual(["ok-new", "err-429", "err-404", "ok-old"]);
	});

	it("apiKey no-api-key sentinel matches NULL keys", async () => {
		const res = await createRequestsSummaryHandler(makeDb(rows))(50, 0, {
			apiKey: "no-api-key",
		});
		expect(await ids(res)).toEqual(["err-500", "ok-old"]);
	});

	it("limit + offset paginate the filtered set", async () => {
		const db = makeDb(rows);
		const page1 = await createRequestsSummaryHandler(db)(2, 0, {
			status: "error",
		});
		const page2 = await createRequestsSummaryHandler(db)(2, 2, {
			status: "error",
		});
		expect(await ids(page1)).toEqual(["err-429", "err-500"]);
		expect(await ids(page2)).toEqual(["err-404"]);
	});

	it("count matches the filtered total", async () => {
		const errRes = await createRequestsCountHandler(makeDb(rows))({
			status: "error",
		});
		expect(((await errRes.json()) as { total: number }).total).toBe(3);

		const allRes = await createRequestsCountHandler(makeDb(rows))({});
		expect(((await allRes.json()) as { total: number }).total).toBe(5);

		const codeRes = await createRequestsCountHandler(makeDb(rows))({
			codes: [404],
		});
		expect(((await codeRes.json()) as { total: number }).total).toBe(1);
	});
});
