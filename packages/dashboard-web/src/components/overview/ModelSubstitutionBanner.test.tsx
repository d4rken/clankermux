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

const NOW = Date.UTC(2026, 8, 21, 12);

describe("ModelSubstitutionBannerView", () => {
	it("renders nothing when no unacknowledged pair remains", () => {
		expect(
			renderToStaticMarkup(
				<ModelSubstitutionBannerView pairs={[]} now={NOW} />,
			),
		).toBe("");
	});

	it("names both models, the account and the share", () => {
		const html = renderToStaticMarkup(
			<ModelSubstitutionBannerView pairs={[pair()]} now={NOW} />,
		);
		expect(html).toContain("gpt-6-astra");
		expect(html).toContain("gpt-5.6-luna");
		expect(html).toContain("Codex-me");
		expect(html).toContain("87%");
		expect(html).toContain("87 of 100");
	});

	it("dates the pair, so a banner is not read as happening right now", () => {
		const html = renderToStaticMarkup(
			<ModelSubstitutionBannerView
				pairs={[pair({ lastAtMs: NOW - 7_200_000 })]}
				now={NOW}
			/>,
		);
		// The label and its age are separated by the <time> element, so the
		// readable sentence is asserted in the two halves the markup has.
		expect(html).toContain("last seen ");
		expect(html).toContain(">2h ago</span>");
		// The prose bound and the per-pair age answer the same question at two
		// scales; a banner that keeps one without the other overstates again.
		expect(html).toContain("in the last 24 hours");
		// The machine-readable instant, not the rendered locale string: the
		// relative label is what the operator reads, and the exact timestamp has
		// to survive for anyone correlating it with the request log.
		expect(html).toContain('dateTime="2026-09-21T10:00:00.000Z"');
	});

	it("keeps the ticking age out of the alert's announced content", () => {
		// The banner is role="alert". A live region re-announces what changes, so
		// an age that advances every clock tick would respeak the whole warning
		// on a timer. Asserted on the markup because the fix is the markup: the
		// visible half is aria-hidden and a fixed absolute instant stands in.
		const html = renderToStaticMarkup(
			<ModelSubstitutionBannerView pairs={[pair()]} now={NOW} />,
		);
		expect(html).toContain('<span aria-hidden="true">12h ago</span>');
		expect(html).toContain('<span class="sr-only">');
	});

	it("offers dismissal only when a handler is supplied", () => {
		// Asserted on the button's aria-label, not the word "Dismiss": the
		// explanatory copy above the list says "Dismiss hides each pair…", so a
		// bare substring check passes in both directions and proves nothing.
		const LABEL = 'aria-label="Dismiss model substitution warnings"';
		expect(
			renderToStaticMarkup(
				<ModelSubstitutionBannerView pairs={[pair()]} now={NOW} />,
			),
		).not.toContain(LABEL);
		expect(
			renderToStaticMarkup(
				<ModelSubstitutionBannerView
					pairs={[pair()]}
					now={NOW}
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
				now={NOW}
			/>,
		);
		expect(html).toContain("gpt-6-luna");
		expect(html.match(/Codex-me/g) ?? []).toHaveLength(2);
	});
});
