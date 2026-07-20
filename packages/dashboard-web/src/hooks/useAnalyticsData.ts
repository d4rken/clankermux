import type { AnalyticsResponse } from "@clankermux/types";
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
 *   a separate query and must not back the shared data.
 */
export function useAnalyticsData(
	range: TimeRange,
	filters: FilterState,
	options?: { perModel?: boolean },
): UseAnalyticsDataResult {
	const primary = useAnalytics(range, filters, "normal");
	const perModel = useAnalytics(range, filters, "normal", true, {
		enabled: options?.perModel ?? false,
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
