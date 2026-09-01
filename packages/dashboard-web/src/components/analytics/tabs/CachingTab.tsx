import type { AnalyticsSection } from "@clankermux/types";
import { useAnalyticsData } from "../../../hooks/useAnalyticsData";
import {
	AnalyticsControls,
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
		<div className="space-y-section">
			<AnalyticsControls timeRange={range} setTimeRange={onRangeChange} />

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
