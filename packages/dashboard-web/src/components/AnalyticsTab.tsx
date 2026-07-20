import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { TimeRange } from "../constants";
import { useAnalytics } from "../hooks/queries";
import { toCumulativeSeries } from "../lib/cumulative";
import { formatAxisTime } from "../lib/time-format";
import {
	ActiveSessionsPanel,
	AnalyticsControls,
	CacheFlowPanel,
	CacheKeepaliveSection,
	ContextCompositionPanel,
	CumulativeGrowthChart,
	CumulativeTokenComposition,
	type FilterState,
	MainMetricsChart,
	ModelAnalytics,
	PerformanceIndicatorsChart,
	ProjectAnalytics,
	RoutingAnalyticsPanel,
	TokenSpeedAnalytics,
	TokenUsageBreakdown,
	ToolErrorsPanel,
} from "./analytics";

export const AnalyticsTab = React.memo(() => {
	const [timeRange, setTimeRange] = useState<TimeRange>("1h");
	const [selectedMetric, setSelectedMetric] = useState("requests");
	const [filterOpen, setFilterOpen] = useState(false);
	const [modelBreakdown, setModelBreakdown] = useState(false);
	const [filters, setFilters] = useState<FilterState>({
		accounts: [],
		models: [],
		apiKeys: [],
		projects: [],
		noProject: false,
		status: "all",
	});

	// Aggregate analytics — always fetched WITHOUT per-model breakdown so every
	// chart that derives from `analytics.timeSeries` (Performance Indicators,
	// Cumulative Trends, the totals/seen-model effects) keeps a stable, one-row-
	// per-timestamp series regardless of the "Per Model" toggle.
	const {
		data: analytics,
		isLoading: loading,
		refetch,
	} = useAnalytics(timeRange, filters, "normal");

	// Per-model breakdown — fetched only while the toggle is on, and consumed only
	// by the Traffic Analytics chart. Keeping it as a separate query is what stops
	// the toggle from bleeding into the other charts: the server returns per-model
	// rows that REPLACE the aggregate series, so it must not back the shared data.
	const {
		data: perModelAnalytics,
		isLoading: perModelLoading,
		refetch: refetchPerModel,
	} = useAnalytics(timeRange, filters, "normal", true, {
		enabled: modelBreakdown,
	});

	// Get unique accounts and models from analytics data
	// Accumulate all seen accounts/models/apiKeys to maintain full list for filters
	const [allSeenAccounts, setAllSeenAccounts] = useState<Set<string>>(
		new Set(),
	);
	const [allSeenModels, setAllSeenModels] = useState<Set<string>>(new Set());
	const [allSeenApiKeys, setAllSeenApiKeys] = useState<Set<string>>(new Set());
	const [allSeenProjects, setAllSeenProjects] = useState<Set<string>>(
		new Set(),
	);
	// Whether any breakdown row in this session had project === null. Accumulated
	// like the seen-sets (latched true, never reset) so the "(no project)"
	// checkbox doesn't flicker away when the current range happens to have no
	// NULL-project rows.
	const [hasNoProjectBucket, setHasNoProjectBucket] = useState(false);

	// Update seen values whenever analytics data changes
	useEffect(() => {
		if (!analytics) return;

		// Add new accounts
		if (analytics.accountPerformance) {
			setAllSeenAccounts((prev) => {
				const updated = new Set(prev);
				for (const account of analytics.accountPerformance) {
					updated.add(account.name);
				}
				return updated;
			});
		}

		// Add new models
		if (analytics.modelDistribution) {
			setAllSeenModels((prev) => {
				const updated = new Set(prev);
				for (const model of analytics.modelDistribution) {
					updated.add(model.model);
				}
				return updated;
			});
		}

		// Add new API keys
		if (analytics.apiKeyPerformance) {
			setAllSeenApiKeys((prev) => {
				const updated = new Set(prev);
				for (const apiKey of analytics.apiKeyPerformance) {
					updated.add(apiKey.name);
				}
				return updated;
			});
		}

		// Add new projects — named projects only; the NULL bucket is handled by
		// the dedicated "(no project)" checkbox, never as a name.
		if (analytics.projectBreakdown) {
			setAllSeenProjects((prev) => {
				const updated = new Set(prev);
				for (const row of analytics.projectBreakdown ?? []) {
					if (row.project != null) {
						updated.add(row.project);
					}
				}
				return updated;
			});
			if (analytics.projectBreakdown.some((row) => row.project == null)) {
				setHasNoProjectBucket(true);
			}
		}
	}, [analytics]);

	// Convert sets to sorted arrays for filter dropdowns
	const availableAccounts = useMemo(
		() => Array.from(allSeenAccounts).sort(),
		[allSeenAccounts],
	);
	const availableModels = useMemo(
		() => Array.from(allSeenModels).sort(),
		[allSeenModels],
	);
	const availableApiKeys = useMemo(
		() => Array.from(allSeenApiKeys).sort(),
		[allSeenApiKeys],
	);
	const availableProjects = useMemo(
		() => Array.from(allSeenProjects).sort(),
		[allSeenProjects],
	);

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
			time: formatAxisTime(point.ts, timeRange),
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
	}, [analytics?.timeSeries, timeRange, filterData]);

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

	// Use real cost by model data with filters. No slice cap: ModelAnalytics
	// joins this per model against the (up to 10) modelPerformance rows, so
	// capping here would silently null out cost for the lower-ranked models.
	const costByModel =
		analytics?.costByModel?.filter(
			(model) =>
				filters.models.length === 0 || filters.models.includes(model.model),
		) || [];

	// Count active filters
	const activeFilterCount =
		filters.accounts.length +
		filters.models.length +
		filters.apiKeys.length +
		filters.projects.length +
		(filters.noProject ? 1 : 0) +
		(filters.status !== "all" ? 1 : 0);

	return (
		<div className="space-y-6">
			{/* Controls */}
			<AnalyticsControls
				timeRange={timeRange}
				setTimeRange={setTimeRange}
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
				loading={modelBreakdown ? loading || perModelLoading : loading}
				timeRange={timeRange}
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
					timeRange={timeRange}
				/>
				<TokenUsageBreakdown
					tokenBreakdown={tokenBreakdown}
					timeRange={timeRange}
				/>
			</div>

			{/* Cache Flow */}
			<CacheFlowPanel cacheFlow={analytics?.cacheFlow} loading={loading} />

			{/* Cache Keep-Alive — grouped section with one shared window selector
			    driving both the history chart and the effectiveness summary. */}
			<CacheKeepaliveSection />

			{/* Context Composition */}
			<ContextCompositionPanel
				contextComposition={analytics?.contextComposition}
				loading={loading}
				timeRange={timeRange}
			/>

			{/* Tool Errors */}
			<ToolErrorsPanel
				toolCallErrors={analytics?.toolCallErrors}
				loading={loading}
				timeRange={timeRange}
			/>

			{/* Enhanced Model Analytics */}
			<ModelAnalytics
				modelPerformance={analytics?.modelPerformance || []}
				costByModel={costByModel}
				loading={loading}
			/>

			{/* Project Breakdown */}
			<ProjectAnalytics
				projectBreakdown={analytics?.projectBreakdown ?? []}
				loading={loading}
			/>

			{/* Token Speed Analytics */}
			<TokenSpeedAnalytics
				speedTimeSeries={analytics?.speedTimeSeries ?? []}
				medianTokensPerSecond={analytics?.totals.medianTokensPerSecond ?? null}
				p95TokensPerSecond={analytics?.totals.p95TokensPerSecond ?? null}
				avgResponseTimeMs={analytics?.totals.avgResponseTime ?? 0}
				modelPerformance={analytics?.modelPerformance || []}
				loading={loading}
				timeRange={timeRange}
			/>

			<RoutingAnalyticsPanel
				routing={analytics?.routing}
				loading={loading}
				timeRange={timeRange}
			/>

			{/* Active Sessions — distinct sessions active per bucket, split by client */}
			<ActiveSessionsPanel
				activeSessions={analytics?.activeSessions}
				loading={loading}
				timeRange={timeRange}
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
					<CumulativeGrowthChart data={cumulativeData} timeRange={timeRange} />
					{tokenBreakdown.length > 0 && (
						<CumulativeTokenComposition tokenBreakdown={tokenBreakdown} />
					)}
				</section>
			)}
		</div>
	);
});
