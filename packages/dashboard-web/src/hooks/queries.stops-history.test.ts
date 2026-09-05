/**
 * The stops-history cache key.
 *
 * Two filter selections are two different measurements, so they must not share
 * a cache entry: a key that ignored the filters would serve the previous
 * selection's numbers under the new panel state and look, from the outside,
 * exactly like a card that honors the filters.
 */

import { describe, expect, it } from "bun:test";
import type { FilterState } from "../components/analytics/AnalyticsFilters";
import { queryKeys } from "../lib/query-keys";
import { stopsHistoryQueryOptions } from "./queries";

const EMPTY: FilterState = {
	accounts: [],
	models: [],
	apiKeys: [],
	projects: [],
	noAccount: false,
	noProject: false,
	status: "all",
};

const FILTERS_A: FilterState = { ...EMPTY, apiKeys: ["k1"] };
const FILTERS_B: FilterState = { ...EMPTY, apiKeys: ["k2"] };

describe("stopsHistoryQueryOptions", () => {
	it("keys on the filters, not only the range", () => {
		const a = stopsHistoryQueryOptions("24h", FILTERS_A).queryKey;
		const b = stopsHistoryQueryOptions("24h", FILTERS_B).queryKey;
		const none = stopsHistoryQueryOptions("24h").queryKey;

		expect(a).not.toEqual(b);
		expect(a).not.toEqual(none);
		expect(b).not.toEqual(none);
	});

	it("keys on the range as well", () => {
		expect(stopsHistoryQueryOptions("24h", FILTERS_A).queryKey).not.toEqual(
			stopsHistoryQueryOptions("7d", FILTERS_A).queryKey,
		);
	});

	it("produces the key a test or an invalidation can construct by hand", () => {
		// Seeding the cache in a component test and reading it from the hook have
		// to meet at the same key, so the factory is the single spelling of it.
		expect(stopsHistoryQueryOptions("24h", FILTERS_A).queryKey).toEqual(
			queryKeys.stopsHistory("24h", FILTERS_A),
		);
		expect(stopsHistoryQueryOptions("24h").queryKey).toEqual(
			queryKeys.stopsHistory("24h", undefined),
		);
	});
});
