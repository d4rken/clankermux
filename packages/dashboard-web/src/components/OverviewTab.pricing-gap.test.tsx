import { describe, expect, it } from "bun:test";
import type { PricingGap, SystemStatusResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../lib/query-keys";
import { OverviewTab } from "./OverviewTab";

/**
 * Wiring test: a unit test of the banner component proves it renders, not that
 * the Overview actually mounts it. This renders the real OverviewTab against a
 * pre-seeded query cache and asserts the gap reaches the page.
 */

const gap: PricingGap = {
	key: "9".repeat(64),
	fingerprint: "9".repeat(16),
	modelId: "claude-not-yet-priced-9",
	provider: "anthropic",
	reason: "model_missing",
	occurrences: 854,
	firstSeenAt: 1_700_000_000_000,
	lastSeenAt: 1_700_000_060_000,
};

function systemStatus(gaps: PricingGap[]): SystemStatusResponse {
	return {
		status: "ok",
		uptime_s: 120,
		memory: { rss_bytes: 1024, rss_mb: 1 },
		pool: {
			total: 1,
			routable: 1,
			paused: 0,
			rate_limited: 0,
			usage_exhausted: 0,
		} as SystemStatusResponse["pool"],
		runtime: {
			asyncWriterHealthy: true,
			integrityStatus: "ok",
			pricingGaps: gaps,
		},
		eventLoop: { lastLagMs: 0, maxLagMs: 0, maxRecentLagMs: 0 },
		strategy: "session",
		timestamp: new Date(1_700_000_060_000).toISOString(),
	};
}

/**
 * OverviewTab returns a loading skeleton until stats + analytics + accounts have
 * resolved, so all three have to be seeded for the banner to be reached at all.
 */
function renderOverview(gaps: PricingGap[]): string {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnMount: false } },
	});
	client.setQueryData(queryKeys.systemStatus(), systemStatus(gaps));
	client.setQueryData(queryKeys.stats(24), {
		totalRequests: 0,
		successRate: 0,
		activeAccounts: 0,
		avgResponseTime: 0,
		totalTokens: 0,
		activeSessions: { total: 0, claude: 0, codex: 0, other: 0, windowMs: 0 },
		recentErrors: [],
		topModels: [],
	});
	client.setQueryData(
		queryKeys.analytics(
			"6h",
			{ accounts: [], models: [], status: "all" },
			"normal",
			undefined,
		),
		{
			totals: {
				requests: 0,
				successRate: 0,
				activeAccounts: 0,
				avgResponseTime: 0,
				totalTokens: 0,
				totalCostUsd: 0,
				cacheHitRate: 0,
			},
			timeSeries: [],
			modelDistribution: [],
			accountPerformance: [],
			accountModelUsage: [],
			projectBreakdown: [],
			tokenBreakdown: {
				inputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
			},
			costByModel: [],
			modelPerformance: [],
		},
	);
	client.setQueryData(queryKeys.accounts(), []);

	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<OverviewTab />
		</QueryClientProvider>,
	);
}

describe("OverviewTab mounts the pricing-gap banner", () => {
	it("renders the gap reported by /api/system/status", () => {
		const html = renderOverview([gap]);

		expect(html).toContain("Requests recorded without pricing");
		expect(html).toContain("claude-not-yet-priced-9");
		expect(html).toContain("854");
	});

	it("renders no banner when the server reports no gaps", () => {
		const html = renderOverview([]);

		expect(html).not.toContain("Requests recorded without pricing");
	});
});
