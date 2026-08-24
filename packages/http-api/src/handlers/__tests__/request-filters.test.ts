import { describe, expect, it } from "bun:test";
import {
	buildRequestFilterClause,
	parseRequestFilters,
} from "../request-filters";

describe("buildRequestFilterClause", () => {
	it("returns an empty clause for no filters", () => {
		expect(buildRequestFilterClause({})).toEqual({ sql: "", params: [] });
	});

	it("treats status 'all' as no filter", () => {
		expect(buildRequestFilterClause({ status: "all" })).toEqual({
			sql: "",
			params: [],
		});
	});

	it("maps status 'success' to the recorded outcome", () => {
		const { sql, params } = buildRequestFilterClause({ status: "success" });
		expect(sql).toBe("WHERE r.success = 1");
		expect(params).toEqual([]);
	});

	it("maps status 'error' to the recorded outcome, including HTTP 200 stream errors", () => {
		const { sql, params } = buildRequestFilterClause({ status: "error" });
		expect(sql).toBe("WHERE r.success = 0");
		expect(params).toEqual([]);
	});

	it("maps specific codes to an IN clause", () => {
		const { sql, params } = buildRequestFilterClause({ codes: [429, 500] });
		expect(sql).toBe("WHERE r.status_code IN (?, ?)");
		expect(params).toEqual([429, 500]);
	});

	it("lets specific codes win over the status category", () => {
		const { sql, params } = buildRequestFilterClause({
			status: "success",
			codes: [500],
		});
		expect(sql).toBe("WHERE r.status_code IN (?)");
		expect(params).toEqual([500]);
	});

	it("filters by a lower time bound", () => {
		const { sql, params } = buildRequestFilterClause({ from: 1000 });
		expect(sql).toBe("WHERE r.timestamp >= ?");
		expect(params).toEqual([1000]);
	});

	it("filters by an upper time bound", () => {
		const { sql, params } = buildRequestFilterClause({ to: 2000 });
		expect(sql).toBe("WHERE r.timestamp <= ?");
		expect(params).toEqual([2000]);
	});

	it("matches an account by name or raw id", () => {
		const { sql, params } = buildRequestFilterClause({ account: "acct-1" });
		expect(sql).toBe("WHERE (a.name = ? OR r.account_used = ?)");
		expect(params).toEqual(["acct-1", "acct-1"]);
	});

	it("matches an exact request id, ahead of every other clause", () => {
		const { sql, params } = buildRequestFilterClause({ id: "req-1" });
		expect(sql).toBe("WHERE r.id = ?");
		expect(params).toEqual(["req-1"]);
	});

	it("matches the no-API-key bucket with IS NULL and no param", () => {
		const { sql, params } = buildRequestFilterClause({ noApiKey: true });
		expect(sql).toBe("WHERE r.api_key_name IS NULL");
		expect(params).toEqual([]);
	});

	it("treats a key literally named 'no-api-key' as a name, not a bucket", () => {
		const { sql, params } = buildRequestFilterClause({ apiKey: "no-api-key" });
		expect(sql).toBe(
			"WHERE COALESCE((SELECT name FROM api_keys WHERE id = r.api_key_id), r.api_key_name) = ?",
		);
		expect(params).toEqual(["no-api-key"]);
	});

	it("matches a named API key by current name with snapshot fallback", () => {
		const { sql, params } = buildRequestFilterClause({ apiKey: "my-key" });
		expect(sql).toBe(
			"WHERE COALESCE((SELECT name FROM api_keys WHERE id = r.api_key_id), r.api_key_name) = ?",
		);
		expect(params).toEqual(["my-key"]);
	});

	it("matches the no-project bucket with IS NULL and no param", () => {
		const { sql, params } = buildRequestFilterClause({ noProject: true });
		expect(sql).toBe("WHERE r.project IS NULL");
		expect(params).toEqual([]);
	});

	it("matches a named project against the stamped column", () => {
		const { sql, params } = buildRequestFilterClause({ project: "my-proj" });
		expect(sql).toBe("WHERE r.project = ?");
		expect(params).toEqual(["my-proj"]);
	});

	it("treats projects named 'all' and 'no-project' as literal names", () => {
		// Both used to be reinterpreted: `all` was dropped entirely (unfiltered
		// results) and `no-project` selected the empty bucket.
		for (const name of ["all", "no-project"]) {
			const { sql, params } = buildRequestFilterClause({ project: name });
			expect(sql).toBe("WHERE r.project = ?");
			expect(params).toEqual([name]);
		}
	});

	it("combines clauses with AND in a stable order and param sequence", () => {
		const { sql, params } = buildRequestFilterClause({
			id: "req-1",
			status: "error",
			from: 100,
			to: 200,
			account: "acct-1",
			apiKey: "my-key",
			project: "my-proj",
		});
		expect(sql).toBe(
			"WHERE r.id = ? " +
				"AND r.success = 0 " +
				"AND r.timestamp >= ? AND r.timestamp <= ? " +
				"AND (a.name = ? OR r.account_used = ?) " +
				"AND COALESCE((SELECT name FROM api_keys WHERE id = r.api_key_id), r.api_key_name) = ? " +
				"AND r.project = ?",
		);
		expect(params).toEqual([
			"req-1",
			100,
			200,
			"acct-1",
			"acct-1",
			"my-key",
			"my-proj",
		]);
	});

	it("lets the empty buckets win over a name sent alongside them", () => {
		const { sql, params } = buildRequestFilterClause({
			apiKey: "my-key",
			noApiKey: true,
			project: "my-proj",
			noProject: true,
		});
		expect(sql).toBe("WHERE r.api_key_name IS NULL AND r.project IS NULL");
		expect(params).toEqual([]);
	});
});

