import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { CostsTab } from "./CostsTab";
import { AccountPerformanceSection } from "./limits/AccountPerformanceSection";

describe("Costs and performance separation", () => {
	it("gives payments and plan value a dedicated page", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, refetchOnMount: false } },
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<CostsTab />
			</QueryClientProvider>,
		);
		expect(html).toContain("Costs and plan value");
		expect(html).toContain("Payments");
		expect(html).toContain("Value Ratio");
		expect(html).not.toContain("Account Performance");
		expect(html).not.toContain("Remaining quota");
		expect(html).not.toContain("$0.00");
	});
	it("keeps the Analytics performance view free of billing summaries", () => {
		const html = renderToStaticMarkup(
			<AccountPerformanceSection
				view="performance"
				accountPerformance={[]}
				loading={false}
				range="7d"
				onRangeChange={() => {}}
				costSummary={{
					planCostUsd: null,
					avgDailyPlanCostUsd: null,
					avgWeeklyPlanCostUsd: null,
				}}
			/>,
		);
		expect(html).toContain("Account Performance");
		expect(html).not.toContain("Value Ratio");
		expect(html).not.toContain("Account cost breakdown");
	});
});
