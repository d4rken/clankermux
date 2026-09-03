import { RUNWAY_HORIZON_MS } from "@clankermux/core";
import type { AnalyticsSection } from "@clankermux/types";
import React, { useMemo, useState } from "react";
import { REFRESH_INTERVALS, type TimeRange } from "../constants";
import {
	useAccounts,
	useAnalytics,
	useRunway,
	useStats,
} from "../hooks/queries";
import { usePoolUsage } from "../hooks/usePoolUsage";
import { dataAvailability, staleAgeLabel } from "../lib/data-availability";
import { buildOverviewTimeSeries } from "../lib/overview-timeseries";
import { listFamilyRows, type ServableClassPool } from "../lib/pool-usage";
import { MissingSectionsNotice } from "./analytics/MissingSectionsNotice";
import { ChartsSection } from "./overview/ChartsSection";
import { LiveActivityLanes } from "./overview/LiveActivityLanes";
import { PricingGapBanner } from "./overview/PricingGapBanner";
import { RateLimitInfo } from "./overview/RateLimitInfo";
import { RunwayCard } from "./overview/RunwayCard";
import { SpendSummaryBand } from "./overview/SpendSummaryBand";
import { StorageIntegrityBanner } from "./overview/StorageIntegrity";
import { SystemHealthStrip } from "./overview/SystemHealthStrip";
import { CompactRecentErrors } from "./overview/system-status/CompactRecentErrors";
import { useVisibleRecentErrors } from "./overview/system-status/useVisibleRecentErrors";
import { TimeRangeSelector } from "./overview/TimeRangeSelector";
import { FamilyWeeklyCard } from "./quota/FamilyWeeklyCard";
import { PoolQuotaCard } from "./quota/PoolQuotaCard";

/** Error window for the Overview's compact list, in hours. */
export const OVERVIEW_ERROR_WINDOW_HOURS = 1;

/**
 * Stands in for the class list while `/api/accounts` is pending or failed.
 *
 * The class list is DERIVED from the accounts, so before they arrive there is
 * nothing to iterate — mapping over the empty array would render no card at all
 * and silently drop the quota section from the page. Every count is zero and
 * every figure null, so the card takes its own pending or unavailable branch and
 * never states a measurement.
 */
