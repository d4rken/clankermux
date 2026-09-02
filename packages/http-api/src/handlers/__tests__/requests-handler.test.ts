import { describe, expect, it } from "bun:test";
import type { BunSqlAdapter, DatabaseOperations } from "@clankermux/database";
import {
	createRequestPayloadHandler,
	createRequestProjectsHandler,
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
			"WHERE r.success = 0 AND r.timestamp >= ?",
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
				project: "clankermux",
				reasoning_effort: "thinking:2048",
				requested_model: "claude-haiku-4-5-20251001",
			},
		]);
		const res = await createRequestsSummaryHandler(db)();
		const body = (await res.json()) as Array<{
			id: string;
			statusCode: number | null;
			rateLimited: boolean;
			accountUsed: string | null;
			project?: string;
			reasoningEffort?: string;
			requestedModel?: string;
		}>;
		expect(body[0].id).toBe("r1");
		expect(body[0].statusCode).toBe(429);
		expect(body[0].rateLimited).toBe(true);
		expect(body[0].accountUsed).toBe("Primary");
		expect(body[0].project).toBe("clankermux");
		expect(body[0].reasoningEffort).toBe("thinking:2048");
		expect(body[0].requestedModel).toBe("claude-haiku-4-5-20251001");
	});

	it("maps the refusal and fallback-credit columns onto the response", async () => {
		const { db } = mockDb([
			{
				id: "refused",
				timestamp: 1_700_000_000_000,
				method: "POST",
				path: "/v1/messages",
				account_used: "acc1",
				account_name: "Primary",
				status_code: 200,
				success: 1,
				error_message: null,
				stop_reason: "refusal",
				// 'unknown' is a real recorded category (the provider named none)
				// and must survive to the wire rather than collapsing to absent.
				refusal_category: "unknown",
				fallback_credit_claimed: 1,
				fallback_from_model: "claude-fable-5-1",
			},
		]);
		const res = await createRequestsSummaryHandler(db)();
		const body = (await res.json()) as Array<{
			stopReason?: string;
			refusalCategory?: string;
			fallbackCreditClaimed?: boolean;
			fallbackFromModel?: string;
		}>;
		expect(body[0].stopReason).toBe("refusal");
		expect(body[0].refusalCategory).toBe("unknown");
		expect(body[0].fallbackCreditClaimed).toBe(true);
		expect(body[0].fallbackFromModel).toBe("claude-fable-5-1");
	});

	it("omits the refusal and fallback fields for a legacy row with all NULLs", async () => {
		const { db } = mockDb([
			{
				id: "legacy",
				timestamp: 1_700_000_000_000,
				method: "POST",
				path: "/v1/messages",
				account_used: "acc1",
				account_name: "Primary",
				status_code: 200,
				success: 1,
				error_message: null,
				stop_reason: null,
				refusal_category: null,
				fallback_credit_claimed: null,
				fallback_from_model: null,
			},
		]);
		const res = await createRequestsSummaryHandler(db)();
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body[0]).not.toHaveProperty("stopReason");
		expect(body[0]).not.toHaveProperty("refusalCategory");
		expect(body[0]).not.toHaveProperty("fallbackCreditClaimed");
		expect(body[0]).not.toHaveProperty("fallbackFromModel");
	});

	it("maps context_binary_chars into attachmentChars", async () => {
		const { db } = mockDb([
			{
				id: "r3",
				timestamp: 1_700_000_000_000,
				method: "POST",
				path: "/v1/messages",
				account_used: "acc1",
				account_name: "Primary",
				status_code: 200,
				success: 1,
				error_message: null,
				context_binary_chars: 91_500,
			},
		]);
		const res = await createRequestsSummaryHandler(db)();
		const body = (await res.json()) as Array<{ attachmentChars?: number }>;
		expect(body[0].attachmentChars).toBe(91_500);
	});

	it("omits attachmentChars for attachment-free rows (0) and pre-column rows (NULL)", async () => {
		const base = {
			timestamp: 1_700_000_000_000,
			method: "POST",
			path: "/v1/messages",
			account_used: "acc1",
			account_name: "Primary",
			status_code: 200,
			success: 1,
			error_message: null,
		};
		const { db } = mockDb([
			{ ...base, id: "zero", context_binary_chars: 0 },
			{ ...base, id: "null", context_binary_chars: null },
			{ ...base, id: "missing" },
		]);
		const res = await createRequestsSummaryHandler(db)();
		const body = (await res.json()) as Array<{
			id: string;
			attachmentChars?: number;
		}>;
		for (const row of body) {
			expect(row.attachmentChars).toBeUndefined();
		}
	});

	it("omits reasoningEffort when the row has none", async () => {
		const { db } = mockDb([
			{
				id: "r2",
				timestamp: 1_700_000_000_000,
				method: "POST",
				path: "/v1/messages",
				account_used: "acc1",
				account_name: "Primary",
				status_code: 200,
				success: 1,
				error_message: null,
				reasoning_effort: null,
			},
		]);
		const res = await createRequestsSummaryHandler(db)();
		const body = (await res.json()) as Array<{
			reasoningEffort?: string;
		}>;
		expect(body[0].reasoningEffort).toBeUndefined();
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
		expect(normalize(sql)).toContain("WHERE r.success = 0");
		expect(params).toEqual([]);
	});

	it("defaults the total to 0 when the query returns nothing", async () => {
		const { db } = mockDb([]);
		const res = await createRequestsCountHandler(db)();
		const body = (await res.json()) as { total: number };
		expect(body.total).toBe(0);
	});
});

describe("createRequestProjectsHandler", () => {
	it("returns the distinct non-null projects as a plain string array", async () => {
		const { db, last } = mockDb([{ project: "alpha" }, { project: "beta" }]);
		const res = await createRequestProjectsHandler(db)();
		const body = (await res.json()) as string[];
		expect(body).toEqual(["alpha", "beta"]);
		const { sql } = last();
		expect(normalize(sql)).toBe(
			"SELECT DISTINCT project FROM requests WHERE project IS NOT NULL ORDER BY project LIMIT 500",
		);
	});

	it("returns an empty array when no requests carry a project", async () => {
		const { db } = mockDb([]);
		const res = await createRequestProjectsHandler(db)();
		const body = (await res.json()) as string[];
		expect(body).toEqual([]);
	});
});

describe("createRequestPayloadHandler", () => {
	function payloadDbOps(payload: unknown): DatabaseOperations {
		return {
			getRequestPayload: async () => payload,
		} as unknown as DatabaseOperations;
	}

	it("404s with a GENERIC 'Payload not found' when the payload is absent", async () => {
		// `getRequestPayload` returns null for a missing REQUEST, a missing
		// PAYLOAD (retention swept it, or payload storage was off) and malformed
		// stored JSON alike, and this handler cannot tell them apart. The previous
		// "Request not found" asserted the first, so a request sitting in the
		// history with its payload aged out reported itself as nonexistent.
		const res = await createRequestPayloadHandler(payloadDbOps(null))("req-1");
		expect(res.status).toBe(404);
		expect(res.headers.get("Content-Type")).toBe("application/json");
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Payload not found");
	});

	it("returns the payload unchanged when one exists", async () => {
		const payload = { request: { model: "claude-sonnet-4-5" }, response: null };
		const res = await createRequestPayloadHandler(payloadDbOps(payload))(
			"req-2",
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(payload);
	});
});
