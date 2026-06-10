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
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-project-breakdown-"));
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
	project: string | null;
	success: boolean;
	totalTokens: number;
	costUsd: number;
	billingType: "plan" | "api" | null;
}): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, status_code, success,
			response_time_ms, failover_attempts, model, total_tokens,
			cost_usd, billing_type, project
		) VALUES (?, ?, 'POST', '/v1/messages', ?, ?, 100, 0, 'claude-opus', ?, ?, ?, ?)`,
		[
			opts.id,
			opts.timestamp,
			opts.success ? 200 : 500,
			opts.success,
			opts.totalTokens,
			opts.costUsd,
			opts.billingType,
			opts.project,
		],
	);
}

async function seedRequests(now: number): Promise<void> {
	// Project "alpha" — two rows (one failure) for success-rate + sum checks
	await insertRequest({
		id: "a1",
		timestamp: now - 1000,
		project: "alpha",
		success: true,
		totalTokens: 1000,
		costUsd: 1.0,
		billingType: "plan",
	});
	await insertRequest({
		id: "a2",
		timestamp: now - 2000,
		project: "alpha",
		success: false,
		totalTokens: 500,
		costUsd: 0.5,
		billingType: "api",
	});
	// Project "beta" — largest token sum, must sort first
	await insertRequest({
		id: "b1",
		timestamp: now - 3000,
		project: "beta",
		success: true,
		totalTokens: 3000,
		costUsd: 2.0,
		billingType: "plan",
	});
	// NULL project — must group as one bucket reported as null
	await insertRequest({
		id: "n1",
		timestamp: now - 4000,
		project: null,
		success: true,
		totalTokens: 200,
		costUsd: 0.2,
		billingType: "api",
	});
	await insertRequest({
		id: "n2",
		timestamp: now - 5000,
		project: null,
		success: false,
		totalTokens: 100,
		costUsd: 0,
		billingType: "api",
	});
	// Literal "no-project" project name — must stay a distinct, filterable
	// name and never merge with the NULL bucket (no in-band sentinel).
	await insertRequest({
		id: "lp1",
		timestamp: now - 6000,
		project: "no-project",
		success: true,
		totalTokens: 50,
		costUsd: 0.05,
		billingType: "api",
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

describe("analytics projectBreakdown", () => {
	it("groups by project incl. a null bucket distinct from a literal 'no-project' name, ordered by total tokens", async () => {
		await seedRequests(Date.now());

		const data = await fetchAnalytics({});

		expect(data.projectBreakdown).toEqual([
			{
				project: "beta",
				requests: 1,
				successRate: 100,
				planCostUsd: 2.0,
				apiCostUsd: 0,
				totalCostUsd: 2.0,
				totalTokens: 3000,
			},
			{
				project: "alpha",
				requests: 2,
				successRate: 50,
				planCostUsd: 1.0,
				apiCostUsd: 0.5,
				totalCostUsd: 1.5,
				totalTokens: 1500,
			},
			{
				project: null,
				requests: 2,
				successRate: 50,
				planCostUsd: 0,
				apiCostUsd: 0.2,
				totalCostUsd: 0.2,
				totalTokens: 300,
			},
			{
				project: "no-project",
				requests: 1,
				successRate: 100,
				planCostUsd: 0,
				apiCostUsd: 0.05,
				totalCostUsd: 0.05,
				totalTokens: 50,
			},
		]);
	});

	it("filters totals, timeSeries, and the breakdown by named projects", async () => {
		await seedRequests(Date.now());

		const data = await fetchAnalytics({ projects: "alpha" });

		expect(data.totals.requests).toBe(2);
		expect(data.totals.totalTokens).toBe(1500);
		const seriesRequests = data.timeSeries.reduce(
			(sum: number, point: { requests: number }) => sum + point.requests,
			0,
		);
		expect(seriesRequests).toBe(2);
		expect(data.projectBreakdown).toHaveLength(1);
		expect(data.projectBreakdown[0].project).toBe("alpha");
	});

	it("selects only NULL-project rows with projectsNone=true", async () => {
		await seedRequests(Date.now());

		const data = await fetchAnalytics({ projectsNone: "true" });

		expect(data.totals.requests).toBe(2);
		expect(data.totals.totalTokens).toBe(300);
		expect(data.projectBreakdown).toHaveLength(1);
		expect(data.projectBreakdown[0].project).toBeNull();
	});

	it("combines a literal 'no-project' name filter with the NULL bucket without pulling in others", async () => {
		await seedRequests(Date.now());

		const data = await fetchAnalytics({
			projects: "no-project",
			projectsNone: "true",
		});

		expect(data.totals.requests).toBe(3);
		expect(data.totals.totalTokens).toBe(350);
		const projects = data.projectBreakdown.map(
			(row: { project: string | null }) => row.project,
		);
		expect(projects).toHaveLength(2);
		expect(projects).toContain("no-project");
		expect(projects).toContain(null);
	});

	it("returns an empty projectBreakdown array when there are no requests in range", async () => {
		const data = await fetchAnalytics({});
		expect(data.projectBreakdown).toEqual([]);
	});

	it("counts NULL billing_type rows as token (api) cost in totals, timeSeries, accountPerformance, and projectBreakdown", async () => {
		// Pre-billing_type history has billing_type IS NULL. A bare
		// `billing_type != 'plan'` predicate evaluates to NULL for those rows and
		// silently drops their cost from every "Token Cost" series while the
		// payments summary still counts them; the COALESCE(billing_type, 'api')
		// form keeps them in the api bucket.
		const now = Date.now();
		await insertRequest({
			id: "nb1",
			timestamp: now - 1000,
			project: "gamma",
			success: true,
			totalTokens: 100,
			costUsd: 0.75,
			billingType: null,
		});
		await insertRequest({
			id: "nb2",
			timestamp: now - 2000,
			project: "gamma",
			success: true,
			totalTokens: 100,
			costUsd: 1.25,
			billingType: "plan",
		});

		const data = await fetchAnalytics({});

		expect(data.totals.apiCostUsd).toBeCloseTo(0.75, 6);
		expect(data.totals.planCostUsd).toBeCloseTo(1.25, 6);
		expect(data.totals.avgDailyApiCostUsd).toBeGreaterThan(0);

		const seriesApiCost = data.timeSeries.reduce(
			(sum: number, point: { apiCostUsd: number }) => sum + point.apiCostUsd,
			0,
		);
		expect(seriesApiCost).toBeCloseTo(0.75, 6);

		// No account_used set, so both rows group under the no-account bucket.
		expect(data.accountPerformance).toHaveLength(1);
		expect(data.accountPerformance[0].apiCostUsd).toBeCloseTo(0.75, 6);
		expect(data.accountPerformance[0].planCostUsd).toBeCloseTo(1.25, 6);

		expect(data.projectBreakdown).toHaveLength(1);
		expect(data.projectBreakdown[0].project).toBe("gamma");
		expect(data.projectBreakdown[0].apiCostUsd).toBeCloseTo(0.75, 6);
		expect(data.projectBreakdown[0].planCostUsd).toBeCloseTo(1.25, 6);
		expect(data.projectBreakdown[0].totalCostUsd).toBeCloseTo(2.0, 6);
	});
});
