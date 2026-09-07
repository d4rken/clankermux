import { describe, expect, it } from "bun:test";
import type {
	AccountResponse,
	AnalyticsResponse,
	RunwayResponse,
	UsageHistoryResponse,
	UsageScopedHistoryResponse,
} from "@clankermux/types";
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

	it("does not claim usage history is still being collected while it is in flight", () => {
		// "Collecting data" asserts that no history EXISTS. With both window reads
		// pending on a cold load, a deployment with months of snapshots would be
		// told the opposite of the truth.
		const queryClient = client();
		seedPending(queryClient, queryKeys.usageHistory("24h"));
		seedPending(queryClient, queryKeys.usageHistory("7d"));
		queryClient.setQueryData(queryKeys.accounts(), []);
		queryClient.setQueryData(analyticsKey, {} as AnalyticsResponse);
		queryClient.setQueryData(queryKeys.runway(), runwayResponse());

		const html = render(queryClient);

		expect(html).toContain("Usage Over Time");
		expect(html).not.toContain("Collecting data");
		expect(html).not.toContain("Usage history unavailable");
	});

	it("says usage history is unavailable when its reads fail outright", () => {
		const queryClient = client(false);
		seedError(queryClient, queryKeys.usageHistory("24h"));
		seedError(queryClient, queryKeys.usageHistory("7d"));
		queryClient.setQueryData(queryKeys.accounts(), []);
		queryClient.setQueryData(analyticsKey, {} as AnalyticsResponse);
		queryClient.setQueryData(queryKeys.runway(), runwayResponse());

		const html = render(queryClient);

		expect(html).not.toContain("Collecting data");
		expect(html.match(/Usage history unavailable/g)).toHaveLength(2);
		// The runway beside it is unaffected.
		expect(html).toContain("3d 2h");
	});

	it("still says usage history is being collected once the reads resolve empty", () => {
		const queryClient = client();
		queryClient.setQueryData(queryKeys.usageHistory("24h"), {
			range: "24h",
			bucketMs: 60_000,
			series: [],
			pool: [],
		} as UsageHistoryResponse);
		queryClient.setQueryData(queryKeys.usageHistory("7d"), {
			range: "7d",
			bucketMs: 60_000,
			series: [],
			pool: [],
		} as UsageHistoryResponse);
		queryClient.setQueryData(queryKeys.accounts(), []);
		queryClient.setQueryData(analyticsKey, {} as AnalyticsResponse);
		queryClient.setQueryData(queryKeys.runway(), runwayResponse());

		const html = render(queryClient);

		expect(html.match(/Collecting data/g)).toHaveLength(2);
		expect(html).not.toContain("Usage history unavailable");
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

describe("LimitsTab per-family weekly panels", () => {
	const FABLE_PANEL = "Fable weekly window";

	function scopedAccount(): AccountResponse {
		return {
			id: "acc-1",
			name: "Primary",
			provider: "anthropic",
			usageData: {
				limits: [
					{
						kind: "weekly_scoped",
						group: "weekly",
						percent: 42,
						resets_at: new Date(Date.now() + 3 * DAY).toISOString(),
						scope: { model: { id: "fable", display_name: "Fable" } },
						is_active: true,
					},
				],
			},
		} as unknown as AccountResponse;
	}

	function scopedHistory(): UsageScopedHistoryResponse {
		return {
			range: "7d",
			bucketMs: HOUR,
			families: [
				{
					family: "fable",
					displayName: "Fable",
					series: [],
					pool: [],
				},
			],
		};
	}

	/** Everything the tab needs to render without any section claiming failure. */
	function seedBaseline(queryClient: QueryClient): void {
		queryClient.setQueryData(analyticsKey, {} as AnalyticsResponse);
		queryClient.setQueryData(queryKeys.runway(), runwayResponse());
		queryClient.setQueryData(queryKeys.usageHistory("24h"), {
			range: "24h",
			bucketMs: HOUR,
			series: [],
			pool: [],
		} as UsageHistoryResponse);
		queryClient.setQueryData(queryKeys.usageHistory("7d"), {
			range: "7d",
			bucketMs: HOUR,
			series: [],
			pool: [],
		} as UsageHistoryResponse);
	}

	it("renders a panel for a family the accounts report live", () => {
		const queryClient = client();
		seedBaseline(queryClient);
		queryClient.setQueryData(queryKeys.accounts(), [scopedAccount()]);
		queryClient.setQueryData(
			queryKeys.usageScopedHistory("7d"),
			scopedHistory(),
		);

		const html = render(queryClient);

		expect(html).toContain(FABLE_PANEL);
		expect(
			queryClient.getQueryCache().find({
				queryKey: queryKeys.usageScopedHistory("7d"),
				exact: true,
			}),
		).toBeDefined();
	});

	it("renders a recorded family even when no account reports it right now", () => {
		// Between a window's reset and the next poll the live payload carries no
		// scoped limit at all. The panel must not blink out.
		const queryClient = client();
		seedBaseline(queryClient);
		queryClient.setQueryData(queryKeys.accounts(), []);
		queryClient.setQueryData(
			queryKeys.usageScopedHistory("7d"),
			scopedHistory(),
		);

		const html = render(queryClient);

		expect(html).toContain(FABLE_PANEL);
	});

	it("renders only the two account-wide panels when there is no scoped window", () => {
		const queryClient = client();
		seedBaseline(queryClient);
		queryClient.setQueryData(queryKeys.accounts(), []);
		queryClient.setQueryData(queryKeys.usageScopedHistory("7d"), {
			range: "7d",
			bucketMs: HOUR,
			families: [],
		} as UsageScopedHistoryResponse);

		const html = render(queryClient);

		expect(html).not.toContain("weekly window");
		expect(html.match(/Collecting data/g)).toHaveLength(2);
	});

	it("does not claim a family has no history while its read is unresolved", () => {
		// "Collecting data" asserts that no history EXISTS, which an unresolved
		// read cannot support — the same rule the two account-wide panels follow.
		const queryClient = client();
		seedBaseline(queryClient);
		queryClient.setQueryData(queryKeys.accounts(), [scopedAccount()]);

		const html = render(queryClient);

		expect(html).toContain(FABLE_PANEL);
		// Only the two seeded-empty account-wide panels make that claim.
		expect(html.match(/Collecting data/g)).toHaveLength(2);
		expect(html).not.toContain("Usage history unavailable");
	});

	it("says the family history is unavailable when its read fails outright", () => {
		const queryClient = client(false);
		seedBaseline(queryClient);
		queryClient.setQueryData(queryKeys.accounts(), [scopedAccount()]);
		seedError(queryClient, queryKeys.usageScopedHistory("7d"));

		const html = render(queryClient);

		// The family is still discovered from the live accounts, and its panel
		// reports the failed read instead of claiming there is nothing recorded.
		expect(html).toContain(FABLE_PANEL);
		expect(html.match(/Usage history unavailable/g)).toHaveLength(1);
		expect(html.match(/Collecting data/g)).toHaveLength(2);
	});
});
