import { registerUIRefresh } from "@clankermux/core";
import type { AnalyticsSection } from "@clankermux/types";
import React, { useEffect, useMemo, useState } from "react";
import {
	useAccounts,
	useAnalytics,
	usePaymentsSummary,
	useUsageHistory,
} from "../../hooks/queries";
import { computePoolUsage } from "../../lib/pool-usage";
import { LoadingSkeleton } from "../overview/LoadingSkeleton";
import { AccountPerformanceSection } from "./AccountPerformanceSection";
import { AccountUtilizationCard } from "./AccountUtilizationCard";
import { LimitsCapacityOverview } from "./LimitsCapacityOverview";
import { PaymentsHistoryCard } from "./PaymentsHistoryCard";
import { UsageSawtoothChart } from "./UsageSawtoothChart";

// Account Performance table plus the plan-cost / burn-rate summary band, both
// of which come from `totals`.
const LIMITS_SECTIONS: readonly AnalyticsSection[] = [
	"totals",
	"accountPerformance",
];

export const LimitsTab = React.memo(() => {
	// Each time-ranged card owns its own range now (the live pool tiles and
	// utilization card below are range-independent and get no selector).
	const [fiveHourUsageRange, setFiveHourUsageRange] = useState("24h");
	const [sevenDayUsageRange, setSevenDayUsageRange] = useState("7d");
	const [perfRange, setPerfRange] = useState("7d");

	const { data: accounts, isLoading: accountsLoading } = useAccounts();
	const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
		perfRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
		false,
		{ sections: LIMITS_SECTIONS },
	);
	const { data: fiveHourUsageHistory, isLoading: fiveHourUsageHistoryLoading } =
		useUsageHistory(fiveHourUsageRange);
	const { data: sevenDayUsageHistory, isLoading: sevenDayUsageHistoryLoading } =
		useUsageHistory(sevenDayUsageRange);
	// Payments-ledger spend summary follows the Account Performance card's range.
	const { data: paymentsSummary } = usePaymentsSummary(perfRange);

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		return registerUIRefresh({
			id: "limits-tab-update",
			callback: () => setNow(Date.now()),
			seconds: 30,
			description: "Limits tab pool/countdown refresh",
		});
	}, []);

	const fiveHourPool = useMemo(
		() => computePoolUsage(accounts ?? [], "five_hour", now),
		[accounts, now],
	);
	const weeklyPool = useMemo(
		() => computePoolUsage(accounts ?? [], "seven_day", now),
		[accounts, now],
	);

	const loading = accountsLoading || analyticsLoading;
	const ready = accounts && analytics;
	if (loading && !ready) {
		return <LoadingSkeleton />;
	}

	const totals = analytics?.totals;
	const accountList = accounts ?? [];
	const costSummary = {
		planCostUsd: totals?.planCostUsd ?? 0,
		avgDailyPlanCostUsd: totals?.avgDailyPlanCostUsd ?? 0,
		avgWeeklyPlanCostUsd: totals?.avgWeeklyPlanCostUsd ?? 0,
	};

	return (
		<div className="space-y-section">
			{/* The two rolling windows share one visual hierarchy so their usage,
			    reporting coverage and recovery timing can be compared at a glance. */}
			<LimitsCapacityOverview
				fiveHour={fiveHourPool}
				sevenDay={weeklyPool}
				now={now}
			/>

			{/* Per-account live utilization — grouped with the pool tiles above as the
			    live, range-independent capacity view (no range selector). */}
			<AccountUtilizationCard accounts={accountList} now={now} />

			{/* Recorded usage history + forecast; each graph owns its range picker. */}
			<UsageSawtoothChart
				accounts={accountList}
				now={now}
				fiveHour={{
					usageHistory: fiveHourUsageHistory,
					loading: fiveHourUsageHistoryLoading,
					range: fiveHourUsageRange,
					onRangeChange: setFiveHourUsageRange,
				}}
				sevenDay={{
					usageHistory: sevenDayUsageHistory,
					loading: sevenDayUsageHistoryLoading,
					range: sevenDayUsageRange,
					onRangeChange: setSevenDayUsageRange,
				}}
			/>

			{/* Account performance + folded-in Plan Value / Cost / Value Ratio summary;
			    own range picker in the card header. */}
			<AccountPerformanceSection
				accountPerformance={analytics?.accountPerformance ?? []}
				loading={loading}
				range={perfRange}
				onRangeChange={setPerfRange}
				costSummary={costSummary}
				paymentsSummary={paymentsSummary}
			/>

			{/* Recent payments-ledger entries (auto renewals + manual credits). */}
			<PaymentsHistoryCard payments={paymentsSummary?.recentPayments ?? []} />
		</div>
	);
});
