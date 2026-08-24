/**
 * Implied-capacity series.
 *
 * `renderToStaticMarkup` gives no layout, so recharts' ResponsiveContainer
 * renders at zero size and the SVG itself is not inspectable here. What IS
 * checkable, and what matters, is the panel's framing and its refusal states:
 * a model that was never separately identified must not get a line at all, an
 * empty series must say the evidence is absent rather than draw a flat line,
 * and the copy must not promise more than a fit over indirect evidence can.
 *
 * The line-breaking behaviour itself is a recharts prop (`connectNulls={false}`)
 * over data this test builds explicitly; the rendered geometry is left to the
 * charting library.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	changedModel,
	cohort,
	measuredModel,
	retiredModel,
	unidentifiedModel,
	windowResult,
} from "./__fixtures__/quota-drift";
import { QuotaDriftPanel } from "./QuotaDriftPanel";

describe("QuotaDriftPanel", () => {
	it("renders a loading state", () => {
		const html = renderToStaticMarkup(<QuotaDriftPanel loading />);

		expect(html).toContain("Implied Capacity Over Time");
		expect(html).toContain("animate-spin");
	});

	it("says so when the cohort has no fitted windows", () => {
		const html = renderToStaticMarkup(<QuotaDriftPanel cohort={cohort([])} />);

		expect(html).toContain("No fitted windows for this group yet");
	});

	it("calls an all-unidentified window an absence of evidence, not a flat line", () => {
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([windowResult("five_hour", [unidentifiedModel()])])}
			/>,
		);

		expect(html).toContain(
			"has been separately measurable for long enough to plot",
		);
		expect(html).toContain("This is an absence of evidence, not a flat line");
		// No line is drawn, so there is no chart to carry a legend entry — but the
		// model still has to be accounted for in words, or it vanishes from the
		// page entirely and the reader never learns it exists.
		expect(html).toContain("What this analysis could not measure, and why");
		expect(html).toContain("claude-haiku-4-5");
		expect(html).toContain(
			"always runs alongside another model, so its own cost cannot be separated",
		);
	});

	it("renders a chart once at least one model is identified somewhere", () => {
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([
					windowResult("five_hour", [measuredModel(), unidentifiedModel()]),
				])}
			/>,
		);

		expect(html).toContain("5-hour window");
		expect(html).not.toContain("This is an absence of evidence");
	});

	it("frames change markers as detected changes, not provider actions", () => {
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([windowResult("five_hour", [changedModel()])])}
			/>,
		);

		expect(html).toContain(
			"detected changes in implied cost, not confirmed provider actions",
		);
		expect(html).not.toContain("reduced your quota");
	});

	it("states that the line breaks where the model was not separable", () => {
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([windowResult("five_hour", [measuredModel()])])}
			/>,
		);

		expect(html).toContain("90% intervals");
		expect(html).toContain(
			"the line breaks wherever the model could not be separated",
		);
	});

	it("names the model and the period a model stopped being routed", () => {
		// The biggest empty regions on the live chart. The chart itself just
		// breaks its line; without this the reader has no way to tell "we could
		// not measure it" from "it was not running".
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([
					windowResult("five_hour", [measuredModel(), retiredModel()]),
				])}
			/>,
		);

		expect(html).toContain("claude-opus-4-8");
		expect(html).toMatch(/claude-opus-4-8<\/span> — not in use since \d+ \w+/);
		// The measured model has no gap, so it contributes no line.
		expect(html).not.toContain("claude-opus-5</span> —");
	});

	it("omits the gap list entirely when nothing is unexplained", () => {
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([windowResult("five_hour", [measuredModel()])])}
			/>,
		);

		expect(html).not.toContain("What this analysis could not measure");
	});

	it("renders one series block per window", () => {
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([
					windowResult("five_hour", [measuredModel()]),
					windowResult("seven_day", [measuredModel("claude-opus-5", 900)]),
				])}
			/>,
		);

		expect(html).toContain("5-hour window");
		expect(html).toContain("Weekly window");
	});
});
