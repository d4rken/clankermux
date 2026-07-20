import type { AnalyticsResponse } from "@clankermux/types";
import type { TimeRange } from "../../../constants";
import type { FilterState } from "../AnalyticsFilters";

/** Global filter/seen props the 3 request tabs receive from the shell (shared across tabs). */
export interface SharedFilterProps {
	filters: FilterState;
	setFilters: (f: FilterState) => void;
	availableAccounts: string[];
	availableModels: string[];
	availableApiKeys: string[];
	availableProjects: string[];
	hasNoProjectBucket: boolean;
	activeFilterCount: number;
	filterOpen: boolean;
	setFilterOpen: (open: boolean) => void;
	/** Latch this tab's query payload into the shell's global seen-sets (filter options). */
	mergeSeen: (analytics: AnalyticsResponse) => void;
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
