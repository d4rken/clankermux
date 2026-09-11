import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequestSummary } from "../api";
import { RequestCostDetails } from "./RequestCostDetails";

function render(summary: Partial<RequestSummary>) {
	return renderToStaticMarkup(
		<RequestCostDetails summary={summary as RequestSummary} />,
	);
}
describe("request cost details", () => {
	it("shows reported zero and the catalogue comparison separately", () => {
		const html = render({
			costUsd: 0,
			estimatedCostUsd: 0.02,
			costSource: "reported",
			costIsByok: true,
		});
		expect(html).toContain("Charged by OpenRouter: $0.0000");
		expect(html).toContain("Catalogue estimate: $0.0200");
		expect(html).toContain("BYOK");
	});
	it("distinguishes estimates, unverified historical amounts, and missing costs", () => {
		expect(render({ costUsd: 0.02, costSource: "estimated" })).toContain(
			"Estimated cost: $0.0200",
		);
		expect(render({ costUsd: 0.02 })).toContain(
			"Cost (source unknown): $0.0200",
		);
		expect(render({ costSource: "unknown" })).toContain("Cost unavailable");
		expect(render({ costSource: "unknown" })).not.toContain("$0.0000");
	});
	it("keeps subscription usage labelled as equivalent plan value", () => {
		expect(
			render({ costUsd: 0.02, costSource: "estimated", billingType: "plan" }),
		).toContain("Plan value (API equivalent)");
	});
});
