import { describe, expect, it } from "bun:test";
import {
	attributionCoverage,
	describeProjectAttribution,
	hasAttributionMetadata,
	projectAttributionChip,
	projectAttributionLabel,
	resolveProjectAttributionSource,
} from "./project-attribution";

describe("projectAttributionChip", () => {
	it("labels an inherited attribution", () => {
		expect(projectAttributionChip("session_inherited")).toEqual({
			label: "inherited",
			title:
				"Project inherited from an earlier request in the same session, not from this request",
		});
	});

	it("labels an ambiguous session", () => {
		expect(projectAttributionChip("session_ambiguous")).toEqual({
			label: "ambiguous",
			title:
				"This session used more than one project, so no project was attributed",
		});
	});

	it("shows no chip for anchored tiers, 'none', or an unknown source", () => {
		for (const source of [
			"header",
			"wd_primary",
			"wd_plain",
			"codex_cwd",
			"none",
		] as const) {
			expect(projectAttributionChip(source)).toBeNull();
		}
		expect(projectAttributionChip(undefined)).toBeNull();
	});
});

describe("projectAttributionLabel", () => {
	it("labels every source, including the anchored tiers and 'none'", () => {
		expect(projectAttributionLabel("header")).toBe("x-project header");
		expect(projectAttributionLabel("wd_primary")).toBe(
			"primary working directory",
		);
		expect(projectAttributionLabel("wd_plain")).toBe("working directory");
		expect(projectAttributionLabel("codex_cwd")).toBe(
			"Codex working directory",
		);
		expect(projectAttributionLabel("session_inherited")).toBe(
			"inherited from session",
		);
		expect(projectAttributionLabel("session_ambiguous")).toBe(
			"ambiguous session",
		);
		expect(projectAttributionLabel("none")).toBe("no project signal");
	});

	it("returns null when the source is unknown (legacy or ineligible row)", () => {
		expect(projectAttributionLabel(undefined)).toBeNull();
	});
});

describe("resolveProjectAttributionSource", () => {
	it("prefers the live summary value", () => {
		expect(resolveProjectAttributionSource("header", "session_inherited")).toBe(
			"header",
		);
	});

	it("falls back to the stored payload meta for hydrated historical rows", () => {
		expect(
			resolveProjectAttributionSource(undefined, "session_inherited"),
		).toBe("session_inherited");
	});

	it("is undefined when neither side knows", () => {
		expect(
			resolveProjectAttributionSource(undefined, undefined),
		).toBeUndefined();
	});
});

describe("hasAttributionMetadata", () => {
	it("is true for the classic attribution fields", () => {
		expect(hasAttributionMetadata({ apiKeyName: "key" })).toBe(true);
		expect(hasAttributionMetadata({ project: "clankermux" })).toBe(true);
		expect(hasAttributionMetadata({ comboName: "combo" })).toBe(true);
	});

	it("is true for a row whose ONLY metadata is an ambiguous session", () => {
		// Regression guard: an ambiguous request has project === null, so an
		// anonymous one would never render its chip if the row gate ignored the
		// attribution source.
		expect(hasAttributionMetadata({ source: "session_ambiguous" })).toBe(true);
	});

	it("is true for an inherited attribution with no other metadata", () => {
		expect(hasAttributionMetadata({ source: "session_inherited" })).toBe(true);
	});

	it("is false when nothing is worth rendering", () => {
		expect(hasAttributionMetadata({})).toBe(false);
		// Anchored tiers and "none" get no chip, so they do not open the row.
		expect(hasAttributionMetadata({ source: "wd_primary" })).toBe(false);
		expect(hasAttributionMetadata({ source: "none" })).toBe(false);
	});
});

describe("describeProjectAttribution", () => {
	it("reports the inference share against MEASURED rows, not total requests", () => {
		// 4 requests, only 3 with a recorded source: 1 of those 3 was inferred.
		// Over total requests this would read 25% and under-report inference.
		expect(
			describeProjectAttribution({
				project: "delta",
				requests: 4,
				measuredRequests: 3,
				inferredRequests: 1,
				ambiguousRequests: 0,
			}),
		).toBe("33% inferred (1 of 3 measured)");
	});

	it("says nothing was measured when no row in the bucket has a source", () => {
		expect(
			describeProjectAttribution({
				project: "legacy",
				requests: 5,
				measuredRequests: 0,
				inferredRequests: 0,
				ambiguousRequests: 0,
			}),
		).toBe("not measured");
	});

	it("splits the no-project bucket instead of claiming 0% inferred", () => {
		expect(
			describeProjectAttribution({
				project: null,
				requests: 3,
				measuredRequests: 2,
				inferredRequests: 0,
				ambiguousRequests: 1,
			}),
		).toBe("1 no signal · 1 ambiguous · 1 unknown");
	});

	it("omits empty parts of the no-project split", () => {
		expect(
			describeProjectAttribution({
				project: null,
				requests: 2,
				measuredRequests: 2,
				inferredRequests: 0,
				ambiguousRequests: 0,
			}),
		).toBe("2 no signal");
	});
});

describe("attributionCoverage", () => {
	it("sums measured rows over all requests in the range", () => {
		expect(
			attributionCoverage([
				{ requests: 4, measuredRequests: 3 },
				{ requests: 2, measuredRequests: 1 },
			]),
		).toEqual({ measured: 4, total: 6, percent: 67 });
	});

	it("has no percentage when the range is empty", () => {
		expect(attributionCoverage([])).toEqual({
			measured: 0,
			total: 0,
			percent: null,
		});
	});
});
