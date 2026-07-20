import { useCallback, useEffect, useMemo } from "react";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import { toCumulativeSeries } from "../../../lib/cumulative";
import { formatAxisTime } from "../../../lib/time-format";
import {
	ActiveSessionsPanel,
	AnalyticsControls,
	CumulativeGrowthChart,
	CumulativeTokenComposition,
	MainMetricsChart,
	PerformanceIndicatorsChart,
	TokenUsageBreakdown,
} from "..";
import type { TrafficTabProps } from "./types";

/**
 * Traffic / volume view. Owns the main metrics chart, the performance-indicators
 * + token-usage grid, and the cumulative-trends section. Drives its own per-model
 * breakdown query (via the shared `useAnalyticsData` hook) so the "Per Model"
 * toggle stays scoped to this tab.
 */
export function TrafficTab(props: TrafficTabProps) {
	const {
		filters,
		setFilters,
		availableAccounts,
		availableModels,
		availableApiKeys,
		availableProjects,
		hasNoProjectBucket,
		activeFilterCount,
		filterOpen,
		setFilterOpen,
		mergeSeen,
		range,
		onRangeChange,
		selectedMetric,
		setSelectedMetric,
		modelBreakdown,
		setModelBreakdown,
	} = props;

	const {
		analytics,
		loading,
		refetch,
		perModelAnalytics,
		perModelLoading,
		refetchPerModel,
	} = useAnalyticsData(range, filters, { perModel: modelBreakdown });

	useEffect(() => {
		if (analytics) mergeSeen(analytics);
	}, [analytics, mergeSeen]);

	// Memoize filter function
	const filterData = useCallback(
		<T extends { errorRate?: number | string }>(data: T[]): T[] => {
			if (!analytics) return data;

			return data.filter((point) => {
				// Status filter
				if (filters.status !== "all") {
					const errorRate =
						typeof point.errorRate === "string"
							? parseFloat(point.errorRate)
							: point.errorRate || 0;
					if (filters.status === "success" && errorRate > 50) return false;
					if (filters.status === "error" && errorRate <= 50) return false;
				}

				// For time series data, we can't filter by specific accounts/models
				// Those filters will be applied to the other charts
				return true;
			});
		},
		[analytics, filters.status],
	);

	// Memoize expensive time series data transformation
	const data = useMemo(() => {
		if (!analytics?.timeSeries) return [];

		const timeSeries = filterData(analytics.timeSeries);

		return timeSeries.map((point) => ({
			// Compact label for the X-axis tick; the raw `ts` is carried alongside
			// so tooltips can render a richer, day-aware label (see time-format.ts).
			time: formatAxisTime(point.ts, range),
			ts: point.ts,
			requests: point.requests,
			tokens: point.tokens,
			cost: parseFloat(point.costUsd.toFixed(2)),
			planCost: point.planCostUsd ?? 0,
			apiCost: point.apiCostUsd ?? 0,
			responseTime: Math.round(point.avgResponseTime),
			errorRate: parseFloat(point.errorRate.toFixed(1)),
			cacheHitRate: parseFloat(point.cacheHitRate.toFixed(1)),
			avgTokensPerSecond: point.avgTokensPerSecond || 0,
		}));
	}, [analytics?.timeSeries, range, filterData]);

	// Cumulative running totals derived client-side from the normal series. This
	// powers the "Cumulative Trends" section at the bottom of the page without a
	// separate server round-trip (mirrors the backend's running-sum transform).
	const cumulativeData = useMemo(() => toCumulativeSeries(data), [data]);

	// Memoize token usage breakdown calculation
	const tokenBreakdown = useMemo(() => {
		if (!analytics?.tokenBreakdown) return [];

		const total = analytics.totals.totalTokens || 1;
		const breakdown = [
			{
				type: "Input Tokens",
				value: analytics.tokenBreakdown.inputTokens,
				percentage: 0,
			},
			{
				type: "Cache Read",
				value: analytics.tokenBreakdown.cacheReadInputTokens,
				percentage: 0,
			},
			{
				type: "Cache Creation",
				value: analytics.tokenBreakdown.cacheCreationInputTokens,
				percentage: 0,
			},
			{
				type: "Output Tokens",
				value: analytics.tokenBreakdown.outputTokens,
				percentage: 0,
			},
		];

		return breakdown.map((item) => ({
			...item,
			percentage: Math.round((item.value / total) * 100),
		}));
	}, [analytics?.tokenBreakdown, analytics?.totals.totalTokens]);

	const mainLoading = modelBreakdown ? loading || perModelLoading : loading;

	return (
		<div className="space-y-6">
			<AnalyticsControls
				timeRange={range}
				setTimeRange={onRangeChange}
				filters={filters}
				setFilters={setFilters}
				availableAccounts={availableAccounts}
				availableModels={availableModels}
				availableApiKeys={availableApiKeys}
				availableProjects={availableProjects}
				hasNoProjectBucket={hasNoProjectBucket}
				activeFilterCount={activeFilterCount}
				filterOpen={filterOpen}
				setFilterOpen={setFilterOpen}
				loading={loading}
				onRefresh={() => {
					void refetch();
					if (modelBreakdown) void refetchPerModel();
				}}
			/>

			{/* Main Metrics Chart */}
			<MainMetricsChart
				data={data}
				rawTimeSeries={perModelAnalytics?.timeSeries}
				loading={mainLoading}
				timeRange={range}
				selectedMetric={selectedMetric}
				setSelectedMetric={setSelectedMetric}
				modelBreakdown={modelBreakdown}
				onModelBreakdownChange={setModelBreakdown}
			/>

			{/* Secondary Charts Row */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<PerformanceIndicatorsChart
					data={data}
					loading={loading}
					timeRange={range}
				/>
				<TokenUsageBreakdown
					tokenBreakdown={tokenBreakdown}
					timeRange={range}
				/>
			</div>

			{/* Active Sessions — distinct sessions active per bucket, split by client */}
			<ActiveSessionsPanel
				activeSessions={analytics?.activeSessions}
				loading={loading}
				timeRange={range}
			/>

			{/* Cumulative Trends - always shown at the bottom */}
			{analytics && data.length > 0 && (
				<section className="space-y-6">
					<div className="border-t pt-6">
						<h2 className="text-lg font-semibold">Cumulative Trends</h2>
						<p className="text-sm text-muted-foreground">
							Running totals across the selected time range
						</p>
					</div>
					<CumulativeGrowthChart data={cumulativeData} timeRange={range} />
					{tokenBreakdown.length > 0 && (
						<CumulativeTokenComposition tokenBreakdown={tokenBreakdown} />
					)}
				</section>
			)}
		</div>
	);
}
