import type { AnalyticsSection } from "@clankermux/types";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import {
	AnalyticsControls,
	ContextCompositionPanel,
	MissingSectionsNotice,
	ModelAnalytics,
	TokenSpeedAnalytics,
} from "..";
import type { ModelsTabProps } from "./types";

// `totals` is still requested because `contextComposition` is computed against
// it server-side; no tile on this tab reads the totals directly any more.
const MODELS_SECTIONS: readonly AnalyticsSection[] = [
	"totals",
	"costByModel",
	"modelPerformance",
	"speedTimeSeries",
	"contextComposition",
];

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
		hasNoAccountBucket,
		hasNoProjectBucket,
		activeFilterCount,
		filterOpen,
		setFilterOpen,
		range,
		onRangeChange,
	} = props;

	const { analytics, loading, refetch } = useAnalyticsData(range, filters, {
		sections: MODELS_SECTIONS,
	});

	// Use real cost by model data with filters. No slice cap: ModelAnalytics
	// joins this per model against the (up to 10) modelPerformance rows, so
	// capping here would silently null out cost for the lower-ranked models.
	const costByModel =
		analytics?.costByModel?.filter(
			(model) =>
				filters.models.length === 0 || filters.models.includes(model.model),
		) || [];

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
				refresh={{ loading, onRefresh: refetch }}
			/>

			<MissingSectionsNotice
				analytics={analytics}
				requested={MODELS_SECTIONS}
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
