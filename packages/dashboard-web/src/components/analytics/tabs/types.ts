import type { AnalyticsFilterOption } from "@clankermux/types";
import type { TimeRange } from "../../../constants";
import type { FilterState } from "../AnalyticsFilters";

/**
 * Global filter props the 3 request tabs receive from the shell (shared across
 * tabs). The dropdown OPTIONS come from /api/analytics/filter-options, not from
 * the tabs' own payloads, so they no longer depend on which tabs were visited.
 */
export interface SharedFilterProps {
	filters: FilterState;
	setFilters: (f: FilterState) => void;
	availableAccounts: AnalyticsFilterOption[];
	availableModels: string[];
	availableApiKeys: AnalyticsFilterOption[];
	availableProjects: string[];
	hasNoAccountBucket: boolean;
	hasNoProjectBucket: boolean;
	activeFilterCount: number;
	filterOpen: boolean;
	setFilterOpen: (open: boolean) => void;
}

/** Per-tab time window (owned by the shell so it survives tab unmount). */
export interface RangeProps {
	range: TimeRange;
	onRangeChange: (range: TimeRange) => void;
}

export type TrafficTabProps = SharedFilterProps &
	RangeProps & {
		selectedMetric: string;
		setSelectedMetric: (m: string) => void;
		modelBreakdown: boolean;
		setModelBreakdown: (b: boolean) => void;
	};
export type ModelsTabProps = SharedFilterProps & RangeProps;
export type ProjectsReliabilityTabProps = SharedFilterProps & RangeProps;
export type CachingTabProps = RangeProps; // (used by a later step; export it here for a single source of truth)
