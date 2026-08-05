/**
 * Section scoping for GET /api/analytics.
 *
 * Three things are under test:
 *  1. The unscoped path still emits the pre-sections wire response, checked
 *     against a golden fixture captured BEFORE section scoping existed
 *     (__fixtures__/analytics-unscoped-golden.json). Comparing "no sections"
 *     against "all sections explicitly" would only prove the two new code paths
 *     agree with each other.
 *  2. A section list yields exactly those fields — omitted, never zero-filled —
 *     with meta.sections echoing the RESOLVED set including implied deps.
 *  3. The conditional additional-data UNION keeps its branch-LOCAL bind order.
 *     Those cases run with a BOUNDED range and non-empty account/model/key/
 *     project filters: with `range=all` and no filters `queryParams` is empty,
 *     and every possible bind-order bug would pass unnoticed.
 */
import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { BunSqlAdapter, ensureSchema } from "@clankermux/database";
import { ANALYTICS_SECTIONS, type AnalyticsSection } from "@clankermux/types";
import type { AnalyticsResponse, APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";
import { createIsolatedAnalyticsHandler } from "../analytics-runner";
import GOLDEN from "./__fixtures__/analytics-unscoped-golden.json";
import {
	ACCOUNT_A,
	ACCOUNT_B,
	API_KEY_LIVE,
	API_KEY_RENAMED,
	FIXED_NOW,
	PROJECT_ALPHA,
	PROJECT_BETA,
	seedAnalyticsFixture,
} from "./analytics-section-fixture";

let db: Database;
let context: APIContext;

beforeEach(() => {
	// The handler reads Date.now() for the burn-rate windows and the range
	// cutoff; freezing it is what makes the golden comparison exact.
	setSystemTime(new Date(FIXED_NOW));
	db = new Database(":memory:");
	ensureSchema(db);
	seedAnalyticsFixture(db);
	const adapter = new BunSqlAdapter(db);
	context = {
		db: adapter,
		config: {},
		dbOps: { getAdapter: () => adapter },
	} as unknown as APIContext;
});

afterEach(() => {
	db.close();
	setSystemTime();
});

async function fetchAnalytics(query: string): Promise<{
	status: number;
	body: AnalyticsResponse & { error?: string };
}> {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams(query),
	);
	return { status: response.status, body: await response.json() };
}

/** All top-level fields the unscoped response carries. */
const FULL_FIELDS = Object.keys(GOLDEN) as Array<keyof AnalyticsResponse>;

describe("unscoped analytics response (backward compatibility)", () => {
	it("matches the pre-sections golden fixture field for field", async () => {
		const { status, body } = await fetchAnalytics("range=all");
		expect(status).toBe(200);

		// meta.sections is new and deliberately additive — everything else must
		// be byte-identical to the captured pre-sections response.
		const { sections, ...meta } = body.meta ?? {};
		expect({ ...body, meta }).toEqual(GOLDEN as unknown as AnalyticsResponse);
		expect(sections).toEqual([...ANALYTICS_SECTIONS].sort());
	});

	it("still emits every field when every section is requested explicitly", async () => {
		const { body } = await fetchAnalytics(
			`range=all&sections=${ANALYTICS_SECTIONS.join(",")}`,
		);
		for (const field of FULL_FIELDS) {
			expect(body[field]).toBeDefined();
		}
	});
});

