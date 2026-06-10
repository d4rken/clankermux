import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler, getRangeConfig } from "../analytics-direct";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-analytics-all-"));
	dbOps = new DatabaseOperations(join(tmpDir, "test.db"));
});

afterEach(async () => {
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

describe("getRangeConfig", () => {
	it("maps 'all' to no cutoff with daily buckets", () => {
		const { startMs, bucket } = getRangeConfig("all");
		expect(startMs).toBeNull();
		expect(bucket.bucketMs).toBe(DAY);
		expect(bucket.displayName).toBe("1d");
	});

	it("keeps the bounded ranges unchanged", () => {
		const before = Date.now();
		const { startMs, bucket } = getRangeConfig("30d");
		const after = Date.now();
		expect(startMs).not.toBeNull();
		expect(startMs as number).toBeGreaterThanOrEqual(before - 30 * DAY);
		expect(startMs as number).toBeLessThanOrEqual(after - 30 * DAY);
		expect(bucket.bucketMs).toBe(DAY);
	});

	it("falls back to the 24h window for garbage input", () => {
		const before = Date.now();
		const { startMs, bucket } = getRangeConfig("bogus");
		const after = Date.now();
		expect(startMs).not.toBeNull();
		expect(startMs as number).toBeGreaterThanOrEqual(before - DAY);
		expect(startMs as number).toBeLessThanOrEqual(after - DAY);
		expect(bucket.bucketMs).toBe(HOUR);
	});
});

describe("analytics range=all", () => {
	it("counts rows older than 30d that the 30d range excludes", async () => {
		const handler = createAnalyticsHandler(context());
		await insertRequest("req-old", Date.now() - 60 * DAY);
		await insertRequest("req-recent", Date.now() - HOUR);

		const bounded = await (
			await handler(new URLSearchParams({ range: "30d" }))
		).json();
		expect(bounded.totals.requests).toBe(1);

		const allTime = await (
			await handler(new URLSearchParams({ range: "all" }))
		).json();
		expect(allTime.totals.requests).toBe(2);
		expect(allTime.meta.range).toBe("all");
		expect(allTime.meta.bucket).toBe("1d");
	});

	it("buckets the all-time time series daily and spans the old rows", async () => {
		const handler = createAnalyticsHandler(context());
		const oldTs = Date.now() - 60 * DAY;
		await insertRequest("req-old", oldTs);
		await insertRequest("req-recent", Date.now() - HOUR);

		const allTime = await (
			await handler(new URLSearchParams({ range: "all" }))
		).json();
		expect(allTime.timeSeries).toHaveLength(2);
		expect(allTime.timeSeries[0].ts).toBe(Math.floor(oldTs / DAY) * DAY);
		expect(allTime.timeSeries[0].requests).toBe(1);
	});

	it("still applies the non-time filters with range=all", async () => {
		const handler = createAnalyticsHandler(context());
		await insertRequest("req-old", Date.now() - 60 * DAY);
		await insertRequest("req-recent", Date.now() - HOUR);

		const errorsOnly = await (
			await handler(new URLSearchParams({ range: "all", status: "error" }))
		).json();
		expect(errorsOnly.totals.requests).toBe(0);
	});
});
