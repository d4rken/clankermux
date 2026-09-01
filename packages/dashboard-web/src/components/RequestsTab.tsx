import { HttpError } from "@clankermux/http-common";
import {
	formatBytes,
	formatCost,
	formatDuration,
	formatReasoningEffort,
	formatTokens,
	formatTokensPerSecond,
} from "@clankermux/ui-common";
import {
	Calendar,
	ChevronDown,
	Clock,
	Eye,
	Filter,
	Folder,
	Hash,
	Key,
	Paperclip,
	RefreshCw,
	User,
	X,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api, type RequestPayload, type RequestSummary } from "../api";
import { API_LIMITS } from "../constants";
import {
	summaryToPlaceholder,
	toDetailsMap,
	useAccounts,
	useApiKeys,
	useInfiniteRequests,
	useRequestById,
	useRequestProjects,
	useRequests,
	useRequestsCount,
} from "../hooks/queries";
import { useRequestStream } from "../hooks/useRequestStream";
import { decodeBase64Utf8 } from "../lib/base64";
import {
	hasAttributionMetadata,
	projectAttributionChip,
	resolveProjectAttributionSource,
} from "../lib/project-attribution";
import {
	buildRequestQueryParams,
	isRequestFilterActive,
	mergeStatusCodes,
	presetRange,
	type RequestFilterState,
	type StatusCategory,
} from "../lib/request-filters";
import { getRequestModelPresentation } from "../lib/request-model";
import { isRowActivationClick } from "../lib/row-activation";
import { cn } from "../lib/utils";
import { isZaiPeakHour } from "../utils/provider-utils";
import { CopyButton } from "./CopyButton";
import { RequestDetailsModal } from "./RequestDetailsModal";
import { Alert } from "./ui/alert";
import { Badge, badgeVariants } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { InsetPanel } from "./ui/inset-panel";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
import { Skeleton } from "./ui/skeleton";

/**
 * Styling for the cost chip in the requests list, keyed off the request's
 * server-derived billing type. Pure and exported so it can be unit-tested
 * without mounting the tab (mirrors `describePinTarget` in ApiKeysTab):
 *   - "overage" / "api" -> orange (the request costs real per-token money)
 *   - "plan"            -> neutral (covered by the subscription plan)
 *   - null / unknown    -> neutral, no title (billing not determined)
 * The title keeps the billing information discoverable now that the
 * standalone Plan/Overage badges are gone.
 */
export function costBadgeProps(billingType: string | null | undefined): {
	className: string;
	title: string | undefined;
} {
	if (billingType === "overage" || billingType === "api") {
		return {
			className: "text-xs border-warning text-warning-strong",
			title: "Pay-per-token",
		};
	}
	return {
		className: "text-xs",
		title: billingType === "plan" ? "Covered by plan" : undefined,
	};
}

/**
 * One dismissible chip in the active-filters bar.
 *
 * Six byte-identical copies of this markup sat inline, which also meant six
 * copies of the off-scale `p-0.5` on the clear button — a deliberate hairline
 * hit-area pad that would read as sloppiness repeated six times and as an
 * intentional exception once.
 */
function FilterChip({
	icon,
	label,
	onClear,
}: {
	icon: ReactNode;
	label: ReactNode;
	onClear: () => void;
}) {
	return (
		<Badge variant="outline" className="gap-item pr-1">
			{icon}
			{label}
			<button
				type="button"
				onClick={onClear}
				className="ml-tight p-0.5 hover:bg-destructive/20 rounded"
			>
				<X className="h-3 w-3" />
			</button>
		</Badge>
	);
}

/**
 * Stable keys for the request-list loading skeleton.
 *
 * Six, not "about eight": the count is fixed so the loading list and the
 * loaded list occupy the same box, and so QA can measure one against the other
 * with the stub returning exactly six rows.
 *
 * `h-[6.75rem]` (108px) is measured, not derived: with six rows loaded the list
 * box is 688px, which over six rows minus the five 8px `space-y-item` gaps is
 * (688 - 40) / 6 = 108px per row.
 *
 * The class-level parts of a card account for about 100px of that, over all
 * THREE content rows it renders: a 1px border top and bottom (2), row 1
 * "where" at `py-1.5` around a `h-7` icon button (28 + 12 = 40), row 2
 * "attribution" at `pb-1.5` around a badge whose `py-0.5` + border sit on a
 * `text-xs` 1rem line box (22 + 6 = 28), and row 3 "outcome" at `pb-item`
 * around that same 22px badge (22 + 8 = 30). The remaining ~8px is not
 * explained by that breakdown; a card that also renders the error line is
 * taller still (+24), so the constant tracks the measured height of a real
 * list rather than a per-part sum. Re-measure it in a browser when the card
 * markup changes instead of recomputing it from classes.
 *
 * The value this replaced counted only two of the three content rows and came
 * out at 72px, which is why the route still jumped 216px when the list loaded.
 */
const REQUEST_SKELETON_ROWS = [
	"row-1",
	"row-2",
	"row-3",
	"row-4",
	"row-5",
	"row-6",
] as const;

/**
 * Option values for the name-valued filter dropdowns.
 *
 * Radix `Select` needs a non-empty string per item, so the widget cannot avoid
 * sentinels — but a bare "all" or "no-project" is confusable with a project or
 * key genuinely called that. Real names are therefore namespaced under a `v:`
 * prefix, which no unprefixed sentinel can collide with.
 */
const SELECT_ALL = "all";
const SELECT_NONE = "none";
const SELECT_NAME_PREFIX = "v:";

