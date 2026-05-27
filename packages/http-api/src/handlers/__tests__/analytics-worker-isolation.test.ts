import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics";
import {
	clearAnalyticsCachesForTests,
	getAnalyticsCacheStatsForTests,
} from "../analytics-runner";

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	process.env.CLANKERMUX_ANALYTICS_CACHE_TTL_MS = "50";
	process.env.CLANKERMUX_ANALYTICS_CACHE_MAX_ENTRIES = "2";
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-analytics-"));
	dbOps = new DatabaseOperations(join(tmpDir, "test.db"));
});

afterEach(async () => {
	clearAnalyticsCachesForTests();
	delete process.env.CLANKERMUX_ANALYTICS_CACHE_TTL_MS;
	delete process.env.CLANKERMUX_ANALYTICS_CACHE_MAX_ENTRIES;
	await dbOps.dispose();
	rmSync(tmpDir, { recursive: true, force: true });
});

function context(): APIContext {
	return {
		db: dbOps.getAdapter(),
		config: {} as APIContext["config"],
		dbOps,
	};
}

async function insertRequest(id: string, timestamp: number): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			response_time_ms, failover_attempts, model, total_tokens, cost_usd,
			output_tokens_per_second, input_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, output_tokens, billing_type
		) VALUES (?, ?, 'POST', '/v1/messages', 'account-1', 200, TRUE,
			100, 0, 'claude-test', 10, 0.01, 5, 1, 7, 1, 1, 'plan')`,
		[id, timestamp],
	);
}

describe("analytics worker isolation", () => {
	it("runs analytics through the SQLite worker and returns data", async () => {
		await insertRequest("req-1", Date.now());

		const response = await createAnalyticsHandler(context())(
			new URLSearchParams({ range: "24h" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");
		expect(data.totals.requests).toBe(1);
		expect(data.totals.totalTokens).toBe(10);
	});

	it("caches successful worker-backed analytics briefly", async () => {
		const handler = createAnalyticsHandler(context());
		await insertRequest("req-1", Date.now());

		const first = await (
			await handler(new URLSearchParams({ range: "24h" }))
		).json();
		await insertRequest("req-2", Date.now());
		const cached = await (
			await handler(new URLSearchParams({ range: "24h" }))
		).json();
		await new Promise((resolve) => setTimeout(resolve, 80));
		const refreshed = await (
			await handler(new URLSearchParams({ range: "24h" }))
		).json();

		expect(first.totals.requests).toBe(1);
		expect(cached.totals.requests).toBe(1);
		expect(refreshed.totals.requests).toBe(2);
	});

	it("caps cached analytics responses across rotating filter combinations", async () => {
		const handler = createAnalyticsHandler(context());
		await insertRequest("req-1", Date.now());

		await handler(new URLSearchParams({ range: "1h" }));
		await handler(new URLSearchParams({ range: "6h" }));
		await handler(new URLSearchParams({ range: "24h" }));

		expect(
			getAnalyticsCacheStatsForTests().responseCacheSize,
		).toBeLessThanOrEqual(2);
	});
});