describe("section scoping", () => {
	it("emits exactly the requested sections and omits the rest", async () => {
		const { body } = await fetchAnalytics(
			"range=all&sections=timeSeries,modelDistribution",
		);
		expect(body.timeSeries).toBeDefined();
		expect(body.modelDistribution).toBeDefined();

		for (const field of FULL_FIELDS) {
			if (field === "meta" || field === "timeSeries") continue;
			if (field === "modelDistribution") continue;
			// Omitted, NEVER zero-filled: absence is the signal the caller uses to
			// tell "not requested" from "no data in range".
			expect(body).not.toHaveProperty(field);
		}
	});

	it("echoes the RESOLVED section set in meta.sections", async () => {
		const { body } = await fetchAnalytics(
			"range=all&sections=contextComposition",
		);
		// contextComposition implies totals.
		expect(body.meta?.sections).toEqual(["contextComposition", "totals"]);
	});

	it("canonicalizes order and duplicates to one section set", async () => {
		const forward = await fetchAnalytics(
			"range=all&sections=timeSeries,modelDistribution",
		);
		const shuffled = await fetchAnalytics(
			"range=all&sections=modelDistribution,timeSeries,modelDistribution",
		);
		expect(shuffled.body.meta?.sections).toEqual(forward.body.meta?.sections);
		expect(shuffled.body).toEqual(forward.body);
	});
});

describe("implied section dependencies", () => {
	it("contextComposition alone still yields a correct coverage.totalRequests", async () => {
		const { body } = await fetchAnalytics(
			"range=all&sections=contextComposition",
		);
		expect(body.contextComposition).toBeDefined();
		// The consolidated totals query is what supplies this denominator, which
		// is exactly why contextComposition implies totals.
		expect(body.contextComposition?.coverage.totalRequests).toBe(
			GOLDEN.contextComposition.coverage.totalRequests,
		);
		expect(body.totals?.requests).toBe(GOLDEN.totals.requests);
	});

	it("speedTotals alone yields a totals object carrying the percentiles", async () => {
		const { body } = await fetchAnalytics("range=all&sections=speedTotals");
		expect(body.meta?.sections).toEqual(["speedTotals", "totals"]);
		expect(body.totals?.medianTokensPerSecond).toBe(
			GOLDEN.totals.medianTokensPerSecond,
		);
		expect(body.totals?.p95TokensPerSecond).toBe(
			GOLDEN.totals.p95TokensPerSecond,
		);
	});

	it("omits the speed percentiles from totals when speedTotals was not requested", async () => {
		const { body } = await fetchAnalytics("range=all&sections=totals");
		expect(body.totals).toBeDefined();
		expect(body.totals).not.toHaveProperty("medianTokensPerSecond");
		expect(body.totals).not.toHaveProperty("p95TokensPerSecond");
	});

	it("activeSessionsByAccount alone still yields timeSeries and the total", async () => {
		const { body } = await fetchAnalytics(
			"range=all&sections=activeSessionsByAccount",
		);
		expect(body.meta?.sections).toEqual([
			"activeSessions",
			"activeSessionsByAccount",
		]);
		expect(body.activeSessions?.totalDistinctSessions).toBe(
			GOLDEN.activeSessions.totalDistinctSessions,
		);
		expect(body.activeSessions?.timeSeries).toEqual(
			GOLDEN.activeSessions.timeSeries as never,
		);
		expect(body.activeSessions?.perAccount).toBeDefined();
	});

	it("omits perAccount when only activeSessions was requested", async () => {
		const { body } = await fetchAnalytics("range=all&sections=activeSessions");
		expect(body.activeSessions).toBeDefined();
		expect(body.activeSessions).not.toHaveProperty("perAccount");
	});
});

describe("sections validation", () => {
	it("rejects an unknown section by name with 400", async () => {
		const { status, body } = await fetchAnalytics(
			"range=all&sections=totals,bogusSection",
		);
		expect(status).toBe(400);
		expect(body.error).toContain("bogusSection");
	});

	it("rejects a present-but-empty sections param with 400", async () => {
		const { status } = await fetchAnalytics("range=all&sections=");
		expect(status).toBe(400);
	});

	it("validates on the main thread, before any worker dispatch", async () => {
		// A db path present means the runner would normally hand the request to
		// the worker. A bad section must still 400 immediately rather than
		// queueing behind a slow heavy query and returning a 503 soft timeout.
		const workerContext = {
			db: context.db,
			config: {},
			dbOps: {
				getAdapter: context.dbOps.getAdapter,
				// Nonexistent path: if the request reached the worker it would fail
				// with a 500/503, not a 400.
				getResolvedDbPath: () => "/nonexistent/clankermux-sections-test.db",
			},
		} as unknown as APIContext;

		const response = await createIsolatedAnalyticsHandler(workerContext)(
			new URLSearchParams("range=all&sections=nope"),
		);
		expect(response.status).toBe(400);
	});
});

