import { expect, it } from "bun:test";
import type { CostCoverage, PaymentsSummary } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountPerformanceSection } from "./AccountPerformanceSection";

it("keeps free and unpriced accounts visible and uses the same snapshot for cost and coverage", () => {
	const coverage: CostCoverage = {
		reportedUsd: 0,
		estimatedUsd: 0,
		unknownSourceUsd: 0,
		pricedRequests: 1,
		unpricedRequests: 0,
		reportedRequests: 1,
		estimatedRequests: 0,
		unknownSourceRequests: 0,
	};
	const amounts = {
		ledgerUsd: 100,
		subscriptionUsd: 0,
		creditsUsd: 100,
		tokenCostUsd: 0,
		totalUsd: 100,
	};
	const payments: PaymentsSummary = {
		amortizedDailyUsd: 0,
		amortizedWeeklyUsd: 0,
		amortizedMonthlyUsd: 0,
		currentMonth: amounts,
		range: {
			...amounts,
			from: 0,
			to: 1,
			days: 1,
			amortizedUsd: 0,
			planValueUsd: 0,
			valueRatio: null,
			overageTokenCostUsd: 0,
			apiCostCoverage: { ...coverage, unpricedRequests: 1 },
		},
		perAccount: ["Free account", "Unpriced account"].map((name, index) => ({
			accountId: name,
			accountName: name,
			priceUsd: null,
			cadence: null,
			nextDueDate: null,
			amortizedMonthlyUsd: 0,
			rangeLedgerUsd: 0,
			rangeTokenCostUsd: 0,
			rangeCostCoverage:
				index === 0
					? coverage
					: {
							...coverage,
							pricedRequests: 0,
							reportedRequests: 0,
							unpricedRequests: 1,
						},
		})),
		recentPayments: [],
	};
	const html = renderToStaticMarkup(
		<AccountPerformanceSection
			accountPerformance={[
				{
					name: "Free account",
					requests: 1,
					successRate: 100,
					planCostUsd: 0,
					apiCostUsd: 999,
					totalCostUsd: 999,
				},
				{
					name: "Unpriced account",
					requests: 1,
					successRate: 100,
					planCostUsd: 0,
					apiCostUsd: 0,
					totalCostUsd: 0,
				},
			]}
			loading={false}
			range="24h"
			onRangeChange={() => {}}
			costSummary={{
				planCostUsd: 0,
				avgDailyPlanCostUsd: 0,
				avgWeeklyPlanCostUsd: 0,
			}}
			paymentsSummary={payments}
		/>,
	);
	const table = html.slice(html.indexOf("<table"));
	expect(table).toContain("Free account");
	expect(table).toContain("Unpriced account");
	expect(table).toContain("$0.00 reported");
	expect(table).toContain("1 request unpriced");
	expect(table.slice(table.indexOf("<tfoot"))).toContain("1 request unpriced");
	expect(table).toContain("—");
	expect(table).not.toContain("$999.00");
	expect(html).toContain("Recorded payments");
	expect(html).toContain("$100.00");
});
