import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { api, type RequestPayload, type RequestSummary } from "../api";
import { eventLoopTone } from "../lib/event-loop";
import { queryKeys } from "../lib/query-keys";
import type { RequestQueryParams } from "../lib/request-filters";

/**
 * Build a lightweight RequestPayload from a RequestSummary.
 *
 * The list view only needs metadata; full bodies (which can be ~256KB each)
 * are lazy-loaded by RequestDetailsModal and CopyButton via /api/requests/payload/:id.
 * `meta.bodiesOmitted` signals to consumers that the bodies must be hydrated.
 */
export function summaryToPlaceholder(summary: RequestSummary): RequestPayload {
	// `accountUsed` is the resolved account name when the JOIN succeeds, else
	// the raw account ID. We put it in accountName so the row renders the
	// friendly name; the ID-only fallback is rare (only after account deletion).
	const accountName = summary.accountUsed ?? undefined;
	return {
		id: summary.id,
		request: { headers: {}, body: null },
		response:
			summary.statusCode != null
				? { status: summary.statusCode, headers: {}, body: null }
				: null,
		error: summary.errorMessage ?? undefined,
		meta: {
			accountName,
			timestamp: new Date(summary.timestamp).getTime(),
			success: summary.success,
			path: summary.path,
			method: summary.method,
			// Server derives this from statusCode === 429 so the list view can
			// render the Rate Limited badge without lazy-loading the body.
			rateLimited: summary.rateLimited,
			bodiesOmitted: true,
		},
	};
}

/**
 * Normalize a details map that may have been revived from JSON (where a `Map`
 * round-trips to an array) back into a `Map` keyed by request id. Shared by the
 * live SSE cache updater and the requests list view.
 */
export function toDetailsMap<T extends { id: string }>(
	raw: Map<string, T> | T[] | undefined,
): Map<string, T> {
	if (raw instanceof Map) return raw;
	return new Map((raw ?? []).map((s) => [s.id, s] as [string, T]));
}

export const useStorageInfo = (refetchInterval?: number) => {
	return useQuery({
		queryKey: queryKeys.storage(),
		queryFn: () => api.getStorageInfo(),
		staleTime: 30_000,
		// Cadence boost while a probe is in flight: a full check on a
		// multi-GB DB takes 25–90s, and a fixed 60s poll could miss the
		// transition entirely. While `integrity_status === "running"` poll
		// every 5s so the dashboard surfaces completion within seconds of
		// the worker finishing. Idle steady-state stays at 60s.
		refetchInterval: (query) => {
			if (refetchInterval !== undefined) return refetchInterval;
			const data = query.state.data;
			if (data?.integrity_status === "running") return 5_000;
			return 60_000;
		},
		refetchIntervalInBackground: false,
	});
};

/**
 * Per-data-type storage usage for the retention settings card. The server
 * caches the (scan-backed) measurement for a few minutes, so we mirror that
 * with a 5-minute staleTime and don't poll — it refetches on mount and is
 * invalidated explicitly after "Clean up now".
 */
export const useStorageUsage = () => {
	return useQuery({
		queryKey: queryKeys.storageUsage(),
		queryFn: () => api.getStorageUsage(),
		staleTime: 5 * 60_000,
	});
};

export const useSystemStatus = (refetchInterval?: number) => {
	return useQuery({
		queryKey: queryKeys.systemStatus(),
		queryFn: () => api.getSystemStatus(),
		// Short staleness: uptime/RSS are live signals the tile re-renders often.
		staleTime: 5_000,
		// Poll every 10s when healthy; tighten to 5s while degraded/unhealthy —
		// or while the event loop is lagging (its tone isn't part of the server
		// rollup) — so the dashboard reflects recovery (or further trouble)
		// promptly.
		refetchInterval: (query) => {
			if (refetchInterval !== undefined) return refetchInterval;
			const data = query.state.data;
			const healthy =
				data?.status === "ok" &&
				eventLoopTone(data.eventLoop?.maxRecentLagMs) === "ok";
			return healthy ? 10_000 : 5_000;
		},
		refetchIntervalInBackground: false,
	});
};

export const useTriggerIntegrityCheck = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (kind: "quick" | "full") => api.triggerIntegrityCheck(kind),
		onError: (error) => {
			// 409 (scheduler already running), network errors, etc. — surface
			// via console so a misbehaving on-demand trigger is visible in
			// devtools. The mutation's `error` field is also exposed by
			// useMutation, so the calling component (StorageIntegritySection)
			// renders the message inline next to the buttons.
			console.error("Integrity check trigger failed:", error);
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.storage() });
		},
	});
};

