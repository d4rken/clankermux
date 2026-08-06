/**
 * The Overview renders PROGRESSIVELY.
 *
 * It used to return a full-page skeleton until stats + analytics + accounts had
 * ALL resolved. `/api/analytics` for this page is dominated by one section
 * (activeSessions, ~3.9 s of a 3.8 s call on the live DB), so the Live Activity
 * card — which depends on none of those three queries; its data comes from the
 * request-event stream — was hidden for about four seconds on every visit.
 *
 * This renders the real OverviewTab against an EMPTY query cache: nothing has
 * resolved, so the tiles must be in their pending state while Live Activity is
 * already on the page.
 */
import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { canonicalSections } from "../lib/analytics-sections";
import { queryKeys } from "../lib/query-keys";
import { OVERVIEW_SECTIONS, OverviewTab } from "./OverviewTab";

/**
 * `retryOnMount: false` is what makes a seeded error state observable. With the
 * default, an observer mounting on a query that has never held data intends to
 * refetch, and React Query's optimistic result rewrites `error` back to
 * `pending` — the tiles would render as loading and the assertion below would
 * silently test nothing.
 */
function client(retryOnMount = true): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false, retryOnMount },
		},
	});
}

// MemoryRouter, not just the query provider: the health strip and the compact
// error list are <Link>s, which throw outside a router context.
function render(queryClient: QueryClient): string {
	return renderToStaticMarkup(
		<MemoryRouter>
			<QueryClientProvider client={queryClient}>
				<OverviewTab />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

/**
 * Marks a query as terminally failed with nothing cached — the "unavailable"
 * case. `setQueryData` cannot express this (it only seeds data), so the cache
 * entry is built and put straight into an error state.
 */
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

const analyticsKey = queryKeys.analytics(
	"6h",
	{ accounts: [], models: [], status: "all" },
	"normal",
	false,
	canonicalSections(OVERVIEW_SECTIONS),
);

describe("OverviewTab progressive render", () => {
	it("paints Live Activity while every metric tile is still pending", () => {
		const html = render(client());

		// The card the removed page-wide gate used to hide.
		expect(html).toContain("Live Activity");
		expect(html).toContain("Every request in the last");
		// Tiles are present but placeholdered, not gone and not zeroed.
		expect(html).toContain("Total Requests");
		expect(html).toContain("Active Sessions");
		expect(html).toContain("5h Pool");
		expect(html).toContain("animate-pulse");
	});

	it("does not present an unresolved read as a measured zero", () => {
		const html = render(client());

		// The old `?? 0` / `|| 0` fallbacks rendered a bold "0" in each tile.
		expect(html).not.toContain('class="text-2xl font-bold">0<');
		// ...and the pool tiles must not show a 0% pool for accounts never read.
		expect(html).not.toContain("0%");
	});

	it("says 'unavailable' rather than 0 when analytics fails outright", () => {
		const queryClient = client(false);
		seedError(queryClient, analyticsKey);

		const html = render(queryClient);

		expect(html).toContain("Request data unavailable");
		expect(html).toContain("Chart data unavailable");
		expect(html).not.toContain('class="text-2xl font-bold">0<');
		// Live Activity is unaffected by an analytics failure.
		expect(html).toContain("Live Activity");
	});

	it("says 'unavailable' rather than empty capacity when accounts fails outright", () => {
		const queryClient = client(false);
		seedError(queryClient, queryKeys.accounts());

		const html = render(queryClient);

		expect(html).toContain("Account data unavailable");
		// "—" for the headline, never a percentage nothing measured.
		expect(html).not.toContain("0%");
		expect(html).not.toContain("active)");
	});

	it("renders no error badge on the health strip while stats is pending", () => {
		// `null` there means "the count is UNKNOWN because the read failed"; using
		// it for an ordinary in-flight load would put that badge on every visit.
		const html = render(client());

		expect(html).not.toContain("errors unknown");
	});
});