/**
 * Bounded range + non-empty filters on every filterable dimension, so
 * `queryParams` is long and a shifted bind is guaranteed to change results.
 */
const FILTERED_QUERY =
	`range=30d` +
	`&accounts=${ACCOUNT_A},${ACCOUNT_B}` +
	`&models=claude-opus-4-8,claude-sonnet-5` +
	`&apiKeys=${API_KEY_LIVE},${API_KEY_RENAMED}` +
	`&projects=${PROJECT_ALPHA},${PROJECT_BETA}`;

const UNION_SECTIONS: AnalyticsSection[] = [
	"modelDistribution",
	"accountPerformance",
	"costByModel",
	"apiKeyPerformance",
	"accountModelUsage",
	"projectBreakdown",
];

describe("conditional additional-data UNION (branch-local bind order)", () => {
	it("the filtered fixture actually exercises the filters", async () => {
		// Guard the guard: if the filters matched everything (or nothing) the
		// bind-order cases below would be vacuous.
		const all = await fetchAnalytics("range=30d&sections=totals");
		const filtered = await fetchAnalytics(`${FILTERED_QUERY}&sections=totals`);
		expect(filtered.body.totals?.requests).toBeGreaterThan(0);
		expect(filtered.body.totals?.requests).toBeLessThan(
			all.body.totals?.requests ?? 0,
		);
	});

	it.each(
		UNION_SECTIONS,
	)("branch '%s' alone returns the same rows as the full UNION", async (section) => {
		const full = await fetchAnalytics(
			`${FILTERED_QUERY}&sections=${UNION_SECTIONS.join(",")}`,
		);
		const alone = await fetchAnalytics(`${FILTERED_QUERY}&sections=${section}`);
		expect(alone.body[section]).toEqual(full.body[section] as never);
	});

	it("the Overview subset returns the same UNION rows as the full request", async () => {
		const overviewSections =
			"totals,timeSeries,modelDistribution,accountModelUsage,projectBreakdown,activeSessions";
		const subset = await fetchAnalytics(
			`${FILTERED_QUERY}&sections=${overviewSections}`,
		);
		const full = await fetchAnalytics(FILTERED_QUERY);

		expect(subset.body.modelDistribution).toEqual(
			full.body.modelDistribution as never,
		);
		expect(subset.body.accountModelUsage).toEqual(
			full.body.accountModelUsage as never,
		);
		expect(subset.body.projectBreakdown).toEqual(
			full.body.projectBreakdown as never,
		);
		// The Overview list omits `speedTotals`, so its totals carry no speed
		// percentiles; every other total must agree with the full response.
		const {
			medianTokensPerSecond: _median,
			p95TokensPerSecond: _p95,
			...fullTotals
		} = full.body.totals ?? {};
		expect(subset.body.totals).toEqual(fullTotals as never);
	});

	it("projectBreakdown alone still emits the untruncated no-project bucket", async () => {
		// Unfiltered on project so the NULL bucket is in scope.
		const { body } = await fetchAnalytics(
			"range=all&sections=projectBreakdown",
		);
		const rows = body.projectBreakdown ?? [];
		expect(rows.some((row) => row.project === null)).toBe(true);
		expect(rows).toEqual(GOLDEN.projectBreakdown as never);
	});

	it("skips the UNION query entirely when no branch is requested", async () => {
		const { body } = await fetchAnalytics("range=all&sections=totals");
		for (const section of UNION_SECTIONS) {
			expect(body).not.toHaveProperty(section);
		}
	});
});