export const useAccounts = () => {
	return useQuery({
		queryKey: queryKeys.accounts(),
		queryFn: () => api.getAccounts(),
		staleTime: 20000, // Consider data fresh for 20 seconds
		refetchInterval: 60000, // Refresh every minute for usage data
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
	});
};

/**
 * Global force-account override state (in-memory on the server, clears on
 * restart). Kept on a short poll + invalidated after set/clear and on every
 * account reload so the per-account toggle and global banner can't drift across
 * tabs or actions (R7).
 */
export const useForcedAccount = () => {
	return useQuery({
		queryKey: queryKeys.forcedAccount(),
		queryFn: () => api.getForcedAccount(),
		staleTime: 10000,
		refetchInterval: 30000,
		refetchIntervalInBackground: false,
		gcTime: 5 * 60 * 1000,
	});
};

interface ApiKeyListItem {
	id: string;
	name: string;
	prefixLast8: string;
	createdAt: string;
	lastUsed: string | null;
	usageCount: number;
	isActive: boolean;
}

interface ApiKeysListResponse {
	success: boolean;
	data: ApiKeyListItem[];
	count: number;
}

export const useApiKeys = () => {
	return useQuery({
		queryKey: queryKeys.apiKeys(),
		queryFn: async () => {
			const res = await api.get<ApiKeysListResponse>("/api/api-keys");
			return res.data ?? [];
		},
		staleTime: 60000,
		gcTime: 5 * 60 * 1000,
	});
};

export const useStats = (
	refetchInterval?: number,
	errorsSinceHours?: number,
) => {
	return useQuery({
		queryKey: queryKeys.stats(errorsSinceHours),
		queryFn: () => api.getStats({ errorsSinceHours }),
		staleTime: 15000, // Consider data fresh for 15 seconds
		refetchInterval: refetchInterval ?? 30000, // Default to 30 seconds instead of 10
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
	});
};

export const useAnalytics = (
	timeRange: string,
	filters: {
		accounts?: string[];
		models?: string[];
		apiKeys?: string[];
		projects?: string[];
		noProject?: boolean;
		status?: "all" | "success" | "error";
	},
	viewMode: "normal" | "cumulative",
	modelBreakdown?: boolean,
	options?: { enabled?: boolean },
) => {
	const logger = {
		debug: (message: string, ...args: unknown[]) => {
			console.debug(`[Analytics Query] ${message}`, ...args);
		},
		error: (message: string, ...args: unknown[]) => {
			console.error(`[Analytics Query] ${message}`, ...args);
		},
	};

	return useQuery({
		queryKey: queryKeys.analytics(timeRange, filters, viewMode, modelBreakdown),
		queryFn: async () => {
			logger.debug(`Starting analytics query`, {
				timeRange,
				filters,
				viewMode,
				modelBreakdown,
				timestamp: new Date().toISOString(),
			});

			try {
				const result = await api.getAnalytics(
					timeRange,
					filters,
					viewMode,
					modelBreakdown,
				);
				logger.debug(`Analytics query completed successfully`, {
					timeRange,
					filters,
					viewMode,
					modelBreakdown,
					resultType: Array.isArray(result) ? "array" : "object",
					timestamp: new Date().toISOString(),
				});
				return result;
			} catch (error) {
				logger.error(`Analytics query failed`, {
					timeRange,
					filters,
					viewMode,
					modelBreakdown,
					error: error instanceof Error ? error.message : String(error),
					errorStack: error instanceof Error ? error.stack : undefined,
					timestamp: new Date().toISOString(),
				});
				throw error;
			}
		},
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		gcTime: 15 * 60 * 1000,
		enabled: !!timeRange && (options?.enabled ?? true),
		retry: (failureCount, error) => {
			logger.debug(`Analytics query retry attempt ${failureCount + 1}`, {
				error: error instanceof Error ? error.message : String(error),
				willRetry: failureCount < 3, // Retry up to 3 times
				timestamp: new Date().toISOString(),
			});
			return failureCount < 3;
		},
	});
};

/**
 * Per-account utilization series + pool aggregate for the Limits-tab sawtooth
 * chart. Mirrors useAnalytics' polling cadence (45s stale, 60s refetch, paused
 * in the background) since both feed time-series charts.
 */
