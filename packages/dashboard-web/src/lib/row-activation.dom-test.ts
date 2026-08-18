import { afterEach, describe, expect, it } from "bun:test";
import {
	hasSelectionWithin,
	isRowActivationClick,
	isRowSurfaceTarget,
} from "./row-activation";

/**
 * `.dom-test.ts` because the guard is defined in terms of real DOM traversal
 * (`closest`, `contains`, `Selection`). Stubbing those would test the stub:
 * the whole point of the helper is that a click on an icon inside a nested
 * <Button> resolves to that button and not to the row.
 */

/**
 * Mirrors the real row: a plain container (NOT itself interactive), a summary
 * <button> covering row 1, an action strip marked `data-row-ignore`, and
 * non-interactive badges on the last row.
 */
function buildRow(): {
	row: HTMLElement;
	summary: HTMLElement;
	text: HTMLElement;
	icon: Element;
	strip: HTMLElement;
	badge: HTMLElement;
	chip: HTMLElement;
} {
	document.body.innerHTML = `
		<div id="row">
			<div id="line">
				<button id="summary"><span id="text">14:02:11</span></button>
				<div id="strip" data-row-ignore>
					<button id="copy"><svg id="icon"></svg></button>
				</div>
			</div>
			<div>
				<button id="chip">my-project</button>
				<div id="badge">1.2k tokens</div>
			</div>
		</div>
	`;
	const byId = (id: string) => {
		const el = document.getElementById(id);
		if (!el) throw new Error(`missing #${id}`);
		return el;
	};
	const icon = document.querySelector("#icon");
	if (!icon) throw new Error("missing #icon");
	return {
		row: byId("row"),
		summary: byId("summary"),
		text: byId("text"),
		icon,
		strip: byId("strip"),
		badge: byId("badge"),
		chip: byId("chip"),
	};
}

afterEach(() => {
	document.body.innerHTML = "";
	window.getSelection()?.removeAllRanges();
});

describe("isRowSurfaceTarget", () => {
	it("accepts a click on a non-interactive badge", () => {
		const { row, badge } = buildRow();
		expect(isRowSurfaceTarget(badge, row)).toBe(true);
	});

	it("accepts a click on the container itself", () => {
		const { row } = buildRow();
		expect(isRowSurfaceTarget(row, row)).toBe(true);
	});

	it("rejects a click on a nested button", () => {
		const { row, chip } = buildRow();
		expect(isRowSurfaceTarget(chip, row)).toBe(false);
	});

	it("rejects a click on the row-1 summary button, which opens the row itself", () => {
		// The summary button has its own handler; letting the container fire too
		// would open the modal twice per click.
		const { row, text } = buildRow();
		expect(isRowSurfaceTarget(text, row)).toBe(false);
	});

	it("rejects a click on an icon inside a nested button", () => {
		const { row, icon } = buildRow();
		expect(isRowSurfaceTarget(icon, row)).toBe(false);
	});

	it("rejects a click on a data-row-ignore region, e.g. beside a disabled button", () => {
		const { row, strip } = buildRow();
		expect(isRowSurfaceTarget(strip, row)).toBe(false);
	});

	it("ignores an interactive ancestor ABOVE the container", () => {
		const { row, badge } = buildRow();
		const outerButton = document.createElement("button");
		document.body.appendChild(outerButton);
		outerButton.appendChild(row);
		expect(isRowSurfaceTarget(badge, row)).toBe(true);
	});

	it("rejects a target outside the container", () => {
		const { row } = buildRow();
		const outside = document.createElement("span");
		document.body.appendChild(outside);
		expect(isRowSurfaceTarget(outside, row)).toBe(false);
	});

	it("rejects a non-element target", () => {
		const { row } = buildRow();
		expect(isRowSurfaceTarget(null, row)).toBe(false);
	});
});

describe("hasSelectionWithin", () => {
	it("is false without a selection", () => {
		const { row } = buildRow();
		expect(hasSelectionWithin(row, window.getSelection())).toBe(false);
	});

	it("is true while row text is selected", () => {
		const { row, text } = buildRow();
		const range = document.createRange();
		range.selectNodeContents(text);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		expect(hasSelectionWithin(row, selection)).toBe(true);
	});

	it("is true for a selection dragged out of the row into a sibling", () => {
		const { row, text } = buildRow();
		const sibling = document.createElement("p");
		sibling.textContent = "the next row";
		document.body.appendChild(sibling);
		const range = document.createRange();
		range.setStart(text.firstChild ?? text, 0);
		range.setEnd(sibling.firstChild ?? sibling, 3);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		// The mouse-up lands on the sibling, but the row is still half-selected;
		// releasing there must not open the row it was dragged out of either.
		expect(hasSelectionWithin(row, selection)).toBe(true);
	});

	it("ignores a selection made outside the row", () => {
		const { row } = buildRow();
		const outside = document.createElement("p");
		outside.textContent = "elsewhere on the page";
		document.body.appendChild(outside);
		const range = document.createRange();
		range.selectNodeContents(outside);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		expect(hasSelectionWithin(row, selection)).toBe(false);
	});
});

describe("isRowActivationClick", () => {
	it("opens on a plain click", () => {
		const { row, badge } = buildRow();
		expect(isRowActivationClick(badge, row, window.getSelection())).toBe(true);
	});

	it("does not open when the click ends a text selection in the row", () => {
		const { row, badge } = buildRow();
		const range = document.createRange();
		range.selectNodeContents(badge);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		expect(isRowActivationClick(badge, row, selection)).toBe(false);
	});

	it("does not open when a nested control was clicked", () => {
		const { row, chip } = buildRow();
		expect(isRowActivationClick(chip, row, window.getSelection())).toBe(false);
	});
});
