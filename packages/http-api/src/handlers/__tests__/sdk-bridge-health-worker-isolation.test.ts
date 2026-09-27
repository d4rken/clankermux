/**
 * `/api/analytics/sdk-bridge-health` through the dashboard worker, whose
 * synthetic APIContext carries only `getAdapter()`. The 200 alone would also
 * come from the main-thread fallback; `x-clankermux-analytics-mode: worker`
 * is what shows the read ran off-thread.
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
import type { SdkBridgeHealthResponse } from "@clankermux/types";
import {
	clearAnalyticsCachesForTests,
	getAnalyticsCacheStatsForTests,
	terminateAnalyticsWorker,
} from "../analytics-runner";
import { createSdkBridgeHealthHandler } from "../sdk-bridge-health";
import { makeContext } from "./dashboard-test-helpers";

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-sdk-bridge-health-"));
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

describe("sdk-bridge-health worker isolation", () => {
	it("serves the endpoint through the SQLite worker", async () => {
		const now = Date.now();
		await dbOps.sdkBridgeTurns.insertTurn({
			id: "turn-1",
			startedAt: now - 60_000,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
			clientHarness: "pi",
		});
		await dbOps.sdkBridgeTurns.finishTurn("turn-1", {
			finishedAt: now - 50_000,
			status: "failed",
			httpStatus: 529,
			errorType: "overloaded_error",
		});

		const handler = createSdkBridgeHealthHandler(makeContext(dbOps));
		const response = await handler(new URLSearchParams({ range: "24h" }));

		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");
		const data = (await response.json()) as SdkBridgeHealthResponse;
		expect(data.byStatus.failed).toBe(1);
		expect(data.recentFailures.map((f) => f.id)).toEqual(["turn-1"]);
	});

	it("joins concurrent reads of one range onto one job", async () => {
		const handler = createSdkBridgeHealthHandler(makeContext(dbOps));
		const params = new URLSearchParams({ range: "24h" });
		const first = handler(params);
		const second = handler(params);
		expect(getAnalyticsCacheStatsForTests().inFlightSize).toBe(1);
		const [a, b] = await Promise.all([first, second]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
	});
});
