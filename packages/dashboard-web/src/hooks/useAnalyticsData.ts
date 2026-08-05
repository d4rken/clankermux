import type { AnalyticsResponse, AnalyticsSection } from "@clankermux/types";
import type { FilterState } from "../components/analytics/AnalyticsFilters";
import type { TimeRange } from "../constants";
import { useAnalytics } from "./queries";

export interface UseAnalyticsDataResult {
	analytics: AnalyticsResponse | undefined;
	loading: boolean;
	refetch: () => void;
	perModelAnalytics: AnalyticsResponse | undefined;
	perModelLoading: boolean;
	refetchPerModel: () => void;
}

/**
 * Reusable per-tab analytics query orchestrator.
 *
 * This is the thin query-orchestration layer extracted from `AnalyticsTab`
 * (the inline `useAnalytics` calls it historically made side-by-side). Each
 * Analytics sub-tab drives its own range/filters and calls this hook, so the
 * primary aggregate query and the gated per-model breakdown query stay wired
 * up identically everywhere without duplicating the pattern.
 *
 * - `analytics` is always fetched WITHOUT a per-model breakdown so charts that
 *   derive from `analytics.timeSeries` keep a stable one-row-per-timestamp
 *   series regardless of any "Per Model" toggle.
 * - `perModelAnalytics` is only fetched when `options.perModel` is true; it
 *   returns per-model rows that REPLACE the aggregate series, so it is kept as
 *   a separate query and must not back the shared data. It carries its own
 *   (much smaller) section list — re-running the tab's full phase set just to
 *   obtain one time series is what made the "Per Model" toggle expensive.
 */
export function useAnalyticsData(
	range: TimeRange,
	filters: FilterState,
	options: {
		perModel?: boolean;
		/** Query phases this tab renders. See lib/analytics-sections.ts. */
		sections: readonly AnalyticsSection[];
		/**
		 * Sections the per-model breakdown query needs. Deliberately separate and
		 * much smaller: it exists only to REPLACE the aggregate series with
		 * per-model rows, so it must not re-run the tab's other phases.
		 */
		perModelSections?: readonly AnalyticsSection[];
	},
): UseAnalyticsDataResult {
	const primary = useAnalytics(range, filters, "normal", false, {
		sections: options.sections,
	});
	const perModel = useAnalytics(range, filters, "normal", true, {
		enabled: options.perModel ?? false,
		sections: options.perModelSections ?? options.sections,
	});

	return {
		analytics: primary.data,
		loading: primary.isLoading,
		refetch: () => {
			void primary.refetch();
		},
		perModelAnalytics: perModel.data,
		perModelLoading: perModel.isLoading,
		refetchPerModel: () => {
			void perModel.refetch();
		},
	};
}
