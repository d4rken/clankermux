import { describe, expect, it } from "bun:test";
import type { PricingGap } from "@clankermux/types";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TONE } from "../../test-utils/tone";
import { PricingGapBannerView } from "./PricingGapBanner";

function gap(overrides: Partial<PricingGap> = {}): PricingGap {
	return {
		key: "9".repeat(64),
		fingerprint: "9".repeat(16),
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

/**
 * The text and tooltip of every fingerprint node.
 *
 * Selected STRUCTURALLY — the span the component gives a `title` — rather than
 * by searching the markup for `#<hex>`. That is the whole point of the field: a
 * client can put fingerprint-shaped text in a model id, but it cannot put it in
 * this node, so a test that matched on text alone would be satisfied by a forgery.
 */
function rowFingerprints(
	gaps: PricingGap[],
): { text: string; title: string }[] {
	const found: { text: string; title: string }[] = [];
	const walk = (node: ReactNode): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child as ReactNode);
			return;
		}
		if (!isValidElement(node)) return;
		const props = node.props as { children?: ReactNode; title?: string };
		if (node.type === "span" && typeof props.title === "string") {
			found.push({ text: String(props.children), title: props.title });
		}
		walk(props.children);
	};
	walk(PricingGapBannerView({ gaps }));
	return found;
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
		expect(html).toContain(TONE.warningBanner);
		expect(html).not.toContain(TONE.anyDestructiveSurface);
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
		// present the SAME (provider, modelId) display pair — the label is now the
		// plain truncated text, so it is identical on both rows. Keying on that pair
		// hands React a duplicate key, which lets it reconcile the wrong row.
		const clipped = "z".repeat(256);
		const first = gap({
			key: "a".repeat(64),
			fingerprint: "a".repeat(16),
			modelId: clipped,
			occurrences: 3,
		});
		const second = gap({
			key: "b".repeat(64),
			fingerprint: "b".repeat(16),
			modelId: clipped,
			occurrences: 7,
		});

		expect(rowKeys([first, second])).toEqual([first.key, second.key]);

		// …and the operator can still tell which row is which, because every row
		// carries the server-derived fingerprint in its own node, with the full
		// digest available as its tooltip.
		expect(rowFingerprints([first, second])).toEqual([
			{ text: `#${first.fingerprint}`, title: first.key },
			{ text: `#${second.fingerprint}`, title: second.key },
		]);
	});

	it("cannot have a row's fingerprint impersonated by model text", () => {
		// A client that reads a fingerprinted row can submit its rendered text as
		// its own model id. That forgery used to work, because the fingerprint lived
		// inside the client-controlled label.
		const genuine = gap({
			key: "a".repeat(64),
			fingerprint: "a".repeat(16),
			modelId: "claude-not-yet-priced-9",
		});
		const forger = gap({
			key: "b".repeat(64),
			fingerprint: "b".repeat(16),
			modelId: `claude-not-yet-priced-9 #${genuine.fingerprint}`,
		});

		// Both rows carry a fingerprint node, and the forger's is its OWN — the
		// mimicry is stranded in the label, which is a different node.
		expect(rowFingerprints([genuine, forger])).toEqual([
			{ text: `#${genuine.fingerprint}`, title: genuine.key },
			{ text: `#${forger.fingerprint}`, title: forger.key },
		]);

		// The forged text still renders (it is what the client sent), but the row it
		// renders on is identified as the forger's, not the genuine one's.
		const html = renderToStaticMarkup(
			<PricingGapBannerView gaps={[genuine, forger]} />,
		);
		expect(html).toContain(`claude-not-yet-priced-9 #${genuine.fingerprint}`);
		expect(html).toContain(`title="${forger.key}"`);
	});

	it("renders the fingerprint on every row, not only on clipped ones", () => {
		// Unconditional by design: a fingerprint that appears only on altered rows
		// tells a client which rows it can impersonate by simply omitting it.
		expect(rowFingerprints([gap()])).toEqual([
			{ text: `#${"9".repeat(16)}`, title: "9".repeat(64) },
		]);
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
