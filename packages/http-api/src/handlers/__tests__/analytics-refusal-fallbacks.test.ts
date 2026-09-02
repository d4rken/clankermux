/**
 * The `refusalFallbacks` analytics section.
 *
 * Runs against the shared deterministic fixture, which carries exactly one
 * anthropic-account refusal and one openai-account refusal inside the 24h
 * window, one fallback-credit retry, one refusal 3 days back (outside 24h), and
 * one in-window success with NO recorded stop reason standing in for history
 * written before the columns existed.
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
import type { RefusalFallbackAnalytics } from "@clankermux/types";
import type { AnalyticsResponse, APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";
import { FIXED_NOW, seedAnalyticsFixture } from "./analytics-section-fixture";

let db: Database;
let context: APIContext;

beforeEach(() => {
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

async function fetchAnalytics(query: string): Promise<AnalyticsResponse> {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams(query),
	);
	expect(response.status).toBe(200);
	return (await response.json()) as AnalyticsResponse;
}

async function fetchSection(query: string): Promise<RefusalFallbackAnalytics> {
	const body = await fetchAnalytics(query);
	const section = body.refusalFallbacks;
	if (!section) throw new Error("refusalFallbacks was not computed");
	return section;
}

/** Stable ordering for groupings the SQL only orders by count. */
function sortCategories(section: RefusalFallbackAnalytics) {
	return [...section.byCategory].sort((a, b) =>
		`${a.provider}:${a.category}`.localeCompare(`${b.provider}:${b.category}`),
	);
}

describe("refusalFallbacks section scoping", () => {
	it("is omitted when it was not requested", async () => {
		const body = await fetchAnalytics("range=24h&sections=totals");
		expect(body).not.toHaveProperty("refusalFallbacks");
		expect(body.meta?.sections).not.toContain("refusalFallbacks");
	});

	it("is present when requested on its own, with no other section computed", async () => {
		const body = await fetchAnalytics("range=24h&sections=refusalFallbacks");
		expect(body.refusalFallbacks).toBeDefined();
		expect(body.meta?.sections).toEqual(["refusalFallbacks"]);
		expect(body).not.toHaveProperty("totals");
	});
});

describe("refusalFallbacks over the 24h window", () => {
	it("totals the refusals, the retries, and the eligible denominator", async () => {
		const section = await fetchSection("range=24h&sections=refusalFallbacks");
		expect(section.totals.refusals).toBe(2);
		expect(section.totals.fallbackRetries).toBe(1);
		// Five in-window 200s carry a stop reason. The sixth in-window success
		// records none (legacy row) and must NOT dilute the share; neither may the
		// two failed requests or the refusal 3 days back.
		expect(section.totals.eligibleRequests).toBe(5);
	});

	it("buckets the series and its sums match the totals", async () => {
		const section = await fetchSection("range=24h&sections=refusalFallbacks");
		expect(section.timeSeries.length).toBeGreaterThan(0);
		const refusals = section.timeSeries.reduce((n, p) => n + p.refusals, 0);
		const retries = section.timeSeries.reduce(
			(n, p) => n + p.fallbackRetries,
			0,
		);
		expect(refusals).toBe(section.totals.refusals);
		expect(retries).toBe(section.totals.fallbackRetries);
		for (const point of section.timeSeries) {
			expect(Number.isFinite(point.ts)).toBe(true);
		}
	});

	it("groups categories by the provider that named them", async () => {
		const section = await fetchSection("range=24h&sections=refusalFallbacks");
		expect(sortCategories(section)).toEqual([
			{ provider: "anthropic", category: "cyber", count: 1 },
			{ provider: "openai", category: "content_filter", count: 1 },
		]);
	});

	it("pairs the refused model with the model the retry went to", async () => {
		const section = await fetchSection("range=24h&sections=refusalFallbacks");
		expect(section.byModelPair).toEqual([
			{
				fromModel: "claude-fable-5-1",
				toModel: "claude-opus-4-8",
				count: 1,
			},
		]);
	});
});

describe("refusalFallbacks honours the shared filters", () => {
	it("narrows both aggregations independently under a models filter", async () => {
		// The opus slice keeps the anthropic refusal and the retry, and drops the
		// openai account's content-filter refusal.
		const opus = await fetchSection(
			"range=24h&sections=refusalFallbacks&models=claude-opus-4-8",
		);
		expect(opus.totals.refusals).toBe(1);
		expect(opus.totals.fallbackRetries).toBe(1);
		expect(sortCategories(opus)).toEqual([
			{ provider: "anthropic", category: "cyber", count: 1 },
		]);

		// The sonnet slice is the mirror image: the content-filter refusal
		// survives, the cyber refusal and the retry do not.
		const sonnet = await fetchSection(
			"range=24h&sections=refusalFallbacks&models=claude-sonnet-5",
		);
		expect(sonnet.totals.refusals).toBe(1);
		expect(sonnet.totals.fallbackRetries).toBe(0);
		expect(sonnet.byModelPair).toEqual([]);
		expect(sortCategories(sonnet)).toEqual([
			{ provider: "openai", category: "content_filter", count: 1 },
		]);
	});

	it("reports zeros under status=error (no refusal row failed)", async () => {
		const section = await fetchSection(
			"range=24h&sections=refusalFallbacks&status=error",
		);
		expect(section.totals.refusals).toBe(0);
		expect(section.totals.fallbackRetries).toBe(0);
		expect(section.totals.eligibleRequests).toBe(0);
		expect(section.timeSeries).toEqual([]);
		expect(section.byCategory).toEqual([]);
		expect(section.byModelPair).toEqual([]);
	});

	it("widens to the refusal outside the 24h window at range=all", async () => {
		const section = await fetchSection("range=all&sections=refusalFallbacks");
		expect(section.totals.refusals).toBe(3);
		expect(section.totals.eligibleRequests).toBe(6);
		expect(sortCategories(section)).toEqual([
			{ provider: "anthropic", category: "cyber", count: 1 },
			{ provider: "anthropic", category: "unknown", count: 1 },
			{ provider: "openai", category: "content_filter", count: 1 },
		]);
	});

	it("emits an empty, zeroed section for a range with no matching rows", async () => {
		// A filter that selects no rows at all: the section is still COMPUTED
		// (empty arrays, zero totals), never omitted — the dashboard has to tell
		// "nothing happened" apart from "not computed".
		const section = await fetchSection(
			"range=24h&sections=refusalFallbacks&accounts=acct-nonexistent",
		);
		expect(section.totals).toEqual({
			refusals: 0,
			fallbackRetries: 0,
			eligibleRequests: 0,
		});
		expect(section.timeSeries).toEqual([]);
		expect(section.byCategory).toEqual([]);
		expect(section.byModelPair).toEqual([]);
	});
});
