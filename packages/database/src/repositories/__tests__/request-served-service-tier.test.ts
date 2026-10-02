/**
 * `requests.service_tier`: the tier the request's latest upstream attempt went
 * out at. A later save with a tier replaces it; the usage-patch re-upsert,
 * which carries none, keeps it.
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
		path: "/v1/responses",
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

describe("requests.service_tier", () => {
	let db: Database;
	let repo: RequestRepository;

	const readTier = (): string | null =>
		(
			db
				.query("SELECT service_tier AS v FROM requests WHERE id = ?")
				.get("req-1") as { v: string | null }
		).v;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("stores the served tier, and NULL when none is given", async () => {
		await repo.save(requestData({ servedServiceTier: "priority" }));
		expect(readTier()).toBe("priority");

		await repo.save(requestData({ id: "req-2" }));
		expect(
			(
				db
					.query("SELECT service_tier AS v FROM requests WHERE id = 'req-2'")
					.get() as { v: string | null }
			).v,
		).toBeNull();
	});

	it("keeps the tier through a re-upsert that carries none", async () => {
		await repo.save(requestData({ servedServiceTier: "priority" }));
		await repo.save(requestData());
		expect(readTier()).toBe("priority");
	});

	it("lets a later save with a tier replace it", async () => {
		await repo.save(requestData({ servedServiceTier: "priority" }));
		await repo.save(requestData({ servedServiceTier: "standard" }));
		expect(readTier()).toBe("standard");
	});
});
