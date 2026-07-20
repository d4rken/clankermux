import { useEffect } from "react";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import {
	AnalyticsControls,
	ProjectAnalytics,
	RoutingAnalyticsPanel,
	ToolErrorsPanel,
} from "..";
import type { ProjectsReliabilityTabProps } from "./types";

/**
 * Projects & reliability view. Owns the per-project breakdown, routing
 * analytics, and tool-error analytics.
 */
export function ProjectsReliabilityTab(props: ProjectsReliabilityTabProps) {
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
	} = props;

	const { analytics, loading, refetch } = useAnalyticsData(range, filters);

	useEffect(() => {
		if (analytics) mergeSeen(analytics);
	}, [analytics, mergeSeen]);

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
				onRefresh={refetch}
			/>

			{/* Project Breakdown */}
			<ProjectAnalytics
				projectBreakdown={analytics?.projectBreakdown ?? []}
				loading={loading}
			/>

			{/* Routing Analytics */}
			<RoutingAnalyticsPanel
				routing={analytics?.routing}
				loading={loading}
				timeRange={range}
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
