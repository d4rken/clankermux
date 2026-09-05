/**
 * The query string `getStopsHistory` puts on the wire.
 *
 * The stops card now sits on a tab with a filter panel, and the server reads
 * that panel with the SAME parser `/api/analytics` uses. So the two reads have
 * to spell one selection identically: same parameter names, same order, same
 * translation of the UI's `noAccount`/`noProject` into the wire's
 * `accountsNone`/`projectsNone`. A drift here does not fail loudly — it
 * produces a card that quietly answers for a different set of requests than the
 * panels beside it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { api } from "./api";
import type { FilterState } from "./components/analytics/AnalyticsFilters";

const EMPTY: FilterState = {
	accounts: [],
	models: [],
	apiKeys: [],
	projects: [],
	noAccount: false,
	noProject: false,
	status: "all",
};

const realFetch = globalThis.fetch;
let requestedUrls: string[];

beforeEach(() => {
	requestedUrls = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		requestedUrls.push(String(input));
		return new Response(JSON.stringify({ causes: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("api.getStopsHistory", () => {
	it("sends the range alone when nothing is selected", async () => {
		await api.getStopsHistory("24h", EMPTY);
		expect(requestedUrls).toEqual(["/api/analytics/stops-history?range=24h"]);
	});

	it("sends the range alone when no filters are passed at all", async () => {
		await api.getStopsHistory("24h");
		expect(requestedUrls).toEqual(["/api/analytics/stops-history?range=24h"]);
	});

	it("spells a full selection exactly as getAnalytics does", async () => {
		const filters: FilterState = {
			accounts: ["a1"],
			models: ["m"],
			apiKeys: ["k1", "k2"],
			projects: ["p"],
			noAccount: true,
			noProject: true,
			status: "error",
		};

		await api.getStopsHistory("24h", filters);
		await api.getAnalytics("24h", filters);

		expect(requestedUrls[0]).toBe(
			"/api/analytics/stops-history?range=24h&accounts=a1&models=m&apiKeys=k1%2Ck2&projects=p&accountsNone=true&projectsNone=true&status=error",
		);
		// Same parameters, same order — the analytics URL only adds its own
		// `sections` handling in front of them.
		expect(requestedUrls[1]).toBe(
			"/api/analytics?range=24h&accounts=a1&models=m&apiKeys=k1%2Ck2&projects=p&accountsNone=true&projectsNone=true&status=error",
		);
	});

	it("omits status=all rather than sending it", async () => {
		await api.getStopsHistory("7d", { ...EMPTY, apiKeys: ["k1"] });
		expect(requestedUrls[0]).toBe(
			"/api/analytics/stops-history?range=7d&apiKeys=k1",
		);
	});
});
