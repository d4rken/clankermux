import React, { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { TimeRange } from "../constants";
import { useAnalyticsFilterOptions } from "../hooks/queries";
import {
	type AnalyticsTabId,
	DEFAULT_RANGES,
	sanitizeTab,
} from "../lib/analytics-tabs";
import { EMPTY_FILTERS, type FilterState } from "./analytics/AnalyticsFilters";
import { CachingTab } from "./analytics/tabs/CachingTab";
import { ModelsTab } from "./analytics/tabs/ModelsTab";
import { ProjectsReliabilityTab } from "./analytics/tabs/ProjectsReliabilityTab";
import { TrafficTab } from "./analytics/tabs/TrafficTab";
import type { SharedFilterProps } from "./analytics/tabs/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export const AnalyticsTab = React.memo(() => {
	// ── Active tab (URL-synced so it survives reload / is shareable) ──────────
	const [searchParams, setSearchParams] = useSearchParams();
	const activeTab = sanitizeTab(searchParams.get("tab"));
	const setActiveTab = useCallback(
		(tab: AnalyticsTabId) =>
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					next.set("tab", tab);
					return next;
				},
				{ replace: true },
			),
		[setSearchParams],
	);

	// ── Per-tab time window (lives here so it survives tab unmount) ───────────
	const [ranges, setRanges] =
		useState<Record<AnalyticsTabId, TimeRange>>(DEFAULT_RANGES);
	const setRange = useCallback(
		(tab: AnalyticsTabId, range: TimeRange) =>
			setRanges((prev) => ({ ...prev, [tab]: range })),
		[],
	);

	// ── Global filter state (shared across the request tabs) ──────────────────
	const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
	const [filterOpen, setFilterOpen] = useState(false);

	// Dropdown options come from a dedicated endpoint rather than being latched
	// out of each tab's analytics payload. Those payloads are truncated to the
	// server's top-N models/projects and only arrive for tabs the user has
	// actually opened, so the old accumulate-as-you-browse approach made the
	// dropdown contents depend on browsing history and hid the long tail.
	const { data: filterOptions } = useAnalyticsFilterOptions();

	// Count active filters
	const activeFilterCount =
		filters.accounts.length +
		filters.models.length +
		filters.apiKeys.length +
		filters.projects.length +
		(filters.noAccount ? 1 : 0) +
		(filters.noProject ? 1 : 0) +
		(filters.status !== "all" ? 1 : 0);

	// ── Traffic-tab UI prefs (hoisted so they survive tab unmount) ────────────
	const [selectedMetric, setSelectedMetric] = useState("requests");
	const [modelBreakdown, setModelBreakdown] = useState(false);

	const sharedFilterProps: SharedFilterProps = useMemo(
		() => ({
			filters,
			setFilters,
			availableAccounts: filterOptions?.accounts ?? [],
			availableModels: filterOptions?.models ?? [],
			availableApiKeys: filterOptions?.apiKeys ?? [],
			availableProjects: filterOptions?.projects ?? [],
			hasNoAccountBucket: filterOptions?.hasNoAccount ?? false,
			hasNoProjectBucket: filterOptions?.hasNoProject ?? false,
			activeFilterCount,
			filterOpen,
			setFilterOpen,
		}),
		[filters, filterOptions, activeFilterCount, filterOpen],
	);

	return (
		<div className="space-y-6">
			<Tabs
				value={activeTab}
				onValueChange={(v) => setActiveTab(v as AnalyticsTabId)}
			>
				<TabsList className="grid w-full grid-cols-4">
					<TabsTrigger value="traffic">Traffic</TabsTrigger>
					<TabsTrigger value="models">Models & Speed</TabsTrigger>
					<TabsTrigger value="caching">Caching</TabsTrigger>
					<TabsTrigger value="projects">Projects & Reliability</TabsTrigger>
				</TabsList>
				<TabsContent value="traffic" className="space-y-6">
					<TrafficTab
						{...sharedFilterProps}
						range={ranges.traffic}
						onRangeChange={(r) => setRange("traffic", r)}
						selectedMetric={selectedMetric}
						setSelectedMetric={setSelectedMetric}
						modelBreakdown={modelBreakdown}
						setModelBreakdown={setModelBreakdown}
					/>
				</TabsContent>
				<TabsContent value="models" className="space-y-6">
					<ModelsTab
						{...sharedFilterProps}
						range={ranges.models}
						onRangeChange={(r) => setRange("models", r)}
					/>
				</TabsContent>
				<TabsContent value="caching" className="space-y-6">
					<CachingTab
						range={ranges.caching}
						onRangeChange={(r) => setRange("caching", r)}
					/>
				</TabsContent>
				<TabsContent value="projects" className="space-y-6">
					<ProjectsReliabilityTab
						{...sharedFilterProps}
						range={ranges.projects}
						onRangeChange={(r) => setRange("projects", r)}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
});
