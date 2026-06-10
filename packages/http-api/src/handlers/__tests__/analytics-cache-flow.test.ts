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
import { NO_ACCOUNT_ID } from "@clankermux/types";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics";
import {
	clearAnalyticsCachesForTests,
	terminateAnalyticsWorker,
} from "../analytics-runner";

let tmpDir: string;
let dbOps: DatabaseOperations;

beforeEach(() => {
	clearAnalyticsCachesForTests();
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-cache-flow-"));
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

function context(): APIContext {
	return {
		db: dbOps.getAdapter(),
		config: {} as APIContext["config"],
		dbOps,
	};
}

async function insertAccount(id: string, name: string): Promise<void> {
	await dbOps
		.getAdapter()
		.run("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)", [
			id,
			name,
			Date.now(),
		]);
}

async function insertRequest(opts: {
	id: string;
	timestamp: number;
	model: string | null;
	accountUsed: string | null;
	inputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
}): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			response_time_ms, failover_attempts, model, input_tokens,
			cache_read_input_tokens, cache_creation_input_tokens, output_tokens
		) VALUES (?, ?, 'POST', '/v1/messages', ?, 200, TRUE, 100, 0, ?, ?, ?, ?, 1)`,
		[
			opts.id,
			opts.timestamp,
			opts.accountUsed,
			opts.model,
			opts.inputTokens,
			opts.cacheReadTokens,
			opts.cacheWriteTokens,
		],
	);
}

describe("analytics cacheFlow", () => {
	it("sums disjoint cache buckets per (model, account), labels NULLs, sorts by total tokens, and respects the time range", async () => {
		const now = Date.now();
		await insertAccount("acc-1", "Alpha");
		await insertAccount("acc-2", "Beta");

		// claude-opus × Alpha — two rows that must be summed
		await insertRequest({
			id: "req-1",
			timestamp: now - 1000,
			model: "claude-opus",
			accountUsed: "acc-1",
			inputTokens: 100,
			cacheReadTokens: 1000,
			cacheWriteTokens: 50,
		});
		await insertRequest({
			id: "req-2",
			timestamp: now - 2000,
			model: "claude-opus",
			accountUsed: "acc-1",
			inputTokens: 10,
			cacheReadTokens: 200,
			cacheWriteTokens: 5,
		});
		// claude-opus × Beta
		await insertRequest({
			id: "req-3",
			timestamp: now - 3000,
			model: "claude-opus",
			accountUsed: "acc-2",
			inputTokens: 30,
			cacheReadTokens: 300,
			cacheWriteTokens: 10,
		});
		// claude-sonnet × Beta — largest total, must sort first; NULL cache
		// columns must coalesce to 0
		await insertRequest({
			id: "req-4",
			timestamp: now - 4000,
			model: "claude-sonnet",
			accountUsed: "acc-2",
			inputTokens: 5000,
			cacheReadTokens: null,
			cacheWriteTokens: null,
		});
		// NULL model × Alpha — model must get a non-null label
		await insertRequest({
			id: "req-5",
			timestamp: now - 5000,
			model: null,
			accountUsed: "acc-1",
			inputTokens: 7,
			cacheReadTokens: 3,
			cacheWriteTokens: 2,
		});
		// Literal "unknown" model × Alpha — must merge into the same group as
		// the NULL-model row above (GROUP BY must bind to the COALESCE alias,
		// not the raw r.model column).
		await insertRequest({
			id: "req-7",
			timestamp: now - 5500,
			model: "unknown",
			accountUsed: "acc-1",
			inputTokens: 1,
			cacheReadTokens: 1,
			cacheWriteTokens: 1,
		});
		// claude-sonnet × NULL account — account must get the no-account label
		await insertRequest({
			id: "req-6",
			timestamp: now - 6000,
			model: "claude-sonnet",
			accountUsed: null,
			inputTokens: 20,
			cacheReadTokens: 30,
			cacheWriteTokens: 40,
		});
		// Outside the 24h range — must be excluded entirely
		await insertRequest({
			id: "req-old",
			timestamp: now - 48 * 60 * 60 * 1000,
			model: "claude-opus",
			accountUsed: "acc-1",
			inputTokens: 999_999,
			cacheReadTokens: 999_999,
			cacheWriteTokens: 999_999,
		});

		const response = await createAnalyticsHandler(context())(
			new URLSearchParams({ range: "24h" }),
		);
		expect(response.status).toBe(200);
		const data = await response.json();

		// Sorted by (read + write + uncached) total descending.
		expect(data.cacheFlow).toEqual([
			{
				model: "claude-sonnet",
				accountName: "Beta",
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				uncachedTokens: 5000,
			},
			{
				model: "claude-opus",
				accountName: "Alpha",
				cacheReadTokens: 1200,
				cacheWriteTokens: 55,
				uncachedTokens: 110,
			},
			{
				model: "claude-opus",
				accountName: "Beta",
				cacheReadTokens: 300,
				cacheWriteTokens: 10,
				uncachedTokens: 30,
			},
			{
				model: "claude-sonnet",
				accountName: NO_ACCOUNT_ID,
				cacheReadTokens: 30,
				cacheWriteTokens: 40,
				uncachedTokens: 20,
			},
			{
				model: "unknown",
				accountName: "Alpha",
				cacheReadTokens: 4,
				cacheWriteTokens: 3,
				uncachedTokens: 8,
			},
		]);
	});

	it("returns an empty cacheFlow array when there are no requests in range", async () => {
		const response = await createAnalyticsHandler(context())(
			new URLSearchParams({ range: "24h" }),
		);
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.cacheFlow).toEqual([]);
	});
});
