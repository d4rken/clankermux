import { describe, expect, it } from "bun:test";
import type { ClientApplication } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderMarkIcon } from "../accounts/provider-marks";
import { ApplicationMarkIcon } from "./application-marks";
import { APPLICATIONS } from "./setup";

const applications = Object.keys(APPLICATIONS) as ClientApplication[];

describe("ApplicationMarkIcon", () => {
	it("gives every application the wizard offers a decorative, sized icon", () => {
		for (const application of applications) {
			const html = renderToStaticMarkup(
				<ApplicationMarkIcon application={application} className="h-5 w-5" />,
			);
			expect(html).toContain("<svg");
			expect(html).toContain('aria-hidden="true"');
			expect(html).toContain("h-5 w-5");
		}
	});

	it("draws a brand mark for every application except the unbranded one", () => {
		for (const application of applications) {
			const html = renderToStaticMarkup(
				<ApplicationMarkIcon application={application} />,
			);
			// Only a brand mark opens its class list with a fill utility; the
			// fallback is a lucide glyph, which strokes rather than fills and
			// carries its own class. Without this, a harness added to the union
			// but not to the mark table would still pass every other assertion
			// here, because the fallback satisfies all of them.
			expect([application, html.includes('class="fill-')]).toEqual([
				application,
				application !== "generic",
			]);
		}
	});

	it("renders the same marks the Accounts page uses for Claude and OpenAI", () => {
		expect(
			renderToStaticMarkup(
				<ApplicationMarkIcon application="claude-code" className="h-5 w-5" />,
			),
		).toEqual(
			renderToStaticMarkup(
				<ProviderMarkIcon provider="anthropic" className="h-5 w-5" />,
			),
		);
		expect(
			renderToStaticMarkup(
				<ApplicationMarkIcon application="codex" className="h-5 w-5" />,
			),
		).toEqual(
			renderToStaticMarkup(
				<ProviderMarkIcon provider="codex" className="h-5 w-5" />,
			),
		);
	});

	it("scales Oh My Pi's mark with its own view box", () => {
		const html = renderToStaticMarkup(
			<ApplicationMarkIcon application="oh-my-pi" />,
		);
		// The path's own bounds, so the pi fills the row icon like the 24x24
		// marks do rather than floating inside the source badge's padding.
		expect(html).toContain('viewBox="14 16 36 40"');
		expect(html).toContain("fill-[#9B4DFF]");
	});
});
