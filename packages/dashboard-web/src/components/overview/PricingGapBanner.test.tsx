import { describe, expect, it } from "bun:test";
import type { PricingGap } from "@clankermux/types";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingGapBannerView } from "./PricingGapBanner";

function gap(overrides: Partial<PricingGap> = {}): PricingGap {
	return {
		key: "9".repeat(64),
		modelId: "claude-not-yet-priced-9",
		provider: "anthropic",
		reason: "model_missing",
		occurrences: 854,
		firstSeenAt: 1_700_000_000_000,
		lastSeenAt: 1_700_000_060_000,
		...overrides,
	};
}

/**
 * The React keys of the rendered rows. Static markup cannot show them, and a
 * duplicate key is exactly the defect under test, so the element tree is walked
 * directly.
 */
function rowKeys(gaps: PricingGap[]): (string | null)[] {
	const keys: (string | null)[] = [];
	const walk = (node: ReactNode): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child as ReactNode);
			return;
		}
		if (!isValidElement(node)) return;
		if (node.type === "li") keys.push(node.key);
		walk((node.props as { children?: ReactNode }).children);
	};
	walk(PricingGapBannerView({ gaps }));
	return keys;
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

	it("keys rows on the gap identity so collided labels stay separate rows", () => {
		// Two model ids sharing a 256-character prefix are two registry entries but
		// present the SAME (provider, modelId) display pair. Keying on that pair
		// hands React a duplicate key, which lets it reconcile the wrong row.
		const clipped = "z".repeat(246);
		const first = gap({
			key: "a".repeat(64),
			modelId: `${clipped} #aaaaaaaa`,
			occurrences: 3,
		});
		const second = gap({
			key: "b".repeat(64),
			modelId: `${clipped} #bbbbbbbb`,
			occurrences: 7,
		});

		expect(rowKeys([first, second])).toEqual([first.key, second.key]);

		// …and the operator can tell which of the two rows is which, because the
		// server fingerprinted the labels it had to clip.
		const html = renderToStaticMarkup(
			<PricingGapBannerView gaps={[first, second]} />,
		);
		expect(html).toContain("#aaaaaaaa");
		expect(html).toContain("#bbbbbbbb");
	});

	it("keeps row keys distinct even when the whole display pair matches", () => {
		// The pathological case the identity exists for: identical provider AND
		// identical label, two genuinely different models.
		const keys = rowKeys([
			gap({ key: "c".repeat(64) }),
			gap({ key: "d".repeat(64) }),
		]);

		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
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
