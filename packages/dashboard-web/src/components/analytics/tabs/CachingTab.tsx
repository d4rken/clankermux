import type { AnalyticsSection } from "@clankermux/types";
import type { TimeRange } from "../../../constants";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import { TimeRangeSelector } from "../../overview/TimeRangeSelector";
import {
	CacheFlowPanel,
	CacheKeepaliveSection,
	MissingSectionsNotice,
} from "..";
import { EMPTY_FILTERS } from "../AnalyticsFilters";
import type { CachingTabProps } from "./types";

// The Cache Keep-Alive card below is backed by its own endpoints, so the only
// analytics phase this tab renders is the cache-flow sankey.
const CACHING_SECTIONS: readonly AnalyticsSection[] = ["cacheFlow"];

/**
 * Caching view. Owns the cache-flow sankey and the grouped Cache Keep-Alive
 * section, both driven by one shared window selector (no per-request filters).
 */
export function CachingTab({ range, onRangeChange }: CachingTabProps) {
	// This view has no per-request filters — both cards are driven by a single
	// window picker. The shared empty selection keeps its analytics query aligned
	// with the other tabs without exposing any filter controls here.
	const { analytics, loading } = useAnalyticsData(range, EMPTY_FILTERS, {
		sections: CACHING_SECTIONS,
	});

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

			<MissingSectionsNotice
				analytics={analytics}
				requested={CACHING_SECTIONS}
			/>

			{/* Cache Flow */}
			<CacheFlowPanel cacheFlow={analytics?.cacheFlow} loading={loading} />

			{/* Cache Keep-Alive — window selector above drives history + effectiveness */}
			<CacheKeepaliveSection range={range} />
		</div>
	);
}
