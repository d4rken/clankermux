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
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-tool-errors-"));
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

async function insertRequest(opts: {
	id: string;
	timestamp: number;
	project?: string | null;
	model?: string;
	success?: boolean;
}): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, status_code, success,
			response_time_ms, failover_attempts, model, project
		) VALUES (?, ?, 'POST', '/v1/messages', 200, ?, 100, 0, ?, ?)`,
		[
			opts.id,
			opts.timestamp,
			opts.success ?? true,
			opts.model ?? "claude-opus",
			opts.project ?? null,
		],
	);
}

async function insertToolCalls(
	requestId: string,
	toolName: string,
	callCount: number,
	errorCount: number,
): Promise<void> {
	await dbOps
		.getAdapter()
		.run(
			`INSERT INTO request_tool_calls (request_id, tool_name, call_count, error_count) VALUES (?, ?, ?, ?)`,
			[requestId, toolName, callCount, errorCount],
		);
}

async function insertToolError(
	requestId: string,
	toolName: string,
	errorText: string | null,
): Promise<void> {
	await dbOps
		.getAdapter()
		.run(
			`INSERT INTO request_tool_errors (request_id, tool_name, error_text) VALUES (?, ?, ?)`,
			[requestId, toolName, errorText],
		);
}

const HOUR = 60 * 60 * 1000;

// Mid-bucket anchor so seeds at base±minutes never straddle an hour boundary
// (the 24h range buckets by 1h, mirroring the timeSeries query).
function bucketBase(): number {
	return Math.floor(Date.now() / HOUR) * HOUR;
}

async function seedRequests(base: number): Promise<void> {
	// alpha project, current-hour bucket: Bash heavy with errors, Read clean.
	await insertRequest({
		id: "r1",
		timestamp: base + 10 * 60 * 1000,
		project: "alpha",
	});
	await insertToolCalls("r1", "Bash", 4, 2);
	await insertToolCalls("r1", "Read", 6, 0);
	await insertToolError("r1", "Bash", "command not found: foo");
	await insertToolError("r1", "Bash", "permission denied");

	// beta project, previous-hour bucket: more Bash errors + a Write error.
	await insertRequest({
		id: "r2",
		timestamp: base - HOUR + 20 * 60 * 1000,
		project: "beta",
	});
	await insertToolCalls("r2", "Bash", 3, 1);
	await insertToolCalls("r2", "Write", 2, 1);
	await insertToolError("r2", "Bash", "command not found: foo");
	await insertToolError("r2", "Write", "file has not been read yet");

	// Out-of-range request (older than the 24h window) — must never aggregate.
	await insertRequest({
		id: "r-old",
		timestamp: base - 48 * HOUR,
		project: "alpha",
	});
	await insertToolCalls("r-old", "Bash", 100, 100);
	await insertToolError("r-old", "Bash", "ancient failure");
}

async function fetchAnalytics(
	params: Record<string, string>,
): Promise<ReturnType<JSON["parse"]>> {
	const response = await createAnalyticsHandler(context())(
		new URLSearchParams({ range: "24h", ...params }),
	);
	expect(response.status).toBe(200);
	return response.json();
}

describe("analytics toolCallErrors", () => {
	it("returns an empty-but-present section when the tool tables have no rows", async () => {
		await insertRequest({ id: "bare", timestamp: bucketBase() });

		const data = await fetchAnalytics({});

		expect(data.toolCallErrors).toEqual({
			byTool: [],
			timeSeries: [],
			topMessages: [],
		});
	});

	it("aggregates per-tool totals and error rate, excluding out-of-range requests", async () => {
		await seedRequests(bucketBase());

		const data = await fetchAnalytics({});
		const byTool = data.toolCallErrors.byTool;

		// Ordered by total_errors DESC, then total_calls DESC.
		expect(byTool).toEqual([
			{
				toolName: "Bash",
				totalCalls: 7, // r1: 4 + r2: 3 (r-old's 100 excluded by range)
				totalErrors: 3,
				errorRatePct: (3 / 7) * 100,
			},
			{
				toolName: "Write",
				totalCalls: 2,
				totalErrors: 1,
				errorRatePct: 50,
			},
			{
				toolName: "Read",
				totalCalls: 6,
				totalErrors: 0,
				errorRatePct: 0,
			},
		]);
	});

	it("buckets the time series by hour per tool", async () => {
		const base = bucketBase();
		await seedRequests(base);

		const data = await fetchAnalytics({});
		const series = data.toolCallErrors.timeSeries;

		const point = (ts: number, toolName: string) =>
			series.find(
				(p: { ts: number; toolName: string }) =>
					p.ts === ts && p.toolName === toolName,
			);

		expect(point(base - HOUR, "Bash")).toEqual({
			ts: base - HOUR,
			toolName: "Bash",
			calls: 3,
			errors: 1,
		});
		expect(point(base - HOUR, "Write")).toEqual({
			ts: base - HOUR,
			toolName: "Write",
			calls: 2,
			errors: 1,
		});
		expect(point(base, "Bash")).toEqual({
			ts: base,
			toolName: "Bash",
			calls: 4,
			errors: 2,
		});
		expect(point(base, "Read")).toEqual({
			ts: base,
			toolName: "Read",
			calls: 6,
			errors: 0,
		});
		expect(series).toHaveLength(4);
		// Ordered by ts ascending.
		const timestamps = series.map((p: { ts: number }) => p.ts);
		expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
	});

	it("restricts the time series to the top 5 tools by error count", async () => {
		const base = bucketBase();
		// t1 gets 7 errors, t2 gets 6, ... t7 gets 1: top 5 = t1..t5.
		for (let t = 1; t <= 7; t++) {
			const id = `req-t${t}`;
			await insertRequest({ id, timestamp: base + t * 60 * 1000 });
			await insertToolCalls(id, `t${t}`, 10, 8 - t);
		}

		const data = await fetchAnalytics({});
		const tools = new Set(
			data.toolCallErrors.timeSeries.map(
				(p: { toolName: string }) => p.toolName,
			),
		);

		expect(tools).toEqual(new Set(["t1", "t2", "t3", "t4", "t5"]));
		// byTool is not top-5 restricted (limit 30) — all seven appear there.
		expect(data.toolCallErrors.byTool).toHaveLength(7);
	});

	it("groups topMessages by (tool, error text) with occurrence counts, skipping NULL texts", async () => {
		const base = bucketBase();
		await seedRequests(base);
		// A NULL error text carries no signal and must be skipped.
		await insertRequest({ id: "r3", timestamp: base + 30 * 60 * 1000 });
		await insertToolCalls("r3", "Bash", 1, 1);
		await insertToolError("r3", "Bash", null);

		const data = await fetchAnalytics({});
		const topMessages = data.toolCallErrors.topMessages;

		expect(topMessages[0]).toEqual({
			toolName: "Bash",
			errorText: "command not found: foo",
			occurrences: 2, // r1 + r2 (r-old excluded by range)
		});
		expect(topMessages).toHaveLength(3);
		expect(topMessages.slice(1)).toEqual(
			expect.arrayContaining([
				{
					toolName: "Bash",
					errorText: "permission denied",
					occurrences: 1,
				},
				{
					toolName: "Write",
					errorText: "file has not been read yet",
					occurrences: 1,
				},
			]),
		);
	});

	it("caps topMessages per tool so a noisy tool cannot crowd out others", async () => {
		const base = bucketBase();
		// Tool A: 25 distinct error texts — more than the per-tool cap (20).
		await insertRequest({ id: "noisy", timestamp: base + 60 * 1000 });
		await insertToolCalls("noisy", "A", 25, 25);
		for (let i = 0; i < 25; i++) {
			await insertToolError("noisy", "A", `A failure variant ${i}`);
		}
		// Tool B: a single error text that must survive A's flood.
		await insertRequest({ id: "quiet", timestamp: base + 2 * 60 * 1000 });
		await insertToolCalls("quiet", "B", 1, 1);
		await insertToolError("quiet", "B", "B lone failure");

		const data = await fetchAnalytics({});
		const topMessages = data.toolCallErrors.topMessages as {
			toolName: string;
			errorText: string;
			occurrences: number;
		}[];

		const aRows = topMessages.filter((m) => m.toolName === "A");
		const bRows = topMessages.filter((m) => m.toolName === "B");
		expect(aRows.length).toBeLessThanOrEqual(20);
		expect(bRows).toEqual([
			{ toolName: "B", errorText: "B lone failure", occurrences: 1 },
		]);
	});

	it("constrains all three sections with the projects filter via the requests join", async () => {
		const base = bucketBase();
		await seedRequests(base);

		const data = await fetchAnalytics({ projects: "beta" });
		const tce = data.toolCallErrors;

		expect(tce.byTool).toHaveLength(2);
		expect(tce.byTool[0]).toMatchObject({
			toolName: "Bash",
			totalCalls: 3,
			totalErrors: 1,
		});
		expect(tce.byTool[0].errorRatePct).toBeCloseTo((1 / 3) * 100, 10);
		expect(tce.byTool[1]).toEqual({
			toolName: "Write",
			totalCalls: 2,
			totalErrors: 1,
			errorRatePct: 50,
		});
		expect(
			tce.timeSeries.every((p: { ts: number }) => p.ts === base - HOUR),
		).toBe(true);
		expect(tce.timeSeries).toHaveLength(2);
		expect(tce.topMessages).toEqual(
			expect.arrayContaining([
				{
					toolName: "Bash",
					errorText: "command not found: foo",
					occurrences: 1,
				},
				{
					toolName: "Write",
					errorText: "file has not been read yet",
					occurrences: 1,
				},
			]),
		);
		expect(tce.topMessages).toHaveLength(2);
	});

	it("constrains the section with the models filter", async () => {
		const base = bucketBase();
		await insertRequest({
			id: "m1",
			timestamp: base + 60 * 1000,
			model: "claude-opus",
		});
		await insertToolCalls("m1", "Bash", 2, 1);
		await insertRequest({
			id: "m2",
			timestamp: base + 2 * 60 * 1000,
			model: "claude-sonnet",
		});
		await insertToolCalls("m2", "Bash", 5, 5);

		const data = await fetchAnalytics({ models: "claude-opus" });

		expect(data.toolCallErrors.byTool).toEqual([
			{
				toolName: "Bash",
				totalCalls: 2,
				totalErrors: 1,
				errorRatePct: 50,
			},
		]);
	});
});
