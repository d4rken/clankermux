import { useEffect } from "react";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import {
	AnalyticsControls,
	ContextCompositionPanel,
	ModelAnalytics,
	TokenSpeedAnalytics,
} from "..";
import type { ModelsTabProps } from "./types";

/**
 * Models view. Owns the per-model performance table (with cost-by-model),
 * token-speed analytics, and the context-composition panel.
 */
export function ModelsTab(props: ModelsTabProps) {
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

	// Use real cost by model data with filters. No slice cap: ModelAnalytics
	// joins this per model against the (up to 10) modelPerformance rows, so
	// capping here would silently null out cost for the lower-ranked models.
	const costByModel =
		analytics?.costByModel?.filter(
			(model) =>
				filters.models.length === 0 || filters.models.includes(model.model),
		) || [];

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

			{/* Enhanced Model Analytics */}
			<ModelAnalytics
				modelPerformance={analytics?.modelPerformance || []}
				costByModel={costByModel}
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
				timeRange={range}
			/>

			{/* Context Composition */}
			<ContextCompositionPanel
				contextComposition={analytics?.contextComposition}
				loading={loading}
				timeRange={range}
			/>
		</div>
	);
}
