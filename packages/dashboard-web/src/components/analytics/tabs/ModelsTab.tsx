import type { AnalyticsSection } from "@clankermux/types";
import { useModelSubstitutions } from "../../../hooks/queries";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import { CostCoverageNote } from "../../CostCoverage";
import {
	AnalyticsControls,
	ContextCompositionPanel,
	MissingSectionsNotice,
	ModelAnalytics,
	ModelSubstitutionCard,
	RefusalFallbackPanel,
	TokenSpeedAnalytics,
} from "..";
import type { ModelsTabProps } from "./types";

// `totals` is still requested because `contextComposition` is computed against
// it server-side; no tile on this tab reads the totals directly any more.
export const MODELS_SECTIONS: readonly AnalyticsSection[] = [
	"totals",
	"costByModel",
	"modelPerformance",
	"refusalFallbacks",
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

	// Range-scoped like every other panel here, but filter-free by design: see
	// ModelSubstitutionCard for why the request filters cannot apply.
	const substitutions = useModelSubstitutions(range);

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

			{analytics?.totals?.apiCostCoverage && (
				<p className="text-xs text-muted-foreground">
					API usage costs in this range:{" "}
					<CostCoverageNote coverage={analytics.totals.apiCostCoverage} />
				</p>
			)}
			{/* Where a provider answered as something other than what it was sent.
			    Its own query rather than an analytics section: the chip and banner
			    read the same endpoint from pages that never request that payload. */}
			<ModelSubstitutionCard
				data={substitutions.data}
				loading={substitutions.isPending}
				unavailableReason={
					substitutions.isError
						? "Substitution data is unavailable right now."
						: null
				}
			/>

			{/* Enhanced Model Analytics */}
			<ModelAnalytics
				modelPerformance={analytics?.modelPerformance || []}
				costByModel={costByModel}
				loading={loading}
			/>

			{/* Safety refusals and the fallback retries that follow them */}
			<RefusalFallbackPanel
				data={analytics?.refusalFallbacks}
				loading={loading}
				timeRange={range}
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
