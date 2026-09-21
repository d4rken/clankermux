import { describe, expect, it } from "bun:test";
import type { ModelSubstitutionPair } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelSubstitutionBannerView } from "./ModelSubstitutionBanner";

function pair(
	over: Partial<ModelSubstitutionPair> = {},
): ModelSubstitutionPair {
	return {
		accountId: "acc-1",
		accountName: "Codex-me",
		provider: "codex",
		outgoingModel: "gpt-6-astra",
		reportedModel: "gpt-5.6-luna",
		accepted: false,
		substituted: 87,
		comparable: 100,
		firstAtMs: Date.UTC(2026, 8, 17),
		lastAtMs: Date.UTC(2026, 8, 21),
		...over,
	};
}

describe("ModelSubstitutionBannerView", () => {
	it("renders nothing when no unacknowledged pair remains", () => {
		expect(
			renderToStaticMarkup(<ModelSubstitutionBannerView pairs={[]} />),
		).toBe("");
	});

	it("names both models, the account and the share", () => {
		const html = renderToStaticMarkup(
			<ModelSubstitutionBannerView pairs={[pair()]} />,
		);
		expect(html).toContain("gpt-6-astra");
		expect(html).toContain("gpt-5.6-luna");
		expect(html).toContain("Codex-me");
		expect(html).toContain("87%");
		expect(html).toContain("87 of 100");
	});

	it("offers dismissal only when a handler is supplied", () => {
		// Asserted on the button's aria-label, not the word "Dismiss": the
		// explanatory copy above the list says "Dismiss hides each pair…", so a
		// bare substring check passes in both directions and proves nothing.
		const LABEL = 'aria-label="Dismiss model substitution warnings"';
		expect(
			renderToStaticMarkup(<ModelSubstitutionBannerView pairs={[pair()]} />),
		).not.toContain(LABEL);
		expect(
			renderToStaticMarkup(
				<ModelSubstitutionBannerView
					pairs={[pair()]}
					onAcknowledge={() => {}}
				/>,
			),
		).toContain(LABEL);
	});

	it("keys rows on the full triple so one account can show two pairs", () => {
		const html = renderToStaticMarkup(
			<ModelSubstitutionBannerView
				pairs={[
					pair(),
					pair({ outgoingModel: "gpt-5.6-luna", reportedModel: "gpt-6-luna" }),
				]}
			/>,
		);
		expect(html).toContain("gpt-6-luna");
		expect(html.match(/Codex-me/g) ?? []).toHaveLength(2);
	});
});
