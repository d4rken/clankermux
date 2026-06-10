import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import { createAnalyticsHandler } from "../analytics";
import {
	clearAnalyticsCachesForTests,
	getAnalyticsCacheStatsForTests,
	terminateAnalyticsWorker,
} from "../analytics-runner";
import { insertRequest, makeContext } from "./dashboard-test-helpers";

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

afterAll(() => {
	terminateAnalyticsWorker();
});

function countOpenFds(): number | null {
	try {
		return readdirSync("/proc/self/fd").length;
	} catch {
		return null;
	}
}

describe("analytics worker isolation", () => {
	it("runs analytics through the SQLite worker and returns data", async () => {
		await insertRequest(dbOps, "req-1", Date.now());

		const response = await createAnalyticsHandler(makeContext(dbOps))(
			new URLSearchParams({ range: "24h" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");
		expect(data.totals.requests).toBe(1);
		expect(data.totals.totalTokens).toBe(10);
	});

	it("caches successful worker-backed analytics briefly", async () => {
		const handler = createAnalyticsHandler(makeContext(dbOps));
		await insertRequest(dbOps, "req-1", Date.now());

		const first = await (
			await handler(new URLSearchParams({ range: "24h" }))
		).json();
		await insertRequest(dbOps, "req-2", Date.now());
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
		const handler = createAnalyticsHandler(makeContext(dbOps));
		await insertRequest(dbOps, "req-1", Date.now());

		await handler(new URLSearchParams({ range: "1h" }));
		await handler(new URLSearchParams({ range: "6h" }));
		await handler(new URLSearchParams({ range: "24h" }));

		expect(
			getAnalyticsCacheStatsForTests().responseCacheSize,
		).toBeLessThanOrEqual(2);
	});

	it("reuses the analytics worker across uncached requests", async () => {
		const before = countOpenFds();
		if (before === null) return;

		const handler = createAnalyticsHandler(makeContext(dbOps));
		await insertRequest(dbOps, "req-1", Date.now());

		for (let i = 0; i < 4; i++) {
			const response = await handler(
				new URLSearchParams({ range: "1h", probe: `fd-${i}` }),
			);
			expect(response.status).toBe(200);
			await response.text();
		}

		const after = countOpenFds();
		expect(after === null ? 0 : after - before).toBeLessThanOrEqual(6);
	});
});
