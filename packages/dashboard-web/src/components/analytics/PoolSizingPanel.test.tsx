/**
 * What the pool-sizing panel must say, and what it must never say.
 *
 * The load-bearing assertions are the ones about refusal: a row whose tiers
 * differ has to state that in words rather than showing a verdict the number
 * alone would support, a lower-bound figure has to carry its ≥, and the
 * explanatory prose has to stay inside a `<details>` so the panel opens as
 * numbers rather than as an essay.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	emptyPoolSizingFixture,
	POOL_SIZING_NOW,
	poolSizingFixture,
} from "./__fixtures__/pool-sizing";
import { PoolSizingPanel } from "./PoolSizingPanel";

function render(
	props: Partial<React.ComponentProps<typeof PoolSizingPanel>> = {},
): string {
	return renderToStaticMarkup(
		<PoolSizingPanel now={POOL_SIZING_NOW} {...props} />,
	);
}

describe("PoolSizingPanel", () => {
	it("renders skeletons while the first read is in flight", () => {
		const html = render({ loading: true });
		expect(html).toContain("Pool sizing");
		expect(html).toContain("animate-pulse");
		expect(html).not.toContain("No weekly usage samples recorded yet.");
	});

	it("states the reason instead of a body when the read failed", () => {
		const html = render({
			unavailableReason: "Pool sizing data is unavailable",
		});
		expect(html).toContain("Pool sizing data is unavailable");
		expect(html).not.toContain("animate-pulse");
		expect(html).not.toContain("How this is computed");
	});

	it("says nothing was recorded rather than drawing an empty table", () => {
		const html = render({ data: emptyPoolSizingFixture() });
		expect(html).toContain("No weekly usage samples recorded yet.");
		expect(html).not.toContain("<table");
	});

	it("renders one row per pool with its verdict and latest completed cycle", () => {
		const html = render({ data: poolSizingFixture() });

		expect(html).toContain("Claude");
		expect(html).toContain("GPT");
		expect(html).toContain("Removal infeasible");
		expect(html).toContain("Removal not established");
		expect(html).toContain("4.79 of 5");
		expect(html).toContain("account-weeks");
	});

	it("names the reason a row's account-weeks are not a comparable unit", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("tiers differ or unknown");
	});

	it("nests the family row under its class with the family label", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("Fable");
		expect(html).toContain("4.66 of 5");
		expect(html.indexOf("Fable")).toBeGreaterThan(html.indexOf("Claude"));
		expect(html.indexOf("Fable")).toBeLessThan(html.indexOf("GPT"));
	});

	it("marks a lower-bound cycle and explains the marker", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("≥ 4.50 of 5");
		expect(html).toContain("lower bound: part of this cycle was not sampled");
	});

	it("shows the running cycle apart from the completed ones", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("In progress");
		expect(html).toContain("1.50 of 5 so far");
	});

	it("keeps rejected attempts visible and separate from terminal stops", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("Rejected attempts");
		expect(html).toContain("Stops");
	});

	it("lists stops that are not capacity evidence in their own block", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("Stops not counted as capacity");
		expect(html).toContain("all_accounts_failed");
		expect(html).toContain("claude-3-opus-retired");
	});

	it("keeps the method behind a collapsed summary, never as page prose", () => {
		const html = render({ data: poolSizingFixture() });
		expect(html).toContain("How this is computed");

		const summaryIndex = html.indexOf("How this is computed");
		const body = "Deleting an account deletes its usage history";
		const bodyIndex = html.indexOf(body);
		expect(bodyIndex).toBeGreaterThan(summaryIndex);

		// The whole explanation lives inside the LAST <details> opened before it.
		const detailsOpen = html.lastIndexOf("<details", summaryIndex);
		const detailsClose = html.indexOf("</details>", summaryIndex);
		expect(detailsOpen).toBeGreaterThanOrEqual(0);
		expect(bodyIndex).toBeGreaterThan(detailsOpen);
		expect(bodyIndex).toBeLessThan(detailsClose);
		// And it is collapsed: no `open` attribute on that element.
		expect(html.slice(detailsOpen, summaryIndex)).not.toContain("open");
	});

	it("never offers a verdict that an account could be removed", () => {
		const html = render({ data: poolSizingFixture() });
		// The one-sided verdict has exactly two spellings, and neither is a
		// green light.
		expect(html).not.toContain("Removal possible");
		expect(html).not.toContain("Removable");
		// "removable" appears once, in the sentence that rules it out.
		expect(html).toContain("Nothing here ever says an account is removable.");
		expect(html.split("removable")).toHaveLength(2);
	});
});
