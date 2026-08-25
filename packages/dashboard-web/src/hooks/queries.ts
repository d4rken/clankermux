import { HttpError } from "@clankermux/http-common";
import type {
	AnalyticsSection,
	ApiKeyResponse,
	ModelDialect,
	ModelOverrideSetRequest,
	ProjectRulesSetRequest,
	RetentionSetRequest,
} from "@clankermux/types";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { api, type RequestPayload, type RequestSummary } from "../api";
import { canonicalSections } from "../lib/analytics-sections";
import { eventLoopTone } from "../lib/event-loop";
import { invalidateCapacityQueries, queryKeys } from "../lib/query-keys";
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

/**
 * Retry policy for the worker-backed dashboard reads (analytics, stats, the
 * history endpoints, payments summary, filter options).
 *
 * Do NOT retry when the server ANSWERED — an HttpError means the request
 * reached the handler and it decided. Retrying a 503 soft timeout is actively
 * harmful: each attempt re-queues a full query behind the same slow read that
 * caused the timeout, so a 3-retry default turns one slow query into four.
 * A genuine network failure (no response at all) gets exactly one retry.
 */
export function shouldRetryDashboardQuery(
	failureCount: number,
	error: unknown,
): boolean {
	if (error instanceof HttpError) return false;
	return failureCount < 1;
}

export const useStorageInfo = (refetchInterval?: number) => {
	return useQuery({
		queryKey: queryKeys.storage(),
		queryFn: () => api.getStorageInfo(),
		staleTime: 30_000,
		// Cadence boost while a probe is in flight: a full check on a
		// multi-GB DB takes 25–90s, and a fixed 60s poll could miss the
		// transition entirely. In-flight is signalled by `integrity_running_kind`
		// (the collapsed `integrity_status` no longer flips to "running" — it
		// keeps the last verified verdict so a corrupt banner persists across a
		// recheck). Poll every 5s while a kind is running so the dashboard
		// surfaces completion within seconds; idle steady-state stays at 60s.
		refetchInterval: (query) => {
			if (refetchInterval !== undefined) return refetchInterval;
			const data = query.state.data;
			if (data?.integrity_running_kind != null) return 5_000;
			return 60_000;
		},
		refetchIntervalInBackground: false,
	});
};

/** How often to re-ask for the measurement while none has landed yet. */
export const STORAGE_USAGE_POLL_MS = 15_000;

/**
 * Poll until a measurement has actually landed, then stop.
 *
 * Keyed on `status`, NOT on the presence of `data`. TanStack keeps the previous
 * value after a failed refetch, so a cold rescan that times out — exactly what
 * "Clean up now" provokes, since it invalidates the server's cached figure —
 * leaves stale numbers in place with `status: "error"`. Keyed on data alone the
 * poll would stop there and strand the card on sizes that no longer describe
 * the database.
 *
 * Stopping on success is equally load-bearing in the other direction: this
 * endpoint runs full-table scans, so a completed measurement must never
 * re-trigger one on a timer.
 */
export function storageUsageRefetchInterval(
	status: "pending" | "error" | "success",
): number | false {
	return status === "success" ? false : STORAGE_USAGE_POLL_MS;
}

/**
 * Per-data-type storage usage for the retention settings card. The server
 * caches the (scan-backed) measurement for a few minutes, so we mirror that
 * with a 5-minute staleTime once a value has landed.
 *
 * Getting the FIRST value is the hard part, and this query needs its own
 * cadence rather than the app-wide defaults from App.tsx. After a restart the
 * scan runs cold over the whole database (minutes on a multi-GB file), well
 * past the 60s client timeout in `api.getStorageUsage`, so early attempts time
 * out while the server keeps scanning behind them. Under the inherited
 * defaults a failing read can chain up to three 60s timeouts before the 30s
 * interval gets a turn — ticks that land mid-fetch coalesce onto the fetch
 * already running — which stretches the gap between attempts to minutes while
 * the card sits on "Measuring storage usage…".
 *
 * So: one attempt per cycle, retried on a tight interval. The server dedups
 * concurrent callers onto one in-flight scan and caches the result, so a poll
 * already in flight when the scan lands returns it immediately, and one that
 * is not starts at most 15s later.
 */
