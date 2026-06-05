import { describe, expect, it } from "bun:test";
import type { BunSqlAdapter } from "@clankermux/database";
import {
	createRequestsCountHandler,
	createRequestsSummaryHandler,
} from "../requests";

/** Mock adapter that captures the last query() call and returns canned rows. */
function mockDb(rows: unknown[] = []): {
	db: BunSqlAdapter;
	last: () => { sql: string; params: unknown[] };
} {
	let captured: { sql: string; params: unknown[] } = { sql: "", params: [] };
	const db = {
		query: async (sql: string, params: unknown[] = []) => {
			captured = { sql, params };
			return rows;
		},
	} as unknown as BunSqlAdapter;
	return { db, last: () => captured };
}

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("createRequestsSummaryHandler", () => {
	it("defaults to no WHERE clause, limit 50, offset 0", async () => {
		const { db, last } = mockDb();
		await createRequestsSummaryHandler(db)();
		const { sql, params } = last();
		expect(normalize(sql)).not.toContain("WHERE");
		expect(normalize(sql)).toContain("LIMIT ? OFFSET ?");
		expect(params).toEqual([50, 0]);
	});

	it("threads filter params before limit/offset, in order", async () => {
		const { db, last } = mockDb();
		await createRequestsSummaryHandler(db)(25, 50, {
			status: "error",
			from: 100,
		});
		const { sql, params } = last();
		expect(normalize(sql)).toContain(
			"WHERE (r.status_code IS NULL OR r.status_code < 200 OR r.status_code >= 300) AND r.timestamp >= ?",
		);
		// filter params (timestamp) first, then limit, then offset
		expect(params).toEqual([100, 25, 50]);
	});

	it("maps a row into the RequestResponse shape with rateLimited derived from 429", async () => {
		const { db } = mockDb([
			{
				id: "r1",
				timestamp: 1_700_000_000_000,
				method: "POST",
				path: "/v1/messages",
				account_used: "acc1",
				account_name: "Primary",
				status_code: 429,
				success: 0,
				error_message: null,
			},
		]);
		const res = await createRequestsSummaryHandler(db)();
		const body = (await res.json()) as Array<{
			id: string;
			statusCode: number | null;
			rateLimited: boolean;
			accountUsed: string | null;
		}>;
		expect(body[0].id).toBe("r1");
		expect(body[0].statusCode).toBe(429);
		expect(body[0].rateLimited).toBe(true);
		expect(body[0].accountUsed).toBe("Primary");
	});
});

describe("createRequestsCountHandler", () => {
	it("returns the total from COUNT(*) with the filter clause applied", async () => {
		const { db, last } = mockDb([{ total: 7 }]);
		const res = await createRequestsCountHandler(db)({ status: "error" });
		const body = (await res.json()) as { total: number };
		expect(body.total).toBe(7);
		const { sql, params } = last();
		expect(normalize(sql)).toContain("SELECT COUNT(*) as total");
		expect(normalize(sql)).toContain(
			"WHERE (r.status_code IS NULL OR r.status_code < 200 OR r.status_code >= 300)",
		);
		expect(params).toEqual([]);
	});

	it("defaults the total to 0 when the query returns nothing", async () => {
		const { db } = mockDb([]);
		const res = await createRequestsCountHandler(db)();
		const body = (await res.json()) as { total: number };
		expect(body.total).toBe(0);
	});
});
