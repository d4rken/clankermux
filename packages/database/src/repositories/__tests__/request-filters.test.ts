/**
 * The analytics filter-to-SQL compiler, tested against expected results rather
 * than through any caller.
 *
 * The predicates themselves are the contract: two reads on the same page claim
 * to describe the same request selection, and they can only do that if they
 * compile the selection identically. Bind ORDER is half of that contract — a
 * condition list that is right while its binds are shifted produces plausible,
 * wrong numbers rather than an error.
 */

import { describe, expect, it } from "bun:test";
import {
	buildRequestFilterConditions,
	EMPTY_REQUEST_FILTERS,
	hasRequestFilters,
	type RequestFilters,
} from "../request-filters";

function filters(over: Partial<RequestFilters> = {}): RequestFilters {
	return { ...EMPTY_REQUEST_FILTERS, ...over };
}

describe("hasRequestFilters", () => {
	it("is false for an absent or cleared selection", () => {
		expect(hasRequestFilters(undefined)).toBe(false);
		expect(hasRequestFilters(EMPTY_REQUEST_FILTERS)).toBe(false);
	});

	it("is true for every dimension on its own", () => {
		expect(hasRequestFilters(filters({ accounts: ["a"] }))).toBe(true);
		expect(hasRequestFilters(filters({ accountsNone: true }))).toBe(true);
		expect(hasRequestFilters(filters({ models: ["m"] }))).toBe(true);
		expect(hasRequestFilters(filters({ apiKeys: ["k"] }))).toBe(true);
		expect(hasRequestFilters(filters({ projects: ["p"] }))).toBe(true);
		expect(hasRequestFilters(filters({ projectsNone: true }))).toBe(true);
		expect(hasRequestFilters(filters({ status: "error" }))).toBe(true);
	});
});

describe("buildRequestFilterConditions", () => {
	it("yields nothing for an absent or cleared selection", () => {
		expect(buildRequestFilterConditions(undefined)).toEqual({
			conditions: [],
			binds: [],
		});
		expect(buildRequestFilterConditions(EMPTY_REQUEST_FILTERS)).toEqual({
			conditions: [],
			binds: [],
		});
	});

	it("compiles named accounts to an IN list", () => {
		expect(
			buildRequestFilterConditions(filters({ accounts: ["a1", "a2"] })),
		).toEqual({
			conditions: ["(r.account_used IN (?,?))"],
			binds: ["a1", "a2"],
		});
	});

	it("compiles the no-account bucket to an IS NULL test with no bind", () => {
		// The sentinel id is never STORED on a request row, so this bucket is
		// only reachable as SQL NULL.
		expect(
			buildRequestFilterConditions(filters({ accountsNone: true })),
		).toEqual({
			conditions: ["(r.account_used IS NULL)"],
			binds: [],
		});
	});

	it("ORs named accounts with the no-account bucket", () => {
		expect(
			buildRequestFilterConditions(
				filters({ accounts: ["a1"], accountsNone: true }),
			),
		).toEqual({
			conditions: ["(r.account_used IN (?) OR r.account_used IS NULL)"],
			binds: ["a1"],
		});
	});

	it("compiles models to an IN list", () => {
		expect(buildRequestFilterConditions(filters({ models: ["m1"] }))).toEqual({
			conditions: ["r.model IN (?)"],
			binds: ["m1"],
		});
	});

	it("compiles API keys to an IN list on the stamped id", () => {
		// The id survives a rename and a hard delete; the display name does not.
		expect(
			buildRequestFilterConditions(filters({ apiKeys: ["k1", "k2"] })),
		).toEqual({
			conditions: ["r.api_key_id IN (?,?)"],
			binds: ["k1", "k2"],
		});
	});

	it("ORs named projects with the no-project bucket", () => {
		expect(
			buildRequestFilterConditions(
				filters({ projects: ["p1"], projectsNone: true }),
			),
		).toEqual({
			conditions: ["(r.project IN (?) OR r.project IS NULL)"],
			binds: ["p1"],
		});
	});

	it("compiles status to the recorded outcome", () => {
		expect(
			buildRequestFilterConditions(filters({ status: "success" })),
		).toEqual({ conditions: ["r.success = TRUE"], binds: [] });
		expect(buildRequestFilterConditions(filters({ status: "error" }))).toEqual({
			conditions: ["r.success = FALSE"],
			binds: [],
		});
		expect(buildRequestFilterConditions(filters({ status: "all" }))).toEqual({
			conditions: [],
			binds: [],
		});
	});

	it("emits every dimension in a fixed order, binds aligned with it", () => {
		// Order is the contract: the caller splices `conditions` and `binds` into
		// one query, so a reordering that moved a bind without its placeholder
		// would silently filter on the wrong column.
		const { conditions, binds } = buildRequestFilterConditions(
			filters({
				accounts: ["a1"],
				accountsNone: true,
				models: ["m1"],
				apiKeys: ["k1"],
				projects: ["p1"],
				projectsNone: true,
				status: "error",
			}),
		);

		expect(conditions).toEqual([
			"(r.account_used IN (?) OR r.account_used IS NULL)",
			"r.model IN (?)",
			"r.api_key_id IN (?)",
			"(r.project IN (?) OR r.project IS NULL)",
			"r.success = FALSE",
		]);
		expect(binds).toEqual(["a1", "m1", "k1", "p1"]);
		// One bind per placeholder, in the same sequence.
		expect(conditions.join(" AND ").split("?")).toHaveLength(binds.length + 1);
	});

	it("applies a custom alias to every column reference", () => {
		const { conditions } = buildRequestFilterConditions(
			filters({
				accounts: ["a1"],
				accountsNone: true,
				models: ["m1"],
				apiKeys: ["k1"],
				projects: ["p1"],
				projectsNone: true,
				status: "success",
			}),
			"req",
		);

		for (const condition of conditions) {
			expect(condition).not.toContain("r.");
			expect(condition).toContain("req.");
		}
	});
});
