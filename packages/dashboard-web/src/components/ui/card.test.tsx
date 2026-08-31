import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./card";

/**
 * The title→description gap is a CSS adjacency rule in `@layer base`, keyed on
 * these two `data-slot` attributes (see globals.css). A render test cannot
 * measure the margin, but it can hold the contract the rule depends on: both
 * markers present, and the description IMMEDIATELY following the title in the
 * markup. Drop either attribute, or slip an element between them, and every
 * card header in the app silently loses the gap again — which is exactly the
 * regression this replaced.
 */
const ADJACENT = /data-slot="title"[\s\S]*?<\/h3><p[^>]*data-slot="subtitle"/;

describe("Card header spacing contract", () => {
	it("emits adjacent title and description slots", () => {
		const html = renderToStaticMarkup(
			<Card>
				<CardHeader>
					<CardTitle>Usage Over Time</CardTitle>
					<CardDescription>Per-account utilization.</CardDescription>
				</CardHeader>
			</Card>,
		);

		expect(html).toMatch(ADJACENT);
	});

	it("keeps them adjacent when a header wraps the pair for a side control", () => {
		// The layout two thirds of the app's headers use: the pair is nested in a
		// flex row so a range picker can sit beside it. A `space-y-*` on
		// CardHeader never reached these; the adjacency rule does.
		const html = renderToStaticMarkup(
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between gap-group">
						<div>
							<CardTitle>Account Performance</CardTitle>
							<CardDescription>Request distribution.</CardDescription>
						</div>
						<button type="button">Last 7 days</button>
					</div>
				</CardHeader>
			</Card>,
		);

		expect(html).toMatch(ADJACENT);
	});

	it("does not carry a spacing utility on the header itself", () => {
		const html = renderToStaticMarkup(
			<CardHeader>
				<CardTitle>Title</CardTitle>
			</CardHeader>,
		);

		// A `space-y-*` here would outrank the base-layer rule for the direct-child
		// headers only, reintroducing two different gaps for the same pair.
		expect(html).not.toContain("space-y-");
	});
});

describe("Headerless card padding", () => {
	it("drops pt-0 when a headerless body passes p-4", () => {
		// Every metric tile is a Card with no header, so its CardContent has to
		// restore the top padding the `pt-0` default removes. That only works
		// while the override is spelled numerically: tailwind-merge cancels
		// `pt-0` against a padding utility it RECOGNISES, and a custom scale key
		// (`p-group`) is not one — the class would survive and the tile would
		// render its figure jammed against the top border.
		const html = renderToStaticMarkup(
			<Card>
				<CardContent className="p-4">12,345</CardContent>
			</Card>,
		);

		expect(html).toContain("p-4");
		expect(html).not.toContain("pt-0");
	});

	it("keeps pt-0 for a headed card that overrides nothing", () => {
		// The other side of the same rule: a card WITH a header wants the
		// default, so the two facing edges do not double up.
		const html = renderToStaticMarkup(
			<Card>
				<CardHeader>
					<CardTitle>Usage Over Time</CardTitle>
				</CardHeader>
				<CardContent>12,345</CardContent>
			</Card>,
		);

		expect(html).toContain("pt-0");
	});
});
