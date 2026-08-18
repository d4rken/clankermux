/**
 * Context Composition panel, attachment-bearing range.
 *
 * Attachments are base64 transport chars, so they dominate the char split while
 * pricing at a flat per-image token cost. Two claims must hold when they are
 * present: the bar/legend stay a char-proportion split over the FULL total
 * (attachments included), and the tool-result callout is measured against text
 * context only, so a screenshot-heavy range can't shrink it to a rounding
 * artifact. The segment tooltips are produced by a recharts formatter that only
 * runs on hover in a real DOM, so they are out of reach here.
 */
import { describe, expect, it } from "bun:test";
import type { AnalyticsResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextCompositionPanel } from "./ContextCompositionPanel";

type ContextComposition = NonNullable<AnalyticsResponse["contextComposition"]>;

// 500K text chars against 3M attachment chars — the shape of a range with a
// handful of screenshots in it.
const COMPOSITION: ContextComposition = {
	coverage: { withComposition: 40, totalRequests: 40 },
	totals: {
		systemChars: 60_000,
		toolsChars: 40_000,
		messagesChars: 400_000,
		toolResultChars: 100_000,
		binaryChars: 3_000_000,
		contextTokens: 6_000_000,
		avgContextTokens: 150_000,
	},
	avgPerRequest: {
		systemChars: 1_500,
		toolsChars: 1_000,
		messagesChars: 10_000,
		binaryChars: 75_000,
		messageCount: 12,
	},
	byProject: [],
	growthCurve: [],
	topToolContributors: [],
};

function render(composition: ContextComposition = COMPOSITION): string {
	return renderToStaticMarkup(
		<ContextCompositionPanel
			contextComposition={composition}
			loading={false}
			timeRange="24h"
		/>,
	);
}

describe("ContextCompositionPanel", () => {
	it("renders the split with an attachment-bearing dataset", () => {
		const html = render();

		expect(html).toContain("Context Composition");
		expect(html).toContain("System prompt");
		expect(html).toContain("Tool definitions");
		expect(html).toContain("Messages");
		expect(html).toContain("Attachments");
	});

	it("keeps the legend shares over the full char total including attachments", () => {
		const html = render();

		// 3,000,000 / 3,500,000 and 400,000 / 3,500,000 — the panel is documented
		// as a char-proportion split, so attachments stay in the denominator here.
		expect(html).toContain("86%");
		expect(html).toContain("11%");
	});

	it("measures tool results against text context, not the binary-inclusive total", () => {
		const html = render();

		// 100,000 / 400,000 messages chars, and 100,000 / 500,000 text chars.
		// Against the 3,500,000 binary-inclusive total it would read 3%.
		expect(html).toContain("25% of messages");
		expect(html).toContain("20% of text context");
		expect(html).not.toContain("of total context");
		expect(html).not.toContain("3% of");
	});

	it("still reports the tool-result share when the range carries no attachments", () => {
		const html = render({
			...COMPOSITION,
			totals: { ...COMPOSITION.totals, binaryChars: 0 },
			avgPerRequest: { ...COMPOSITION.avgPerRequest, binaryChars: 0 },
		});

		// Text-only denominator, so dropping attachments must not move it.
		expect(html).toContain("20% of text context");
	});
});