export const useUsageHistory = (range: string) => {
	return useQuery({
		queryKey: queryKeys.usageHistory(range),
		queryFn: () => api.getUsageHistory(range),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
	});
};

/**
 * Process memory footprint (RSS + JS heap) time-series for the Overview-tab
 * "Memory Usage" chart. Same polling cadence as useUsageHistory (45s stale, 60s
 * refetch, paused in the background) since both feed time-series charts.
 */
export const useMemoryHistory = (range: string) => {
	return useQuery({
		queryKey: queryKeys.memoryHistory(range),
		queryFn: () => api.getMemoryHistory(range),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
	});
};

/**
 * Spend/plan-value summary from the payments ledger. Slow-moving data
 * (subscription renewals land hourly at most), so a relaxed cadence: 60s
 * stale, 2-minute poll, paused in the background. Mutations (record/delete
 * payment, renewal price changes) invalidate the prefix key explicitly.
 */
export const usePaymentsSummary = (range: string) => {
	return useQuery({
		queryKey: queryKeys.paymentsSummary(range),
		queryFn: () => api.getPaymentsSummary(range),
		staleTime: 60_000,
		refetchInterval: 120_000,
		refetchIntervalInBackground: false,
	});
};

export const useCreatePayment = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			accountId: string;
			kind: "subscription" | "credits";
			paidDate: string;
			amountUsd: number;
			notes?: string;
		}) => api.createPayment(input),
		onSuccess: () => {
			// Prefix invalidation: every range-keyed summary is stale now.
			queryClient.invalidateQueries({
				queryKey: queryKeys.paymentsSummaries(),
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useDeletePayment = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deletePayment(id),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.paymentsSummaries(),
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useRequests = (limit: number, opts?: { enabled?: boolean }) => {
	return useQuery({
		queryKey: queryKeys.requests(limit),
		queryFn: async () => {
			// Fetch only the summary endpoint - it has everything the list view needs.
			// Full request/response bodies are lazy-loaded per row when needed
			// (modal open, copy-as-JSON) via /api/requests/payload/:id.
			const requestsSummary = await api.getRequestsSummary(limit);
			const detailsMap = new Map(
				requestsSummary.map((summary) => [summary.id, summary]),
			);
			const requests: RequestPayload[] =
				requestsSummary.map(summaryToPlaceholder);
			return { requests, detailsMap };
		},
		staleTime: Infinity, // Consider data fresh until manually refetched
		gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
		// Disabled while server-side filters are active (the filtered explorer
		// owns the view then); SSE handles real-time updates in the live tail.
		enabled: opts?.enabled ?? true,
	});
};

/**
 * Server-side filtered + paginated request explorer.
 *
 * Each page is a `RequestSummary[]` of length `limit` (the last page is short).
 * "Load more" advances the offset via `fetchNextPage`; there is no next page
 * once a page comes back shorter than `limit`. Disabled (no fetch) until at
 * least one filter is active, so the default view stays on the live tail.
 */
export const useInfiniteRequests = (
	params: RequestQueryParams,
	limit: number,
	enabled: boolean,
) => {
	return useInfiniteQuery({
		queryKey: queryKeys.requestsFiltered({ ...params, limit }),
		queryFn: ({ pageParam }) =>
			api.getRequestsSummary(limit, { ...params, offset: pageParam }),
		initialPageParam: 0,
		getNextPageParam: (lastPage, allPages) =>
			lastPage.length === limit ? allPages.length * limit : undefined,
		staleTime: Infinity,
		gcTime: 5 * 60 * 1000,
		enabled,
	});
};

/**
 * Distinct project names observed across all recorded requests. Backs the
 * Project filter dropdown; mirrors useApiKeys' caching (the list changes
 * rarely, so a minute of staleness is fine).
 */
export const useRequestProjects = () => {
	return useQuery({
		queryKey: queryKeys.requestProjects(),
		queryFn: () => api.getRequestProjects(),
		staleTime: 60000,
		gcTime: 5 * 60 * 1000,
	});
};

/** Total number of requests matching `params` (drives the "M of N" counter). */
export const useRequestsCount = (
	params: RequestQueryParams,
	enabled: boolean,
) => {
	return useQuery({
		queryKey: queryKeys.requestsCount(params),
		queryFn: () => api.getRequestsCount(params),
		staleTime: Infinity,
		gcTime: 5 * 60 * 1000,
		enabled,
	});
};

export const useLogHistory = () => {
	return useQuery({
		queryKey: queryKeys.logHistory(),
		queryFn: () => api.getLogHistory(),
	});
};

// Mutations
export const useRemoveAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			name,
			confirmInput,
		}: {
			name: string;
			confirmInput: string;
		}) => api.removeAccount(name, confirmInput),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useRenameAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			accountId,
			newName,
		}: {
			accountId: string;
			newName: string;
		}) => api.renameAccount(accountId, newName),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useResetStats = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.resetStats(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.stats() });
		},
	});
};

