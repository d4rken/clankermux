import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelEmptyState } from "./panel-empty-state";

describe("PanelEmptyState without slots", () => {
	/**
	 * Seven Analytics panels render this with a message and nothing else, and one
	 * of them (ModelPerformanceTable) carries a comment depending on the
	 * `min-h-40` it gets from here. Adding the icon and action slots must not move
	 * any of those seven, so the no-slot case is pinned by full-string equality
	 * rather than by class containment — containment would not notice a wrapper
	 * element appearing around the message.
	 */
	it("emits byte-identical markup when neither slot is passed", () => {
		expect(
			renderToStaticMarkup(
				<PanelEmptyState>No model performance data available</PanelEmptyState>,
			),
		).toBe(
			'<div class="flex min-h-40 items-center justify-center rounded-md border border-dashed px-section text-center text-sm text-muted-foreground">No model performance data available</div>',
		);
	});

	it("keeps the caller's own class merged onto the same element", () => {
		expect(
			renderToStaticMarkup(
				<PanelEmptyState className="mt-row">Nothing here</PanelEmptyState>,
			),
		).toBe(
			'<div class="flex min-h-40 items-center justify-center rounded-md border border-dashed px-section text-center text-sm text-muted-foreground mt-row">Nothing here</div>',
		);
	});
});

describe("PanelEmptyState with slots", () => {
	it("stacks icon, message and action in that order", () => {
		const html = renderToStaticMarkup(
			<PanelEmptyState
				icon={<svg role="presentation" />}
				action={<button type="button">Create one</button>}
			>
				No routing chains yet
			</PanelEmptyState>,
		);

		expect(html).toContain("flex-col gap-row");
		expect(html).toMatch(
			/<span class="flex shrink-0"><svg role="presentation"><\/svg><\/span>No routing chains yet<span class="shrink-0"><button type="button">Create one<\/button><\/span>/,
		);
	});

	it("keeps the shared geometry when only the icon slot is used", () => {
		const html = renderToStaticMarkup(
			<PanelEmptyState icon={<svg role="presentation" />}>
				No API keys yet
			</PanelEmptyState>,
		);

		// The geometry the seven Analytics call sites depend on is the same
		// geometry the extended states get: 160px tall, 24px of side padding.
		expect(html).toContain("min-h-40");
		expect(html).toContain("px-section");
		expect(html).toContain("flex-col gap-row");
		expect(html).not.toContain('<span class="shrink-0">');
	});

	it("does not switch to the column layout for a message alone", () => {
		const html = renderToStaticMarkup(
			<PanelEmptyState>Just a message</PanelEmptyState>,
		);

		expect(html).not.toContain("flex-col");
	});
});
