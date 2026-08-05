import { describe, expect, it } from "bun:test";
import type { AnalyticsResponse, AnalyticsSection } from "@clankermux/types";
import { canonicalSections, hasSection } from "../analytics-sections";

describe("canonicalSections", () => {
	it("dedupes and sorts so section ORDER never forks the cache", () => {
		expect(canonicalSections(["timeSeries", "totals", "timeSeries"])).toEqual([
			"timeSeries",
			"totals",
		]);
		expect(canonicalSections(["totals", "timeSeries"])).toEqual(
			canonicalSections(["timeSeries", "totals"]),
		);
	});
});

describe("hasSection", () => {
	const withMeta = (sections: AnalyticsSection[]): AnalyticsResponse => ({
		meta: { range: "24h", bucket: "1h", cumulative: false, sections },
	});

	it("reports a computed section as present even when its data is empty", () => {
		// The distinction that matters: an empty array here is REAL data ("no
		// traffic in range"), not a missing section.
		const analytics: AnalyticsResponse = {
			...withMeta(["modelDistribution"]),
			modelDistribution: [],
		};
		expect(hasSection(analytics, "modelDistribution")).toBe(true);
	});

	it("reports a section the server did not compute as absent", () => {
		expect(hasSection(withMeta(["totals"]), "routing")).toBe(false);
	});

	it("treats a response with no meta.sections as fully computed", () => {
		// A pre-sections server never sends the field.
		const legacy: AnalyticsResponse = {
			meta: { range: "24h", bucket: "1h" },
			totals: undefined,
		};
		expect(hasSection(legacy, "routing")).toBe(true);
	});

	it("reports everything absent when there is no response yet", () => {
		expect(hasSection(undefined, "totals")).toBe(false);
	});
});
