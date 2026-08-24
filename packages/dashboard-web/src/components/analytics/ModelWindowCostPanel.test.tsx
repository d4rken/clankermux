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
		expect(html).toContain("45.0M tokens");
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
		expect(html).toContain("900M tokens");
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

	it("says so when a window carried no measurable models at all", () => {
		const html = renderToStaticMarkup(
			<ModelWindowCostPanel cohort={cohort([windowResult("five_hour", [])])} />,
		);

		expect(html).toContain("No models carried enough traffic in this window");
	});
});
