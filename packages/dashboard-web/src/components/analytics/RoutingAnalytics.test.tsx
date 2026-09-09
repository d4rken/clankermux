import { describe, expect, it } from "bun:test";
import type { RoutingAnalytics } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutingAnalyticsPanel } from "./RoutingAnalytics";

function renderDecision(decision: string): string {
	const routing: RoutingAnalytics = {
		totalRequests: 1,
		flow: [
			{
				strategy: "balanced",
				decision,
				accountId: "account-id",
				accountName: "Account",
				outcome: "success",
				requests: 1,
				successRate: 100,
				failoverAttempts: 0,
			},
		],
		timeline: [],
		decisionBreakdown: [
			{
				strategy: "balanced",
				decision,
				requests: 1,
				percentage: 100,
				successRate: 100,
				failoverAttempts: 0,
			},
		],
		accountSplit: [],
	};
	return renderToStaticMarkup(
		<RoutingAnalyticsPanel routing={routing} loading={false} timeRange="24h" />,
	);
}

describe("routing decision explanations", () => {
	it.each([
		["__proto__", "  proto  "],
		["constructor", "constructor"],
		["new_decision", "new decision"],
	])("renders the fallback label for unknown decision %s", (decision, label) => {
		const html = renderDecision(decision);
		expect(html).toContain(`<title>${label}</title>`);
		expect(html).toContain(`Top reason: ${label}`);
	});

	it("keeps the explanation and label for a known decision", () => {
		const html = renderDecision("affinity_hit");
		expect(html).toContain(
			"<title>A project or thread was already pinned to this account.</title>",
		);
		expect(html).toContain("Top reason: Affinity hit");
	});
});
