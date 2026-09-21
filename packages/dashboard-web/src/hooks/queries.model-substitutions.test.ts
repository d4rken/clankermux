import { describe, expect, it } from "bun:test";
import { queryKeys } from "../lib/query-keys";
import { modelSubstitutionsQueryOptions } from "./queries";

describe("modelSubstitutionsQueryOptions", () => {
	it("uses the shared key factory rather than a parallel literal", () => {
		expect(modelSubstitutionsQueryOptions("24h").queryKey).toEqual(
			queryKeys.modelSubstitutions("24h"),
		);
	});

	it("forks the cache entry per range", () => {
		expect(modelSubstitutionsQueryOptions("24h").queryKey).not.toEqual(
			modelSubstitutionsQueryOptions("7d").queryKey,
		);
	});

	/**
	 * Load-bearing: the Accounts chip and the Overview banner both ask for
	 * "24h", and sharing one key is what keeps opening both pages from running
	 * the routing_attempts scan twice.
	 */
	it("gives the same key to two callers asking for the same range", () => {
		expect(modelSubstitutionsQueryOptions("24h").queryKey).toEqual(
			modelSubstitutionsQueryOptions("24h").queryKey,
		);
	});

	it("takes no filter dimension", () => {
		// The endpoint cannot be filtered: the substituting attempt is not the
		// attempt that produced the request row the filters key on.
		expect(queryKeys.modelSubstitutions("24h")).toEqual(
			queryKeys.modelSubstitutions("24h"),
		);
		expect(JSON.stringify(queryKeys.modelSubstitutions("24h"))).not.toContain(
			"filters",
		);
	});
});
