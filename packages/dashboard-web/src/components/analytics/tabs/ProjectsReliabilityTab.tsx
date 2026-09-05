import type { AnalyticsSection } from "@clankermux/types";
import { useEffect, useState } from "react";
import { useStopsHistory } from "../../../hooks/queries";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import {
	dataAvailability,
	staleAgeLabel,
} from "../../../lib/data-availability";
import { subscribePoolClock } from "../../../lib/pool-clock";
import {
	AnalyticsControls,
	MissingSectionsNotice,
	ProjectAnalytics,
	RoutingAnalyticsPanel,
	StopsHistoryCard,
	ToolErrorsPanel,
} from "..";
import type { ProjectsReliabilityTabProps } from "./types";

// `totals` is here for projectAttributionCoverage, which it owns — the coverage
// numbers come from the consolidated totals query, not from summing the
// top-N-truncated projectBreakdown.
const PROJECTS_SECTIONS: readonly AnalyticsSection[] = [
	"totals",
	"projectBreakdown",
	"routing",
	"toolCallErrors",
];

/**
 * Projects & reliability view. Owns the per-project breakdown, routing
 * analytics, tool-error analytics, and the record of what actually blocked a
 * request.
 */
export function ProjectsReliabilityTab(props: ProjectsReliabilityTabProps) {
	const {
		filters,
		setFilters,
		availableAccounts,
		availableModels,
		availableApiKeys,
		availableProjects,
		hasNoAccountBucket,
		hasNoProjectBucket,
		activeFilterCount,
		filterOpen,
		setFilterOpen,
		range,
		onRangeChange,
	} = props;

	const { analytics, loading, refetch } = useAnalyticsData(range, filters, {
		sections: PROJECTS_SECTIONS,
	});

	// Its own endpoint, so its own query — and its own availability state. The
	// three claims stay distinguishable, because a `?? 0` fallback is
	// indistinguishable from a measured zero:
	//   pending     — first fetch in flight, nothing cached → skeleton
	//   unavailable — terminal failure, nothing cached      → say so
	//   stale       — cached numbers, latest refresh failed → show them, aged
	const stopsQuery = useStopsHistory(range, filters);
	const { data: stops, isLoading: stopsLoading } = stopsQuery;
	const stopsAvailability = dataAvailability(stopsQuery, stopsLoading);
	const stopsUnavailable = stopsAvailability.state === "unavailable";
	const stopsPending = stopsLoading && !stops;

	// The SHARED 30s clock every quota surface reads, not a private interval:
	// a second registered interval displaces the first (see lib/pool-clock), and
	// a bare setInterval here would let this card's ages drift against the ones
	// on Overview and Usage.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => subscribePoolClock(setNow), []);

	// Recomputed against `now` so the age keeps ticking rather than freezing at
	// the moment the read first failed.
	const stopsStaleNote =
		stopsAvailability.state === "stale"
			? `Last updated ${staleAgeLabel(stopsAvailability.lastUpdatedAt, now)}`
			: undefined;

	return (
		<div className="space-y-section">
			<AnalyticsControls
				timeRange={range}
				setTimeRange={onRangeChange}
				filterProps={{
					filters,
					setFilters,
					availableAccounts,
					availableModels,
					availableApiKeys,
					availableProjects,
					hasNoAccountBucket,
					hasNoProjectBucket,
					activeFilterCount,
					filterOpen,
					setFilterOpen,
				}}
				refresh={{
					loading,
					// Both reads on this tab, or the refresh would leave the stops card
					// showing figures from before the click.
					onRefresh: () => {
						refetch();
						void stopsQuery.refetch();
					},
				}}
			/>

			<MissingSectionsNotice
				analytics={analytics}
				requested={PROJECTS_SECTIONS}
			/>

			{/* Project Breakdown */}
			<ProjectAnalytics
				projectBreakdown={analytics?.projectBreakdown ?? []}
				attributionCoverageTotals={analytics?.projectAttributionCoverage}
				loading={loading}
			/>

			{/* Routing Analytics */}
			<RoutingAnalyticsPanel
				routing={analytics?.routing}
				loading={loading}
				timeRange={range}
			/>

			{/* What ACTUALLY blocked a request in this range, scoped by the filters
			    above. The routing panel says how requests were placed; this says
			    when there was nowhere to place them. */}
			<StopsHistoryCard
				data={stops}
				now={now}
				loading={stopsPending}
				unavailableReason={
					stopsUnavailable ? "Stops data unavailable" : undefined
				}
				staleNote={stopsStaleNote}
			/>

			{/* Tool Errors */}
			<ToolErrorsPanel
				toolCallErrors={analytics?.toolCallErrors}
				loading={loading}
				timeRange={range}
			/>
		</div>
	);
}
