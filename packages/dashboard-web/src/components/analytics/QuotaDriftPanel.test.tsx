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
	multiGapModel,
	preChangeCohort,
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

	it("names every stretch of a model, not just the longest one", () => {
		// Below the share floor early, measurable in the middle, out of use at the
		// end. The early stretch is the longer one, so reporting only the dominant
		// gap would answer "too little traffic to measure" and hide the reason the
		// line stops NOW.
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([
					windowResult("five_hour", [measuredModel(), multiGapModel()]),
				])}
			/>,
		);

		expect(html).toContain("claude-sonnet-4-5");
		expect(html).toMatch(/too little of this window.{0,6}s traffic to measure/);
		expect(html).toContain("not in use since");
	});

	it("omits the gap list entirely when nothing is unexplained", () => {
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([windowResult("five_hour", [measuredModel()])])}
			/>,
		);

		expect(html).not.toContain("What this analysis could not measure");
	});

	it("states a window the provider never moved, below the chart", () => {
		// The chart keeps its full x-axis and its historical series; the reason it
		// stops being informative is written out rather than drawn.
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort(
					[
						windowResult("five_hour", [measuredModel()], {
							flatSince: Date.UTC(2026, 6, 12, 12, 0, 0, 0),
							lastObservedMs: Date.UTC(2026, 7, 21, 12, 0, 0, 0),
							lastMovementMs: null,
							flatValuePct: 0,
							flatScope: "all-accounts",
						}),
					],
					{ provider: "codex" },
				)}
			/>,
		);

		expect(html).toContain("OpenAI has reported 0% for this window since");
		expect(html).toContain("12 Jul 2026");
		expect(html).toContain("the latest reading on 21 Aug 2026");
		expect(html).toContain("while this proxy kept sending traffic against it");
		// Never an inference about the provider: the percentage series cannot
		// support one, however obvious it feels.
		expect(html).not.toContain("removed");
		expect(html).not.toContain("no longer");
	});

	it("states a window our readings no longer include, below the chart", () => {
		// The series simply ends, and without this the panel gives no reason for
		// it. The sentence covers our readings and stops there.
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort(
					[
						windowResult("five_hour", [measuredModel()], {
							lastObservedMs: Date.UTC(2026, 7, 21, 11, 58, 0, 0),
							notReportedSince: Date.UTC(2026, 7, 21, 12, 0, 0, 0),
							notReportedScope: "all-accounts",
						}),
					],
					{ provider: "codex" },
				)}
			/>,
		);

		expect(html).toContain(
			"No OpenAI usage reading since 21 Aug 2026 has included a 5-hour value",
		);
		expect(html).not.toContain("retired");
		expect(html).not.toContain("removed");
		expect(html).not.toContain("no longer");
	});

	it("says nothing about a window that is still moving", () => {
		const html = renderToStaticMarkup(
			<QuotaDriftPanel
				cohort={cohort([
					windowResult("five_hour", [measuredModel()], {
						flatSince: null,
						lastObservedMs: Date.UTC(2026, 7, 21, 12, 0, 0, 0),
						lastMovementMs: Date.UTC(2026, 7, 21, 11, 0, 0, 0),
						flatValuePct: null,
					}),
				])}
			/>,
		);

		expect(html).not.toContain("There is nothing here to measure");
	});

	it("renders a payload written before any of these fields existed", () => {
		// The cached blob is up to 30 minutes old and carries no schema version,
		// so the panel has to render the previous shape without inventing a
		// reason, a date, or a flat-window claim from the absence.
		const html = renderToStaticMarkup(
			<QuotaDriftPanel cohort={preChangeCohort()} />,
		);

		expect(html).toContain("5-hour window");
		expect(html).not.toContain("There is nothing here to measure");
		expect(html).not.toContain("has included a 5-hour value");
		// The gap is still stated, but only as far as the payload supports: the
		// stretch is real, the cause is unknown and must not be guessed.
		expect(html).toContain("claude-haiku-4-5");
		expect(html).toContain("not measurable on this window");
		expect(html).not.toContain("undefined");
		expect(html).not.toContain("NaN");
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
