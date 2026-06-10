import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import { createAnalyticsHandler } from "../analytics-direct";
import { getRangeConfig } from "../range-config";
import { insertRequest, makeContext } from "./dashboard-test-helpers";

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

describe("getRangeConfig", () => {
	it("maps 'all' to no lookback bound with daily buckets", () => {
		const { windowMs, bucketMs, displayName } = getRangeConfig("all");
		expect(windowMs).toBeNull();
		expect(bucketMs).toBe(DAY);
		expect(displayName).toBe("1d");
	});

	it("keeps the bounded ranges unchanged", () => {
		const { windowMs, bucketMs } = getRangeConfig("30d");
		expect(windowMs).toBe(30 * DAY);
		expect(bucketMs).toBe(DAY);
	});

	it("falls back to the 24h window for garbage input", () => {
		const { windowMs, bucketMs } = getRangeConfig("bogus");
		expect(windowMs).toBe(DAY);
		expect(bucketMs).toBe(HOUR);
	});
});

describe("analytics range=all", () => {
	it("counts rows older than 30d that the 30d range excludes", async () => {
		const handler = createAnalyticsHandler(makeContext(dbOps));
		await insertRequest(dbOps, "req-old", Date.now() - 60 * DAY);
		await insertRequest(dbOps, "req-recent", Date.now() - HOUR);

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
		const handler = createAnalyticsHandler(makeContext(dbOps));
		const oldTs = Date.now() - 60 * DAY;
		await insertRequest(dbOps, "req-old", oldTs);
		await insertRequest(dbOps, "req-recent", Date.now() - HOUR);

		const allTime = await (
			await handler(new URLSearchParams({ range: "all" }))
		).json();
		expect(allTime.timeSeries).toHaveLength(2);
		expect(allTime.timeSeries[0].ts).toBe(Math.floor(oldTs / DAY) * DAY);
		expect(allTime.timeSeries[0].requests).toBe(1);
	});

	it("still applies the non-time filters with range=all", async () => {
		const handler = createAnalyticsHandler(makeContext(dbOps));
		await insertRequest(dbOps, "req-old", Date.now() - 60 * DAY);
		await insertRequest(dbOps, "req-recent", Date.now() - HOUR);

		const errorsOnly = await (
			await handler(new URLSearchParams({ range: "all", status: "error" }))
		).json();
		expect(errorsOnly.totals.requests).toBe(0);
	});
});
