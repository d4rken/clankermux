import type { AnalyticsResponse } from "@clankermux/types";
import React, { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { TimeRange } from "../constants";
import {
	type AnalyticsTabId,
	DEFAULT_RANGES,
	sanitizeTab,
} from "../lib/analytics-tabs";
import type { FilterState } from "./analytics/AnalyticsFilters";
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
	const [filters, setFilters] = useState<FilterState>({
		accounts: [],
		models: [],
		apiKeys: [],
		projects: [],
		noProject: false,
		status: "all",
	});
	const [filterOpen, setFilterOpen] = useState(false);

	// Accumulate all seen accounts/models/apiKeys/projects to maintain a full
	// list for the filter dropdowns across every tab's queries.
	const [allSeenAccounts, setAllSeenAccounts] = useState<Set<string>>(
		new Set(),
	);
	const [allSeenModels, setAllSeenModels] = useState<Set<string>>(new Set());
	const [allSeenApiKeys, setAllSeenApiKeys] = useState<Set<string>>(new Set());
	const [allSeenProjects, setAllSeenProjects] = useState<Set<string>>(
		new Set(),
	);
	// Whether any breakdown row in this session had project === null. Accumulated
	// like the seen-sets (latched true, never reset) so the "(no project)"
	// checkbox doesn't flicker away when the current range happens to have no
	// NULL-project rows.
	const [hasNoProjectBucket, setHasNoProjectBucket] = useState(false);

	// Latch a tab's query payload into the global seen-sets. Called by each tab
	// whenever its analytics data changes (replaces the old useEffect on the
	// single shared query, now that every tab drives its own).
	const mergeSeen = useCallback((analytics: AnalyticsResponse) => {
		// Add new accounts
		if (analytics.accountPerformance) {
			setAllSeenAccounts((prev) => {
				const updated = new Set(prev);
				for (const account of analytics.accountPerformance) {
					updated.add(account.name);
				}
				return updated;
			});
		}

		// Add new models
		if (analytics.modelDistribution) {
			setAllSeenModels((prev) => {
				const updated = new Set(prev);
				for (const model of analytics.modelDistribution) {
					updated.add(model.model);
				}
				return updated;
			});
		}

		// Add new API keys
		if (analytics.apiKeyPerformance) {
			setAllSeenApiKeys((prev) => {
				const updated = new Set(prev);
				for (const apiKey of analytics.apiKeyPerformance) {
					updated.add(apiKey.name);
				}
				return updated;
			});
		}

		// Add new projects — named projects only; the NULL bucket is handled by
		// the dedicated "(no project)" checkbox, never as a name.
		if (analytics.projectBreakdown) {
			setAllSeenProjects((prev) => {
				const updated = new Set(prev);
				for (const row of analytics.projectBreakdown ?? []) {
					if (row.project != null) {
						updated.add(row.project);
					}
				}
				return updated;
			});
			if (analytics.projectBreakdown.some((row) => row.project == null)) {
				setHasNoProjectBucket(true);
			}
		}
	}, []);

	// Convert sets to sorted arrays for filter dropdowns
	const availableAccounts = useMemo(
		() => Array.from(allSeenAccounts).sort(),
		[allSeenAccounts],
	);
	const availableModels = useMemo(
		() => Array.from(allSeenModels).sort(),
		[allSeenModels],
	);
	const availableApiKeys = useMemo(
		() => Array.from(allSeenApiKeys).sort(),
		[allSeenApiKeys],
	);
	const availableProjects = useMemo(
		() => Array.from(allSeenProjects).sort(),
		[allSeenProjects],
	);

	// Count active filters
	const activeFilterCount =
		filters.accounts.length +
		filters.models.length +
		filters.apiKeys.length +
		filters.projects.length +
		(filters.noProject ? 1 : 0) +
		(filters.status !== "all" ? 1 : 0);

	// ── Traffic-tab UI prefs (hoisted so they survive tab unmount) ────────────
	const [selectedMetric, setSelectedMetric] = useState("requests");
	const [modelBreakdown, setModelBreakdown] = useState(false);

	const sharedFilterProps: SharedFilterProps = {
		filters,
		setFilters,
		availableAccounts,
		availableModels,
		availableApiKeys,
		availableProjects,
		hasNoProjectBucket,
		activeFilterCount,
		filterOpen,
		setFilterOpen,
		mergeSeen,
	};

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
