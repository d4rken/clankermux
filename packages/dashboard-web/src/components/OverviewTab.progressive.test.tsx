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
import type { RunwayResponse } from "@clankermux/types";
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
 * The markup of ONE metric tile, from its title to the start of the next card.
 *
 * Every zero assertion below has to be scoped this way. The page legitimately
 * renders zeros of its own — "0 active" in the Live Activity readout is a real
 * measurement of the request stream — so a document-wide "contains no zero"
 * check is either wrong or, as the checks this replaced were, pinned to a class
 * pair (`text-2xl font-bold`) that no longer exists and therefore passes
 * whatever the tiles render.
 */
function tile(markup: string, title: string): string {
	const at = markup.indexOf(`>${title}<`);
	if (at === -1) throw new Error(`no tile titled "${title}"`);
	const rest = markup.slice(at);
	const next = rest.indexOf("bg-card");
	return next === -1 ? rest : rest.slice(0, next);
}

/** The four tiles of the metrics grid, each of which speaks for its own read. */
const TILES = ["Total Requests", "5h Pool", "7d Pool", "Quota Runway"];

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

/**
 * A resolved `/api/runway` payload with one finite runway. `exhaustsAtMs` is
 * anchored far enough ahead that the tile's live countdown cannot cross it
 * while the test runs.
 */
function runwayResponse(): RunwayResponse {
	const now = Date.now();
	const HOUR = 60 * 60 * 1000;
	const DAY = 24 * HOUR;
	return {
		generatedAt: now,
		horizonMs: 14 * DAY,
		worstKeyId: "k1",
		keys: [
			{
				keyId: "k1",
				keyName: "prod",
				isActive: true,
				pin: { accountId: null, providers: null },
				eligibleAccountIds: ["acc-1", "acc-2"],
				outcome: {
					kind: "runway",
					exhaustsAtMs: now + 3 * DAY + 2 * HOUR,
					durationMs: 3 * DAY + 2 * HOUR,
					causes: [{ accountId: "acc-2", windowKind: "seven_day" }],
					unprojectableAccountIds: [],
				},
			},
		],
		accounts: [
			{
				id: "acc-1",
				name: "Primary",
				provider: "anthropic",
				metered: true,
				usageAsOfMs: now,
				windows: [],
			},
			{
				id: "acc-2",
				name: "Backup",
				provider: "anthropic",
				metered: true,
				usageAsOfMs: now,
				windows: [],
			},
		],
	};
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
		expect(html).toContain("7d Pool");
		expect(html).toContain("5h Pool");
		expect(html).toContain("animate-pulse");
	});

	it("does not present an unresolved read as a measured zero", () => {
		const html = render(client());

		// The old `?? 0` / `|| 0` fallbacks rendered a "0" in each tile. Checked
		// per tile, because the page elsewhere reports real zeros.
		for (const title of TILES) {
			expect(tile(html, title)).not.toContain(">0<");
		}
		// ...and the pool tiles must not show a 0% pool for accounts never read.
		expect(html).not.toContain("0%");
	});

	it("says 'unavailable' rather than 0 when analytics fails outright", () => {
		const queryClient = client(false);
		seedError(queryClient, analyticsKey);

		const html = render(queryClient);

		expect(html).toContain("Request data unavailable");
		expect(html).toContain("Chart data unavailable");
		// The tile that read analytics is the one that must not fall back to a
		// zero; the others are speaking for reads that did not fail.
		expect(tile(html, "Total Requests")).not.toContain(">0<");
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

	it("keeps the runway readable when the accounts read fails outright", () => {
		// The whole point of serving the runway with its own account block: the
		// tile speaks for /api/runway alone, so the read that blanks the two pool
		// tiles beside it must leave this one standing.
		const queryClient = client(false);
		seedError(queryClient, queryKeys.accounts());
		queryClient.setQueryData(queryKeys.runway(), runwayResponse());

		const html = render(queryClient);

		expect(html).toContain("Account data unavailable");
		expect(html).toContain("3d 2h");
		expect(html).toContain("Backup weekly");
		expect(html).not.toContain("Runway data unavailable");
	});

	it("says the runway is unavailable when its own read fails", () => {
		const queryClient = client(false);
		queryClient.setQueryData(queryKeys.accounts(), []);
		seedError(queryClient, queryKeys.runway());

		const html = render(queryClient);

		expect(html).toContain("Runway data unavailable");
		// The em-dash unavailable state, never a fabricated figure or a zero.
		expect(html).toContain("—");
		expect(html).not.toContain("∞");
		expect(tile(html, "Quota Runway")).not.toContain(">0<");
	});

	it("renders no error badge on the health strip while stats is pending", () => {
		// `null` there means "the count is UNKNOWN because the read failed"; using
		// it for an ordinary in-flight load would put that badge on every visit.
		const html = render(client());

		expect(html).not.toContain("errors unknown");
	});
});
