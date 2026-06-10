import { registerUIRefresh } from "@clankermux/core";
import { formatNumber, formatPercentage } from "@clankermux/ui-common";
import { Activity, BarChart3, Database, Gauge } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { REFRESH_INTERVALS } from "../constants";
import {
	useAccounts,
	useAnalytics,
	useMemoryHistory,
	useStats,
} from "../hooks/queries";
import { computePoolUsage } from "../lib/pool-usage";
import { ChartsSection } from "./overview/ChartsSection";
import { LoadingSkeleton } from "./overview/LoadingSkeleton";
import { MemoryUsageChart } from "./overview/MemoryUsageChart";
import { MetricCard } from "./overview/MetricCard";
import { PoolMetricCard } from "./overview/PoolMetricCard";
import { RateLimitInfo } from "./overview/RateLimitInfo";
import { StorageIntegrityBanner } from "./overview/StorageIntegrity";
import { SystemStatus } from "./overview/SystemStatus";
import { TimeRangeSelector } from "./overview/TimeRangeSelector";

export const OverviewTab = React.memo(() => {
	// Fetch all data using React Query hooks
	const { data: stats, isLoading: statsLoading } = useStats(
		REFRESH_INTERVALS.default,
		24,
	);
	const [timeRange, setTimeRange] = useState("6h");
	const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
		timeRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
	);
	const { data: accounts, isLoading: accountsLoading } = useAccounts();

	// Memory chart has its own range, independent of the analytics range above;
	// 7d by default so the leak-trend view is the landing state.
	const [memoryRange, setMemoryRange] = useState("7d");
	const { data: memoryHistory, isLoading: memoryLoading } =
		useMemoryHistory(memoryRange);

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		return registerUIRefresh({
			id: "pool-metric-card-update",
			callback: () => setNow(Date.now()),
			seconds: 30,
			description: "Combined-quota tile refresh",
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

	// Memoize percentage change calculation (must be at top level)
	const pctChange = useCallback(
		(current: number, previous: number): number | null => {
			if (previous === 0) return null; // avoid division by zero
			return ((current - previous) / previous) * 100;
		},
		[],
	);

	// Memoize trend period description
	const getTrendPeriod = useCallback((range: string): string => {
		switch (range) {
			case "1h":
				return "previous minute";
			case "6h":
				return "previous 5 minutes";
			case "24h":
				return "previous hour";
			case "7d":
				return "previous hour";
			case "30d":
			case "all":
				return "previous day";
			default:
				return "previous period";
		}
	}, []);

	const loading = statsLoading || analyticsLoading || accountsLoading;
	const combinedData =
		stats && analytics && accounts ? { stats, analytics, accounts } : null;

	// Transform time series data
	const timeSeriesData = useMemo(() => {
		if (!analytics) return [];
		return analytics.timeSeries.map((point) => ({
			ts: point.ts,
			requests: point.requests,
			successRate: point.successRate,
			cacheHitRate: point.cacheHitRate,
			responseTime: Math.round(point.avgResponseTime),
			cost: point.costUsd.toFixed(2),
			planCost: point.planCostUsd ?? 0,
			apiCost: point.apiCostUsd ?? 0,
			tokensPerSecond: point.avgTokensPerSecond || 0,
		}));
	}, [analytics]);

	// Memoize percentage changes calculation
	const trends = useMemo(() => {
		if (timeSeriesData.length < 2) {
			return {
				deltaRequests: null,
				deltaCacheHitRate: null,
				trendRequests: "flat" as "up" | "down" | "flat",
				trendCacheHitRate: "flat" as "up" | "down" | "flat",
			};
		}

		const lastBucket = timeSeriesData[timeSeriesData.length - 1];
		const prevBucket = timeSeriesData[timeSeriesData.length - 2];

		// Calculate deltas
		const deltaRequests = pctChange(lastBucket.requests, prevBucket.requests);
		const deltaCacheHitRate = pctChange(
			lastBucket.cacheHitRate,
			prevBucket.cacheHitRate,
		);

		// Helper to determine trend
		const getTrend = (delta: number | null): "up" | "down" | "flat" => {
			if (delta === null) return "flat";
			return delta >= 0 ? "up" : "down";
		};

		return {
			deltaRequests,
			deltaCacheHitRate,
			trendRequests: getTrend(deltaRequests),
			trendCacheHitRate: getTrend(deltaCacheHitRate),
		};
	}, [timeSeriesData, pctChange]);

	if (loading && !combinedData) {
		return <LoadingSkeleton />;
	}

	const trendPeriod = getTrendPeriod(timeRange);

	// Use analytics data for model distribution
	const modelData =
		analytics?.modelDistribution?.map((model) => ({
			name: model.model || "Unknown",
			value: model.count,
		})) || [];

	const accountModelUsageData = analytics?.accountModelUsage || [];
	const apiKeyPerformanceData = analytics?.apiKeyPerformance || [];

	return (
		<div className="space-y-6">
			{/* Sticky corruption banner — only renders when /api/storage reports corrupt */}
			<StorageIntegrityBanner />

			{/* Header with Time Range Selector */}
			<div className="flex justify-between items-center">
				<h2 className="text-2xl font-semibold">Overview</h2>
				<TimeRangeSelector value={timeRange} onChange={setTimeRange} />
			</div>

			{/* Metrics Grid */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				<MetricCard
					title="Total Requests"
					value={formatNumber(analytics?.totals.requests || 0)}
					change={
						trends.deltaRequests !== null ? trends.deltaRequests : undefined
					}
					trend={trends.trendRequests}
					trendPeriod={trendPeriod}
					icon={Activity}
					subRows={[
						{
							label: "Success rate",
							value: formatPercentage(analytics?.totals.successRate || 0, 0),
						},
					]}
				/>
				<MetricCard
					title="Cache Hit Rate"
					value={formatPercentage(analytics?.totals.cacheHitRate || 0, 0)}
					change={
						trends.deltaCacheHitRate !== null
							? trends.deltaCacheHitRate
							: undefined
					}
					trend={trends.trendCacheHitRate}
					trendPeriod={trendPeriod}
					icon={Database}
				/>
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

			<ChartsSection
				timeSeriesData={timeSeriesData}
				timeRange={timeRange}
				modelData={modelData}
				accountModelUsageData={accountModelUsageData}
				apiKeyPerformanceData={apiKeyPerformanceData}
				loading={loading}
			/>

			<SystemStatus />

			<MemoryUsageChart
				memoryHistory={memoryHistory}
				loading={memoryLoading}
				range={memoryRange}
				onRangeChange={setMemoryRange}
			/>

			{accounts && <RateLimitInfo accounts={accounts} />}
		</div>
	);
});
