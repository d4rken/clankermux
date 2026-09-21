/**
 * Round-trip for the `request_headers` table: the sanitized header sets are
 * stored apart from the payload envelope so they can outlive it, which makes
 * the repository — not the envelope reader — the thing long-range analytics
 * goes through.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import {
	type RequestData,
	RequestRepository,
} from "../repositories/request.repository";

let db: Database;
let repo: RequestRepository;

const request: RequestData = {
	id: "r",
	method: "POST",
	path: "/v1/messages",
	accountUsed: null,
	statusCode: 200,
	success: true,
	errorMessage: null,
	responseTime: 100,
	failoverAttempts: 0,
	projectAttributionSource: null,
};

beforeEach(async () => {
	db = new Database(":memory:");
	ensureSchema(db);
	repo = new RequestRepository(new BunSqlAdapter(db));
	await repo.save(request);
});
afterEach(() => db.close());

describe("request headers repository", () => {
	it("round-trips both header sets", async () => {
		await repo.saveHeaders({
			requestId: "r",
			requestHeaders: { accept: "application/json", "anthropic-beta": "x" },
			responseHeaders: { "anthropic-ratelimit-unified-5h-utilization": "0.42" },
			createdAt: 1_700_000_000_000,
		});

		expect(await repo.getHeaders("r")).toEqual({
			requestHeaders: { accept: "application/json", "anthropic-beta": "x" },
			responseHeaders: { "anthropic-ratelimit-unified-5h-utilization": "0.42" },
			createdAt: 1_700_000_000_000,
		});
	});

	it("returns null for a request that has no header row", async () => {
		expect(await repo.getHeaders("r")).toBeNull();
	});

	it("keeps the first created_at across a re-record", async () => {
		await repo.saveHeaders({
			requestId: "r",
			requestHeaders: { accept: "application/json" },
			responseHeaders: null,
			createdAt: 1_700_000_000_000,
		});
		// A late usage patch re-runs persistence; the retention clock must not
		// restart, or a row could outlive its window indefinitely.
		await repo.saveHeaders({
			requestId: "r",
			requestHeaders: null,
			responseHeaders: { "content-type": "application/json" },
			createdAt: 1_700_000_999_999,
		});

		expect(await repo.getHeaders("r")).toEqual({
			requestHeaders: { accept: "application/json" },
			responseHeaders: { "content-type": "application/json" },
			createdAt: 1_700_000_000_000,
		});
	});

	it("yields null for a side whose stored JSON is malformed", async () => {
		db.run(
			"INSERT INTO request_headers (request_id, request_headers, response_headers, created_at) VALUES ('r', '{not json', '{\"a\":\"b\"}', 1)",
		);

		expect(await repo.getHeaders("r")).toEqual({
			requestHeaders: null,
			responseHeaders: { a: "b" },
			createdAt: 1,
		});
	});
});
