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
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-context-composition-"));
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

interface InsertComposition {
	systemChars: number;
	toolsChars: number;
	toolCount: number;
	messagesChars: number;
	messageCount: number;
	toolResultChars: number;
	largestToolChars: number;
	largestToolName: string | null;
}

async function insertRequest(opts: {
	id: string;
	timestamp: number;
	project?: string | null;
	model?: string;
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	// null = not recorded (all 8 context_* columns stay NULL)
	composition: InsertComposition | null;
}): Promise<void> {
	const c = opts.composition;
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, status_code, success,
			response_time_ms, failover_attempts, model, project,
			input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
			context_system_chars, context_tools_chars, context_tool_count,
			context_messages_chars, context_message_count,
			context_tool_result_chars, context_largest_tool_chars,
			context_largest_tool_name
		) VALUES (?, ?, 'POST', '/v1/messages', 200, TRUE, 100, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			opts.id,
			opts.timestamp,
			opts.model ?? "claude-opus",
			opts.project ?? null,
			opts.inputTokens ?? 0,
			opts.cacheReadTokens ?? 0,
			opts.cacheCreationTokens ?? 0,
			c?.systemChars ?? null,
			c?.toolsChars ?? null,
			c?.toolCount ?? null,
			c?.messagesChars ?? null,
			c?.messageCount ?? null,
			c?.toolResultChars ?? null,
			c?.largestToolChars ?? null,
			c?.largestToolName ?? null,
		],
	);
}

const HOUR = 60 * 60 * 1000;

// Mid-bucket anchor so seeds at base±minutes never straddle an hour boundary
// (the 24h range buckets by 1h, mirroring the timeSeries query).
function bucketBase(): number {
	return Math.floor(Date.now() / HOUR) * HOUR;
}

