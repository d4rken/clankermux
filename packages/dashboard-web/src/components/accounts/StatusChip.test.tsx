import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusChip } from "./StatusChip";

describe("StatusChip", () => {
	it("renders its children", () => {
		const html = renderToStaticMarkup(<StatusChip>Primary</StatusChip>);
		expect(html).toContain("Primary");
		expect(html).toContain("<span");
	});

	it("applies the shared base pill classes", () => {
		const html = renderToStaticMarkup(<StatusChip>Chip</StatusChip>);
		// One uniform size/shape for every status chip.
		expect(html).toContain("inline-flex");
		expect(html).toContain("items-center");
		expect(html).toContain("rounded-full");
		expect(html).toContain("px-2");
		expect(html).toContain("py-0.5");
		expect(html).toContain("text-xs");
		expect(html).toContain("font-medium");
	});

	it("merges a caller className alongside the base classes", () => {
		const html = renderToStaticMarkup(
			<StatusChip className="bg-amber-100 text-amber-700">
				Near limit
			</StatusChip>,
		);
		// Custom color pair is present…
		expect(html).toContain("bg-amber-100");
		expect(html).toContain("text-amber-700");
		// …and the base classes are still there.
		expect(html).toContain("rounded-full");
		expect(html).toContain("px-2");
	});

	it("spreads native span props (e.g. title)", () => {
		const html = renderToStaticMarkup(<StatusChip title="hello">x</StatusChip>);
		expect(html).toContain('title="hello"');
	});
});
