import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InsetPanel } from "./inset-panel";

describe("InsetPanel", () => {
	it("renders a div carrying the shared inset surface", () => {
		const html = renderToStaticMarkup(<InsetPanel>body</InsetPanel>);
		expect(html).toStartWith("<div ");
		expect(html).toContain("rounded-md");
		expect(html).toContain("border");
		expect(html).toContain("bg-muted/30");
		expect(html).toContain("px-row");
		expect(html).toContain("py-item");
	});

	/**
	 * Two call sites in LimitsCapacityOverview wrap `<dt>`/`<dd>` pairs. A
	 * `<div>` there would leave those pairs without a `dl` ancestor: invalid
	 * markup and no list semantics for assistive technology. That is what the
	 * `as` prop exists for.
	 */
	it("renders the requested element when `as` is given", () => {
		const html = renderToStaticMarkup(
			<InsetPanel as="dl">
				<dt>Reporting</dt>
				<dd>2 of 3 accounts</dd>
			</InsetPanel>,
		);
		expect(html).toStartWith("<dl ");
		expect(html).toContain("<dt>Reporting</dt>");
	});

	/**
	 * The whole reason `cn()` had to learn the spacing scale before this
	 * primitive existed: those two `<dl>` sites put their padding on the inner
	 * cells and cancel the primitive's with `p-0`. If the named scale is not
	 * registered, `px-row py-item` survives the cancel and the cells double up.
	 */
	it("lets a caller's p-0 cancel its padding", () => {
		const html = renderToStaticMarkup(<InsetPanel className="p-0" />);
		expect(html).toContain("p-0");
		expect(html).not.toContain("px-row");
		expect(html).not.toContain("py-item");
	});

	it("appends caller classes after its own", () => {
		const html = renderToStaticMarkup(
			<InsetPanel className="mt-group grid grid-cols-2" />,
		);
		expect(html).toContain("bg-muted/30");
		expect(html).toContain("mt-group");
		expect(html).toContain("grid-cols-2");
	});
});
