/**
 * The Stops card on Projects & Reliability.
 *
 * Two properties are worth pinning. It is FILTER-SCOPED: the card reads a cache
 * entry keyed on the tab's filter selection, so a payload fetched under a
 * different selection must not be shown under this one — that is the whole
 * mechanism by which the card and the panels around it describe the same
 * requests. And it speaks for its OWN read: a failing stops query blanks this
 * card and leaves the Routing and Tool-errors panels standing.
 */
import { describe, expect, it } from "bun:test";
import type { StopsHistoryResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { queryKeys } from "../../../lib/query-keys";
import { EMPTY_FILTERS, type FilterState } from "../AnalyticsFilters";
import { ProjectsReliabilityTab } from "./ProjectsReliabilityTab";

const RANGE = "7d" as const;
const FILTERS: FilterState = { ...EMPTY_FILTERS, apiKeys: ["k1"] };

/**
 * `retryOnMount: false` is what makes a seeded error state observable: with the
 * default, an observer mounting on a query that has never held data intends to
 * refetch and React Query rewrites `error` back to `pending`.
 */
function client(retryOnMount = true): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false, retryOnMount },
		},
	});
}

/** Marks a query as terminally failed with nothing cached. */
function seedError(queryClient: QueryClient, key: readonly unknown[]): void {
	queryClient
		.getQueryCache()
		.build(queryClient, { queryKey: key as unknown[] })
		.setState({
			status: "error",
			error: new Error("read failed"),
			fetchStatus: "idle",
			data: undefined,
			dataUpdatedAt: 0,
			errorUpdatedAt: Date.now(),
		});
}

/** A resolved `/api/analytics/stops-history` payload with one blocked cause. */
function stopsResponse(): StopsHistoryResponse {
	const now = Date.now();
	const HOUR = 60 * 60 * 1000;
	return {
		range: RANGE,
		bucketMs: HOUR,
		windowStartsAt: now - 7 * 24 * HOUR,
		windowEndsAt: now,
		totalRequests: 500,
		blockedRequests: 7,
		causes: [
			{
				cause: "pool_quota_exhausted",
				count: 7,
				firstSeenMs: now - 3 * HOUR,
				lastSeenMs: now - HOUR,
				topRequestedModel: "gpt-5.2-codex",
				topRequestedModelCount: 7,
				sampleErrorMessage: "all_accounts_failed",
				series: [{ ts: now - HOUR, count: 7 }],
			},
		],
		candidates: {
			observedRequests: 500,
			zeroCandidateRequests: 7,
			distribution: [
				{ candidatesCount: 0, requests: 7 },
				{ candidatesCount: 2, requests: 493 },
			],
		},
	};
}

function render(queryClient: QueryClient, filters: FilterState): string {
	return renderToStaticMarkup(
		<MemoryRouter>
			<QueryClientProvider client={queryClient}>
				<ProjectsReliabilityTab
					filters={filters}
					setFilters={() => {}}
					availableAccounts={[]}
					availableModels={[]}
					availableApiKeys={[]}
					availableProjects={[]}
					hasNoAccountBucket={false}
					hasNoProjectBucket={false}
					activeFilterCount={filters.apiKeys.length}
					filterOpen={false}
					setFilterOpen={() => {}}
					range={RANGE}
					onRangeChange={() => {}}
				/>
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe("ProjectsReliabilityTab stops card", () => {
	it("renders the stops read seeded under the tab's OWN filter selection", () => {
		const queryClient = client(false);
		queryClient.setQueryData(
			queryKeys.stopsHistory(RANGE, FILTERS),
			stopsResponse(),
		);

		const html = render(queryClient, FILTERS);

		expect(html).toContain("Stops");
		expect(html).toContain("7 of 500 requests blocked");
		expect(html).toContain("Pool quota exhausted");
	});

	it("does not show another selection's numbers under these filters", () => {
		// A different filter set is a different measurement and therefore a
		// different cache entry. Reading the unfiltered one here would present
		// figures for requests the panel excluded.
		const queryClient = client(false);
		queryClient.setQueryData(
			queryKeys.stopsHistory(RANGE, EMPTY_FILTERS),
			stopsResponse(),
		);

		const html = render(queryClient, FILTERS);

		expect(html).toContain("Stops");
		expect(html).not.toContain("requests blocked");
	});

	it("blanks only the stops card when its own read fails", () => {
		const queryClient = client(false);
		seedError(queryClient, queryKeys.stopsHistory(RANGE, FILTERS));

		const html = render(queryClient, FILTERS);

		expect(html).toContain("Stops data unavailable");
		expect(html).not.toContain("requests blocked");
		// The neighbours speak for a read that did not fail; both render their
		// titles in their loading branch.
		expect(html).toContain("Routing");
		expect(html).toContain("Tool");
	});
});
