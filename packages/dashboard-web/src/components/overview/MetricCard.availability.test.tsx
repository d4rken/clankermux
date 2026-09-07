/**
 * A metric card must never present a fallback zero as a measurement.
 *
 * The regression this guards came from the Overview's since-removed Active
 * Sessions tile, which rendered `stats?.activeSessions?.total ?? 0` and so
 * displayed a confident "0" for a failed /api/stats read — the reported "not
 * all results are correct" symptom. "Active Sessions" survives below only as a
 * title fixture for the generic MetricCard, which every remaining tile uses.
 */
import { describe, expect, it } from "bun:test";
import { Users } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricCard } from "./MetricCard";

/** The opening tag of the element whose own text is `text`. */
function tagFor(markup: string, text: string): string {
	const at = markup.indexOf(`>${text}<`);
	if (at === -1) throw new Error(`nothing renders "${text}"`);
	const start = markup.lastIndexOf("<", at);
	return markup.slice(start, at + 1);
}

describe("MetricCard availability states", () => {
	it("renders the value normally when the read succeeded", () => {
		const html = renderToStaticMarkup(
			<MetricCard
				title="Active Sessions"
				value="7"
				icon={Users}
				subRows={[{ label: "Claude", value: "5" }]}
			/>,
		);
		expect(html).toContain(">7<");
		expect(html).toContain("Claude");
	});

	it("renders a genuine zero as a real measurement", () => {
		const html = renderToStaticMarkup(
			<MetricCard title="Active Sessions" value="0" icon={Users} />,
		);
		expect(html).toContain(">0<");
		expect(html).not.toContain("unavailable");
	});

	it("replaces the value with an explicit unavailable state, not a zero", () => {
		const html = renderToStaticMarkup(
			<MetricCard
				title="Active Sessions"
				value="0"
				icon={Users}
				unavailableReason="Session data unavailable"
				subRows={[{ label: "Claude", value: "0" }]}
			/>,
		);
		expect(html).toContain("Session data unavailable");
		expect(html).not.toContain(">0<");
		// Sub-rows would carry the same misleading fallback zeros.
		expect(html).not.toContain("Claude");
	});

	it("keeps the title visible next to a long caption", () => {
		// Regression: the title carried `truncate` while the caption carried
		// `shrink-0`, so a long caption won the single-line row and the title
		// rendered as an empty ellipsis. The title is a short fixed string and
		// the caption is caller-generated and unbounded, so the CAPTION has to be
		// the element that yields. Asserted through the two tags rather than by
		// pinning the exact markup around the title text.
		const caption = "11 keys · no run-out within 14d · 3 accounts unknown";
		const html = renderToStaticMarkup(
			<MetricCard
				title="Quota Runway"
				value="7"
				icon={Users}
				caption={caption}
			/>,
		);
		expect(html).toContain("Quota Runway");
		expect(html).toContain(caption);

		expect(tagFor(html, "Quota Runway")).toContain("shrink-0");
		expect(tagFor(html, "Quota Runway")).not.toContain("truncate");
		expect(tagFor(html, caption)).toContain("truncate");
		// The caption keeps its full text on hover.
		expect(html).toContain(`title="${caption}"`);
	});

	it("keeps a stale value visible but labels its age", () => {
		const html = renderToStaticMarkup(
			<MetricCard
				title="Active Sessions"
				value="7"
				icon={Users}
				staleNote="Last updated 2m ago"
			/>,
		);
		expect(html).toContain(">7<");
		expect(html).toContain("Last updated 2m ago");
	});
});
