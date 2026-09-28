/**
 * A pre-head client abort is stored with `success` NULL: the request has no
 * outcome, so it is neither a success nor a failure. These pin the row's
 * round trip and that the outcome-rated readers leave it out.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CLIENT_CLOSED_REQUEST } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { type RequestData, RequestRepository } from "../request.repository";
import { ratedOutcomeSql } from "../request-filters";
import { StatsRepository } from "../stats.repository";

function requestData(overrides: Partial<RequestData> = {}): RequestData {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct-a",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 1_000,
		failoverAttempts: 0,
		projectAttributionSource: null,
		...overrides,
	};
}

const clientClosed = (id: string, overrides: Partial<RequestData> = {}) =>
	requestData({
		id,
		statusCode: 499,
		success: null,
		errorMessage: CLIENT_CLOSED_REQUEST,
		responseTime: 60_000,
		model: "gpt-6-astra",
		...overrides,
	});

describe("pre-head client abort rows", () => {
	let db: Database;
	let requests: RequestRepository;
	let stats: StatsRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		const adapter = new BunSqlAdapter(db);
		requests = new RequestRepository(adapter);
		stats = new StatsRepository(adapter);
	});
	afterEach(() => db.close());

	const row = (id: string) =>
		db
			.query(
				"SELECT success, status_code, error_message, model FROM requests WHERE id=?",
			)
			.get(id) as {
			success: number | null;
			status_code: number | null;
			error_message: string | null;
			model: string | null;
		};

	it("stores success as NULL", async () => {
		await requests.save(clientClosed("abort"));
		expect(row("abort")).toEqual({
			success: null,
			status_code: 499,
			error_message: CLIENT_CLOSED_REQUEST,
			model: "gpt-6-astra",
		});
	});

	it("falls back to the row's model when no usage names one", async () => {
		await requests.save(requestData({ id: "a", model: "gpt-6-astra" }));
		await requests.save(
			requestData({
				id: "b",
				model: "gpt-6-astra",
				usage: { model: "gpt-6-luna" },
			}),
		);
		await requests.save(requestData({ id: "c" }));
		expect(row("a").model).toBe("gpt-6-astra");
		expect(row("b").model).toBe("gpt-6-luna");
		expect(row("c").model).toBeNull();
	});

	async function seedMixed(): Promise<void> {
		await requests.save(requestData({ id: "ok" }));
		await requests.save(
			requestData({
				id: "upstream",
				statusCode: 500,
				success: false,
				errorMessage: "500 api_error: boom",
			}),
		);
		await requests.save(
			requestData({
				id: "post-head",
				statusCode: 200,
				success: false,
				errorMessage: "client disconnected",
			}),
		);
		await requests.save(clientClosed("abort"));
	}

	it("the shared predicate names exactly the rated rows", async () => {
		await seedMixed();
		const ids = (
			db
				.query(
					`SELECT id FROM requests r WHERE ${ratedOutcomeSql("r")} ORDER BY id`,
				)
				.all() as { id: string }[]
		).map((r) => r.id);
		expect(ids).toEqual(["ok", "post-head", "upstream"]);
	});

	it("leaves the abort out of the Overview totals and success rate", async () => {
		await seedMixed();
		const result = await stats.getAggregatedStats(0);
		expect(result.totalRequests).toBe(3);
		expect(result.successfulRequests).toBe(1);
		// The abort's minute of waiting is not a response time.
		expect(result.avgResponseTime).toBe(1_000);
	});

	it("leaves the abort out of the Overview's recent errors", async () => {
		await seedMixed();
		const groups = await stats.getRecentErrorGroups(0);
		expect(groups.map((g) => g.errorCode).sort()).toEqual([
			"500 api_error: boom",
			"client disconnected",
		]);
	});

	it("leaves the abort out of the stops-history denominator", async () => {
		await seedMixed();
		expect(await requests.countRequestsSince({ sinceMs: 0 })).toBe(3);
	});

	it("an abort-only range has no rated requests at all", async () => {
		await requests.save(clientClosed("abort-1"));
		await requests.save(clientClosed("abort-2"));
		const result = await stats.getAggregatedStats(0);
		expect(result.totalRequests).toBe(0);
		expect(result.successfulRequests).toBe(0);
		expect(result.avgResponseTime).toBe(0);
		expect(await stats.getRecentErrorGroups(0)).toEqual([]);
		expect(await requests.countRequestsSince({ sinceMs: 0 })).toBe(0);
	});
});