describe("parseRequestFilters", () => {
	const parse = (qs: string) => parseRequestFilters(new URLSearchParams(qs));

	it("returns an empty object for no params", () => {
		expect(parse("")).toEqual({});
	});

	it("parses a valid status category", () => {
		expect(parse("status=success")).toEqual({ status: "success" });
		expect(parse("status=error")).toEqual({ status: "error" });
	});

	it("omits status 'all' and unknown values", () => {
		expect(parse("status=all")).toEqual({});
		expect(parse("status=bogus")).toEqual({});
	});

	it("parses a comma-separated code list, trimming and dropping non-numbers", () => {
		expect(parse("codes=429,500")).toEqual({ codes: [429, 500] });
		expect(parse("codes=429, 500 ,abc")).toEqual({ codes: [429, 500] });
	});

	it("omits an empty/garbage code list", () => {
		expect(parse("codes=")).toEqual({});
		expect(parse("codes=abc,def")).toEqual({});
	});

	it("parses numeric time bounds", () => {
		expect(parse("from=123&to=456")).toEqual({ from: 123, to: 456 });
	});

	it("ignores non-numeric time bounds", () => {
		expect(parse("from=abc")).toEqual({});
	});

	it("takes name filters on presence, so 'all' is just a name", () => {
		expect(parse("account=all&apiKey=all&project=all")).toEqual({
			account: "all",
			apiKey: "all",
			project: "all",
		});
	});

	it("drops empty name params", () => {
		expect(parse("account=&apiKey=&project=")).toEqual({});
	});

	it("parses account, apiKey, and project values", () => {
		expect(parse("account=acct-1&apiKey=my-key&project=my-proj")).toEqual({
			account: "acct-1",
			apiKey: "my-key",
			project: "my-proj",
		});
	});

	it("parses an exact request id", () => {
		expect(parse("id=req-1")).toEqual({ id: "req-1" });
		expect(parse("id=")).toEqual({});
	});

	it("parses the no-API-key bucket from its own flag", () => {
		expect(parse("noApiKey=1")).toEqual({ noApiKey: true });
		// A key literally called "no-api-key" stays a name.
		expect(parse("apiKey=no-api-key")).toEqual({ apiKey: "no-api-key" });
	});

	it("parses the no-project bucket from its own flag", () => {
		expect(parse("noProject=1")).toEqual({ noProject: true });
		expect(parse("project=no-project")).toEqual({ project: "no-project" });
	});

	it("ignores a name param when the matching bucket flag is set", () => {
		expect(parse("noProject=1&project=my-proj")).toEqual({ noProject: true });
		expect(parse("noApiKey=1&apiKey=my-key")).toEqual({ noApiKey: true });
	});

	it("ignores a bucket flag that is not exactly '1'", () => {
		expect(parse("noProject=0&project=my-proj")).toEqual({
			project: "my-proj",
		});
	});

	it("parses the failure-reason filter", () => {
		expect(parse("error=provider_overloaded")).toEqual({
			error: "provider_overloaded",
		});
		expect(parse("error=")).toEqual({});
	});
});

describe("failure-reason filtering", () => {
	// Status codes cannot separate these three. A synthetic bounce and a
	// forwarded upstream 529 are BOTH HTTP 529, and an Anthropic stream that
	// dies in an overloaded_error frame is HTTP 200 with success = 0, so no
	// `codes=` filter can see it at all. During the 2026-08-24 incident that
	// last kind was 53 of the 88 overload failures — the majority, invisible.
	it("matches the reason substring with LIKE, escaped", () => {
		const { sql, params } = buildRequestFilterClause({
			error: "provider_overloaded",
		});
		expect(sql).toContain("r.error_message LIKE ?");
		// The ESCAPE clause is required: SQLite's LIKE has no default escape
		// character, so without it the backslash below is matched literally and
		// every underscore-bearing reason string silently returns nothing.
		expect(sql).toContain("ESCAPE");
		expect(params).toEqual(["%provider\\_overloaded%"]);
	});

	it("escapes every LIKE metacharacter, not just the underscore", () => {
		const { params } = buildRequestFilterClause({ error: "a_b%c\\d" });
		expect(params).toEqual(["%a\\_b\\%c\\\\d%"]);
	});

	it("lets a stem match the whole overload class", () => {
		// `error=overload` is the one query that spans our synthetic terminal,
		// a forwarded upstream 529, and an in-band mid-stream failure.
		const { params } = buildRequestFilterClause({ error: "overload" });
		expect(params).toEqual(["%overload%"]);
	});
});
