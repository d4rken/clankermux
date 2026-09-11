import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	RequestRepository,
} from "@clankermux/database";
import { createRequestsSummaryHandler } from "../requests";

it("request summaries preserve reported zero, comparison estimate, and false BYOK", async () => {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		const adapter = new BunSqlAdapter(db);
		const repo = new RequestRepository(adapter);
		await repo.save({
			id: "reported",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 100,
			failoverAttempts: 0,
			projectAttributionSource: null,
			usage: {
				costUsd: 0,
				estimatedCostUsd: 0.02,
				costSource: "reported",
				costIsByok: false,
			},
		});
		const response = await createRequestsSummaryHandler(adapter)();
		const rows = await response.json();
		expect(rows[0]).toMatchObject({
			costUsd: 0,
			estimatedCostUsd: 0.02,
			costSource: "reported",
			costIsByok: false,
		});
	} finally {
		db.close();
	}
});