async function seedRequests(base: number): Promise<void> {
	// Covered rows (composition recorded)
	await insertRequest({
		id: "c1",
		timestamp: base + 10 * 60 * 1000,
		project: "alpha",
		inputTokens: 100,
		cacheReadTokens: 200,
		cacheCreationTokens: 50, // ctx tokens = 350
		composition: {
			systemChars: 1000,
			toolsChars: 500,
			toolCount: 5,
			messagesChars: 2000,
			messageCount: 4,
			toolResultChars: 800,
			largestToolChars: 600,
			largestToolName: "Read",
		},
	});
	// Zero-valued buckets are valid recorded values: this row is covered even
	// though toolsChars/toolResultChars/largestToolChars are all 0.
	await insertRequest({
		id: "c2",
		timestamp: base + 20 * 60 * 1000,
		project: "alpha",
		inputTokens: 50, // ctx tokens = 50
		composition: {
			systemChars: 500,
			toolsChars: 0,
			toolCount: 0,
			messagesChars: 1000,
			messageCount: 2,
			toolResultChars: 0,
			largestToolChars: 0,
			largestToolName: null,
		},
	});
	await insertRequest({
		id: "c3",
		timestamp: base + 5 * 60 * 1000,
		project: null,
		inputTokens: 10,
		cacheReadTokens: 20, // ctx tokens = 30
		composition: {
			systemChars: 300,
			toolsChars: 100,
			toolCount: 1,
			messagesChars: 600,
			messageCount: 1,
			toolResultChars: 50,
			largestToolChars: 50,
			largestToolName: "Bash",
		},
	});
	// Uncovered rows (composition NULL — pre-feature history); their large token
	// counts must NOT leak into the covered-only aggregates, but MUST appear in
	// the growth curve. Placed in the previous hour bucket.
	await insertRequest({
		id: "u1",
		timestamp: base - HOUR + 10 * 60 * 1000,
		project: "beta",
		inputTokens: 1000,
		cacheReadTokens: 1000,
		cacheCreationTokens: 1000, // ctx tokens = 3000
		composition: null,
	});
	await insertRequest({
		id: "u2",
		timestamp: base - HOUR + 20 * 60 * 1000,
		project: "alpha",
		inputTokens: 400, // ctx tokens = 400
		composition: null,
	});
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

describe("analytics contextComposition", () => {
	it("reports coverage as covered rows vs all filtered rows", async () => {
		await seedRequests(bucketBase());

		const data = await fetchAnalytics({});

		expect(data.contextComposition.coverage).toEqual({
			withComposition: 3,
			totalRequests: 5,
		});
	});

	it("sums totals and averages per request over covered rows, counting zero-valued buckets", async () => {
		await seedRequests(bucketBase());

		const data = await fetchAnalytics({});
		const { totals, avgPerRequest } = data.contextComposition;

		expect(totals.systemChars).toBe(1800);
		expect(totals.toolsChars).toBe(600);
		expect(totals.messagesChars).toBe(3600);
		expect(totals.toolResultChars).toBe(850);
		expect(avgPerRequest.systemChars).toBeCloseTo(600, 5);
		expect(avgPerRequest.toolsChars).toBeCloseTo(200, 5);
		expect(avgPerRequest.messagesChars).toBeCloseTo(1200, 5);
		expect(avgPerRequest.messageCount).toBeCloseTo(7 / 3, 5);
	});

	it("computes contextTokens/avgContextTokens over covered rows ONLY", async () => {
		await seedRequests(bucketBase());

		const data = await fetchAnalytics({});
		const { totals } = data.contextComposition;

		// u1 (3000) and u2 (400) are uncovered and must be excluded.
		expect(totals.contextTokens).toBe(430);
		expect(totals.avgContextTokens).toBeCloseTo(430 / 3, 5);
	});

	it("groups byProject over covered rows incl. a null-project bucket, ordered by requests", async () => {
		await seedRequests(bucketBase());

		const data = await fetchAnalytics({});
		const byProject = data.contextComposition.byProject;

		expect(byProject).toHaveLength(2);
		expect(byProject[0]).toEqual({
			project: "alpha",
			requests: 2, // covered alpha rows only — u2 is uncovered
			avgContextTokens: 200,
			avgSystemChars: 750,
			avgToolsChars: 250,
			avgMessagesChars: 1500,
		});
		expect(byProject[1]).toEqual({
			project: null,
			requests: 1,
			avgContextTokens: 30,
			avgSystemChars: 300,
			avgToolsChars: 100,
			avgMessagesChars: 600,
		});
	});

	it("builds the growth curve over ALL rows (incl. uncovered) with time bucketing", async () => {
		const base = bucketBase();
		await seedRequests(base);

		const data = await fetchAnalytics({});
		const curve = data.contextComposition.growthCurve;

		const point = (ts: number, project: string | null) =>
			curve.find(
				(p: { ts: number; project: string | null }) =>
					p.ts === ts && p.project === project,
			);

		// Previous-hour bucket: uncovered rows still chart (token columns only).
		expect(point(base - HOUR, "beta")).toEqual({
			ts: base - HOUR,
			project: "beta",
			avgContextTokens: 3000,
			maxContextTokens: 3000,
			requests: 1,
		});
		expect(point(base - HOUR, "alpha")).toEqual({
			ts: base - HOUR,
			project: "alpha",
			avgContextTokens: 400,
			maxContextTokens: 400,
			requests: 1,
		});
		// Current-hour bucket: covered rows aggregate per project.
		expect(point(base, "alpha")).toEqual({
			ts: base,
			project: "alpha",
			avgContextTokens: 200,
			maxContextTokens: 350,
			requests: 2,
		});
		expect(point(base, null)).toEqual({
			ts: base,
			project: null,
			avgContextTokens: 30,
			maxContextTokens: 30,
			requests: 1,
		});
		expect(curve).toHaveLength(4);
		// Ordered by ts ascending.
		const timestamps = curve.map((p: { ts: number }) => p.ts);
		expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
	});

	it("restricts the growth curve to the top 5 projects by request count", async () => {
		const base = bucketBase();
		// p1 gets 7 requests, p2 gets 6, ... p7 gets 1: top 5 = p1..p5.
		for (let p = 1; p <= 7; p++) {
			for (let i = 0; i < 8 - p; i++) {
				await insertRequest({
					id: `p${p}-r${i}`,
					timestamp: base + (p * 60 + i) * 1000,
					project: `p${p}`,
					inputTokens: 10,
					composition: null,
				});
			}
		}

		const data = await fetchAnalytics({});
		const projects = new Set(
			data.contextComposition.growthCurve.map(
				(point: { project: string | null }) => point.project,
			),
		);

		expect(projects).toEqual(new Set(["p1", "p2", "p3", "p4", "p5"]));
	});

	it("lists top tool contributors excluding NULL and zero-char rows, ordered desc", async () => {
		const base = bucketBase();
		await seedRequests(base);

		const data = await fetchAnalytics({});
		const contributors = data.contextComposition.topToolContributors;

		expect(contributors).toEqual([
			{
				requestId: "c1",
				ts: base + 10 * 60 * 1000,
				project: "alpha",
				model: "claude-opus",
				toolName: "Read",
				chars: 600,
			},
			{
				requestId: "c3",
				ts: base + 5 * 60 * 1000,
				project: null,
				model: "claude-opus",
				toolName: "Bash",
				chars: 50,
			},
		]);
	});

	it("constrains all three sections with the projects filter", async () => {
		const base = bucketBase();
		await seedRequests(base);

		const data = await fetchAnalytics({ projects: "alpha" });
		const cc = data.contextComposition;

		expect(cc.coverage).toEqual({ withComposition: 2, totalRequests: 3 });
		expect(cc.totals.contextTokens).toBe(400);
		expect(cc.totals.systemChars).toBe(1500);
		expect(cc.byProject).toHaveLength(1);
		expect(cc.byProject[0].project).toBe("alpha");
		expect(
			cc.growthCurve.every(
				(point: { project: string | null }) => point.project === "alpha",
			),
		).toBe(true);
		expect(cc.growthCurve).toHaveLength(2);
		expect(cc.topToolContributors).toHaveLength(1);
		expect(cc.topToolContributors[0].requestId).toBe("c1");
	});

	it("returns an empty-but-present section when there are no requests in range", async () => {
		const data = await fetchAnalytics({});
		const cc = data.contextComposition;

		expect(cc.coverage).toEqual({ withComposition: 0, totalRequests: 0 });
		expect(cc.totals).toEqual({
			systemChars: 0,
			toolsChars: 0,
			messagesChars: 0,
			toolResultChars: 0,
			contextTokens: 0,
			avgContextTokens: 0,
		});
		expect(cc.byProject).toEqual([]);
		expect(cc.growthCurve).toEqual([]);
		expect(cc.topToolContributors).toEqual([]);
	});
});
