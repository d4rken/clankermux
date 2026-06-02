import { registerUIRefresh } from "@clankermux/core";
import { BarChart3, Gauge } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import {
	useAccounts,
	useAnalytics,
	useUsageHistory,
} from "../../hooks/queries";
import { computePoolUsage } from "../../lib/pool-usage";
import { LoadingSkeleton } from "../overview/LoadingSkeleton";
import { PoolMetricCard } from "../overview/PoolMetricCard";
import { AccountPerformanceSection } from "./AccountPerformanceSection";
import { AccountUtilizationCard } from "./AccountUtilizationCard";
import { UsageSawtoothChart } from "./UsageSawtoothChart";

export const LimitsTab = React.memo(() => {
	// Each time-ranged card owns its own range now (the live pool tiles and
	// utilization card below are range-independent and get no selector).
	const [usageRange, setUsageRange] = useState("7d");
	const [perfRange, setPerfRange] = useState("7d");

	const { data: accounts, isLoading: accountsLoading } = useAccounts();
	const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
		perfRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
	);
	const { data: usageHistory, isLoading: usageHistoryLoading } =
		useUsageHistory(usageRange);

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
		apiCostUsd: totals?.apiCostUsd ?? 0,
		avgDailyPlanCostUsd: totals?.avgDailyPlanCostUsd ?? 0,
		avgWeeklyPlanCostUsd: totals?.avgWeeklyPlanCostUsd ?? 0,
	};

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

			{/* Per-account live utilization — grouped with the pool tiles above as the
			    live, range-independent capacity view (no range selector). */}
			<AccountUtilizationCard accounts={accountList} />

			{/* Recorded usage history + forecast; range picker lives in the card header. */}
			<UsageSawtoothChart
				usageHistory={usageHistory}
				accounts={accountList}
				now={now}
				loading={usageHistoryLoading}
				range={usageRange}
				onRangeChange={setUsageRange}
			/>

			{/* Account performance + folded-in Plan Value / API Cost summary; own range
			    picker in the card header. */}
			<AccountPerformanceSection
				accountPerformance={analytics?.accountPerformance ?? []}
				loading={loading}
				range={perfRange}
				onRangeChange={setPerfRange}
				costSummary={costSummary}
			/>
		</div>
	);
});
