/**
 * The "Usage by API key" donut.
 *
 * Everything here is about IDENTITY. The rows carry an `apiKeyId` and a display
 * label, and the label is not unique: a live key and a hard-deleted one can
 * share a name, and "No key" — the label the null bucket gets — is also a name
 * a real key can be given. Grouping the legend by label would merge those into
 * one slice whose number belongs to neither of them, and nothing on screen
 * would say so.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartsSection } from "./ChartsSection";

type Row = {
	apiKeyId: string | null;
	apiKey: string;
	model: string;
	count: number;
};

function render(apiKeyModelUsageData: Row[]): string {
	return renderToStaticMarkup(
		<ChartsSection
			timeSeriesData={[]}
			timeRange="6h"
			modelData={[]}
			apiKeyModelUsageData={apiKeyModelUsageData}
			projectBreakdownData={[]}
			loading={false}
		/>,
	);
}

/** The markup of the API-key card alone, so the assertions can't match a sibling card. */
function apiKeyCard(html: string): string {
	const at = html.indexOf("Usage by API key");
	expect(at).toBeGreaterThan(-1);
	const rest = html.slice(at);
	const next = rest.indexOf("Usage by Project");
	return next === -1 ? rest : rest.slice(0, next);
}

describe("ChartsSection API-key donut", () => {
	it("totals each key and lists its models when it spans more than one", () => {
		const card = apiKeyCard(
			render([
				{ apiKeyId: "k1", apiKey: "workstation", model: "opus", count: 30 },
				{ apiKeyId: "k1", apiKey: "workstation", model: "sonnet", count: 12 },
				{ apiKeyId: "k2", apiKey: "ci-runner", model: "opus", count: 7 },
			]),
		);

		expect(card).toContain("workstation");
		expect(card).toContain("ci-runner");
		// 30 + 12, summed across the key's models.
		expect(card).toContain(">42<");
		// The per-model sub-rows, for the multi-model key only.
		expect(card).toContain("sonnet");
		expect(card).toContain(">30<");
		expect(card).toContain(">12<");
	});

	it("keeps two ids apart when they share a display name", () => {
		// A hard-deleted key's snapshot name can equal a live key's current name.
		// They are different keys and their counts must not be added together.
		const card = apiKeyCard(
			render([
				{ apiKeyId: "k-live", apiKey: "shared-name", model: "opus", count: 9 },
				{
					apiKeyId: "k-deleted",
					apiKey: "shared-name",
					model: "opus",
					count: 4,
				},
			]),
		);

		expect(card.split("shared-name").length - 1).toBe(2);
		expect(card).toContain(">9<");
		expect(card).toContain(">4<");
		expect(card).not.toContain(">13<");
	});

	it("keeps the no-key bucket apart from a real key named 'No key'", () => {
		// The label is not the identity: `apiKeyId: null` is the bucket for
		// requests that carried no key at all, and a user is free to name a key
		// exactly that.
		const card = apiKeyCard(
			render([
				{ apiKeyId: null, apiKey: "No key", model: "opus", count: 6 },
				{ apiKeyId: "k-named", apiKey: "No key", model: "opus", count: 2 },
			]),
		);

		expect(card.split("No key").length - 1).toBe(2);
		expect(card).toContain(">6<");
		expect(card).toContain(">2<");
		expect(card).not.toContain(">8<");
	});

	it("orders the legend by request count, biggest first", () => {
		const card = apiKeyCard(
			render([
				{ apiKeyId: "small", apiKey: "laptop", model: "opus", count: 3 },
				{ apiKeyId: "big", apiKey: "workstation", model: "opus", count: 40 },
			]),
		);

		expect(card.indexOf("workstation")).toBeLessThan(card.indexOf("laptop"));
	});
});
