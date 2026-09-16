import { afterEach, describe, expect, it } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	changedModel,
	cohort,
	measuredModel,
	readyResponse,
	windowResult,
} from "./__fixtures__/quota-drift";
import { QuotaChangeVerdicts } from "./QuotaChangeVerdicts";
import { QuotaDriftPanel } from "./QuotaDriftPanel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
}
afterEach(unmount);
async function renderCaveats(
	node: ReactNode,
	label = "What these numbers are not",
) {
	await unmount();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root?.render(node));
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	const trigger = host.querySelector<HTMLButtonElement>(
		`button[aria-label="${label}"]`,
	);
	expect(trigger).not.toBeNull();
	await act(async () => trigger?.click());
	return document.body.textContent ?? "";
}

describe("quota caveats popover", () => {
	it("opens the four things the measurement cannot separate", async () => {
		const html = await renderCaveats(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([windowResult("five_hour", [measuredModel()])]),
				])}
			/>,
		);

		expect(html).toContain("What these numbers are not");
		expect(html).toContain("implied cost");
		expect(html).toContain("not the provider's internal quota accounting");
		expect(html).toContain("weights input, output and cached");
		expect(html).toContain("cannot be measured here");
		expect(html).toContain("how model ids are normalized");
	});

	it("labels the hidden-traffic figure as a lower bound, never as coverage", async () => {
		const html = await renderCaveats(
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

	it("qualifies implied capacity as conditional on list-price ratios", async () => {
		// The number is 100/coefficient in PRICE-EQUIVALENT tokens. Presented
		// without that condition it reads as a measured raw-token quota, which is
		// the one thing it is not.
		const html = await renderCaveats(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([windowResult("five_hour", [measuredModel()])]),
				])}
			/>,
		);

		expect(html).toContain("price-equivalent tokens");
		expect(html).toContain("list-price ratios");
		expect(html).toContain("not a measurement of a raw-token quota");
	});

	it("discloses an assumed tier and omits the line when every tier was recorded", async () => {
		const assumed = await renderCaveats(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([windowResult("five_hour", [measuredModel()])], {
						tierProvenance: "assumed",
					}),
				])}
			/>,
		);
		expect(assumed).toContain("inferred from today's values");
		expect(assumed).toContain("reads exactly like quota drift");

		const recorded = await renderCaveats(
			<QuotaChangeVerdicts
				data={readyResponse([
					cohort([windowResult("five_hour", [measuredModel()])]),
				])}
			/>,
		);
		expect(recorded).not.toContain("inferred from today's values");
	});
	it("frames change markers as detected changes, not provider actions", async () => {
		const html = await renderCaveats(
			<QuotaDriftPanel
				cohort={cohort([windowResult("five_hour", [changedModel()])])}
			/>,
			"How to read this chart",
		);

		expect(html).toContain(
			"detected changes in implied cost, not confirmed provider actions",
		);
		expect(html).not.toContain("reduced your quota");
	});

	it("states that the line breaks where the model was not separable", async () => {
		const html = await renderCaveats(
			<QuotaDriftPanel
				cohort={cohort([windowResult("five_hour", [measuredModel()])])}
			/>,
			"How to read this chart",
		);

		expect(html).toContain("90% intervals");
		expect(html).toContain(
			"the line breaks wherever the model could not be separated",
		);
	});
});
