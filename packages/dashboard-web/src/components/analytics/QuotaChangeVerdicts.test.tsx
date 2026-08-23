/**
 * Quota-tab verdict callouts.
 *
 * The panel's job is mostly to refuse to say things, so that is what is
 * asserted: the caveat block is always present, `computing` is distinguishable
 * from "nothing is drifting", a `stable` verdict on an unmeasurable coefficient
 * is not reported as a negative result, and the hidden-traffic figure is
 * labelled as a lower bound rather than as coverage.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	COMPUTING,
	changedModel,
	cohort,
	measuredModel,
	readyResponse,
	underpoweredModel,
	unidentifiedModel,
	windowResult,
} from "./__fixtures__/quota-drift";
import { QuotaChangeVerdicts } from "./QuotaChangeVerdicts";

describe("QuotaChangeVerdicts", () => {
	it("renders a loading state without claiming anything", () => {
		const html = renderToStaticMarkup(<QuotaChangeVerdicts loading />);

		expect(html).toContain("Loading analysis");
		expect(html).not.toContain("No change detected");
	});

	it("distinguishes computing from a measured absence of drift", () => {
		const html = renderToStaticMarkup(<QuotaChangeVerdicts data={COMPUTING} />);

		expect(html).toContain("Computing");
		expect(html).toContain("the first pass has not finished yet");
		expect(html).not.toContain("No change detected");
		expect(html).not.toContain("Nothing measurable yet");
	});

	it("says nothing is measurable when the payload is empty", () => {
		const html = renderToStaticMarkup(
			<QuotaChangeVerdicts data={readyResponse([])} />,
		);

		expect(html).toContain("Nothing measurable yet");
		expect(html).not.toContain("No change detected");
	});

	it("reports a detected change as an observed change in IMPLIED cost", () => {
		const html = renderToStaticMarkup(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([windowResult("five_hour", [changedModel()])]),
				])}
			/>,
		);

		expect(html).toContain("observed change in implied cost");
		expect(html).toContain("+38%");
		expect(html).toContain("claude-sonnet-5");
		// Never a claim about what the provider did.
		expect(html).not.toContain("reduced your quota");
		expect(html).not.toContain("Anthropic reduced");
	});

	it("does not report stable for a coefficient it refuses to print", () => {
		const html = renderToStaticMarkup(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([windowResult("five_hour", [unidentifiedModel()])]),
				])}
			/>,
		);

		// The model's verdict IS "stable" on the wire, but its estimate is not
		// identified: reporting it would claim a negative result about a number
		// the panel never shows.
		expect(html).not.toContain("claude-haiku-4-5");
		expect(html).not.toContain("No change detected");
		// It collapses to the same answer an empty payload gets: there is nothing
		// this panel is willing to claim about the model.
		expect(html).toContain("Nothing measurable yet");
	});

	it("keeps insufficient-evidence out of the stable list", () => {
		const html = renderToStaticMarkup(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([
						windowResult("five_hour", [measuredModel(), underpoweredModel()]),
					]),
				])}
			/>,
		);

		expect(html).toContain("No change detected");
		expect(html).toContain("claude-opus-5");
		// The scan could not run for this one; it is not a negative result.
		expect(html).not.toContain("claude-fable-5");
	});

	it("always states the four things the measurement cannot separate", () => {
		const html = renderToStaticMarkup(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([windowResult("five_hour", [measuredModel()])]),
				])}
			/>,
		);

		expect(html).toContain("What these numbers are not");
		expect(html).toContain("implied cost");
		expect(html).toContain("not the provider&#x27;s internal quota accounting");
		expect(html).toContain("weights input, output and cached");
		expect(html).toContain("cannot be measured here");
		expect(html).toContain("how model ids are normalized");
	});

	it("labels the hidden-traffic figure as a lower bound, never as coverage", () => {
		const html = renderToStaticMarkup(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([
						windowResult("five_hour", [measuredModel()], {
							zeroObservedTokenDeltaShare: 0.084,
						}),
					]),
				])}
			/>,
		);

		expect(html).toContain("At least 8.4%");
		expect(html).toContain(
			"a lower bound on hidden usage, not a coverage figure",
		);
		expect(html).not.toContain("coverage of");
		expect(html).not.toContain("fully observed");
	});

	it("discloses an assumed tier and omits the line when every tier was recorded", () => {
		const assumed = renderToStaticMarkup(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([windowResult("five_hour", [measuredModel()])], {
						tierProvenance: "assumed",
					}),
				])}
			/>,
		);
		expect(assumed).toContain("inferred from today&#x27;s values");
		expect(assumed).toContain("reads exactly like quota drift");

		const recorded = renderToStaticMarkup(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([windowResult("five_hour", [measuredModel()])]),
				])}
			/>,
		);
		expect(recorded).not.toContain("inferred from today&#x27;s values");
	});
});