export const useStorageUsage = () => {
	return useQuery({
		queryKey: queryKeys.storageUsage(),
		queryFn: () => api.getStorageUsage(),
		staleTime: 5 * 60_000,
		// One attempt per cycle; the poll below is the retry mechanism.
		retry: false,
		refetchInterval: (query) => storageUsageRefetchInterval(query.state.status),
		// Deliberately not polling a hidden tab: this endpoint runs full-table
		// scans, and nothing is waiting to read them while the tab is away.
		refetchIntervalInBackground: false,
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
 * Per-API-key quota runway, computed server-side.
 *
 * Polled on the same cadence as the accounts read it replaced as the runway's
 * source, because it describes the same live quota state. The response carries
 * the account names the runway surfaces need, so those surfaces gate on THIS
 * query alone — a failing `/api/accounts` must not blank the runway.
 */
export const useRunway = () => {
	return useQuery({
		queryKey: queryKeys.runway(),
		queryFn: () => api.getRunway(),
		staleTime: 20000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		gcTime: 5 * 60 * 1000,
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

// The wire type verbatim. A hand-written local copy used to drop the routing-pin
// fields the endpoint has always sent, which made per-key capacity projection
// impossible to write against this hook.
interface ApiKeysListResponse {
	success: boolean;
	data: ApiKeyResponse[];
	count: number;
}

/**
 * The one `/api/api-keys` fetcher. Exported because ApiKeysTab keeps its own
 * observer (it suspends the request while the generated-key dialog is up) yet
 * shares `queryKeys.apiKeys()`: one cache key with two hand-written queryFns
 * would let whichever observer fetched first decide the cached SHAPE, so the
 * other reader silently gets something it cannot parse.
 */
export async function fetchApiKeys(): Promise<ApiKeyResponse[]> {
	const res = await api.get<ApiKeysListResponse>("/api/api-keys");
	return res.data ?? [];
}

export const useApiKeys = () => {
	return useQuery({
		queryKey: queryKeys.apiKeys(),
		queryFn: fetchApiKeys,
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
		retry: shouldRetryDashboardQuery,
	});
};

/**
 * Analytics query.
 *
 * `sections` scopes the SERVER to the query phases this caller renders — the
 * dominant cost of the endpoint. Omitting it computes everything, which is only
 * appropriate for a caller that genuinely reads everything. The list is
 * canonicalized once so it can key the cache and the request identically.
 */
export const useAnalytics = (
	timeRange: string,
	filters: {
		accounts?: string[];
		models?: string[];
		apiKeys?: string[];
		projects?: string[];
		noAccount?: boolean;
		noProject?: boolean;
		status?: "all" | "success" | "error";
	},
	viewMode: "normal" | "cumulative",
	modelBreakdown?: boolean,
	options?: { enabled?: boolean; sections?: readonly AnalyticsSection[] },
) => {
	const sections = options?.sections
		? canonicalSections(options.sections)
		: undefined;
	const logger = {
		debug: (message: string, ...args: unknown[]) => {
			console.debug(`[Analytics Query] ${message}`, ...args);
		},
		error: (message: string, ...args: unknown[]) => {
			console.error(`[Analytics Query] ${message}`, ...args);
		},
	};

	return useQuery({
		queryKey: queryKeys.analytics(
			timeRange,
			filters,
			viewMode,
			modelBreakdown,
			sections,
		),
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
					sections,
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
			const willRetry = shouldRetryDashboardQuery(failureCount, error);
			logger.debug(`Analytics query retry attempt ${failureCount + 1}`, {
				error: error instanceof Error ? error.message : String(error),
				willRetry,
				timestamp: new Date().toISOString(),
			});
			return willRetry;
		},
	});
};

/**
 * Options for the analytics filter dropdowns.
 *
 * Replaces accumulating them from whatever the analytics breakdowns returned:
 * those are truncated to the top N models/projects and only cover the sub-tabs
 * the user has opened, so the long tail was silently unselectable and the
 * dropdown contents depended on browsing history.
 *
 * Slow-moving (a new model or project appears rarely), and the server caches it
 * for 5 minutes, so this mirrors that with a long staleTime and no polling.
 */
export const useAnalyticsFilterOptions = () => {
	return useQuery({
		queryKey: queryKeys.analyticsFilterOptions(),
		queryFn: () => api.getAnalyticsFilterOptions(),
		staleTime: 5 * 60_000,
		retry: shouldRetryDashboardQuery,
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
		retry: shouldRetryDashboardQuery,
	});
};

/**
 * Precomputed quota-drift analysis for the Analytics "Quota" tab.
 *
 * The server recomputes it every 30 minutes, so polling faster would only
 * re-fetch the same blob: 5-minute staleness, 5-minute refetch, paused in the
 * background. `status: "computing"` is a normal answer (no pass has completed
 * yet), not an error, so it is left to the panels to render rather than retried.
 */
export const useQuotaDrift = () => {
	return useQuery({
		queryKey: queryKeys.quotaDrift(),
		queryFn: () => api.getQuotaDrift(),
		staleTime: 5 * 60_000,
		refetchInterval: 5 * 60_000,
		refetchIntervalInBackground: false,
		retry: shouldRetryDashboardQuery,
	});
};

/**
 * Process memory footprint (RSS + JS heap) time-series, feeding the System
 * Health page's "Memory Usage" chart and the Overview health strip's RSS
 * sparkline. Keyed by range, so the two share a cache entry only when the
 * chart's selector happens to sit on the sparkline's 24h window. Same polling
 * cadence as useUsageHistory (45s stale, 60s refetch, paused in the background)
 * since both feed time-series charts.
 */
export const useMemoryHistory = (range: string) => {
	return useQuery({
		queryKey: queryKeys.memoryHistory(range),
		queryFn: () => api.getMemoryHistory(range),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		retry: shouldRetryDashboardQuery,
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
		retry: shouldRetryDashboardQuery,
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
			invalidateCapacityQueries(queryClient);
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
			invalidateCapacityQueries(queryClient);
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
 * One request resolved by id.
 *
 * Only for the deep link from Live Activity, whose target is regularly outside
 * the slice the list view has loaded. Callers pass `null` whenever the row is
 * already in that slice, which disables the query entirely — an ordinary row
 * click therefore issues no extra request.
 *
 * `refetchInterval: false` is explicit: without it the query inherits the
 * app-wide `REFRESH_INTERVALS.default` from App.tsx and polls for as long as
 * the details modal stays open. A recorded request never changes.
 *
 * The two results have opposite staleness, which is why `staleTime` is a
 * function of the data. A summary is immutable, so it never needs looking up
 * again. `null` is not an answer but a "not recorded YET": the request was
 * still in flight when we asked, and caching that for the whole `gcTime` would
 * leave a reader who navigated away and back stuck on the not-recorded notice
 * with no lookup running even though the row now exists. `refetchOnMount` is
 * spelled out for the same reason — remounting the tab is exactly when that
 * second look has to happen.
 */
export const useRequestById = (id: string | null) => {
	return useQuery({
		queryKey: queryKeys.requestById(id ?? ""),
		queryFn: () => api.getRequestById(id as string),
		enabled: id !== null,
		staleTime: (query) => (query.state.data == null ? 0 : Infinity),
		refetchOnMount: true,
		gcTime: 5 * 60 * 1000,
		refetchInterval: false,
		retry: shouldRetryDashboardQuery,
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

/**
 * Log history backfills the live SSE stream ONCE per mount; it is not a polled
 * resource. Without these options the query inherits the app-wide
 * `refetchInterval` (App.tsx), and each refetch hands LogsTab a fresh array
 * that would replace the live tail with the interval's snapshot.
 *
 * Two things the naive "never refetch" version got wrong, both because the
 * stream has NO REPLAY — anything missed is missed for good:
 *  - a cached snapshot must not survive unmount (`gcTime: 0`). With
 *    `staleTime: Infinity` a remount would hydrate the old snapshot, consider
 *    it fresh, and never fetch, so every line emitted while the tab was away
 *    would be absent for the whole mount.
 *  - a FAILED load must keep retrying. LogsTab renders its error branch ahead
 *    of the log list, so a stuck error hides live lines that are arriving
 *    perfectly well.
 */
export const logHistoryQueryOptions = {
	refetchInterval: (query: { state: { status: string } }) =>
		query.state.status === "error" ? 30_000 : false,
	refetchOnWindowFocus: false,
	staleTime: Infinity,
	gcTime: 0,
} as const;

export const useLogHistory = () => {
	return useQuery({
		queryKey: queryKeys.logHistory(),
		queryFn: () => api.getLogHistory(),
		...logHistoryQueryOptions,
	});
};

// Mutations
export const useRemoveAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			accountId,
			confirmInput,
		}: {
			accountId: string;
			confirmInput: string;
		}) => api.removeAccount(accountId, confirmInput),
		onSuccess: () => {
			invalidateCapacityQueries(queryClient);
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
			invalidateCapacityQueries(queryClient);
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

/**
 * The model catalogue for one dialect, and the edits to it.
 *
 * Keyed by dialect: the two mounts are separate catalogues, and a shared key
 * would show the Anthropic list while the OpenAI tab was selected during the
 * first fetch after a switch. Every mutation invalidates only its own dialect,
 * because a write to one cannot change the other.
 */
export const useModelCatalog = (dialect: ModelDialect) => {
	return useQuery({
		queryKey: ["model-catalog", dialect],
		queryFn: () => api.getModelCatalog(dialect),
	});
};

export const useSetModelOverride = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: ModelOverrideSetRequest) =>
			api.setModelOverride(payload),
		onSuccess: (_result, payload) => {
			queryClient.invalidateQueries({
				queryKey: ["model-catalog", payload.dialect],
			});
		},
	});
};

export const useDeleteModelOverride = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: { dialect: ModelDialect; modelId: string }) =>
			api.deleteModelOverride(payload.dialect, payload.modelId),
		onSuccess: (_result, payload) => {
			queryClient.invalidateQueries({
				queryKey: ["model-catalog", payload.dialect],
			});
		},
	});
};

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
		// Shared request shape — see the note on ApiClient.setRetention.
		mutationFn: (partial: RetentionSetRequest) => api.setRetention(partial),
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
		mutationFn: (body: {
			mode?: "off" | "static" | "dynamic";
			minTokens?: number;
			bridgeHours?: number;
			riskFactor?: number;
		}) => api.setCacheWarming(body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["cache-warming"] });
		},
	});
};

