/**
 * Worker round-trip tests for the usage-history and memory-history endpoints
 * (kinds "usage-history" / "memory-history" on the shared read-only dashboard
 * worker). Mirrors stats-worker-isolation.test.ts: real temp DB, the thin
 * main-thread wrappers, and assertions that the wire shape matches what the
 * old main-thread handlers produced. The shaping logic itself is covered by
 * the direct-handler unit tests (usage-history.test.ts / memory-history.test.ts).
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import type {
	MemoryHistoryResponse,
	UsageHistoryResponse,
} from "@clankermux/types";
import {
	clearAnalyticsCachesForTests,
	getAnalyticsCacheStatsForTests,
	terminateAnalyticsWorker,
} from "../analytics-runner";
import { createMemoryHistoryHandler } from "../memory-history";
import { createUsageHistoryHandler } from "../usage-history";
import { makeContext } from "./dashboard-test-helpers";

const HOUR = 60 * 60 * 1000;

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-history-"));
	dbOps = new DatabaseOperations(join(tmpDir, "test.db"));
});

afterEach(async () => {
	clearAnalyticsCachesForTests();
	await dbOps.dispose();
	rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
	terminateAnalyticsWorker();
});

async function insertAccount(id: string, name: string): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority, request_count)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[id, name, "anthropic", "tok", Date.now(), 0, 0],
	);
}

describe("history worker isolation", () => {
	it("serves /api/analytics/usage-history through the SQLite worker with the same shape", async () => {
		const now = Date.now();
		// 24h range buckets hourly; expected ts is the bucket-aligned sample time.
		const expectedTs = Math.floor(now / HOUR) * HOUR;
		await insertAccount("acct-1", "Alpha");
		await dbOps.insertUsageSnapshots([
			{
				accountId: "acct-1",
				provider: "anthropic",
				sampledAt: now,
				fiveHourPct: 42,
				fiveHourReset: now + 2 * HOUR,
				sevenDayPct: 7,
				sevenDayReset: now + 100 * HOUR,
			},
		]);

		const handler = createUsageHistoryHandler(makeContext(dbOps));
		const response = await handler(new URLSearchParams({ range: "24h" }));
		const data = (await response.json()) as UsageHistoryResponse;

		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");
		expect(data.range).toBe("24h");
		expect(data.bucketMs).toBe(HOUR);
		expect(data.series).toHaveLength(1);
		expect(data.series[0]?.accountId).toBe("acct-1");
		expect(data.series[0]?.name).toBe("Alpha");
		expect(data.series[0]?.provider).toBe("anthropic");
		expect(data.series[0]?.points).toEqual([
			{ ts: expectedTs, fiveHourPct: 42, sevenDayPct: 7 },
		]);
		expect(data.pool).toEqual([
			{
				ts: expectedTs,
				fiveHourAvg: 42,
				sevenDayAvg: 7,
				fiveHourMax: 42,
				sevenDayMax: 7,
				sampledCount: 1,
			},
		]);
	});

	it("serves /api/analytics/memory-history through the SQLite worker with the same shape", async () => {
		const now = Date.now();
		const expectedTs = Math.floor(now / HOUR) * HOUR;
		await dbOps.insertMemorySnapshot({
			sampledAt: now,
			rssBytes: 500_000_000,
			heapUsedBytes: 120_000_000,
			heapTotalBytes: 180_000_000,
			eventLoopMaxLagMs: 412,
		});

		const handler = createMemoryHistoryHandler(makeContext(dbOps));
		const response = await handler(new URLSearchParams({ range: "24h" }));
		const data = (await response.json()) as MemoryHistoryResponse;

		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");
		expect(data.range).toBe("24h");
		expect(data.bucketMs).toBe(HOUR);
		expect(data.points).toEqual([
			{
				ts: expectedTs,
				rssBytes: 500_000_000,
				heapUsedBytes: 120_000_000,
				heapTotalBytes: 180_000_000,
				eventLoopMaxLagMs: 412,
			},
		]);
	});

	it("keeps usage-history and memory-history cache entries isolated for identical params", async () => {
		const context = makeContext(dbOps);
		const params = () => new URLSearchParams({ range: "24h" });

		const usageResponse = await createUsageHistoryHandler(context)(params());
		expect(usageResponse.status).toBe(200);

		const memoryResponse = await createMemoryHistoryHandler(context)(params());
		expect(memoryResponse.status).toBe(200);

		// Two distinct cache entries despite identical canonical param strings.
		expect(getAnalyticsCacheStatsForTests().responseCacheSize).toBe(2);
		// Each body keeps its own kind-specific shape.
		const usageData = (await usageResponse.json()) as UsageHistoryResponse;
		const memoryData = (await memoryResponse.json()) as MemoryHistoryResponse;
		expect(usageData.series).toEqual([]);
		expect(usageData.pool).toEqual([]);
		expect(memoryData.points).toEqual([]);
		expect("series" in memoryData).toBe(false);
	});
});
