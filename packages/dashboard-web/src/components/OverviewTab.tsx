import { registerUIRefresh, TIME_CONSTANTS } from "@clankermux/core";
import type { AnalyticsSection } from "@clankermux/types";
import { formatNumber, formatPercentage } from "@clankermux/ui-common";
import { Activity, BarChart3, Gauge, Users } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { REFRESH_INTERVALS } from "../constants";
import { useAccounts, useAnalytics, useStats } from "../hooks/queries";
import { SESSION_SCOPE_SHORT_LABELS } from "../lib/active-sessions";
import { dataAvailability, staleAgeLabel } from "../lib/data-availability";
import { buildOverviewTimeSeries } from "../lib/overview-timeseries";
import { computePoolUsage } from "../lib/pool-usage";
import { MissingSectionsNotice } from "./analytics/MissingSectionsNotice";
import { ChartsSection } from "./overview/ChartsSection";
import { LiveActivityLanes } from "./overview/LiveActivityLanes";
import { LoadingSkeleton } from "./overview/LoadingSkeleton";
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
 * list yields `undefined` analytics and the page renders its loading skeleton.
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
	// A failed /api/stats read used to be invisible: every consumer below
	// rendered `?? 0`, which is indistinguishable from a real zero. Resolve the
	// three cases once here and hand the verdict to each stats-backed widget.
	const statsAvailability = dataAvailability(statsQuery, statsLoading);
	const statsUnavailable = statsAvailability.state === "unavailable";
	const [timeRange, setTimeRange] = useState("6h");
	const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
		timeRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
		false,
		{ sections: OVERVIEW_SECTIONS },
	);
	const { data: accounts, isLoading: accountsLoading } = useAccounts();

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
	const projectBreakdownData = analytics?.projectBreakdown || [];

	return (
		<div className="space-y-6">
			{/* Sticky corruption banner — only renders when /api/storage reports corrupt */}
			<StorageIntegrityBanner />

			{/* Only renders when /api/system/status reports unpriced models */}
			<PricingGapBanner />

			{/* Deliberately ABOVE the header below, and therefore above the range
			    selector: this card is live and carries its own minutes-scale
			    window, which has nothing to do with the hours-to-days range that
			    scopes everything after it. Placed below, it would read as a second
			    control competing to scope the same content. */}
			<LiveActivityLanes />

			{/* Header with Time Range Selector — scopes everything below it */}
			<div className="flex justify-between items-center">
				<h2 className="text-2xl font-semibold">Overview</h2>
				<TimeRangeSelector value={timeRange} onChange={setTimeRange} />
			</div>

			<MissingSectionsNotice
				analytics={analytics}
				requested={OVERVIEW_SECTIONS}
			/>

			{/* Metrics Grid */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				<MetricCard
					title="Total Requests"
					value={formatNumber(analytics?.totals?.requests || 0)}
					change={
						trends.deltaRequests !== null ? trends.deltaRequests : undefined
					}
					trend={trends.trendRequests}
					trendPeriod={trendPeriod}
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
				<MetricCard
					title="Active Sessions"
					caption={`· last ${Math.round((stats?.activeSessions?.windowMs ?? TIME_CONSTANTS.ACTIVE_SESSION_WINDOW_MS) / 60000)}m`}
					value={formatNumber(stats?.activeSessions?.total ?? 0)}
					// Without these the tile shows "0" for a failed read — exactly the
					// "not all results are correct" symptom the lane split addresses,
					// but which a DB-busy error or a worker crash can still produce.
					unavailableReason={
						statsUnavailable ? "Session data unavailable" : undefined
					}
					staleNote={statsStaleNote}
					icon={Users}
					subRows={[
						{
							label: SESSION_SCOPE_SHORT_LABELS.claude,
							value: formatNumber(stats?.activeSessions?.claude ?? 0),
						},
						{
							label: SESSION_SCOPE_SHORT_LABELS.codex,
							value: formatNumber(stats?.activeSessions?.codex ?? 0),
						},
						...(stats?.activeSessions?.other
							? [
									{
										label: SESSION_SCOPE_SHORT_LABELS.other,
										value: formatNumber(stats.activeSessions.other),
										tooltip:
											"Sessions identified only by a project label (no Claude Code session id or Codex thread id) — can't be reliably attributed to either provider.",
									},
								]
							: []),
					]}
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

			{/* Calendar-month ledger spend + amortized subscription run rates. */}
			<SpendSummaryBand />

			<ChartsSection
				timeSeriesData={timeSeriesData}
				timeRange={timeRange}
				modelData={modelData}
				accountModelUsageData={accountModelUsageData}
				projectBreakdownData={projectBreakdownData}
				loading={loading}
			/>

			{/* Glance-level health; the full diagnostics live on /system.
			    `null` means the error count is UNKNOWN (the stats read failed) —
			    passing 0 would claim "no errors". */}
			<SystemHealthStrip
				errorGroupCount={statsUnavailable ? null : visibleErrors.length}
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
