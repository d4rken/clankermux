import { registerUIRefresh } from "@clankermux/core";
import { formatCost } from "@clankermux/ui-common";
import { BarChart3, DollarSign, Gauge } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import {
	useAccounts,
	useAnalytics,
	useUsageHistory,
} from "../../hooks/queries";
import {
	computePoolUsage,
	type PoolUsageContribution,
	type PoolUsageExclusion,
	type PoolWindow,
} from "../../lib/pool-usage";
import { LoadingSkeleton } from "../overview/LoadingSkeleton";
import { MetricCard } from "../overview/MetricCard";
import { PoolMetricCard } from "../overview/PoolMetricCard";
import { TimeRangeSelector } from "../overview/TimeRangeSelector";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Progress } from "../ui/progress";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { AccountPerformanceSection } from "./AccountPerformanceSection";
import { UsageSawtoothChart } from "./UsageSawtoothChart";

/** Format a future reset timestamp as a short "in Xh Ym" / "in Xm" countdown. */
function formatCountdown(resetMs: number | null, now: number): string {
	if (resetMs == null) return "reset time unknown";
	const remaining = resetMs - now;
	if (remaining <= 0) return "resetting now";
	const totalMinutes = Math.round(remaining / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `resets in ${hours}h ${minutes}m`;
	return `resets in ${minutes}m`;
}

function utilizationColor(pct: number): string {
	if (pct < 60) return "bg-success";
	if (pct < 80) return "bg-warning";
	return "bg-destructive";
}

interface AccountUsageRow {
	name: string;
	pct: number;
	resetMs: number | null;
	exhausted: boolean;
}

export const LimitsTab = React.memo(() => {
	const [range, setRange] = useState("24h");
	const [window, setWindow] = useState<PoolWindow>("five_hour");

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

	// Per-account list for the currently-selected window: live contributing
	// accounts plus exhausted ones (rendered at 100%), sorted by utilization.
	const accountUsageRows = useMemo<AccountUsageRow[]>(() => {
		const selected = window === "five_hour" ? fiveHourPool : weeklyPool;
		const contributing: AccountUsageRow[] = selected.contributing.map(
			(c: PoolUsageContribution) => ({
				name: c.name,
				pct: c.pct,
				resetMs: c.resetMs,
				exhausted: false,
			}),
		);
		const exhausted: AccountUsageRow[] = selected.exhausted.map(
			(e: PoolUsageExclusion) => ({
				name: e.name,
				pct: 100,
				resetMs: e.resetMs,
				exhausted: true,
			}),
		);
		return [...contributing, ...exhausted].sort((a, b) => b.pct - a.pct);
	}, [window, fiveHourPool, weeklyPool]);

	const loading = accountsLoading || analyticsLoading;
	const ready = accounts && analytics;
	if (loading && !ready) {
		return <LoadingSkeleton />;
	}

	const totals = analytics?.totals;

	return (
		<div className="space-y-6">
			{/* Large 5h & 7d pool tiles — the headline capacity view. */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<PoolMetricCard
					title="5h Pool"
					icon={Gauge}
					result={fiveHourPool}
					window="five_hour"
				/>
				<PoolMetricCard
					title="7d Pool"
					icon={BarChart3}
					result={weeklyPool}
					window="seven_day"
				/>
			</div>

			{/* Scope note — explains why the history may differ from untracked providers. */}
			<p className="text-xs text-muted-foreground">
				Limits cover Anthropic and Codex windowed accounts (5-hour and 7-day
				rolling quotas). Pay-as-you-go and other providers without rolling
				windows aren't tracked here.
			</p>

			{/* Sawtooth chart with range selector + window toggle. */}
			<div className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<Tabs
						value={window}
						onValueChange={(v) => setWindow(v as PoolWindow)}
					>
						<TabsList>
							<TabsTrigger value="five_hour">5-hour</TabsTrigger>
							<TabsTrigger value="seven_day">7-day</TabsTrigger>
						</TabsList>
					</Tabs>
					<TimeRangeSelector value={range} onChange={setRange} />
				</div>
				<UsageSawtoothChart
					usageHistory={usageHistory}
					window={window}
					loading={usageHistoryLoading}
				/>
			</div>

			{/* Per-account live utilization for the selected window. */}
			<Card>
				<CardHeader>
					<CardTitle>
						Account Utilization ({window === "five_hour" ? "5-hour" : "7-day"})
					</CardTitle>
					<CardDescription>
						Current quota usage and reset countdown per account
					</CardDescription>
				</CardHeader>
				<CardContent>
					{accountUsageRows.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No windowed accounts reporting usage for this window yet.
						</p>
					) : (
						<div className="space-y-4">
							{accountUsageRows.map((row) => (
								<div key={row.name} className="space-y-1.5">
									<div className="flex items-center justify-between gap-2 text-sm">
										<span className="truncate font-medium" title={row.name}>
											{row.name}
										</span>
										<span className="tabular-nums text-muted-foreground">
											{row.pct.toFixed(0)}%
										</span>
									</div>
									<Progress
										value={Math.min(100, Math.max(0, row.pct))}
										indicatorClassName={utilizationColor(row.pct)}
									/>
									<p className="text-xs text-muted-foreground">
										{row.exhausted ? "Exhausted · " : ""}
										{formatCountdown(row.resetMs, now)}
									</p>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>

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
							tooltip: "Average daily plan value over the last 7 days",
						},
						{
							label: "Avg / week",
							value: formatCost(totals?.avgWeeklyPlanCostUsd ?? 0),
							tooltip:
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
