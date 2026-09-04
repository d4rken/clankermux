import type { AnalyticsSection } from "@clankermux/types";
import type { QueryClient } from "@tanstack/react-query";

export const queryKeys = {
	all: ["clankermux"] as const,
	/** The management login gate. Public by policy, so it answers even signed out. */
	authStatus: () => [...queryKeys.all, "auth-status"] as const,
	accounts: () => [...queryKeys.all, "accounts"] as const,
	// Server-computed per-key quota runway. Derived from BOTH the account state
	// and the API-key set (with their routing pins), so it is invalidated
	// wherever either changes — see invalidateCapacityQueries below.
	runway: () => [...queryKeys.all, "runway"] as const,
	// Server-computed pacing scan. Built from the SAME account array `accounts()`
	// serves, so it goes stale on exactly the same events and is invalidated
	// beside it.
	pacing: () => [...queryKeys.all, "pacing"] as const,
	forcedAccount: () => [...queryKeys.all, "forced-account"] as const,
	stats: (errorsSinceHours?: number) =>
		errorsSinceHours !== undefined
			? ([...queryKeys.all, "stats", { errorsSinceHours }] as const)
			: ([...queryKeys.all, "stats"] as const),
	// `sections` is part of the key: two callers asking for different section
	// sets get different payloads and must not share a cache entry (the smaller
	// one would leave the larger caller's panels blank). It is canonicalized by
	// the caller so section ORDER never forks the cache.
	analytics: (
		timeRange?: string,
		filters?: unknown,
		viewMode?: string,
		modelBreakdown?: boolean,
		sections?: readonly AnalyticsSection[],
	) =>
		[
			...queryKeys.all,
			"analytics",
			{ timeRange, filters, viewMode, modelBreakdown, sections },
		] as const,
	usageHistory: (range?: string) =>
		[...queryKeys.all, "usage-history", { range }] as const,
	// Per-model-family weekly history. Keyed by range only: one response covers
	// every family, so two family panels on the same range share a cache entry.
	usageScopedHistory: (range?: string) =>
		[...queryKeys.all, "usage-scoped-history", { range }] as const,
	// Blocked-request history by cause. Keyed by range only: one response covers
	// every cause, so the chart and the table share a cache entry.
	stopsHistory: (range?: string) =>
		[...queryKeys.all, "stops-history", { range }] as const,
	memoryHistory: (range?: string) =>
		[...queryKeys.all, "memory-history", { range }] as const,
	// Unkeyed: the payload is precomputed over the whole retained history, so
	// there is no range or filter axis to fork the cache on.
	quotaDrift: () => [...queryKeys.all, "quota-drift"] as const,
	cacheKeepalive: () => [...queryKeys.all, "cache-keepalive"] as const,
	cacheKeepaliveHistory: (range?: string) =>
		[...queryKeys.all, "cache-keepalive-history", { range }] as const,
	cacheEffectiveness: (range?: string) =>
		[...queryKeys.all, "cache-effectiveness", { range }] as const,
	// Prefix key — invalidating this hits every range-keyed payments summary.
	paymentsSummaries: () => [...queryKeys.all, "payments-summary"] as const,
	paymentsSummary: (range?: string) =>
		[...queryKeys.paymentsSummaries(), { range }] as const,
	requests: (limit?: number) =>
		[...queryKeys.all, "requests", { limit }] as const,
	// Filtered/paginated request explorer. Keyed on the resolved server filter
	// params (+ page size) so changing any filter starts a fresh infinite query.
	requestsFiltered: (params: unknown) =>
		[...queryKeys.all, "requests", "filtered", params] as const,
	requestsCount: (params: unknown) =>
		[...queryKeys.all, "requests", "count", params] as const,
	// A single request resolved by id, for a deep link whose target is outside
	// the loaded slice.
	requestById: (id: string) =>
		[...queryKeys.all, "requests", "by-id", { id }] as const,
	requestProjects: () => [...queryKeys.all, "requests", "projects"] as const,
	// Options for the analytics filter dropdowns. Unkeyed: the lists are global
	// by design, so scoping them to the active filters would make a filter
	// un-clearable once it excluded its own option.
	analyticsFilterOptions: () =>
		[...queryKeys.all, "analytics", "filter-options"] as const,
	logs: () => [...queryKeys.all, "logs"] as const,
	logHistory: () => [...queryKeys.all, "logs", "history"] as const,
	combos: () => [...queryKeys.all, "combos"] as const,
	families: () => [...queryKeys.all, "families"] as const,
	apiKeys: () => [...queryKeys.all, "api-keys"] as const,
	storage: () => [...queryKeys.all, "storage"] as const,
	// Deliberately NOT nested under storage() — the size scan is expensive and
	// must not be invalidated by the storage()-key invalidation that fires on
	// every integrity-check trigger. Only useCleanupNow invalidates this key.
	storageUsage: () => [...queryKeys.all, "storage-usage"] as const,
	systemStatus: () => [...queryKeys.all, "system-status"] as const,
} as const;

/**
 * Invalidate everything that describes routable capacity: the accounts, the API
 * keys, and the runway derived from both.
 *
 * ONE helper rather than a second `invalidateQueries` call at each of the
 * dozen-odd mutation sites, because that enumeration is exactly what drifts —
 * a surface invalidating one key while another surface reads a second key
 * derived from it is how the runway would go stale after an account change.
 * Anything that mutates an account or a key routes through here.
 *
 * Some callers only touch one of the three (regenerating a key's secret changes
 * no runway field, for instance). They still use this: a redundant invalidation
 * costs one refetch, a missing one is a wrong number on screen.
 */
export function invalidateCapacityQueries(queryClient: QueryClient): void {
	queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
	queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
	queryClient.invalidateQueries({ queryKey: queryKeys.runway() });
	queryClient.invalidateQueries({ queryKey: queryKeys.pacing() });
}
