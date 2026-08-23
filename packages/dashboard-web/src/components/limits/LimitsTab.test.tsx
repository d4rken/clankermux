import { describe, expect, it } from "bun:test";
import type { AnalyticsResponse, RunwayResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { canonicalSections } from "../../lib/analytics-sections";
import { queryKeys } from "../../lib/query-keys";
import { LIMITS_SECTIONS, LimitsTab } from "./LimitsTab";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function client(retryOnMount = true): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false, retryOnMount },
		},
	});
}

function render(queryClient: QueryClient): string {
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<LimitsTab />
		</QueryClientProvider>,
	);
}

/** Terminally failed with nothing cached — what `setQueryData` cannot express. */
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
 * First fetch in flight with nothing cached. A static render runs no effects, so
 * a query left untouched sits at `fetchStatus: "idle"` and reads as unavailable
 * rather than loading; the in-flight state has to be built explicitly.
 */
function seedPending(queryClient: QueryClient, key: readonly unknown[]): void {
	queryClient
		.getQueryCache()
		.build(queryClient, { queryKey: key as unknown[] })
		.setState({
			status: "pending",
			fetchStatus: "fetching",
			data: undefined,
			dataUpdatedAt: 0,
		});
}

const analyticsKey = queryKeys.analytics(
	"7d",
	{ accounts: [], models: [], status: "all" },
	"normal",
	false,
	canonicalSections(LIMITS_SECTIONS),
);

function runwayResponse(): RunwayResponse {
	const now = Date.now();
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

describe("LimitsTab usage-history ranges", () => {
	it("starts the 5-hour graph at 24h and the weekly graph at 7d", () => {
		const queryClient = client();

		render(queryClient);

		expect(
			queryClient.getQueryCache().find({
				queryKey: queryKeys.usageHistory("24h"),
				exact: true,
			}),
		).toBeDefined();
		expect(
			queryClient.getQueryCache().find({
				queryKey: queryKeys.usageHistory("7d"),
				exact: true,
			}),
		).toBeDefined();
	});
});

describe("LimitsTab per-section gating", () => {
	it("shows a resolved runway while the accounts and analytics reads are still in flight", () => {
		// No page-wide skeleton: /api/analytics is the slowest read here, and a
		// cold load must not hide a runway that has already landed behind it.
		const queryClient = client();
		seedPending(queryClient, queryKeys.accounts());
		seedPending(queryClient, analyticsKey);
		queryClient.setQueryData(queryKeys.runway(), runwayResponse());

		const html = render(queryClient);

		expect(html).toContain("Quota runway");
		expect(html).toContain("3d 2h");
		expect(html).toContain("Backup weekly");
		expect(html).toContain("Runs out");
		// The sections that DO depend on those reads say so, rather than printing
		// a measured-looking zero.
		expect(html).toContain("Quota overview");
		expect(html).toContain("Reading accounts");
		expect(html).not.toContain("No reported account-wide average");
		expect(html).not.toContain("$0.00");
	});

	it("keeps the runway readable when the analytics read fails outright", () => {
		const queryClient = client(false);
		queryClient.setQueryData(queryKeys.accounts(), []);
		seedError(queryClient, analyticsKey);
		queryClient.setQueryData(queryKeys.runway(), runwayResponse());

		const html = render(queryClient);

		expect(html).toContain("3d 2h");
		expect(html).toContain("Runs out");
		expect(html).toContain("Account performance data unavailable");
		expect(html).not.toContain("Runway data unavailable");
		expect(html).not.toContain("$0.00");
	});

	it("keeps the runway readable when the accounts read fails outright", () => {
		// The runway response carries the account names its causes and pin labels
		// need, so the read that empties the two window panels beside it must not
		// empty this one.
		const queryClient = client(false);
		seedError(queryClient, queryKeys.accounts());
		queryClient.setQueryData(analyticsKey, {} as AnalyticsResponse);
		queryClient.setQueryData(queryKeys.runway(), runwayResponse());

		const html = render(queryClient);

		expect(html).toContain("3d 2h");
		expect(html).toContain("Backup weekly");
		expect(html).toContain("Runs out");
		expect(html).not.toContain("Runway data unavailable");
		// The two window panels beside it, and the utilization card below, are the
		// ones that go dark.
		expect(html).toContain("Account data unavailable");
		expect(html).not.toContain("No reported account-wide average");
		expect(html).not.toContain("No windowed accounts reporting usage yet.");
	});

	it("says the runway is unavailable when its own read fails", () => {
		const queryClient = client(false);
		queryClient.setQueryData(queryKeys.accounts(), []);
		queryClient.setQueryData(analyticsKey, {} as AnalyticsResponse);
		seedError(queryClient, queryKeys.runway());

		const html = render(queryClient);

		expect(html).toContain("Runway data unavailable");
		expect(html).toContain("Runway unknown");
		expect(html).not.toContain("∞");
		expect(html).not.toContain(">0<");
	});
});
