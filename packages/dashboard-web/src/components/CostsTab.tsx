import type { AnalyticsSection } from "@clankermux/types";
import { useState } from "react";
import type { TimeRange } from "../constants";
import { useAnalytics, usePaymentsSummary } from "../hooks/queries";
import { dataAvailability } from "../lib/data-availability";
import { AccountPerformanceSection } from "./limits/AccountPerformanceSection";
import { PaymentsHistoryCard } from "./limits/PaymentsHistoryCard";
export const COSTS_SECTIONS: readonly AnalyticsSection[] = [
	"totals",
	"accountPerformance",
];
export function CostsTab() {
	const [range, setRange] = useState<TimeRange>("7d");
	const analytics = useAnalytics(
		range,
		{ accounts: [], models: [], status: "all" },
		"normal",
		false,
		{ sections: COSTS_SECTIONS },
	);
	const payments = usePaymentsSummary(range);
	const state = dataAvailability(analytics, analytics.isLoading);
	const paymentState = dataAvailability(payments, payments.isLoading);
	const totals = analytics.data?.totals;
	return (
		<div className="space-y-section">
			<AccountPerformanceSection
				view="costs"
				range={range}
				onRangeChange={setRange}
				accountPerformance={analytics.data?.accountPerformance ?? []}
				loading={state.state === "loading"}
				unavailable={state.state === "unavailable"}
				costSummary={{
					planCostUsd: totals?.planCostUsd ?? null,
					avgDailyPlanCostUsd: totals?.avgDailyPlanCostUsd ?? null,
					avgWeeklyPlanCostUsd: totals?.avgWeeklyPlanCostUsd ?? null,
				}}
				paymentsSummary={payments.data}
			/>
			{(state.state === "stale" || paymentState.state === "stale") && (
				<p className="text-sm text-warning-strong">
					Showing saved cost data; refresh failed.
				</p>
			)}
			<PaymentsHistoryCard
				payments={payments.data?.recentPayments ?? []}
				summary={payments.data}
				loading={paymentState.state === "loading"}
				unavailableReason={
					paymentState.state === "unavailable"
						? "Payments data unavailable"
						: undefined
				}
			/>
		</div>
	);
}
