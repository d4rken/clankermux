import { registerUIRefresh } from "@clankermux/core";
import type { AnalyticsSection } from "@clankermux/types";
import { formatNumber, formatPercentage } from "@clankermux/ui-common";
import { Activity, BarChart3, Gauge } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { REFRESH_INTERVALS } from "../constants";
import { useAccounts, useAnalytics, useStats } from "../hooks/queries";
import { dataAvailability, staleAgeLabel } from "../lib/data-availability";
import { buildOverviewTimeSeries } from "../lib/overview-timeseries";
import { computePoolUsage } from "../lib/pool-usage";
import { MissingSectionsNotice } from "./analytics/MissingSectionsNotice";
import { ChartsSection } from "./overview/ChartsSection";
import { LiveActivityLanes } from "./overview/LiveActivityLanes";
import { MetricCard } from "./overview/MetricCard";
import { PoolMetricCard } from "./overview/PoolMetricCard";
import { PricingGapBanner } from "./overview/PricingGapBanner";
import { RateLimitInfo } from "./overview/RateLimitInfo";
import { SpendSummaryBand } from "./overview/SpendSummaryBand";
import { StorageIntegrityBanner } from "./overview/StorageIntegrity";
import { SystemHealthStrip } from "./overview/SystemHealthStrip";
import { CompactRecentErrors } from "./overview/system-status/CompactRecentErrors";
import { useVisibleRecentErrors } from "./overview/system-status/useVisibleRecentErrors";
import { TimeRangeSelector } from "./overview/TimeRangeSelector";

/** Error window for the Overview's compact list, in hours. */
export const OVERVIEW_ERROR_WINDOW_HOURS = 1;

/**
 * The Overview's metric tiles and charts. `activeSessions` is not optional
 * here: buildOverviewTimeSeries merges the session series into the chart rows.
 *
 * Exported so tests seeding the query cache key on the SAME list — a divergent
 * list yields `undefined` analytics and the analytics-backed tiles stay in
 * their pending state.
 */
export const OVERVIEW_SECTIONS: readonly AnalyticsSection[] = [
	"totals",
	"timeSeries",
	"modelDistribution",
	"accountModelUsage",
	"projectBreakdown",
	"activeSessions",
];

