import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	RequestRepository,
} from "@clankermux/database";
import { CLIENT_CLOSED_REQUEST } from "@clankermux/types";
import type { RequestFilters } from "../request-filters";
import {
	createRequestsCountHandler,
	createRequestsSummaryHandler,
} from "../requests";

/**
 * Request History lists a pre-head client abort under "all" and under its
 * own status code, and under neither outcome filter: it has no outcome.
 */
describe("Request History and pre-head client aborts", () => {
	let db: Database;
	let adapter: BunSqlAdapter;

	beforeEach(async () => {
		db = new Database(":memory:");
		ensureSchema(db);
		adapter = new BunSqlAdapter(db);
		const repo = new RequestRepository(adapter);
		const base = {
			method: "POST",
			path: "/v1/messages",
			accountUsed: "acct-a",
			responseTime: 100,
			failoverAttempts: 0,
			projectAttributionSource: null,
		};
		await repo.save({
			...base,
			id: "ok",
			statusCode: 200,
			success: true,
			errorMessage: null,
		});
		await repo.save({
			...base,
			id: "failed",
			statusCode: 500,
			success: false,
			errorMessage: "500 api_error: boom",
		});
		await repo.save({
			...base,
			id: "abort",
			statusCode: 499,
			success: null,
			errorMessage: CLIENT_CLOSED_REQUEST,
			requestedModel: "gpt-6-astra",
		});
	});
	afterEach(() => db.close());

	const list = async (filters: RequestFilters = {}) =>
		(await (
			await createRequestsSummaryHandler(adapter)(50, 0, filters)
		).json()) as Array<{
			id: string;
			success: boolean;
			statusCode: number | null;
			errorMessage: string | null;
			model?: string;
			requestedModel?: string;
		}>;
	const count = async (filters: RequestFilters = {}) =>
		(
			(await (await createRequestsCountHandler(adapter)(filters)).json()) as {
				total: number;
			}
		).total;

	it("lists the abort with a boolean success on the wire", async () => {
		const abort = (await list()).find((r) => r.id === "abort");
		expect(abort).toMatchObject({
			success: false,
			statusCode: 499,
			errorMessage: CLIENT_CLOSED_REQUEST,
			requestedModel: "gpt-6-astra",
		});
		// No usage, so no model: the list shows the requested one instead.
		expect(abort?.model ?? null).toBeNull();
		expect(await count()).toBe(3);
	});

	it("finds the abort by its status code", async () => {
		expect((await list({ codes: [499] })).map((r) => r.id)).toEqual(["abort"]);
		expect(await count({ codes: [499] })).toBe(1);
	});

	it("keeps the abort out of both outcome filters", async () => {
		expect((await list({ status: "error" })).map((r) => r.id)).toEqual([
			"failed",
		]);
		expect((await list({ status: "success" })).map((r) => r.id)).toEqual([
			"ok",
		]);
		expect(await count({ status: "error" })).toBe(1);
	});
});