const PLACEHOLDER_CLASS_POOL: ServableClassPool = {
	classId: "pending",
	label: "Quota",
	accounts: [],
	leastUsed: null,
	worst: null,
	reportingCount: 0,
	capacityCount: 0,
	eligibleTotal: 0,
	singlePointOfFailure: false,
	earliestResetMs: null,
	earliestResetAccountName: null,
} as const;

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
	const [timeRange, setTimeRange] = useState<TimeRange>("6h");
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
	// The runway is computed server-side and arrives with the account names its
	// pin labels and causes need. That is what lets the tile speak for ONE read
	// instead of being blocked whenever /api/accounts fails.
	const runwayQuery = useRunway();
	const { data: runway, isLoading: runwayLoading } = runwayQuery;

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
	const runwayAvailability = dataAvailability(runwayQuery, runwayLoading);
	const runwayUnavailable = runwayAvailability.state === "unavailable";
	const runwayPending = runwayLoading && !runway;

	// Resolved once here so the strip's count and the list below it can never
	// disagree about what's been dismissed.
	const {
		visible: visibleErrors,
		dismiss: dismissError,
		dismissAll: dismissAllErrors,
	} = useVisibleRecentErrors(stats?.recentErrors);

	// One computation and one clock, shared with the Usage page — see
	// usePoolUsage. `now` also drives the stale-age captions below, so every
	// duration on this page advances on the same tick.
	const { now, fiveHour: fiveHourPool, sevenDay: weeklyPool } = usePoolUsage();
	// Recomputed against `now` so the age keeps ticking with the 30s refresh
	// below rather than freezing at the moment the read first failed.
	const statsStaleNote =
		statsAvailability.state === "stale"
			? `Last updated ${staleAgeLabel(statsAvailability.lastUpdatedAt, now)}`
			: undefined;
	const accountsStaleNote =
		accountsAvailability.state === "stale"
			? `Last updated ${staleAgeLabel(accountsAvailability.lastUpdatedAt, now)}`
			: undefined;
	// Live discovery only, over the same accounts the quota cards read.
	const familyRows = useMemo(
		() => listFamilyRows(accounts ?? [], now),
		[accounts, now],
	);
	const runwayStaleNote =
		runwayAvailability.state === "stale"
			? `Last updated ${staleAgeLabel(runwayAvailability.lastUpdatedAt, now)}`
			: undefined;

	// Transform time series data
	const timeSeriesData = useMemo(
		() => buildOverviewTimeSeries(analytics),
		[analytics],
	);

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

			{/* LIVE-STATE row: current quota per servable class, plus the runway.
			    Deliberately ABOVE the range selector and unaffected by it — these
			    describe the pool right now, not a time window. Total Requests used to
			    sit here and IS range-scoped, so the selector appeared to govern the
			    whole row while governing one tile of four; it moved down to sit with
			    the ranged content instead.

			    Three columns, not four: with Total Requests moved out this row holds
			    one card per servable class plus the runway, and a four-column grid
			    left the last slot visibly empty. A fifth provider wraps to a second
			    row rather than shrinking every card below legibility. */}
			<div className="grid grid-cols-1 gap-group md:grid-cols-2 lg:grid-cols-3">
				{/* One card per servable class, because the accounts in different
				    classes cannot cover for each other — see lib/pool-classes. The
				    5-hour window is a ROW inside each card rather than a card of its
				    own: the weekly window is the budget, the 5-hour one is the rate
				    governor that paces you through it.

				    `computePoolUsage([], …)` yields an all-empty result that reads as
				    "no accounts contribute to this pool" — a claim neither an in-flight
				    nor a failed /api/accounts read is entitled to make, hence the
				    explicit pending/unavailable props. While either holds there are no
				    classes to iterate, so one placeholder card stands in for the set. */}
				{accountsPending || accountsUnavailable ? (
					<PoolQuotaCard
						weekly={PLACEHOLDER_CLASS_POOL}
						fiveHour={null}
						weeklyResult={weeklyPool}
						now={now}
						loading={accountsPending}
						unavailableReason={
							accountsUnavailable ? "Account data unavailable" : undefined
						}
					/>
				) : (
					weeklyPool.classes.map((weeklyClass) => (
						<PoolQuotaCard
							key={weeklyClass.classId}
							weekly={weeklyClass}
							fiveHour={
								fiveHourPool.classes.find(
									(c) => c.classId === weeklyClass.classId,
								) ?? null
							}
							weeklyResult={weeklyPool}
							now={now}
							staleNote={accountsStaleNote}
						/>
					))
				)}
				{/* Gated on the runway read ALONE. The response carries the account
				    names it needs, so a failing /api/accounts — which blanks the two
				    pool tiles beside it — must not blank this one too. */}
				<RunwayCard
					runways={runway?.keys ?? []}
					accounts={runway?.accounts ?? []}
					horizonMs={runway?.horizonMs ?? RUNWAY_HORIZON_MS}
					now={now}
					loading={runwayPending}
					unavailableReason={
						runwayUnavailable ? "Runway data unavailable" : undefined
					}
					staleNote={runwayStaleNote}
				/>
			</div>

			{/* Per-model weekly caps, full width beneath the class cards. A family
			    limit is independent of the account-wide weekly window above it — a
			    model can be spent while every card here still reads healthy — so it
			    sits with the live quota state rather than under the range selector.
			    No new query: same accounts read the cards use. */}
			<FamilyWeeklyCard
				rows={familyRows}
				now={now}
				loading={accountsPending}
				unavailableReason={
					accountsUnavailable ? "Account data unavailable" : undefined
				}
				staleNote={accountsStaleNote}
			/>

			{/* Calendar-month ledger spend + amortized subscription run rates. */}
			<SpendSummaryBand />

			{/* Everything from here down IS scoped by the selector, and nothing
			    above it is.

			    There is deliberately no Total Requests tile: the request-volume chart
			    directly below plots the same count per bucket, and its right axis
			    already carries success rate and cache hit — the three figures the
			    tile used to state as flat aggregates. */}
			<div className="flex justify-end">
				<TimeRangeSelector value={timeRange} onChange={setTimeRange} />
			</div>

			<MissingSectionsNotice
				analytics={analytics}
				requested={OVERVIEW_SECTIONS}
			/>

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
				onDismissAll={dismissAllErrors}
				unavailable={statsUnavailable}
				staleNote={statsStaleNote}
			/>

			{accounts && <RateLimitInfo accounts={accounts} />}
		</div>
	);
});
