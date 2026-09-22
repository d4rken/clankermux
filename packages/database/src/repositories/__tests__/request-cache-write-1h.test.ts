/**
 * The 1-hour share of a request's cache writes is its own column, because it is
 * billed at 2x input where the rest is billed at the 5-minute rate. NULL means
 * the provider reported no split; 0 means it reported that none were 1-hour.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { type RequestData, RequestRepository } from "../request.repository";

function requestData(overrides: Partial<RequestData> = {}): RequestData {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct-a",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 1_200,
		failoverAttempts: 0,
		projectAttributionSource: null,
		...overrides,
	};
}

describe("requests.cache_creation_1h_input_tokens", () => {
	let db: Database;
	let repo: RequestRepository;

	const read1h = (): number | null =>
		(
			db
				.query(
					"SELECT cache_creation_1h_input_tokens AS v FROM requests WHERE id = ?",
				)
				.get("req-1") as { v: number | null }
		).v;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("stores the reported split on save", async () => {
		await repo.save(
			requestData({
				usage: {
					cacheCreationInputTokens: 1_000,
					cacheCreation1hInputTokens: 400,
				},
			}),
		);
		expect(read1h()).toBe(400);
	});

	it("stores a reported 0 as 0 and an absent split as NULL", async () => {
		await repo.save(
			requestData({
				usage: {
					cacheCreationInputTokens: 1_000,
					cacheCreation1hInputTokens: 0,
				},
			}),
		);
		expect(read1h()).toBe(0);

		await repo.save(
			requestData({ usage: { cacheCreationInputTokens: 1_000 } }),
		);
		expect(read1h()).toBeNull();
	});

	it("patches the split through updateUsage without clearing it later", async () => {
		await repo.save(requestData());
		await repo.updateUsage("req-1", {
			cacheCreationInputTokens: 1_000,
			cacheCreation1hInputTokens: 400,
		});
		expect(read1h()).toBe(400);

		await repo.updateUsage("req-1", { cacheCreationInputTokens: 1_000 });
		expect(read1h()).toBe(400);
	});
});
