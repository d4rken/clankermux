import type { TimeRange } from "../../../constants";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import { TimeRangeSelector } from "../../overview/TimeRangeSelector";
import { CacheFlowPanel, CacheKeepaliveSection } from "..";
import type { FilterState } from "../AnalyticsFilters";
import type { CachingTabProps } from "./types";

// Caching view has no per-request filters — both cards are driven by a single
// window picker. An empty, stable filter object keeps the shared analytics query
// aligned with the other tabs without exposing any filter controls here.
const NO_FILTERS: FilterState = {
	accounts: [],
	models: [],
	apiKeys: [],
	projects: [],
	noProject: false,
	status: "all",
};

/**
 * Caching view. Owns the cache-flow sankey and the grouped Cache Keep-Alive
 * section, both driven by one shared window selector (no per-request filters).
 */
export function CachingTab({ range, onRangeChange }: CachingTabProps) {
	const { analytics, loading } = useAnalyticsData(range, NO_FILTERS);

	return (
		<div className="space-y-6">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
				<div className="flex items-center gap-2 shrink-0">
					<span className="text-xs text-muted-foreground">Window</span>
					<TimeRangeSelector
						value={range}
						onChange={(v) => onRangeChange(v as TimeRange)}
					/>
				</div>
			</div>

			{/* Cache Flow */}
			<CacheFlowPanel cacheFlow={analytics?.cacheFlow} loading={loading} />

			{/* Cache Keep-Alive — window selector above drives history + effectiveness */}
			<CacheKeepaliveSection range={range} />
		</div>
	);
}
