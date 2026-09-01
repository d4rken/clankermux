import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "./table";

describe("TableFrame", () => {
	it("frames by default and scrolls in both variants", () => {
		const framed = renderToStaticMarkup(<TableFrame />);
		expect(framed).toContain("rounded-md");
		expect(framed).toContain("border");
		// Not `overflow-hidden`: it clips the tinted head to the rounded corners
		// just the same, and the wide tables get somewhere to go.
		expect(framed).toContain("overflow-x-auto");

		const bare = renderToStaticMarkup(<TableFrame variant="bare" />);
		expect(bare).toContain("overflow-x-auto");
		expect(bare).not.toContain("rounded-md");
		expect(bare).not.toContain("border");
	});
});

describe("Table sections", () => {
	/**
	 * A footer is a `<tfoot>`. Spelled out because the mistake — a second
	 * `<thead>` — both typechecks and renders, and only shows up as a totals row
	 * that the browser has hoisted to the top of the table.
	 */
	it("renders the footer as a tfoot, not a second thead", () => {
		const html = renderToStaticMarkup(
			<Table>
				<TableFooter>
					<TableRow>
						<TableCell>Total</TableCell>
					</TableRow>
				</TableFooter>
			</Table>,
		);
		expect(html).toContain("<tfoot");
		expect(html.match(/<thead/g)).toBeNull();
	});

	/**
	 * Tailwind's preflight already sets `border-collapse: collapse` on every
	 * `table`, and globals.css imports it. Two call sites restating it is what
	 * made it look like a decision.
	 */
	it("does not restate border-collapse", () => {
		const html = renderToStaticMarkup(<Table />);
		expect(html).toContain("w-full");
		expect(html).toContain("text-sm");
		expect(html).not.toContain("border-collapse");
	});
});

describe("TableCell", () => {
	/**
	 * `ModelWindowCostPanel.test.tsx` asserts `not.toContain("tokens</td>")` to
	 * hold an unidentified model's capacity column collapsed. That couples to
	 * `<td>` being the IMMEDIATE parent of the text: wrap children in anything
	 * and the assertion passes forever while testing nothing.
	 */
	it("renders children directly, with no wrapper element", () => {
		const html = renderToStaticMarkup(
			<Table>
				<TableBody>
					<TableRow>
						<TableCell>45.0M eq-tokens</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		expect(html).toContain("45.0M eq-tokens</td>");
	});
});

describe("TableHead", () => {
	/**
	 * The type treatment is derived from `scope` rather than carried on a
	 * separate variant, so a `.label-caps` row label and a bare-weight column
	 * head are both unrepresentable. `.label-caps` is a base-layer component
	 * class, so a call site could not cancel it with `cn()` either way.
	 */
	it("gives a column head the label-caps micro-label", () => {
		const html = renderToStaticMarkup(<TableHead>Account</TableHead>);
		expect(html).toContain('scope="col"');
		expect(html).toContain("label-caps");
	});

	it("leaves a row label at data weight", () => {
		const html = renderToStaticMarkup(<TableHead scope="row">Total</TableHead>);
		expect(html).toContain('scope="row"');
		// It sits beside its own font-medium totals; shrinking and muting it
		// would make a data row mimic a column head.
		expect(html).not.toContain("label-caps");
		expect(html).toContain("font-medium");
	});
});

describe("density", () => {
	it("defaults to the comfortable padding on heads and cells", () => {
		const html = renderToStaticMarkup(
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Claim</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell>812</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		expect(html.match(/px-row py-item/g)).toHaveLength(2);
		expect(html).not.toContain("px-tight");
	});

	/**
	 * Density is set once on the table and read from context, rather than
	 * repeated on each of the 27 cells the widest call site has, where a later
	 * edit misses one.
	 */
	it("reaches both heads and cells through the context", () => {
		const html = renderToStaticMarkup(
			<Table density="compact">
				<TableHeader>
					<TableRow>
						<TableHead>Claim</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell>812</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		// Compact is px-tight, not px-0: columns that touch are a more visible
		// defect than 4px of width per side.
		expect(html.match(/px-tight py-tight/g)).toHaveLength(2);
		expect(html).not.toContain("px-row");
	});
});

/**
 * The same contract `cn()` learning the named spacing scale bought the other
 * primitives: a call site's padding has to WIN, not sit beside the default and
 * lose to source order.
 */
describe("padding overrides", () => {
	it("lets a call-site p-* on the named scale cancel the primitive's", () => {
		const html = renderToStaticMarkup(
			<TableCell className="p-tight">812</TableCell>,
		);
		expect(html).toContain("p-tight");
		expect(html).not.toContain("px-row");
		expect(html).not.toContain("py-item");
	});
});
