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
import { TIME_CONSTANTS } from "@clankermux/core";
import { DatabaseOperations } from "@clankermux/database";
import { createAnalyticsHandler } from "../analytics";
import {
	clearAnalyticsCachesForTests,
	getAnalyticsCacheStatsForTests,
	terminateAnalyticsWorker,
} from "../analytics-runner";
import { createStatsHandler } from "../stats";
import { insertRequest, makeContext } from "./dashboard-test-helpers";

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-stats-"));
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

function statsUrl(query = ""): URL {
	return new URL(`http://localhost/api/stats${query}`);
}

async function insertAccount(name: string): Promise<string> {
	const id = crypto.randomUUID();
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority, request_count)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[id, name, "anthropic", "tok", Date.now(), 0, 5],
	);
	return id;
}

async function insertRouting(
	requestId: string,
	affinityScope: string,
	affinityKeyHash: string,
	createdAt: number,
): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO request_routing
			(request_id, strategy, decision, affinity_scope, affinity_key_hash, created_at)
		 VALUES (?, 'session', 'affinity_hit', ?, ?, ?)`,
		[requestId, affinityScope, affinityKeyHash, createdAt],
	);
}

describe("stats worker isolation", () => {
	it("serves /api/stats through the SQLite worker with the same shape", async () => {
		await insertAccount("acct-1");
		await insertRequest(dbOps, "req-ok", Date.now());
		await insertRequest(dbOps, "req-err", Date.now(), {
			success: false,
			errorMessage: "upstream exploded",
		});

		const response = await createStatsHandler(makeContext(dbOps))(statsUrl());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");
		expect(data.totalRequests).toBe(2);
		expect(data.successRate).toBe(50);
		expect(data.activeAccounts).toBe(1);
		expect(data.totalTokens).toBe(20);
		expect(data.totalCostUsd).toBeCloseTo(0.02);
		expect(data.avgResponseTime).toBe(100);
		expect(data.avgTokensPerSecond).toBe(5);
		expect(Array.isArray(data.recentErrors)).toBe(true);
		expect(data.recentErrors).toHaveLength(1);
		expect(data.recentErrors[0].errorCode).toBe("upstream exploded");
		expect(data.recentErrors[0].occurrenceCount).toBe(1);
	});

	it("surfaces active-session counts within the configured window", async () => {
		const now = Date.now();
		await insertRequest(dbOps, "req-session", now);
		await insertRouting("req-session", "claude_session", "hash-a", now);

		const response = await createStatsHandler(makeContext(dbOps))(statsUrl());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.activeSessions.windowMs).toBe(
			TIME_CONSTANTS.ACTIVE_SESSION_WINDOW_MS,
		);
		expect(data.activeSessions.claude).toBe(1);
		expect(data.activeSessions.codex).toBe(0);
		expect(data.activeSessions.other).toBe(0);
		expect(data.activeSessions.total).toBe(1);
	});

	it("keeps stats and analytics cache entries isolated for identical params", async () => {
		await insertRequest(dbOps, "req-1", Date.now());

		const analyticsResponse = await createAnalyticsHandler(makeContext(dbOps))(
			new URLSearchParams({ range: "24h" }),
		);
		expect(analyticsResponse.status).toBe(200);

		const statsResponse = await createStatsHandler(makeContext(dbOps))(
			statsUrl("?range=24h"),
		);
		const statsData = await statsResponse.json();

		expect(statsResponse.status).toBe(200);
		// Two distinct cache entries despite identical canonical param strings.
		expect(getAnalyticsCacheStatsForTests().responseCacheSize).toBe(2);
		// The stats response must be stats-shaped, not the cached analytics body.
		expect(statsData.totalRequests).toBe(1);
		expect(statsData.totals).toBeUndefined();

		// A repeat stats call (served from cache) stays stats-shaped too.
		const cachedStats = await createStatsHandler(makeContext(dbOps))(
			statsUrl("?range=24h"),
		);
		expect(cachedStats.headers.get("x-clankermux-analytics-mode")).toBe(
			"worker-cache",
		);
		expect((await cachedStats.json()).totalRequests).toBe(1);
	});

	it("serves repeat stats reads from cache until the cache is cleared", async () => {
		const handler = createStatsHandler(makeContext(dbOps));
		await insertRequest(dbOps, "req-1", Date.now());

		const first = await (await handler(statsUrl())).json();
		await insertRequest(dbOps, "req-2", Date.now());
		// Within the cache TTL, the second read is served from cache.
		const cached = await (await handler(statsUrl())).json();
		// Dropping the cache forces a fresh worker read, which now sees req-2.
		clearAnalyticsCachesForTests();
		const refreshed = await (await handler(statsUrl())).json();

		expect(first.totalRequests).toBe(1);
		expect(cached.totalRequests).toBe(1);
		expect(refreshed.totalRequests).toBe(2);
	});
});
