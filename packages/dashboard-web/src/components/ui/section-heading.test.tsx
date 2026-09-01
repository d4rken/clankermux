import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionHeading } from "./section-heading";

/**
 * Same contract Card's header holds, one level up: the gap between a section
 * title and its description is a base-layer adjacency rule keyed on the two
 * `data-slot` attributes (see globals.css). A render test cannot measure the
 * margin, but it can hold what the rule depends on — both markers present, and
 * the description IMMEDIATELY following the title.
 */
const ADJACENT = /data-slot="title"[\s\S]*?<\/h2><p[^>]*data-slot="subtitle"/;

describe("SectionHeading", () => {
	it("sets the title in the display face at heading size and weight", () => {
		// `.display-face` sets ONLY font-family and tracking, so naming it alone
		// would render a section heading at body size and regular weight — the
		// exact defect this component exists to stop repeating.
		const html = renderToStaticMarkup(<SectionHeading title="Quota Drift" />);

		expect(html).toContain(
			'<h2 data-slot="title" class="display-face text-lg font-semibold">',
		);
	});

	it("caps the description at the app's reading measure", () => {
		// One of the three hand-rolled copies omitted `max-w-prose`, so its
		// description ran the full panel width — roughly three times the measure.
		const html = renderToStaticMarkup(
			<SectionHeading title="Cache Keep-Alive" description="Live status." />,
		);

		expect(html).toContain(
			'<p data-slot="subtitle" class="max-w-prose text-sm text-muted-foreground">',
		);
	});

	it("emits the title and description slots adjacent", () => {
		const html = renderToStaticMarkup(
			<SectionHeading
				title="Cumulative Trends"
				description="Running totals across the selected time range"
			/>,
		);

		expect(html).toMatch(ADJACENT);
	});

	it("renders no subtitle element when there is no description", () => {
		const html = renderToStaticMarkup(<SectionHeading title="Bare" />);

		expect(html).not.toContain('data-slot="subtitle"');
	});

	it("puts a call site's own class on the wrapper, not on the heading", () => {
		// One call site rules the section off from the one above it. That belongs
		// on the block, not on the `<h2>`, whose class list is fixed.
		const html = renderToStaticMarkup(
			<SectionHeading className="border-t pt-section" title="Cumulative" />,
		);

		expect(html).toContain('<div class="border-t pt-section">');
		expect(html).toContain('class="display-face text-lg font-semibold"');
	});
});
