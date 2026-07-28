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
import type { ProjectAttributionSource } from "@clankermux/types";
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
	/** Omitted = a legacy row written before the column existed (SQL NULL). */
	attributionSource?: ProjectAttributionSource;
}): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, status_code, success,
			response_time_ms, failover_attempts, model, total_tokens,
			cost_usd, billing_type, project, project_attribution_source
		) VALUES (?, ?, 'POST', '/v1/messages', ?, ?, 100, 0, 'claude-opus', ?, ?, ?, ?, ?)`,
		[
			opts.id,
			opts.timestamp,
			opts.success ? 200 : 500,
			opts.success,
			opts.totalTokens,
			opts.costUsd,
			opts.billingType,
			opts.project,
			opts.attributionSource ?? null,
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
				measuredRequests: 0,
				inferredRequests: 0,
				ambiguousRequests: 0,
			},
			{
				project: "alpha",
				requests: 2,
				successRate: 50,
				planCostUsd: 1.0,
				apiCostUsd: 0.5,
				totalCostUsd: 1.5,
				totalTokens: 1500,
				measuredRequests: 0,
				inferredRequests: 0,
				ambiguousRequests: 0,
			},
			{
				project: null,
				requests: 2,
				successRate: 50,
				planCostUsd: 0,
				apiCostUsd: 0.2,
				totalCostUsd: 0.2,
				totalTokens: 300,
				measuredRequests: 0,
				inferredRequests: 0,
				ambiguousRequests: 0,
			},
			{
				project: "no-project",
				requests: 1,
				successRate: 100,
				planCostUsd: 0,
				apiCostUsd: 0.05,
				totalCostUsd: 0.05,
				totalTokens: 50,
				measuredRequests: 0,
				inferredRequests: 0,
				ambiguousRequests: 0,
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
		// The no-project branch is an ungrouped aggregate, so its HAVING guard
		// is what keeps an all-NULL placeholder row out of the empty result.
		expect(data.projectBreakdown).toEqual([]);
		expect(data.projectAttributionCoverage).toEqual({
			total: 0,
			measured: 0,
			none: 0,
			inherited: 0,
			ambiguous: 0,
		});
	});

	it("reports inference against the MEASURED denominator, not total requests", async () => {
		const now = Date.now();
		// delta: two anchored rows, one inherited row — 1/3 inferred — plus a
		// legacy row with no recorded source, which must NOT dilute the ratio.
		await insertRequest({
			id: "d1",
			timestamp: now - 1000,
			project: "delta",
			success: true,
			totalTokens: 100,
			costUsd: 0,
			billingType: "api",
			attributionSource: "wd_primary",
		});
		await insertRequest({
			id: "d2",
			timestamp: now - 2000,
			project: "delta",
			success: true,
			totalTokens: 100,
			costUsd: 0,
			billingType: "api",
			attributionSource: "header",
		});
		await insertRequest({
			id: "d3",
			timestamp: now - 3000,
			project: "delta",
			success: true,
			totalTokens: 100,
			costUsd: 0,
			billingType: "api",
			attributionSource: "session_inherited",
		});
		await insertRequest({
			id: "d4",
			timestamp: now - 4000,
			project: "delta",
			success: true,
			totalTokens: 100,
			costUsd: 0,
			billingType: "api",
		});

		const data = await fetchAnalytics({});
		const delta = data.projectBreakdown.find(
			(row: { project: string | null }) => row.project === "delta",
		);
		expect(delta.requests).toBe(4);
		// Legacy (NULL-source) rows are excluded from the denominator.
		expect(delta.measuredRequests).toBe(3);
		expect(delta.inferredRequests).toBe(1);
		expect(delta.ambiguousRequests).toBe(0);

		// The range-wide aggregate carries the same split for the whole range.
		expect(data.projectAttributionCoverage).toEqual({
			total: 4,
			measured: 3,
			none: 0,
			inherited: 1,
			ambiguous: 0,
		});
	});

	it("splits the no-project bucket into none / ambiguous / legacy-unknown", async () => {
		const now = Date.now();
		await insertRequest({
			id: "np1",
			timestamp: now - 1000,
			project: null,
			success: true,
			totalTokens: 10,
			costUsd: 0,
			billingType: "api",
			attributionSource: "none",
		});
		await insertRequest({
			id: "np2",
			timestamp: now - 2000,
			project: null,
			success: true,
			totalTokens: 10,
			costUsd: 0,
			billingType: "api",
			attributionSource: "session_ambiguous",
		});
		await insertRequest({
			id: "np3",
			timestamp: now - 3000,
			project: null,
			success: true,
			totalTokens: 10,
			costUsd: 0,
			billingType: "api",
		});

		const data = await fetchAnalytics({});
		const bucket = data.projectBreakdown.find(
			(row: { project: string | null }) => row.project === null,
		);
		expect(bucket.requests).toBe(3);
		expect(bucket.measuredRequests).toBe(2);
		expect(bucket.ambiguousRequests).toBe(1);
		expect(bucket.inferredRequests).toBe(0);
		// The "none" count is what is measured but neither inferred nor
		// ambiguous; legacy-unknown is requests - measured.
		expect(
			bucket.measuredRequests -
				bucket.ambiguousRequests -
				bucket.inferredRequests,
		).toBe(1);
		expect(bucket.requests - bucket.measuredRequests).toBe(1);
	});

	it("measures coverage over the whole range, not the truncated breakdown array", async () => {
		const now = Date.now();
		// More named projects than the server's project_breakdown limit (20).
		// The 20 biggest all carry a recorded source; the 5 smallest are legacy
		// rows with none, and they are exactly the ones the LIMIT cuts. Summing
		// the returned array therefore reads as 100% covered.
		for (let i = 0; i < 25; i++) {
			await insertRequest({
				id: `wide-${i}`,
				timestamp: now - 1000 - i,
				project: `proj-${i}`,
				success: true,
				totalTokens: (25 - i) * 100,
				costUsd: 0,
				billingType: "api",
				attributionSource: i < 20 ? "wd_primary" : undefined,
			});
		}

		const data = await fetchAnalytics({});

		expect(data.projectBreakdown).toHaveLength(20);
		const arrayRequests = data.projectBreakdown.reduce(
			(sum: number, row: { requests: number }) => sum + row.requests,
			0,
		);
		const arrayMeasured = data.projectBreakdown.reduce(
			(sum: number, row: { measuredRequests: number }) =>
				sum + row.measuredRequests,
			0,
		);
		// The array-derived number is the wrong one: it says 20 of 20 = 100%.
		expect(arrayMeasured).toBe(20);
		expect(arrayRequests).toBe(20);

		// The range-wide aggregate keeps the 5 truncated legacy rows in the
		// denominator: 20 of 25 = 80%.
		expect(data.projectAttributionCoverage).toEqual({
			total: 25,
			measured: 20,
			none: 0,
			inherited: 0,
			ambiguous: 0,
		});
	});

	it("returns the no-project bucket even when it ranks below the top 20 projects", async () => {
		const now = Date.now();
		for (let i = 0; i < 25; i++) {
			await insertRequest({
				id: `wide-${i}`,
				timestamp: now - 1000 - i,
				project: `proj-${i}`,
				success: true,
				totalTokens: (25 - i) * 1000,
				costUsd: 0,
				billingType: "api",
				attributionSource: "wd_primary",
			});
		}
		// Smallest bucket in the range by tokens. Grouped alongside the named
		// projects it would rank 26th and be truncated away, taking the
		// none/ambiguous/legacy split with it.
		await insertRequest({
			id: "np-none",
			timestamp: now - 2000,
			project: null,
			success: true,
			totalTokens: 1,
			costUsd: 0,
			billingType: "api",
			attributionSource: "none",
		});
		await insertRequest({
			id: "np-ambiguous",
			timestamp: now - 2001,
			project: null,
			success: true,
			totalTokens: 1,
			costUsd: 0,
			billingType: "api",
			attributionSource: "session_ambiguous",
		});
		await insertRequest({
			id: "np-legacy",
			timestamp: now - 2002,
			project: null,
			success: true,
			totalTokens: 1,
			costUsd: 0,
			billingType: "api",
		});

		const data = await fetchAnalytics({});

		// 20 named projects (the cut still applies to them) plus the bucket.
		const named = data.projectBreakdown.filter(
			(row: { project: string | null }) => row.project !== null,
		);
		expect(named).toHaveLength(20);
		expect(data.projectBreakdown).toHaveLength(21);

		const bucket = data.projectBreakdown.find(
			(row: { project: string | null }) => row.project === null,
		);
		expect(bucket).toBeDefined();
		expect(bucket.requests).toBe(3);
		expect(bucket.measuredRequests).toBe(2);
		expect(bucket.ambiguousRequests).toBe(1);
		expect(bucket.inferredRequests).toBe(0);
		expect(bucket.totalTokens).toBe(3);

		// Merged back in token order, so the fewest-token bucket sorts last.
		expect(data.projectBreakdown[20].project).toBeNull();

		expect(data.projectAttributionCoverage).toEqual({
			total: 28,
			measured: 27,
			none: 1,
			inherited: 0,
			ambiguous: 1,
		});
	});

	it("keeps the other UNION branches intact when the attribution columns are added", async () => {
		await seedRequests(Date.now());

		const data = await fetchAnalytics({});

		// A malformed sub-select would fail the whole UNION at runtime, so every
		// branch having rows is the real assertion here.
		expect(data.modelDistribution.length).toBeGreaterThan(0);
		expect(data.accountPerformance.length).toBeGreaterThan(0);
		expect(data.costByModel.length).toBeGreaterThan(0);
		expect(data.accountModelUsage.length).toBeGreaterThan(0);
		expect(data.projectBreakdown.length).toBeGreaterThan(0);
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
