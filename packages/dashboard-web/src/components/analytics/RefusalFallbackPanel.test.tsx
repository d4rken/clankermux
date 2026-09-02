import { describe, expect, it } from "bun:test";
import type { RefusalFallbackAnalytics } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { RefusalFallbackPanel } from "./RefusalFallbackPanel";

function analytics(
	overrides: Partial<RefusalFallbackAnalytics> = {},
): RefusalFallbackAnalytics {
	return {
		totals: { refusals: 3, fallbackRetries: 2, eligibleRequests: 200 },
		timeSeries: [{ ts: 1_773_273_600_000, refusals: 3, fallbackRetries: 2 }],
		byCategory: [
			{ provider: "anthropic", category: "cyber", count: 2 },
			{ provider: "openai", category: "content_filter", count: 1 },
		],
		byModelPair: [
			{ fromModel: "claude-fable-5-1", toModel: "claude-opus-4-8", count: 2 },
		],
		...overrides,
	};
}

function render(
	data: RefusalFallbackAnalytics | undefined,
	loading = false,
): string {
	return renderToStaticMarkup(
		<RefusalFallbackPanel data={data} loading={loading} timeRange="24h" />,
	);
}

describe("RefusalFallbackPanel", () => {
	it("shows the two counts and the share of eligible requests", () => {
		const html = render(analytics());
		expect(html).toContain("Refusals");
		expect(html).toContain("Fallback retries");
		expect(html).toContain("1.5%");
		// The denominator is stated, because it is not every request in range.
		expect(html).toContain("completed requests with a recorded stop reason");
	});

	it("renders the category and model-pair rows", () => {
		const html = render(analytics());
		expect(html).toContain("content_filter");
		expect(html).toContain("anthropic");
		expect(html).toContain("claude-fable-5-1");
		expect(html).toContain("claude-opus-4-8");
	});

	it("renders an em dash for the share when nothing is eligible yet", () => {
		const html = render(
			analytics({
				totals: { refusals: 0, fallbackRetries: 1, eligibleRequests: 0 },
			}),
		);
		expect(html).toContain("—");
	});

	it("labels an unnamed provider and an unresolved origin model as unknown", () => {
		const html = render(
			analytics({
				byCategory: [{ provider: null, category: "unknown", count: 1 }],
				byModelPair: [{ fromModel: null, toModel: null, count: 1 }],
			}),
		);
		expect(html).toContain("unknown");
	});

	it("replaces the chart and tables with an empty state when nothing happened", () => {
		const html = render(
			analytics({
				totals: { refusals: 0, fallbackRetries: 0, eligibleRequests: 120 },
				timeSeries: [],
				byCategory: [],
				byModelPair: [],
			}),
		);
		expect(html).toContain("No safety refusals in this range");
		// The tiles stay: "0 of 120" is a fact worth stating.
		expect(html).toContain("Refusals");
		expect(html).not.toContain("By category");
	});

	it("renders nothing at all when the server did not compute the section", () => {
		// MissingSectionsNotice already reports that at the top of the tab; an
		// empty card here would read as "no refusals happened".
		expect(render(undefined)).toBe("");
	});

	it("still renders the card while the section is loading", () => {
		const html = render(undefined, true);
		expect(html).toContain("Safety refusals and fallbacks");
	});
});