// Note: Clear logs functionality appears to be removed from the API

// Retention settings
export const useRetention = () => {
	return useQuery({
		queryKey: ["retention"],
		queryFn: () => api.getRetention(),
	});
};

export const useSetRetention = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (partial: {
			payloadDays?: number;
			requestDays?: number;
			usageSnapshotDays?: number;
			memorySnapshotDays?: number;
			storePayloads?: boolean;
		}) => api.setRetention(partial),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["retention"] });
		},
	});
};

export const useCacheWarming = () => {
	return useQuery({
		queryKey: ["cache-warming"],
		queryFn: () => api.getCacheWarming(),
	});
};

export const useSetCacheWarming = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { enabled?: boolean; minTokens?: number }) =>
			api.setCacheWarming(body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["cache-warming"] });
		},
	});
};

export const useUsageThrottling = () => {
	return useQuery({
		queryKey: ["usage-throttling"],
		queryFn: () => api.getUsageThrottling(),
	});
};

export const useSetUsageThrottling = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (settings: {
			fiveHourEnabled: boolean;
			weeklyEnabled: boolean;
		}) => api.setUsageThrottling(settings),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["usage-throttling"] });
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useCleanupNow = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.cleanupNow(),
		onSuccess: () => {
			// Sizes/row counts changed — refresh the standing per-type display.
			queryClient.invalidateQueries({ queryKey: queryKeys.storageUsage() });
		},
	});
};

export const useCombos = () => {
	return useQuery({
		queryKey: queryKeys.combos(),
		queryFn: () => api.getCombos(),
	});
};

export const useFamilies = () => {
	return useQuery({
		queryKey: queryKeys.families(),
		queryFn: () => api.getFamilies(),
	});
};

export const useCreateCombo = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (params: {
			name: string;
			description?: string;
			enabled?: boolean;
		}) => api.createCombo(params),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
		},
	});
};

export const useAssignFamily = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (params: {
			family: string;
			comboId: string | null;
			enabled: boolean;
		}) => api.assignFamily(params),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.families() });
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
		},
	});
};

export const useDeleteCombo = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteCombo(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
		},
	});
};

export const useUpdateCombo = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (params: {
			id: string;
			name?: string;
			description?: string;
			enabled?: boolean;
		}) => api.updateCombo(params.id, params),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
		},
	});
};

export const useGetCombo = (id: string | null) => {
	return useQuery({
		queryKey: ["combo", id],
		queryFn: () => {
			if (id === null) {
				throw new Error("combo id is required");
			}
			return api.getCombo(id);
		},
		enabled: !!id,
	});
};

export const useAddComboSlot = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			comboId,
			params,
		}: {
			comboId: string;
			params: { account_id: string; model: string; enabled?: boolean };
		}) => api.addComboSlot(comboId, params),
		onSuccess: (_data, { comboId }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
			queryClient.invalidateQueries({ queryKey: ["combo", comboId] });
		},
	});
};

export const useUpdateComboSlot = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			comboId,
			slotId,
			params,
		}: {
			comboId: string;
			slotId: string;
			params: { model?: string; enabled?: boolean };
		}) => api.updateComboSlot(comboId, slotId, params),
		onSuccess: (_data, { comboId }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
			queryClient.invalidateQueries({ queryKey: ["combo", comboId] });
		},
	});
};

export const useRemoveComboSlot = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ comboId, slotId }: { comboId: string; slotId: string }) =>
			api.removeComboSlot(comboId, slotId),
		onSuccess: (_data, { comboId }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
			queryClient.invalidateQueries({ queryKey: ["combo", comboId] });
		},
	});
};

export const useReorderComboSlots = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			comboId,
			slotIds,
		}: {
			comboId: string;
			slotIds: string[];
		}) => api.reorderComboSlots(comboId, slotIds),
		onSuccess: (_data, { comboId }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
			queryClient.invalidateQueries({ queryKey: ["combo", comboId] });
		},
	});
};
