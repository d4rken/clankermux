/**
 * Tests for the SQL cooldown guard added to AutoRefreshScheduler in PR #200 (bug 1).
 *
 * The eligibility query must skip accounts whose rate_limited_until is still in
 * the future, and must include accounts where rate_limited_until IS NULL or has
 * already passed.
 *
 * Strategy: capture the SQL string passed to db.query() and assert the clause and
 * parameter array are correct — no real DB required.
 */
import { describe, expect, it, mock } from "bun:test";

type QueryCall = { sql: string; params: unknown[] };

function makeDb(queryResult: unknown[] = []) {
	const queryCalls: QueryCall[] = [];
	return {
		query: mock(async (sql: string, params: unknown[]) => {
			queryCalls.push({ sql, params });
			return queryResult;
		}),
		run: mock(async () => {}),
		queryCalls,
	};
}

function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
	};
}

async function makeScheduler(db: ReturnType<typeof makeDb>) {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		makeProxyContext() as never,
	) as InstanceType<typeof AutoRefreshScheduler> & {
		checkAndRefresh(): Promise<void>;
	};
}

describe("AutoRefreshScheduler — SQL cooldown guard (PR #200 bug 1)", () => {
	it("eligibility query contains the rate_limited_until guard clause", async () => {
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);

		await (
			scheduler as never as { checkAndRefresh(): Promise<void> }
		).checkAndRefresh();

		// The main eligibility query selects multiple columns (id, name, provider, …)
		// and includes rate_limit_reset — distinguishable from the cleanup query
		// which only selects `id`.
		const mainQuery = db.queryCalls.find(
			(c) =>
				c.sql.includes("rate_limit_reset") &&
				c.sql.includes("auto_refresh_enabled"),
		);
		expect(mainQuery).toBeDefined();
		expect(mainQuery?.sql).toContain(
			"rate_limited_until IS NULL OR rate_limited_until <=",
		);
	});

	it("eligibility query passes now as its single parameter (rate_limited_until guard)", async () => {
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);

		const before = Date.now();
		await (
			scheduler as never as { checkAndRefresh(): Promise<void> }
		).checkAndRefresh();
		const after = Date.now();

		const mainQuery = db.queryCalls.find(
			(c) =>
				c.sql.includes("rate_limit_reset") &&
				c.sql.includes("auto_refresh_enabled"),
		);
		expect(mainQuery).toBeDefined();

		// The base query was broadened for weekly-dormant priming: the two
		// rate_limit_reset placeholders were removed and the 5h reset predicate
		// moved into the per-account fiveHourWindowGate. The only remaining bind
		// is the `now` used by the rate_limited_until <= ? cooldown guard.
		expect(Array.isArray(mainQuery?.params)).toBe(true);
		expect(mainQuery?.params.length).toBe(1);

		const onlyParam = mainQuery?.params[0] as number;
		expect(onlyParam).toBeGreaterThanOrEqual(before);
		expect(onlyParam).toBeLessThanOrEqual(after);
	});

	it("the single parameter is a current timestamp value", async () => {
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);

		const before = Date.now();
		await (
			scheduler as never as { checkAndRefresh(): Promise<void> }
		).checkAndRefresh();
		const after = Date.now();

		const mainQuery = db.queryCalls.find(
			(c) =>
				c.sql.includes("rate_limit_reset") &&
				c.sql.includes("auto_refresh_enabled"),
		);
		expect(mainQuery).toBeDefined();

		const [p0] = mainQuery?.params as number[];
		expect(p0).toBeGreaterThanOrEqual(before);
		expect(p0).toBeLessThanOrEqual(after);
	});
});

describe("AutoRefreshScheduler — cooldown guard scenarios", () => {
	it("account with rate_limited_until IS NULL is included (eligible)", async () => {
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);

		await (
			scheduler as never as { checkAndRefresh(): Promise<void> }
		).checkAndRefresh();

		const mainQuery = db.queryCalls.find(
			(c) =>
				c.sql.includes("rate_limit_reset") &&
				c.sql.includes("auto_refresh_enabled"),
		);
		expect(mainQuery).toBeDefined();
		// The clause must allow NULL — verified by the IS NULL branch in the SQL
		expect(mainQuery?.sql).toContain("rate_limited_until IS NULL");
	});

	it("account with rate_limited_until in the past is included (eligible)", async () => {
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);

		await (
			scheduler as never as { checkAndRefresh(): Promise<void> }
		).checkAndRefresh();

		const mainQuery = db.queryCalls.find(
			(c) =>
				c.sql.includes("rate_limit_reset") &&
				c.sql.includes("auto_refresh_enabled"),
		);
		expect(mainQuery).toBeDefined();
		// <= ? allows rows where rate_limited_until <= now (i.e. past timestamps)
		expect(mainQuery?.sql).toContain("rate_limited_until <=");
	});

	it("account with rate_limited_until in the future is excluded (skipped)", async () => {
		// The SQL guard `rate_limited_until IS NULL OR rate_limited_until <= ?`
		// is a WHERE clause, so rows with rate_limited_until > now are excluded
		// at the DB level.  We verify the clause uses <=, not <, so an account
		// whose cooldown expired at exactly 'now' is also eligible.
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);

		await (
			scheduler as never as { checkAndRefresh(): Promise<void> }
		).checkAndRefresh();

		const mainQuery = db.queryCalls.find(
			(c) =>
				c.sql.includes("rate_limit_reset") &&
				c.sql.includes("auto_refresh_enabled"),
		);
		expect(mainQuery).toBeDefined();
		// The guard must be `<= ?` (not `< ?`) so boundary accounts are included
		expect(mainQuery?.sql).toMatch(/rate_limited_until <= \?/);
		// And the full OR clause must be present to exclude strictly-future values
		expect(mainQuery?.sql).toMatch(
			/rate_limited_until IS NULL OR rate_limited_until <= \?/,
		);
	});
});