/** What a name-valued filter is currently selecting. */
interface NameSelection {
	/** Literal name, or null when no name is selected. */
	name: string | null;
	/** The "recorded without one" bucket. */
	none: boolean;
}

/** Selection -> the `Select` option value that represents it. */
export function nameSelectValue(selection: NameSelection): string {
	if (selection.none) return SELECT_NONE;
	return selection.name === null
		? SELECT_ALL
		: `${SELECT_NAME_PREFIX}${selection.name}`;
}

/** Option value -> the selection it means. Inverse of {@link nameSelectValue}. */
export function decodeNameSelectValue(value: string): NameSelection {
	if (value === SELECT_NONE) return { name: null, none: true };
	if (value.startsWith(SELECT_NAME_PREFIX)) {
		return { name: value.slice(SELECT_NAME_PREFIX.length), none: false };
	}
	return { name: null, none: false };
}

export function RequestsTab() {
	// ── URL-addressable state ─────────────────────────────────────────────────
	// Only the project filter and the open request live in the URL: they are the
	// two things Live Activity links to. Every setter clones the current params
	// first, so none of them can drop a parameter it does not own.
	const [searchParams, setSearchParams] = useSearchParams();

	// Presence, not value. Reading "all" as "no filter" is exactly the bug this
	// avoids: a project can be named that, and then the link would show
	// everything instead of it.
	const noProjectFilter = searchParams.get("noProject") === "1";
	// Empty is no filter, exactly as `?request=` is no selection. Both
	// `requestQueryToSearchParams` and the server's `parseRequestFilters` drop an
	// empty name by truthiness, so keeping it as an active value would put the
	// page in the filtered explorer — SSE paused, "Filtered results" in the
	// header, an empty filter chip — over a completely unfiltered list.
	const projectFilter = noProjectFilter
		? null
		: searchParams.get("project") || null;

	const setProjectSelection = useCallback(
		(selection: NameSelection) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					// The two forms are mutually exclusive; leaving the other key
					// behind would let a stale one win on the next read.
					next.delete("project");
					next.delete("noProject");
					if (selection.none) next.set("noProject", "1");
					else if (selection.name !== null) next.set("project", selection.name);
					return next;
				},
				// Fiddling with the dropdown must not fill the history stack.
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	/** The open request, or null. Empty means no selection, not a request "". */
	const modalRequestId = searchParams.get("request") || null;

	// Opening PUSHES and closing REPLACES: Back then closes an open modal, and
	// a closed modal leaves no entry behind that Forward could reopen.
	const openRequest = useCallback(
		(id: string) => {
			setSearchParams((prev) => {
				const next = new URLSearchParams(prev);
				next.set("request", id);
				return next;
			});
		},
		[setSearchParams],
	);
	const closeRequest = useCallback(() => {
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("request");
				return next;
			},
			{ replace: true },
		);
	}, [setSearchParams]);

	const [statusCategory, setStatusCategory] = useState<StatusCategory>("all");
	const [accountFilter, setAccountFilter] = useState<string | null>(null);
	const [apiKeyFilter, setApiKeyFilter] = useState<string | null>(null);
	const [noApiKeyFilter, setNoApiKeyFilter] = useState(false);
	const [dateFrom, setDateFrom] = useState<string>("");
	const [dateTo, setDateTo] = useState<string>("");
	const [showFilters, setShowFilters] = useState(false);
	const [statusCodeFilters, setStatusCodeFilters] = useState<Set<string>>(
		new Set(),
	);

	// Resolve the filter form into a state object and the server query params.
	// When any filter is active the page switches from the live tail to a
	// server-side filtered + paginated "explorer" (see modes below).
	const filterState: RequestFilterState = useMemo(
		() => ({
			status: statusCategory,
			codes: Array.from(statusCodeFilters),
			account: accountFilter,
			apiKey: apiKeyFilter,
			noApiKey: noApiKeyFilter,
			project: projectFilter,
			noProject: noProjectFilter,
			from: dateFrom,
			to: dateTo,
		}),
		[
			statusCategory,
			statusCodeFilters,
			accountFilter,
			apiKeyFilter,
			noApiKeyFilter,
			projectFilter,
			noProjectFilter,
			dateFrom,
			dateTo,
		],
	);
	const filtersActive = isRequestFilterActive(filterState);
	const queryParams = useMemo(
		() => buildRequestQueryParams(filterState),
		[filterState],
	);

	// Mode A — live tail: latest N, real-time via SSE. Active when no filters.
	const liveQuery = useRequests(API_LIMITS.requestsDetail, {
		enabled: !filtersActive,
	});
	useRequestStream(API_LIMITS.requestsDetail, !filtersActive);

	// Mode B — filtered explorer: server-side WHERE + "Load more". Active when
	// any filter is set. SSE is paused so the result stays a stable snapshot.
	const filteredQuery = useInfiniteRequests(
		queryParams,
		API_LIMITS.requestsDetail,
		filtersActive,
	);
	const { data: totalMatching } = useRequestsCount(queryParams, filtersActive);

	const { data: accounts } = useAccounts();
	const { data: configuredApiKeys } = useApiKeys();
	const { data: knownProjects } = useRequestProjects();
	const zaiAccountNames = new Set(
		(accounts ?? []).filter((a) => a.provider === "zai").map((a) => a.name),
	);

	// Unify both modes into a single { requests, summaries } shape so the row
	// renderer below doesn't care which mode produced the data.
	const data = useMemo(() => {
		if (filtersActive) {
			const summariesArr = (filteredQuery.data?.pages ?? []).flat();
			const summaries = new Map<string, RequestSummary>(
				summariesArr.map((s) => [s.id, s]),
			);
			const requests = summariesArr.map(summaryToPlaceholder);
			return { requests, summaries };
		}
		if (!liveQuery.data) return null;
		const summaries = toDetailsMap<RequestSummary>(
			liveQuery.data.detailsMap as
				| Map<string, RequestSummary>
				| RequestSummary[],
		);
		return { requests: liveQuery.data.requests, summaries };
	}, [filtersActive, filteredQuery.data, liveQuery.data]);

	const requests = data?.requests ?? [];
	const loadedCount = requests.length;
	const loading = filtersActive ? filteredQuery.isLoading : liveQuery.isLoading;
	const error = filtersActive ? filteredQuery.error : liveQuery.error;
	const reload = () =>
		filtersActive ? filteredQuery.refetch() : liveQuery.refetch();
	const hasMore = filtersActive && Boolean(filteredQuery.hasNextPage);
	const isFetchingMore = filteredQuery.isFetchingNextPage;

	// ── Resolving the request named in the URL ────────────────────────────────
	// 1. In the loaded data: use it directly. This is every ordinary row click,
	//    and it issues no extra request.
	//
	//    BOTH collections are consulted, because they do not gain a request at
	//    the same moment. A request that was already in flight when this tab
	//    connected never gets a `start` event, so the stream reducer has no row
	//    to update when its `summary` arrives: the summary lands in the details
	//    map and the payload array stays without it. Searching only the array
	//    would leave a deep-linked in-flight request showing the
	//    "not recorded yet" notice forever, even after it completed — which is
	//    the primary case this deep link exists for.
	const loadedPayload = modalRequestId
		? (requests.find((request) => request.id === modalRequestId) ?? null)
		: null;
	const loadedSummary = modalRequestId
		? data?.summaries.get(modalRequestId)
		: undefined;
	// Memoized so the modal's hydration effect sees a stable request identity.
	const localRequest = useMemo(
		() =>
			loadedPayload ??
			(loadedSummary ? summaryToPlaceholder(loadedSummary) : null),
		[loadedPayload, loadedSummary],
	);
	// 2. Otherwise look it up by id. A deep link from Live Activity regularly
	//    names a request outside the slice: the live tail is the latest
	//    `API_LIMITS.requestsDetail` rows while the Live Activity window reaches
	//    30 minutes, and the modal reads its model, token, cost and attribution
	//    fields off the summary — without this they would all render empty.
	//    Held until the list query has settled: on a cold deep link the slice
	//    has not arrived yet, and firing immediately would fetch a row that is
	//    about to appear in it anyway.
	const byIdActive =
		modalRequestId !== null &&
		localRequest === null &&
		loadedSummary === undefined &&
		!loading;
	const byIdQuery = useRequestById(byIdActive ? modalRequestId : null);

	const modalSummary = loadedSummary ?? byIdQuery.data ?? undefined;
	// Memoized for the same reason as `localRequest` above.
	const byIdPlaceholder = useMemo(
		() => (byIdQuery.data ? summaryToPlaceholder(byIdQuery.data) : null),
		[byIdQuery.data],
	);
	const modalRequest = localRequest ?? (byIdActive ? byIdPlaceholder : null);

	// The by-id lookup's four states are kept distinct on purpose:
	//  - pending: nothing at all, so no header flashes an epoch-0 timestamp;
	//  - error: a durable failure, because the retry policy deliberately does
	//    not retry an HttpError — so it needs a Retry the reader can press;
	//  - success with no row: the COMMON case, not an error. An in-flight
	//    request has no database row until it completes, and Live Activity
	//    deliberately shows pending and streaming marks. No polling is added:
	//    a deep link carries no filters, so the tab is in live-tail mode with
	//    the SSE stream running, and the request lands in `data.summaries` on
	//    completion — which opens the modal through step 1 above.
	const byIdError = byIdActive ? byIdQuery.error : null;
	const byIdMissing =
		byIdActive && byIdQuery.isSuccess && byIdQuery.data === null;

	// Filter dropdown options come from dedicated endpoints (not from the loaded
	// requests slice) so every configured account/API key is selectable, even
	// when it doesn't appear in the most recent N requests.
	const uniqueAccounts = useMemo(() => {
		const fromConfig = (accounts ?? []).map((a) => a.name).filter(Boolean);
		const fromRequests = (data?.requests ?? [])
			.map((r) => r.meta.accountName || r.meta.accountId)
			.filter((v): v is string => Boolean(v));
		return Array.from(new Set([...fromConfig, ...fromRequests])).sort();
	}, [accounts, data]);

	// Status codes for the specific-code picker: the curated common set (so error
	// codes are always selectable even when the loaded rows are all 200s) unioned
	// with any codes actually observed in the current data.
	const statusCodeOptions = useMemo(() => {
		const observed = (data?.requests ?? [])
			.map((r) => r.response?.status)
			.filter((status): status is number => status !== undefined);
		return mergeStatusCodes(observed);
	}, [data]);

	// API key filter: union of all configured keys (from /api/api-keys) and any
	// keys observed in the loaded request slice (covers historical keys that
	// were deleted but still appear on past requests).
	const uniqueApiKeys = useMemo(() => {
		const fromConfig = (configuredApiKeys ?? []).map((k) => k.name);
		const fromRequests = data
			? Array.from(data.summaries.values())
					.map((s) => s.apiKeyName)
					.filter((v): v is string => Boolean(v))
			: [];
		return Array.from(new Set([...fromConfig, ...fromRequests])).sort();
	}, [configuredApiKeys, data]);

	// Project filter: union of every project seen across recorded requests (from
	// /api/requests/projects) and any projects observed in the loaded slice
	// (covers brand-new projects the cached endpoint result doesn't know yet).
	const uniqueProjects = useMemo(() => {
		const fromEndpoint = knownProjects ?? [];
		const fromRequests = data
			? Array.from(data.summaries.values())
					.map((s) => s.project)
					.filter((v): v is string => Boolean(v))
			: [];
		return Array.from(new Set([...fromEndpoint, ...fromRequests])).sort();
	}, [knownProjects, data]);

	// Date preset helpers — produce local-time datetime-local strings so the
	// values match what the inputs display (no UTC drift).
	const applyDatePreset = (preset: string) => {
		const range = presetRange(preset, new Date());
		if (!range) return;
		setDateFrom(range.from);
		setDateTo(range.to);
	};

	const toggleStatusCode = (code: string) => {
		setStatusCodeFilters((prev) => {
			const next = new Set(prev);
			if (next.has(code)) {
				next.delete(code);
			} else {
				next.add(code);
			}
			return next;
		});
	};

	const getStatusCodeColor = (code: number) => {
		if (code >= 200 && code < 300) return "text-success-strong";
		if (code >= 400 && code < 500) return "text-warning-strong";
		if (code >= 500) return "text-destructive-strong";
		return "text-muted-foreground";
	};

	const clearAllFilters = () => {
		setStatusCategory("all");
		setAccountFilter(null);
		setApiKeyFilter(null);
		setNoApiKeyFilter(false);
		setProjectSelection({ name: null, none: false });
		setDateFrom("");
		setDateTo("");
		setStatusCodeFilters(new Set());
	};

	const statusCategoryLabel = (cat: StatusCategory) =>
		cat === "success" ? "Successful" : "Errors";

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>Request History</CardTitle>
						<CardDescription>
							{filtersActive
								? "Filtered results · live updates paused"
								: `Live · latest ${API_LIMITS.requestsDetail} requests`}
						</CardDescription>
					</div>
					<div className="flex gap-item">
						<Button
							onClick={() => setShowFilters(!showFilters)}
							variant={showFilters ? "default" : "outline"}
							size="sm"
							className="relative"
						>
							<Filter className="h-4 w-4" />
							Filters
							{filtersActive && !showFilters && (
								<span className="absolute -top-1 -right-1 h-2 w-2 bg-primary rounded-full animate-pulse" />
							)}
						</Button>
						<Button onClick={() => reload()} variant="ghost" size="icon">
							<RefreshCw className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{error && (
					<Alert
						tone="destructive"
						className="mb-group"
						title={`Error: ${error instanceof Error ? error.message : String(error)}`}
					>
						{/* No `mt-2`: as Alert children this sits in the body wrapper,
						    which already supplies the offset. */}
						<Button onClick={() => reload()} variant="outline" size="sm">
							<RefreshCw className="h-4 w-4" />
							Retry
						</Button>
					</Alert>
				)}

				{/* A linked-to request that could not be looked up. Retryable by
				    hand because the dashboard retry policy deliberately does not
				    retry an HttpError — the server answered, so this state stays
				    until someone asks again. */}
				{byIdError != null && (
					<Alert
						tone="destructive"
						className="mb-group"
						title={`Could not load the linked request: ${
							byIdError instanceof Error ? byIdError.message : String(byIdError)
						}`}
					>
						<Button
							onClick={() => byIdQuery.refetch()}
							variant="outline"
							size="sm"
						>
							<RefreshCw className="h-4 w-4" />
							Retry
						</Button>
					</Alert>
				)}

				{/* Not an error: a request has no recorded row until it completes,
				    and Live Activity links in-flight marks on purpose. The live tail
				    is still running, so it opens by itself once the row lands.

				    Deliberately NOT an <Alert>: this is neutral information, and
				    Alert has no neutral tone — `info` would tint it blue and read as
				    a warning about something that is working as designed. */}
				{byIdMissing && (
					<div className="mb-group p-row rounded-lg border bg-muted/50">
						<p className="text-sm text-muted-foreground">
							That request has not been recorded yet — it may still be in
							flight. Its details will open here as soon as it completes.
						</p>
					</div>
				)}

				{/* Active Filters Display */}
				{filtersActive && (
					<InsetPanel className="mb-group">
						<div className="flex flex-wrap items-center gap-item">
							{statusCategory !== "all" && statusCodeFilters.size === 0 && (
								<FilterChip
									icon={<Hash className="h-3 w-3" />}
									label={statusCategoryLabel(statusCategory)}
									onClear={() => setStatusCategory("all")}
								/>
							)}
							{statusCodeFilters.size > 0 && (
								<FilterChip
									icon={<Hash className="h-3 w-3" />}
									label={Array.from(statusCodeFilters).join(", ")}
									onClear={() => setStatusCodeFilters(new Set())}
								/>
							)}
							{accountFilter !== null && (
								<FilterChip
									icon={<User className="h-3 w-3" />}
									label={accountFilter}
									onClear={() => setAccountFilter(null)}
								/>
							)}
							{(noApiKeyFilter || apiKeyFilter !== null) && (
								<FilterChip
									icon={<Hash className="h-3 w-3" />}
									label={noApiKeyFilter ? "No API Key" : apiKeyFilter}
									onClear={() => {
										setApiKeyFilter(null);
										setNoApiKeyFilter(false);
									}}
								/>
							)}
							{(noProjectFilter || projectFilter !== null) && (
								<FilterChip
									icon={<Folder className="h-3 w-3" />}
									label={noProjectFilter ? "No Project" : projectFilter}
									onClear={() =>
										setProjectSelection({ name: null, none: false })
									}
								/>
							)}
							{(dateFrom || dateTo) && (
								<FilterChip
									icon={<Calendar className="h-3 w-3" />}
									label={
										dateFrom && dateTo
											? "Custom range"
											: dateFrom
												? `From ${new Date(dateFrom).toLocaleDateString()}`
												: `Until ${new Date(dateTo).toLocaleDateString()}`
									}
									onClear={() => {
										setDateFrom("");
										setDateTo("");
									}}
								/>
							)}
							<div className="ml-auto flex items-center gap-item">
								<span className="text-xs text-muted-foreground">
									{totalMatching != null
										? `${loadedCount} of ${totalMatching} matching`
										: `${loadedCount} loaded`}
								</span>
								<Button
									variant="ghost"
									size="sm"
									onClick={clearAllFilters}
									className="h-7 text-xs"
								>
									Clear all
								</Button>
							</div>
						</div>
					</InsetPanel>
				)}

				{/* Filters Panel. InsetPanel supplies the surface step this panel
				    used to lack — it carried `bg-card` INSIDE the tab's own Card, so
				    it read as a bare border with no surface behind it. Its own
				    `px-row py-item` is sized for definition rows, hence the `p-0`
				    override and the explicit padding on the two inner blocks. */}
				{showFilters && (
					<InsetPanel className="mb-section p-0">
						<div className="p-group border-b">
							<div className="flex items-center justify-between">
								<h3 className="display-face font-medium">Filters</h3>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setShowFilters(false)}
									className="h-8 w-8 p-0"
								>
									<X className="h-4 w-4" />
								</Button>
							</div>
						</div>

						<div className="p-group space-y-group">
							{/* Time Range Section */}
							<div>
								<h4 className="display-face text-sm font-medium mb-row flex items-center gap-item">
									<Clock className="h-4 w-4" />
									Time Range
								</h4>
								<div className="flex flex-wrap gap-item mb-row">
									<Button
										variant={dateFrom || dateTo ? "outline" : "secondary"}
										size="sm"
										onClick={() => applyDatePreset("1h")}
									>
										Last hour
									</Button>
									<Button
										variant={dateFrom || dateTo ? "outline" : "secondary"}
										size="sm"
										onClick={() => applyDatePreset("24h")}
									>
										Last 24h
									</Button>
									<Button
										variant={dateFrom || dateTo ? "outline" : "secondary"}
										size="sm"
										onClick={() => applyDatePreset("7d")}
									>
										Last 7 days
									</Button>
									<Button
										variant={dateFrom || dateTo ? "outline" : "secondary"}
										size="sm"
										onClick={() => applyDatePreset("30d")}
									>
										Last 30 days
									</Button>
								</div>
								<div className="grid grid-cols-2 gap-row">
									<div>
										<Label htmlFor="date-from" className="text-xs">
											From
										</Label>
										<Input
											id="date-from"
											type="datetime-local"
											value={dateFrom}
											onChange={(e) => setDateFrom(e.target.value)}
											className="h-9 text-sm"
										/>
									</div>
									<div>
										<Label htmlFor="date-to" className="text-xs">
											To
										</Label>
										<Input
											id="date-to"
											type="datetime-local"
											value={dateTo}
											onChange={(e) => setDateTo(e.target.value)}
											className="h-9 text-sm"
										/>
									</div>
								</div>
							</div>

							<div className="h-px bg-border" />

							{/* Resource Filters */}
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-group">
								{/* Status Category */}
								<div>
									<Label className="text-xs flex items-center gap-tight mb-item">
										<Hash className="h-3 w-3" />
										Status
									</Label>
									<div className="flex h-9 rounded-md border overflow-hidden">
										{(["all", "success", "error"] as const).map((cat) => (
											<button
												key={cat}
												type="button"
												onClick={() => setStatusCategory(cat)}
												className={`flex-1 text-xs px-item border-r last:border-r-0 transition-colors ${
													statusCategory === cat
														? "bg-primary text-primary-foreground"
														: "hover:bg-accent"
												}`}
											>
												{cat === "all"
													? "All"
													: cat === "success"
														? "Success"
														: "Errors"}
											</button>
										))}
									</div>
								</div>

								{/* Status Code Filter */}
								<div>
									<Label className="text-xs flex items-center gap-tight mb-item">
										<Hash className="h-3 w-3" />
										Status Codes
									</Label>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="outline"
												className="h-9 w-full justify-between font-normal"
											>
												{statusCodeFilters.size > 0
													? `${statusCodeFilters.size} selected`
													: "All codes"}
												<ChevronDown className="h-4 w-4 opacity-50" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent className="w-56 max-h-64 overflow-y-auto">
											<div className="p-item">
												<div className="label-caps mb-item">
													Select status codes
												</div>
												{statusCodeOptions.map((code) => (
													<button
														key={code}
														type="button"
														className="flex items-center gap-item p-item hover:bg-accent rounded cursor-pointer w-full text-left"
														onClick={() => toggleStatusCode(code.toString())}
													>
														<div
															className={`w-4 h-4 border rounded-sm flex items-center justify-center ${
																statusCodeFilters.has(code.toString())
																	? "bg-primary border-primary"
																	: "border-input"
															}`}
														>
															{statusCodeFilters.has(code.toString()) && (
																<svg
																	className="w-3 h-3 text-primary-foreground"
																	fill="none"
																	viewBox="0 0 24 24"
																	stroke="currentColor"
																	aria-label="Selected"
																>
																	<title>Selected</title>
																	<path
																		strokeLinecap="round"
																		strokeLinejoin="round"
																		strokeWidth={3}
																		d="M5 13l4 4L19 7"
																	/>
																</svg>
															)}
														</div>
														<span
															className={`text-sm font-medium ${getStatusCodeColor(code)}`}
														>
															{code}
														</span>
													</button>
												))}
											</div>
											<div className="border-t p-item text-xs text-muted-foreground">
												Specific codes override the Status category.
											</div>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>

								{/* Account Filter */}
								<div>
									<Label className="text-xs flex items-center gap-tight mb-item">
										<User className="h-3 w-3" />
										Account
									</Label>
									{/* Namespaced values, like the API key and project selects: a
									    bare account name of "all" would otherwise be read back as
									    the any-account sentinel and silently show everything.
									    There is no "recorded without one" bucket for accounts, so
									    `none` is always false here. */}
									<Select
										value={nameSelectValue({
											name: accountFilter,
											none: false,
										})}
										onValueChange={(value) =>
											setAccountFilter(decodeNameSelectValue(value).name)
										}
									>
										<SelectTrigger className="h-9">
											<SelectValue placeholder="All accounts" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={SELECT_ALL}>All accounts</SelectItem>
											{uniqueAccounts.map((account) => (
												<SelectItem
													key={account}
													value={nameSelectValue({
														name: account,
														none: false,
													})}
												>
													{account}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								{/* API Key Filter */}
								<div>
									<Label className="text-xs flex items-center gap-tight mb-item">
										<Key className="h-3 w-3" />
										API Key
									</Label>
									<Select
										value={nameSelectValue({
											name: apiKeyFilter,
											none: noApiKeyFilter,
										})}
										onValueChange={(value) => {
											const next = decodeNameSelectValue(value);
											setApiKeyFilter(next.name);
											setNoApiKeyFilter(next.none);
										}}
									>
										<SelectTrigger className="h-9">
											<SelectValue placeholder="All API keys" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={SELECT_ALL}>All API keys</SelectItem>
											<SelectItem value={SELECT_NONE}>No API Key</SelectItem>
											{uniqueApiKeys.map((key) => (
												<SelectItem
													key={key}
													value={nameSelectValue({ name: key, none: false })}
												>
													{key}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								{/* Project Filter */}
								<div>
									<Label className="text-xs flex items-center gap-tight mb-item">
										<Folder className="h-3 w-3" />
										Project
									</Label>
									<Select
										value={nameSelectValue({
											name: projectFilter,
											none: noProjectFilter,
										})}
										onValueChange={(value) =>
											setProjectSelection(decodeNameSelectValue(value))
										}
									>
										<SelectTrigger className="h-9">
											<SelectValue placeholder="All projects" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={SELECT_ALL}>All projects</SelectItem>
											<SelectItem value={SELECT_NONE}>No Project</SelectItem>
											{uniqueProjects.map((project) => (
												<SelectItem
													key={project}
													value={nameSelectValue({
														name: project,
														none: false,
													})}
												>
													{project}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</div>
						</div>
					</InsetPanel>
				)}

				{loading && loadedCount === 0 ? (
					// A bare Skeleton has no role and no accessible text, so the
					// sr-only line carries the announcement the removed text line
					// used to carry. `role="status"` stays OFF the decorative blocks.
					<div
						data-slot="request-list"
						aria-busy="true"
						className="space-y-item"
					>
						<span className="sr-only" role="status">
							Loading requests
						</span>
						{REQUEST_SKELETON_ROWS.map((key) => (
							<Skeleton key={key} className="h-[6.75rem] w-full rounded-lg" />
						))}
					</div>
				) : !data || requests.length === 0 ? (
					<p className="text-muted-foreground">
						{filtersActive
							? "No requests match the selected filters"
							: "No requests found"}
					</p>
				) : (
					<div data-slot="request-list" className="space-y-item">
						{requests.map((request) => {
							const isError = request.error || !request.meta.success;
							const statusCode = request.response?.status;
							const summary = data?.summaries.get(request.id);
							const modelPresentation = getRequestModelPresentation(summary);
							const method = request.meta.method || summary?.method;
							const path = request.meta.path || summary?.path;
							const accountLabel =
								request.meta.accountName ||
								(request.meta.accountId
									? `${request.meta.accountId.slice(0, 8)}...`
									: null);
							// The default endpoint is noise — only surface unusual paths.
							const showPath = Boolean(path && path !== "/v1/messages");
							const retries = summary?.failoverAttempts ?? 0;
							// Hoisted as consts so the click-to-filter chips below capture a
							// narrowed string in their onClick closures.
							const apiKeyName = summary?.apiKeyName;
							const project = summary?.project;
							// Provenance of `project`. An ambiguous row has NO project, so this
							// must also gate the attribution row below — otherwise an anonymous
							// ambiguous request would never render its chip.
							const attributionSource = resolveProjectAttributionSource(
								summary?.projectAttributionSource,
								request.meta.projectAttributionSource,
							);
							const attributionChip = projectAttributionChip(attributionSource);
							// Tokens that weren't served from / written to the prompt cache.
							// Derived from totalTokens (not input+output) because OpenAI rows
							// count cached tokens inside inputTokens.
							const freshTokens =
								summary?.totalTokens != null
									? Math.max(
											0,
											summary.totalTokens -
												(summary.cacheReadInputTokens ?? 0) -
												(summary.cacheCreationInputTokens ?? 0),
										)
									: null;
							const isZaiPeak =
								zaiAccountNames.has(request.meta.accountName ?? "") &&
								isZaiPeakHour(request.meta.timestamp);
							const statusClass = isError
								? "bg-destructive/10 text-destructive-strong"
								: statusCode == null
									? ""
									: statusCode >= 200 && statusCode < 300
										? "bg-success/10 text-success-strong"
										: statusCode >= 400 && statusCode < 500
											? "bg-warning/10 text-warning-strong"
											: statusCode >= 500
												? "bg-destructive/10 text-destructive-strong"
												: "bg-muted text-muted-foreground";

							return (
								// The card delegates POINTER clicks only, so any dead space in it
								// opens the details modal. Keyboard and screen-reader users go
								// through the real <button> on row 1 below — giving the card a
								// role="button" instead would nest the action buttons and filter
								// chips inside a button role, which flattens them in the
								// accessibility tree and names the row after every badge it holds.
								// biome-ignore lint/a11y/noStaticElementInteractions: keyboard access is the row-1 button, not this delegate
								// biome-ignore lint/a11y/useKeyWithClickEvents: same — a key handler here would double up with that button
								<div
									key={request.id}
									onClick={(e) => {
										if (
											isRowActivationClick(
												e.target,
												e.currentTarget,
												window.getSelection(),
											)
										) {
											openRequest(request.id);
										}
									}}
									className={`border rounded-lg cursor-pointer transition-all duration-300 hover:bg-accent/40 ${
										isError ? "border-destructive/50" : "border-border"
									} ${request.meta.pending ? "animate-pulse opacity-70" : "opacity-100"}`}
								>
									{/* Row 1 "where": single line, never wraps — time, status,
									    method, unusual endpoint, account, retries, timing, id */}
									<div className="flex items-center gap-item px-row py-1.5">
										<button
											type="button"
											className="flex items-center gap-item min-w-0 flex-1 text-left cursor-pointer"
											onClick={() => openRequest(request.id)}
										>
											<span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0">
												{new Date(request.meta.timestamp).toLocaleTimeString(
													[],
													{ hour12: false, hourCycle: "h23" },
												)}
											</span>
											{statusCode != null && (
												<span
													className={`text-xs font-mono font-semibold tabular-nums px-1.5 py-0.5 rounded shrink-0 ${statusClass}`}
												>
													{statusCode}
												</span>
											)}
											{method && (
												<span className="text-xs font-semibold uppercase shrink-0">
													{method}
												</span>
											)}
											{showPath && (
												<span className="text-xs font-mono text-muted-foreground truncate min-w-0 flex-1">
													{path}
												</span>
											)}
											{accountLabel && (
												<span className="text-xs text-muted-foreground truncate min-w-0 max-w-[12rem]">
													via {accountLabel}
												</span>
											)}
											{/* Spacer keeps timing/id right-aligned when no path is shown */}
											{!showPath && <span className="flex-1" />}
											{retries > 0 && (
												<span className="text-xs text-muted-foreground border rounded px-1.5 py-0.5 shrink-0">
													{retries} {retries === 1 ? "retry" : "retries"}
												</span>
											)}
											{summary?.responseTimeMs != null && (
												<span
													className="text-xs font-mono tabular-nums text-muted-foreground shrink-0"
													title="Response time"
												>
													{formatDuration(summary.responseTimeMs)}
												</span>
											)}
											<span
												className="text-xs figure text-muted-foreground/70 shrink-0 hidden sm:inline"
												title={request.id}
											>
												{request.id.slice(0, 8)}
											</span>
										</button>

										{/* Action buttons stay outside the row-1 button so they never
										    get cut off by flex shrinking and have their own hit area.
										    `data-row-ignore` covers the gaps between them: a button
										    mid-copy is disabled and stops receiving pointer events, and
										    a click landing on this strip must not open the modal. */}
										<div
											data-row-ignore
											className="flex items-center gap-tight shrink-0"
										>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7"
												onClick={() => openRequest(request.id)}
												title="View Details"
											>
												<Eye className="h-4 w-4" />
											</Button>
											<CopyButton
												variant="ghost"
												size="icon"
												className="h-7 w-7"
												title="Copy as JSON"
												getValueAsync={async () => {
													let full = request;
													if (request.meta.bodiesOmitted) {
														try {
															full = await api.getRequestPayload(request.id);
														} catch (error) {
															// Historical synthetic rows deliberately had no
															// payload. Copy their summary placeholder rather
															// than turning a useful action into a 404.
															if (
																!(
																	error instanceof HttpError &&
																	error.status === 404
																)
															) {
																throw error;
															}
														}
													}
													const decoded: RequestPayload & {
														decoded?: true;
													} = {
														...full,
														request: full.request
															? {
																	...full.request,
																	body: full.request.body
																		? decodeBase64Utf8(full.request.body)
																		: null,
																}
															: full.request,
														response: full.response
															? {
																	...full.response,
																	body: full.response.body
																		? decodeBase64Utf8(full.response.body)
																		: null,
																}
															: null,
														decoded: true,
													};
													return JSON.stringify(decoded, null, 2);
												}}
											/>
										</div>
									</div>

									{/* Row 2 "attribution": wraps freely — who/what triggered the
									    request. Rows 2 and 3 share row 1's `px-3` left edge rather
									    than hanging indented under it: the indent they used to
									    carry lined up with nothing, since row 1 opens with a
									    variable-width timestamp and not a fixed gutter, so one
									    card read as three differently-aligned blocks. */}
									{hasAttributionMetadata({
										apiKeyName,
										project,
										comboName: summary?.comboName,
										source: attributionSource,
									}) && (
										<div className="flex flex-wrap items-center gap-item px-row pb-1.5 text-xs">
											{apiKeyName && (
												<button
													type="button"
													className={cn(
														badgeVariants({ variant: "outline" }),
														"text-xs cursor-pointer hover:bg-accent",
													)}
													onClick={() => {
														setApiKeyFilter(apiKeyName);
														setNoApiKeyFilter(false);
													}}
													title={`Filter by API key ${apiKeyName}`}
												>
													<Key className="h-3 w-3 mr-tight" />
													{apiKeyName}
												</button>
											)}
											{project && (
												<button
													type="button"
													className={cn(
														badgeVariants({ variant: "outline" }),
														"text-xs cursor-pointer hover:bg-accent",
													)}
													onClick={() => {
														setProjectSelection({ name: project, none: false });
													}}
													title={`Filter by project ${project}`}
												>
													<Folder className="h-3 w-3 mr-tight" />
													{project}
												</button>
											)}
											{attributionChip && (
												<Badge
													variant="outline"
													className="border-warning text-warning-strong"
													title={attributionChip.title}
												>
													{attributionChip.label}
												</Badge>
											)}
											{summary?.comboName && (
												<Badge
													variant="outline"
													className="border-info/60 text-info"
												>
													Combo: {summary.comboName}
												</Badge>
											)}
										</div>
									)}

									{/* Row 3 "what/outcome": wraps freely — model, usage, cost, flags */}
									{(modelPresentation ||
										summary?.reasoningEffort ||
										summary?.totalTokens != null ||
										(summary?.attachmentChars ?? 0) > 0 ||
										(summary?.tokensPerSecond ?? 0) > 0 ||
										(summary?.costUsd != null && summary.costUsd > 0) ||
										request.meta.rateLimited ||
										isZaiPeak) && (
										<div className="flex flex-wrap items-center gap-item px-row pb-item text-xs">
											{(modelPresentation || summary?.reasoningEffort) && (
												<Badge
													variant="secondary"
													title={
														modelPresentation?.requestedOnly
															? "Requested model; the provider did not report a served model"
															: undefined
													}
												>
													{[
														modelPresentation
															? `${modelPresentation.value}${modelPresentation.requestedOnly ? " · requested" : ""}`
															: null,
														summary?.reasoningEffort
															? formatReasoningEffort(summary.reasoningEffort)
															: null,
													]
														.filter(Boolean)
														.join(" · ")}
												</Badge>
											)}
											{summary?.totalTokens != null && (
												<Badge variant="outline">
													{formatTokens(summary.totalTokens)} tokens
													{freshTokens != null &&
													freshTokens !== summary.totalTokens
														? ` (${formatTokens(freshTokens)} fresh)`
														: ""}
												</Badge>
											)}
											{(summary?.attachmentChars ?? 0) > 0 && (
												<Badge
													variant="outline"
													title="Attached images/documents (decoded size)"
												>
													<Paperclip className="h-3 w-3 mr-tight" />
													{formatBytes(
														Math.round((summary?.attachmentChars ?? 0) * 0.75),
													)}
												</Badge>
											)}
											{summary?.tokensPerSecond != null &&
												summary.tokensPerSecond > 0 && (
													<Badge variant="secondary">
														{formatTokensPerSecond(
															summary.tokensPerSecond,
															summary.tokensPerSecondApproximate,
														)}
													</Badge>
												)}
											{summary?.costUsd != null && summary.costUsd > 0 && (
												<Badge
													variant="outline"
													{...costBadgeProps(summary.billingType)}
												>
													{formatCost(summary.costUsd)}
												</Badge>
											)}
											{request.meta.rateLimited && (
												<Badge variant="warning">Rate Limited</Badge>
											)}
											{isZaiPeak && (
												<Badge
													variant="outline"
													className="border-warning text-warning-strong"
												>
													Peak
												</Badge>
											)}
										</div>
									)}

									{request.error && (
										<div className="text-xs text-destructive-strong px-row pb-item break-words">
											Error: {request.error}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}

				{/* Load more / end-of-results — filtered explorer only */}
				{filtersActive && (hasMore || isFetchingMore) && (
					<div className="mt-group flex justify-center">
						<Button
							variant="outline"
							size="sm"
							onClick={() => filteredQuery.fetchNextPage()}
							disabled={isFetchingMore}
						>
							{isFetchingMore ? (
								<>
									<RefreshCw className="h-4 w-4 animate-spin" />
									Loading...
								</>
							) : (
								"Load more"
							)}
						</Button>
					</div>
				)}
				{filtersActive && !hasMore && loadedCount > 0 && (
					<p className="mt-group text-center text-xs text-muted-foreground">
						End of results
					</p>
				)}
			</CardContent>

			{modalRequest && (
				<RequestDetailsModal
					request={modalRequest}
					summary={modalSummary}
					isOpen={true}
					onClose={closeRequest}
				/>
			)}
		</Card>
	);
}
