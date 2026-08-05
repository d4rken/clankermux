/**
 * ID-based analytics filters + the /api/analytics/filter-options endpoint.
 *
 * The filters used to match on DISPLAY NAMES, which are not identity: a rename
 * orphaned the history, a hard delete made it unreachable, and the
 * `account_used = 'no_account'` sentinel disjunct matched nothing at all
 * (account_used is either an id or SQL NULL), so the no-account requests were
 * unfilterable while the dropdown still offered the option.
 *
 * The dropdown options used to be accumulated from the analytics breakdowns,
 * which are truncated to the top 10 models / top 20 projects — the long tail
 * was silently unselectable.
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
import type { AnalyticsFilterOptionsResponse, APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics-direct";
import { createAnalyticsFilterOptionsHandler } from "../analytics-filter-options-direct";
import {
	ACCOUNT_A,
	ACCOUNT_A_NAME,
	ACCOUNT_B,
	ACCOUNT_DELETED,
	API_KEY_DELETED,
	API_KEY_DELETED_NAME,
	API_KEY_LIVE,
	API_KEY_LIVE_NAME,
	API_KEY_RENAMED,
	API_KEY_RENAMED_NAME,
	FIXED_NOW,
	PROJECT_ALPHA,
	seedAnalyticsFixture,
} from "./analytics-section-fixture";

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

async function totalsFor(query: string): Promise<number> {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams(`range=all&sections=totals&${query}`),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { totals: { requests: number } };
	return body.totals.requests;
}

async function filterOptions(): Promise<AnalyticsFilterOptionsResponse> {
	const response = await createAnalyticsFilterOptionsHandler(context)();
	expect(response.status).toBe(200);
	return (await response.json()) as AnalyticsFilterOptionsResponse;
}

describe("account filtering by id", () => {
	it("selects the rows stamped with that account id", async () => {
		// r-01, r-02, r-03, r-09, r-11 belong to account A.
		expect(await totalsFor(`accounts=${ACCOUNT_A}`)).toBe(5);
		// r-04, r-05, r-10.
		expect(await totalsFor(`accounts=${ACCOUNT_B}`)).toBe(3);
		expect(await totalsFor(`accounts=${ACCOUNT_A},${ACCOUNT_B}`)).toBe(8);
	});

	it("still selects a hard-deleted account's history", async () => {
		// No `accounts` row exists for this id; a name-based predicate could not
		// have matched it at all. r-06 and r-12.
		expect(await totalsFor(`accounts=${ACCOUNT_DELETED}`)).toBe(2);
	});

	it("does NOT match the display name", async () => {
		expect(await totalsFor(`accounts=${ACCOUNT_A_NAME}`)).toBe(0);
	});

	it("accountsNone=true selects the SQL-NULL-account rows", async () => {
		// r-07 and r-08. This is the class the old sentinel predicate
		// (`account_used = 'no_account'`) could never reach: the sentinel is a
		// display value, never a stored one.
		expect(await totalsFor("accountsNone=true")).toBe(2);
	});

	it("ORs the id list with the no-account bucket", async () => {
		expect(await totalsFor(`accounts=${ACCOUNT_B}&accountsNone=true`)).toBe(5);
	});
});

describe("API-key filtering by id", () => {
	it("matches a RENAMED key's rows, which carry the pre-rename snapshot", async () => {
		// r-04 and r-05 were stamped with the OLD name; the key's current name is
		// different. Neither name identifies the key — the id on the row does.
		expect(await totalsFor(`apiKeys=${API_KEY_RENAMED}`)).toBe(2);
	});

	it("matches a hard-deleted key's rows", async () => {
		// r-06 and r-12; no api_keys row exists for this id.
		expect(await totalsFor(`apiKeys=${API_KEY_DELETED}`)).toBe(2);
	});

	it("does NOT match the display name", async () => {
		expect(await totalsFor(`apiKeys=${API_KEY_RENAMED_NAME}`)).toBe(0);
	});

	it("combines multiple key ids", async () => {
		// Live key: r-01, r-02, r-03, r-09, r-10, r-11. Deleted key: r-06, r-12.
		expect(await totalsFor(`apiKeys=${API_KEY_LIVE},${API_KEY_DELETED}`)).toBe(
			8,
		);
	});
});

describe("filter-options endpoint", () => {
	it("lists every model and project, not just the analytics top-N", async () => {
		const options = await filterOptions();
		expect(options.models).toEqual([
			"claude-opus-4-8",
			"claude-sonnet-5",
			"gpt-5-codex",
		]);
		expect(options.projects).toEqual([PROJECT_ALPHA, "beta"]);
	});

	it("returns projects the top-N breakdown would have truncated away", async () => {
		// 25 extra named projects — past the analytics project_breakdown cut of 20.
		for (let i = 0; i < 25; i++) {
			db.run(
				`INSERT INTO requests (id, timestamp, method, path, success, status_code, project)
				 VALUES (?, ?, 'POST', '/v1/messages', 1, 200, ?)`,
				[
					`extra-${i}`,
					FIXED_NOW - 1000,
					`zz-project-${String(i).padStart(2, "0")}`,
				],
			);
		}

		const analytics = await createAnalyticsHandler(context)(
			new URLSearchParams("range=all&sections=projectBreakdown"),
		);
		const breakdown = (await analytics.json()) as {
			projectBreakdown: Array<{ project: string | null }>;
		};
		const breakdownNames = new Set(
			breakdown.projectBreakdown.map((row) => row.project),
		);

		const options = await filterOptions();
		expect(options.projects).toContain("zz-project-24");
		// Guard: the truncation the endpoint exists to bypass is real here.
		expect(breakdownNames.has("zz-project-24")).toBe(false);
	});

	it("labels accounts by CURRENT name and falls back to the id when deleted", async () => {
		const options = await filterOptions();
		const byValue = new Map(options.accounts.map((a) => [a.value, a.label]));
		expect(byValue.get(ACCOUNT_A)).toBe(ACCOUNT_A_NAME);
		expect(byValue.get(ACCOUNT_DELETED)).toBe(ACCOUNT_DELETED);
	});

	it("labels a renamed key by its NEW name and a deleted key by its snapshot", async () => {
		const options = await filterOptions();
		const byValue = new Map(options.apiKeys.map((k) => [k.value, k.label]));
		expect(byValue.get(API_KEY_LIVE)).toBe(API_KEY_LIVE_NAME);
		// Request rows for this key still carry "old-name".
		expect(byValue.get(API_KEY_RENAMED)).toBe(API_KEY_RENAMED_NAME);
		// No api_keys row: the most recent record-time snapshot is the label.
		expect(byValue.get(API_KEY_DELETED)).toBe(API_KEY_DELETED_NAME);
	});

	it("reports the NULL account and project buckets", async () => {
		const options = await filterOptions();
		expect(options.hasNoAccount).toBe(true);
		expect(options.hasNoProject).toBe(true);
	});

	it("reports no NULL buckets when every row is attributed", async () => {
		db.run(
			`DELETE FROM requests WHERE account_used IS NULL OR project IS NULL`,
		);
		const options = await filterOptions();
		expect(options.hasNoAccount).toBe(false);
		expect(options.hasNoProject).toBe(false);
	});
});