/**
 * Live cache-keepalive bridge gauges + cumulative-since-restart counters for the
 * Analytics-tab "Cache Keep-Alive" headline tiles. Read off the proxy singletons
 * on the main thread, so it's cheap — short staleness + a 15s poll like the
 * other live stat hooks. Paused in the background.
 */
export const useCacheKeepalive = () => {
	return useQuery({
		queryKey: queryKeys.cacheKeepalive(),
		queryFn: () => api.getCacheKeepalive(),
		staleTime: 10_000,
		refetchInterval: 15_000,
		refetchIntervalInBackground: false,
	});
};

/**
 * Bucketed cache-keepalive history for the "Cache Keep-Alive" chart. Same
 * polling cadence as useMemoryHistory (45s stale, 60s refetch, paused in the
 * background) since both feed time-series charts.
 */
export const useCacheKeepaliveHistory = (range: string) => {
	return useQuery({
		queryKey: queryKeys.cacheKeepaliveHistory(range),
		queryFn: () => api.getCacheKeepaliveHistory(range),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		retry: shouldRetryDashboardQuery,
	});
};

/**
 * Per-range cache-warming EFFECTIVENESS summary for the "Cache Keep-Alive
 * Effectiveness" panel. Same polling cadence as useCacheKeepaliveHistory (45s
 * stale, 60s refetch, paused in the background).
 */
export const useCacheEffectiveness = (range: string) => {
	return useQuery({
		queryKey: queryKeys.cacheEffectiveness(range),
		queryFn: () => api.getCacheEffectiveness(range),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		retry: shouldRetryDashboardQuery,
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
			invalidateCapacityQueries(queryClient);
		},
	});
};

/**
 * Path-to-project rules plus the recently-unmatched working directories.
 *
 * The unmatched list is live server state that changes with traffic rather
 * than with edits, so it is polled rather than left to invalidate-on-write —
 * an operator watching the card for "which layout is missing" should see a new
 * path appear without reloading.
 */
export const useProjectRules = () => {
	return useQuery({
		queryKey: ["project-rules"],
		queryFn: () => api.getProjectRules(),
		refetchInterval: 30000,
		refetchIntervalInBackground: false,
	});
};

export const useSetProjectRules = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (rules: ProjectRulesSetRequest) => api.setProjectRules(rules),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["project-rules"] });
			// Attribution changes what the project filter and the analytics
			// breakdown will report for NEW requests, so the lists the dashboard
			// already holds are stale the moment the rules change.
			queryClient.invalidateQueries({ queryKey: queryKeys.requestProjects() });
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
