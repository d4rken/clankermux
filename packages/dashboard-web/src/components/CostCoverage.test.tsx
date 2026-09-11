import { describe, expect, it } from "bun:test";
import type { CostCoverage } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { CostCoverageNote, formatKnownCost } from "./CostCoverage";

const empty: CostCoverage = {
	reportedUsd: 0,
	estimatedUsd: 0,
	unknownSourceUsd: 0,
	pricedRequests: 0,
	unpricedRequests: 0,
	reportedRequests: 0,
	estimatedRequests: 0,
	unknownSourceRequests: 0,
};
describe("usage cost coverage", () => {
	it("renders an all-unpriced range differently from a reported free range", () => {
		const missing = { ...empty, unpricedRequests: 2 };
		expect(formatKnownCost(0, missing)).toBe("—");
		expect(
			renderToStaticMarkup(<CostCoverageNote coverage={missing} />),
		).toContain("2 requests unpriced");
		const free = { ...empty, pricedRequests: 1, reportedRequests: 1 };
		expect(formatKnownCost(0, free)).toBe("$0.00");
		expect(
			renderToStaticMarkup(<CostCoverageNote coverage={free} />),
		).toContain("$0.00 reported");
	});
	it("explains mixed sources without adding estimates of already reported charges", () => {
		const coverage = {
			...empty,
			reportedUsd: 20,
			estimatedUsd: 2,
			unknownSourceUsd: 3,
			pricedRequests: 3,
			unpricedRequests: 1,
			reportedRequests: 1,
			estimatedRequests: 1,
			unknownSourceRequests: 1,
		};
		const html = renderToStaticMarkup(<CostCoverageNote coverage={coverage} />);
		for (const text of [
			"$20.00 reported",
			"$2.00 estimated",
			"$3.00 source unknown",
			"1 request unpriced",
		])
			expect(html).toContain(text);
	});
});
