import { registerUIRefresh } from "@clankermux/core";
import type { AnalyticsSection } from "@clankermux/types";
import React, { useEffect, useMemo, useState } from "react";
import {
	useAccounts,
	useAnalytics,
	usePaymentsSummary,
	useRunway,
	useUsageHistory,
} from "../../hooks/queries";
import { dataAvailability } from "../../lib/data-availability";
import { computePoolUsage } from "../../lib/pool-usage";
import { AccountPerformanceSection } from "./AccountPerformanceSection";
import { AccountUtilizationCard } from "./AccountUtilizationCard";
import { LimitsCapacityOverview } from "./LimitsCapacityOverview";
import { PaymentsHistoryCard } from "./PaymentsHistoryCard";
import { UsageSawtoothChart } from "./UsageSawtoothChart";

// Account Performance table plus the plan-cost / burn-rate summary band, both
// of which come from `totals`.
//
// Exported so tests seeding the query cache key on the SAME list — a divergent
// list yields `undefined` analytics, and the sections computed from it render
// their own pending state instead of the numbers under test.
export const LIMITS_SECTIONS: readonly AnalyticsSection[] = [
	"totals",
	"accountPerformance",
];

export const LimitsTab = React.memo(() => {
	// Each time-ranged card owns its own range now (the live pool tiles and
	// utilization card below are range-independent and get no selector).
	const [fiveHourUsageRange, setFiveHourUsageRange] = useState("24h");
	const [sevenDayUsageRange, setSevenDayUsageRange] = useState("7d");
	const [perfRange, setPerfRange] = useState("7d");

	const accountsQuery = useAccounts();
	const { data: accounts, isLoading: accountsLoading } = accountsQuery;
	// The runway is computed server-side; this tab owns the query and hands the
	// rows down, so LimitsCapacityOverview stays a pure view component.
	const runwayQuery = useRunway();
	const { data: runway, isLoading: runwayLoading } = runwayQuery;
	const analyticsQuery = useAnalytics(
		perfRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
		false,
		{ sections: LIMITS_SECTIONS },
	);
	const { data: analytics, isLoading: analyticsLoading } = analyticsQuery;
	const { data: fiveHourUsageHistory, isLoading: fiveHourUsageHistoryLoading } =
		useUsageHistory(fiveHourUsageRange);
	const { data: sevenDayUsageHistory, isLoading: sevenDayUsageHistoryLoading } =
		useUsageHistory(sevenDayUsageRange);
	// Payments-ledger spend summary follows the Account Performance card's range.
	const paymentsQuery = usePaymentsSummary(perfRange);
	const { data: paymentsSummary, isLoading: paymentsLoading } = paymentsQuery;

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
	// There is deliberately no page-wide loading gate. Each section states the
	// availability of the ONE query it is computed from, so a slow or failed read
	// can only blank the section that depends on it. `/api/analytics` is the
	// slowest read on this page; letting it hold the whole tab hostage is exactly
	// what hid a resolved runway behind an unrelated request.
	//
	// `pending` is `isLoading && !data`, so a background refetch never blanks a
	// section that already has numbers to show.
	const accountsUnavailable =
		dataAvailability(accountsQuery, accountsLoading).state === "unavailable";
	const accountsPending = accountsLoading && !accounts;
	const accountsUnavailableReason = accountsUnavailable
		? "Account data unavailable"
		: undefined;
	const analyticsUnavailable =
		dataAvailability(analyticsQuery, analyticsLoading).state === "unavailable";
	const analyticsPending = analyticsLoading && !analytics;
	const paymentsUnavailable =
		dataAvailability(paymentsQuery, paymentsLoading).state === "unavailable";
	const paymentsPending = paymentsLoading && !paymentsSummary;
	// Gated on the runway read ALONE. The response carries the account names its
	// pin labels and causes need, so a failing /api/accounts — which empties the
	// two window panels beside it — must not empty this one too.
	const runwayUnavailable =
		dataAvailability(runwayQuery, runwayLoading).state === "unavailable";
	const runwaysUnavailableReason = runwayUnavailable
		? "Runway data unavailable"
		: undefined;

	const totals = analytics?.totals;
	const accountList = accounts ?? [];
	// Null, never 0: an unresolved analytics read has no figure, and "$0.00"
	// would read as a range that genuinely cost nothing.
	const analyticsResolved = !analyticsPending && !analyticsUnavailable;
	const costSummary = {
		planCostUsd: analyticsResolved ? (totals?.planCostUsd ?? null) : null,
		avgDailyPlanCostUsd: analyticsResolved
			? (totals?.avgDailyPlanCostUsd ?? null)
			: null,
		avgWeeklyPlanCostUsd: analyticsResolved
			? (totals?.avgWeeklyPlanCostUsd ?? null)
			: null,
	};

	return (
		<div className="space-y-section">
			{/* The two rolling windows share one visual hierarchy so their usage,
			    reporting coverage and recovery timing can be compared at a glance. */}
			<LimitsCapacityOverview
				fiveHour={fiveHourPool}
				sevenDay={weeklyPool}
				now={now}
				runways={runway?.keys ?? []}
				accounts={runway?.accounts ?? []}
				windowsLoading={accountsPending}
				windowsUnavailableReason={accountsUnavailableReason}
				runwaysLoading={runwayLoading && !runway}
				runwaysUnavailableReason={runwaysUnavailableReason}
			/>

			{/* Per-account live utilization — grouped with the pool tiles above as the
			    live, range-independent capacity view (no range selector). */}
			<AccountUtilizationCard
				accounts={accountList}
				now={now}
				loading={accountsPending}
				unavailableReason={accountsUnavailableReason}
			/>

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
				loading={analyticsPending}
				unavailable={analyticsUnavailable}
				range={perfRange}
				onRangeChange={setPerfRange}
				costSummary={costSummary}
				paymentsSummary={paymentsSummary}
			/>

			{/* Recent payments-ledger entries (auto renewals + manual credits). */}
			<PaymentsHistoryCard
				payments={paymentsSummary?.recentPayments ?? []}
				loading={paymentsPending}
				unavailableReason={
					paymentsUnavailable ? "Payments data unavailable" : undefined
				}
			/>
		</div>
	);
});