export const OverviewTab = React.memo(() => {
	// Fetch all data using React Query hooks. The 1-hour error window feeds the
	// compact list below the health strip; nothing else on this page reads
	// `recentErrors`, and the parameter only scopes that field server-side. The
	// full, range-selectable list lives on /system.
	const statsQuery = useStats(
		REFRESH_INTERVALS.default,
		OVERVIEW_ERROR_WINDOW_HOURS,
	);
	const { data: stats, isLoading: statsLoading } = statsQuery;
	const [timeRange, setTimeRange] = useState("6h");
	const analyticsQuery = useAnalytics(
		timeRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
		false,
		{ sections: OVERVIEW_SECTIONS },
	);
	const { data: analytics, isLoading: analyticsLoading } = analyticsQuery;
	const accountsQuery = useAccounts();
	const { data: accounts, isLoading: accountsLoading } = accountsQuery;

	// This page renders PROGRESSIVELY: there is no whole-page gate, because one
	// slow section (activeSessions dominates /api/analytics) used to hide the
	// Live Activity card for seconds even though that card depends on none of
	// these queries.
	//
	// The cost of dropping the gate is that every tile now speaks for its own
	// source, and the three claims must stay distinguishable — a `?? 0` fallback
	// is indistinguishable from a measured zero:
	//   pending     — first fetch in flight, nothing cached → skeleton
	//   unavailable — terminal failure, nothing cached      → say so
	//   stale       — cached numbers, latest refresh failed  → show them, aged
	// `pending` is `isLoading && !data`, so a background refetch never
	// re-skeletons a tile that already has numbers on it.
	const statsAvailability = dataAvailability(statsQuery, statsLoading);
	const statsUnavailable = statsAvailability.state === "unavailable";
	const statsPending = statsLoading && !stats;
	const analyticsAvailability = dataAvailability(
		analyticsQuery,
		analyticsLoading,
	);
	const analyticsUnavailable = analyticsAvailability.state === "unavailable";
	const analyticsPending = analyticsLoading && !analytics;
	const accountsAvailability = dataAvailability(accountsQuery, accountsLoading);
	const accountsUnavailable = accountsAvailability.state === "unavailable";
	const accountsPending = accountsLoading && !accounts;

	// Resolved once here so the strip's count and the list below it can never
	// disagree about what's been dismissed.
	const { visible: visibleErrors, dismiss: dismissError } =
		useVisibleRecentErrors(stats?.recentErrors);

	const [now, setNow] = useState(() => Date.now());
	// Recomputed against `now` so the age keeps ticking with the 30s refresh
	// below rather than freezing at the moment the read first failed.
	const statsStaleNote =
		statsAvailability.state === "stale"
			? `Last updated ${staleAgeLabel(statsAvailability.lastUpdatedAt, now)}`
			: undefined;
	const analyticsStaleNote =
		analyticsAvailability.state === "stale"
			? `Last updated ${staleAgeLabel(analyticsAvailability.lastUpdatedAt, now)}`
			: undefined;
	const accountsStaleNote =
		accountsAvailability.state === "stale"
			? `Last updated ${staleAgeLabel(accountsAvailability.lastUpdatedAt, now)}`
			: undefined;

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

	// Transform time series data
	const timeSeriesData = useMemo(
		() => buildOverviewTimeSeries(analytics),
		[analytics],
	);

	// Memoize percentage changes calculation
	const trends = useMemo(() => {
		if (timeSeriesData.length < 2) {
			return {
				deltaRequests: null,
				trendRequests: "flat" as "up" | "down" | "flat",
			};
		}

		const lastBucket = timeSeriesData[timeSeriesData.length - 1];
		const prevBucket = timeSeriesData[timeSeriesData.length - 2];

		// Calculate deltas
		const deltaRequests = pctChange(lastBucket.requests, prevBucket.requests);

		// Helper to determine trend
		const getTrend = (delta: number | null): "up" | "down" | "flat" => {
			if (delta === null) return "flat";
			return delta >= 0 ? "up" : "down";
		};

		return {
			deltaRequests,
			trendRequests: getTrend(deltaRequests),
		};
	}, [timeSeriesData, pctChange]);

	const trendPeriod = getTrendPeriod(timeRange);

	// Use analytics data for model distribution
	const modelData =
		analytics?.modelDistribution?.map((model) => ({
			name: model.model || "Unknown",
			value: model.count,
		})) || [];

	const accountModelUsageData = analytics?.accountModelUsage || [];
	const projectBreakdownData = analytics?.projectBreakdown || [];

	return (
		<div className="space-y-section">
			{/* Sticky corruption banner — only renders when /api/storage reports corrupt */}
			<StorageIntegrityBanner />

			{/* Only renders when /api/system/status reports unpriced models */}
			<PricingGapBanner />

			{/* Visually hidden, but structurally load-bearing. The shell already
			    renders the page's only visible title as an h1, so printing
			    "Overview" here again was the page naming itself twice on screen.
			    The heading itself has to stay: it keeps order at h1 → h2 → the
			    card's own h3, and without it screen-reader heading navigation
			    meets a level 3 before its level-2 parent. It now names the section
			    rather than the page, which is what a level-2 heading is for. */}
			<h2 className="sr-only">Pool activity and metrics</h2>

			{/* Above the range selector, not below it: this card is live and
			    carries its own minutes-scale window, which has nothing to do with
			    the hours-to-days range that scopes everything after it. Sitting
			    under that selector it read as a second control competing to scope
			    the same content. */}
			<LiveActivityLanes />

			{/* Scopes everything below it, and now sits directly above it. */}
			<div className="flex justify-end">
				<TimeRangeSelector value={timeRange} onChange={setTimeRange} />
			</div>

			<MissingSectionsNotice
				analytics={analytics}
				requested={OVERVIEW_SECTIONS}
			/>

			{/* Metrics Grid */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-group">
				<MetricCard
					title="Total Requests"
					value={formatNumber(analytics?.totals?.requests || 0)}
					change={
						trends.deltaRequests !== null ? trends.deltaRequests : undefined
					}
					trend={trends.trendRequests}
					trendPeriod={trendPeriod}
					loading={analyticsPending}
					// Without these the tile would render the `|| 0` fallback, which is
					// indistinguishable from a range that genuinely saw no requests.
					unavailableReason={
						analyticsUnavailable ? "Request data unavailable" : undefined
					}
					staleNote={analyticsStaleNote}
					icon={Activity}
					subRows={[
						{
							label: "Success rate",
							value: formatPercentage(analytics?.totals?.successRate || 0, 0),
						},
						{
							label: "Cache hit",
							value: formatPercentage(analytics?.totals?.cacheHitRate || 0, 0),
						},
					]}
				/>
				{/* `computePoolUsage([], …)` yields an all-empty result that reads as
				    "no accounts contribute to this pool" — a claim neither an
				    in-flight nor a failed /api/accounts read is entitled to make. */}
				<PoolMetricCard
					title="5h Pool"
					icon={Gauge}
					result={fiveHourPool}
					window="five_hour"
					loading={accountsPending}
					unavailableReason={
						accountsUnavailable ? "Account data unavailable" : undefined
					}
					staleNote={accountsStaleNote}
				/>
				<PoolMetricCard
					title="7d Pool"
					icon={BarChart3}
					result={weeklyPool}
					window="seven_day"
					loading={accountsPending}
					unavailableReason={
						accountsUnavailable ? "Account data unavailable" : undefined
					}
					staleNote={accountsStaleNote}
				/>
			</div>

			{/* Calendar-month ledger spend + amortized subscription run rates. */}
			<SpendSummaryBand />

			<ChartsSection
				timeSeriesData={timeSeriesData}
				timeRange={timeRange}
				modelData={modelData}
				accountModelUsageData={accountModelUsageData}
				projectBreakdownData={projectBreakdownData}
				loading={analyticsPending}
				unavailable={analyticsUnavailable}
			/>

			{/* Glance-level health; the full diagnostics live on /system.
			    Tri-state count: `undefined` while the stats read is still in flight
			    (no badge), `null` when it FAILED (the count is unknown — passing 0
			    would claim "no errors"), a number once resolved. */}
			<SystemHealthStrip
				errorGroupCount={
					statsPending
						? undefined
						: statsUnavailable
							? null
							: visibleErrors.length
				}
			/>

			<CompactRecentErrors
				errors={visibleErrors}
				accounts={accounts}
				onDismiss={dismissError}
				unavailable={statsUnavailable}
				staleNote={statsStaleNote}
			/>

			{accounts && <RateLimitInfo accounts={accounts} />}
		</div>
	);
});
