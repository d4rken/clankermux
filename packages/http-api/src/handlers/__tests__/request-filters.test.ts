import { describe, expect, it } from "bun:test";
import {
	buildRequestFilterClause,
	NO_API_KEY,
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

	it("maps status 'success' to the 2xx range", () => {
		const { sql, params } = buildRequestFilterClause({ status: "success" });
		expect(sql).toBe("WHERE r.status_code >= 200 AND r.status_code < 300");
		expect(params).toEqual([]);
	});

	it("maps status 'error' to everything outside 2xx (null-defensive)", () => {
		const { sql, params } = buildRequestFilterClause({ status: "error" });
		expect(sql).toBe(
			"WHERE (r.status_code IS NULL OR r.status_code < 200 OR r.status_code >= 300)",
		);
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

	it("matches the no-API-key sentinel with IS NULL and no param", () => {
		const { sql, params } = buildRequestFilterClause({ apiKey: NO_API_KEY });
		expect(sql).toBe("WHERE r.api_key_name IS NULL");
		expect(params).toEqual([]);
	});

	it("matches a named API key by current name with snapshot fallback", () => {
		const { sql, params } = buildRequestFilterClause({ apiKey: "my-key" });
		expect(sql).toBe(
			"WHERE COALESCE((SELECT name FROM api_keys WHERE id = r.api_key_id), r.api_key_name) = ?",
		);
		expect(params).toEqual(["my-key"]);
	});

	it("combines clauses with AND in a stable order and param sequence", () => {
		const { sql, params } = buildRequestFilterClause({
			status: "error",
			from: 100,
			to: 200,
			account: "acct-1",
			apiKey: "my-key",
		});
		expect(sql).toBe(
			"WHERE (r.status_code IS NULL OR r.status_code < 200 OR r.status_code >= 300) " +
				"AND r.timestamp >= ? AND r.timestamp <= ? " +
				"AND (a.name = ? OR r.account_used = ?) " +
				"AND COALESCE((SELECT name FROM api_keys WHERE id = r.api_key_id), r.api_key_name) = ?",
		);
		expect(params).toEqual([100, 200, "acct-1", "acct-1", "my-key"]);
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

	it("omits the 'all' sentinel for account and apiKey", () => {
		expect(parse("account=all&apiKey=all")).toEqual({});
	});

	it("parses account and apiKey values", () => {
		expect(parse("account=acct-1&apiKey=my-key")).toEqual({
			account: "acct-1",
			apiKey: "my-key",
		});
	});

	it("parses the no-API-key sentinel", () => {
		expect(parse(`apiKey=${NO_API_KEY}`)).toEqual({ apiKey: NO_API_KEY });
	});
});
