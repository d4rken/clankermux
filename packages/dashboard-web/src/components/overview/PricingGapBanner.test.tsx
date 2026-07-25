import { describe, expect, it } from "bun:test";
import type { PricingGap } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingGapBannerView } from "./PricingGapBanner";

function gap(overrides: Partial<PricingGap> = {}): PricingGap {
	return {
		modelId: "claude-not-yet-priced-9",
		provider: "anthropic",
		reason: "model_missing",
		occurrences: 854,
		firstSeenAt: 1_700_000_000_000,
		lastSeenAt: 1_700_000_060_000,
		...overrides,
	};
}

describe("PricingGapBannerView", () => {
	it("renders nothing when there are no gaps", () => {
		// The healthy case must cost zero vertical space on the Overview.
		expect(renderToStaticMarkup(<PricingGapBannerView gaps={[]} />)).toBe("");
	});

	it("renders the model, provider and occurrence count", () => {
		const html = renderToStaticMarkup(
			<PricingGapBannerView gaps={[gap()]} />, //
		);

		expect(html).toContain('role="alert"');
		expect(html).toContain("claude-not-yet-priced-9");
		expect(html).toContain("anthropic");
		expect(html).toContain("854");
		expect(html).toContain("requests");
		// Amber warn tone, not the destructive red of the corruption banner:
		// requests are still served, only costing is degraded. This asserts the
		// className the markup asks for — NOT that it resolves to any CSS. What
		// makes it resolve is `warning` being a registered theme color in
		// globals.css's `@theme inline` block.
		expect(html).toContain("bg-warning/15");
		expect(html).not.toContain("bg-destructive");
	});

	it("words the remediation for both failure shapes", () => {
		const html = renderToStaticMarkup(
			<PricingGapBannerView
				gaps={[
					gap(),
					gap({
						modelId: "MiniMax-M2",
						provider: "minimax",
						reason: "cost_missing",
						occurrences: 1,
					}),
				]}
			/>,
		);

		// The catch fires both for a model that is absent and for one that is
		// present but lacks a rate, so the fix is "add OR complete".
		expect(html).toContain("Add or complete the pricing entry");
		expect(html).toContain("not in the pricing catalogue");
		expect(html).toContain("pricing entry is incomplete");
		// Singular/plural on the occurrence count.
		expect(html).toContain("1 request");
	});

	it("renders whatever the server sends without re-applying provider suppression", () => {
		// Suppression (ollama / ollama-cloud) is a server-side policy. Duplicating
		// it here would let the two copies drift.
		const html = renderToStaticMarkup(
			<PricingGapBannerView
				gaps={[gap({ modelId: "llama-local", provider: "ollama" })]}
			/>,
		);

		expect(html).toContain("llama-local");
		expect(html).toContain("ollama");
	});
});
