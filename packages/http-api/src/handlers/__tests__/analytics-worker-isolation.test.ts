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
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-analytics-"));
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

	it("serves repeat analytics reads from cache until the cache is cleared", async () => {
		const handler = createAnalyticsHandler(makeContext(dbOps));
		await insertRequest(dbOps, "req-1", Date.now());

		const first = await (
			await handler(new URLSearchParams({ range: "24h" }))
		).json();
		await insertRequest(dbOps, "req-2", Date.now());
		// Within the cache TTL, the second read is served from cache and does not
		// reflect req-2.
		const cached = await (
			await handler(new URLSearchParams({ range: "24h" }))
		).json();
		// Dropping the cache forces a fresh worker read, which now sees req-2.
		clearAnalyticsCachesForTests();
		const refreshed = await (
			await handler(new URLSearchParams({ range: "24h" }))
		).json();

		expect(first.totals.requests).toBe(1);
		expect(cached.totals.requests).toBe(1);
		expect(refreshed.totals.requests).toBe(2);
	});

	it("caches distinct filter combinations as separate entries", async () => {
		const handler = createAnalyticsHandler(makeContext(dbOps));
		await insertRequest(dbOps, "req-1", Date.now());

		await handler(new URLSearchParams({ range: "1h" }));
		await handler(new URLSearchParams({ range: "6h" }));
		await handler(new URLSearchParams({ range: "24h" }));

		expect(getAnalyticsCacheStatsForTests().responseCacheSize).toBe(3);
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
