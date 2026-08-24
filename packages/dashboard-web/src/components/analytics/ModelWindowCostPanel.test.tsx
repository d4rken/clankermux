/**
 * Window-cost table.
 *
 * The claim under test is the one the panel exists to protect: an unidentified
 * model reads as a stated reason, never as a number, a zero, or a dash. A
 * `0.00%` in this table would say "this model is free" when the truth is "we
 * could not tell", and that is the exact failure the null-not-zero wire
 * contract exists to prevent.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	cohort,
	measuredModel,
	retiredModel,
	unidentifiedModel,
	windowResult,
} from "./__fixtures__/quota-drift";
import { ModelWindowCostPanel } from "./ModelWindowCostPanel";

describe("ModelWindowCostPanel", () => {
	it("renders a loading state with no table", () => {
		const html = renderToStaticMarkup(<ModelWindowCostPanel loading />);

		expect(html).toContain("Loading analysis");
		expect(html).not.toContain("<table");
	});

	it("says so when a cohort has no fitted windows", () => {
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel cohort={cohort([])} />,
		);

		expect(html).toContain("No fitted windows for this group yet");
	});

	it("shows the coefficient, its interval and the implied capacity", () => {
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel
				cohort={cohort([windowResult("five_hour", [measuredModel()])])}
			/>,
		);

		expect(html).toContain("5-hour window");
		expect(html).toContain("claude-opus-5");
		// 100 / 45 = 2.22 points per 1M eq-tokens.
		expect(html).toContain("2.22%");
		expect(html).toContain("2.04 – 2.40%");
		expect(html).toContain("45.0M eq-tokens");
		expect(html).toContain("64.0%");
	});

	it("renders both windows with their own observation counts", () => {
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel
				cohort={cohort([
					windowResult("five_hour", [measuredModel()]),
					windowResult("seven_day", [measuredModel("claude-opus-5", 900)], {
						nSegments: 73,
					}),
				])}
			/>,
		);

		expect(html).toContain("5-hour window");
		expect(html).toContain("Weekly window");
		expect(html).toContain("73 observations");
		expect(html).toContain("900M eq-tokens");
	});

	it("gives an unidentified model a reason, never a number", () => {
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel
				cohort={cohort([windowResult("five_hour", [unidentifiedModel()])])}
			/>,
		);

		expect(html).toContain("claude-haiku-4-5");
		expect(html).toContain("Not enough independent traffic");
		expect(html).toContain("always runs alongside another model");
		// The three numeric columns collapse into the reason; nothing numeric may
		// appear for this model except its share of traffic.
		expect(html).not.toContain("0.00%");
		expect(html).not.toContain("tokens</td>");
		// Its share IS known and is shown — it is what makes "too little traffic"
		// checkable rather than an assertion.
		expect(html).toContain("11.0%");
	});

	it("says a retired model was not in use, not that it was too small", () => {
		// The same model the chart's gap list calls "not in use during this
		// period". Before this the table had no coefficient to read, fell back to
		// "Not enough independent traffic", and the two halves of one tab gave a
		// reader two different reasons for the same fact.
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel
				cohort={cohort([
					windowResult("five_hour", [measuredModel(), retiredModel()]),
				])}
			/>,
		);

		expect(html).toContain("claude-opus-4-8");
		expect(html).toContain("Not in use during this period");
		expect(html).not.toContain("Too little of this window");
		// Zero exposure is a real, counted share, so it is shown as one rather
		// than as an em dash that would read as "unknown".
		expect(html).toContain("0.0%");
		expect(html).not.toContain("0.00%");
	});

	it("discloses an assumed tier in the panel description", () => {
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel
				cohort={cohort([windowResult("five_hour", [measuredModel()])], {
					tierProvenance: "assumed",
				})}
			/>,
		);

		expect(html).toContain("inferred from today&#x27;s account values");
	});

	it("denominates BOTH numeric columns in price-equivalent tokens", () => {
		// The prose above the table is not enough: a reader scanning columns takes
		// "/ 1M" as raw tokens and "45.0M tokens" as a raw-token budget. Neither
		// column measures raw tokens — both are list-price-weighted equivalents.
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel
				cohort={cohort([windowResult("five_hour", [measuredModel()])])}
			/>,
		);

		expect(html).toContain("% of window / 1M eq-tokens");
		expect(html).toContain("45.0M eq-tokens");
		expect(html).not.toContain("45.0M tokens");
		expect(html).toContain("price-equivalent tokens");
	});

	it("states the cluster support behind a printed coefficient", () => {
		// The interval cannot express this: the bootstrap resamples whole runs, so
		// a coefficient resting on two runs and one resting on forty print
		// indistinguishable widths.
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel
				cohort={cohort([windowResult("five_hour", [measuredModel()])])}
			/>,
		);

		expect(html).toContain("exposure in 12 runs across 3 accounts");
	});

	it("never shows support on a row that prints a reason instead of a number", () => {
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel
				cohort={cohort([
					windowResult("five_hour", [unidentifiedModel(), retiredModel()]),
				])}
			/>,
		);

		expect(html).not.toContain("exposure in");
	});

	it("says so when a window carried no measurable models at all", () => {
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel cohort={cohort([windowResult("five_hour", [])])} />,
		);

		expect(html).toContain("No models carried enough traffic in this window");
	});
});
