import { registerUIRefresh } from "@clankermux/core";
import { formatCost } from "@clankermux/ui-common";
import { BarChart3, DollarSign, Gauge } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import {
	useAccounts,
	useAnalytics,
	useUsageHistory,
} from "../../hooks/queries";
import { computePoolUsage } from "../../lib/pool-usage";
import { LoadingSkeleton } from "../overview/LoadingSkeleton";
import { MetricCard } from "../overview/MetricCard";
import { PoolMetricCard } from "../overview/PoolMetricCard";
import { TimeRangeSelector } from "../overview/TimeRangeSelector";
import { AccountPerformanceSection } from "./AccountPerformanceSection";
import { AccountUtilizationCard } from "./AccountUtilizationCard";
import { UsageSawtoothChart } from "./UsageSawtoothChart";

export const LimitsTab = React.memo(() => {
	const [range, setRange] = useState("24h");

	const { data: accounts, isLoading: accountsLoading } = useAccounts();
	const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
		range,
		{ accounts: [], models: [], status: "all" },
		"normal",
	);
	const { data: usageHistory, isLoading: usageHistoryLoading } =
		useUsageHistory(range);

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

	return (
		<div className="space-y-6">
			{/* Large 5h & 7d pool tiles — the headline capacity view, full detail inline. */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<PoolMetricCard
					title="5h Pool"
					icon={Gauge}
					result={fiveHourPool}
					window="five_hour"
					inlineDetails
				/>
				<PoolMetricCard
					title="7d Pool"
					icon={BarChart3}
					result={weeklyPool}
					window="seven_day"
					inlineDetails
				/>
			</div>

			{/* Scope note — explains why the history may differ from untracked providers. */}
			<p className="text-xs text-muted-foreground">
				Limits cover Anthropic and Codex windowed accounts (5-hour and 7-day
				rolling quotas). Pay-as-you-go and other providers without rolling
				windows aren't tracked here.
			</p>

			{/* Sawtooth charts (both windows) with a range selector. */}
			<div className="space-y-3">
				<div className="flex flex-wrap items-center justify-end gap-3">
					<TimeRangeSelector value={range} onChange={setRange} />
				</div>
				<UsageSawtoothChart
					usageHistory={usageHistory}
					accounts={accountList}
					now={now}
					loading={usageHistoryLoading}
				/>
			</div>

			{/* Per-account live utilization for both windows, with burn-rate projection. */}
			<AccountUtilizationCard accounts={accountList} />

			{/* Moved Plan Value + API Cost tiles. */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<MetricCard
					title="Plan Value"
					value={
						totals?.planCostUsd ? formatCost(totals.planCostUsd) : "$0.0000"
					}
					icon={DollarSign}
					subRows={[
						{
							label: "Avg / day",
							value: formatCost(totals?.avgDailyPlanCostUsd ?? 0),
							inlineExplainer: "Average daily plan value over the last 7 days",
						},
						{
							label: "Avg / week",
							value: formatCost(totals?.avgWeeklyPlanCostUsd ?? 0),
							inlineExplainer:
								"Average weekly plan value, derived from the last 30 days",
						},
					]}
				/>
				<MetricCard
					title="API Cost"
					value={totals?.apiCostUsd ? formatCost(totals.apiCostUsd) : "$0.0000"}
					icon={DollarSign}
				/>
			</div>

			{/* Account performance bar + cost-breakdown table. */}
			<AccountPerformanceSection
				accountPerformance={analytics?.accountPerformance ?? []}
				loading={loading}
			/>
		</div>
	);
});
