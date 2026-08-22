/**
 * Per-tile pending/unavailable states.
 *
 * The Overview no longer gates the whole page on one slow query, so every tile
 * now has to speak for its own source. Three claims must stay distinguishable:
 * a first fetch still in flight (skeleton), a terminal failure (an explicit
 * "unavailable", never a fallback zero), and real-but-stale numbers.
 */
import { describe, expect, it } from "bun:test";
import { Activity, Gauge } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PoolUsageResult } from "../../../lib/pool-usage";
import { ChartsSection } from "../ChartsSection";
import { MetricCard } from "../MetricCard";
import { PoolMetricCard } from "../PoolMetricCard";

const SUB_ROWS = [
	{ label: "Success rate", value: "97%" },
	{ label: "Cache hit", value: "42%" },
];

function metricCard(props: Partial<Parameters<typeof MetricCard>[0]> = {}) {
	return renderToStaticMarkup(
		<MetricCard
			title="Total Requests"
			value="12,345"
			change={12}
			trend="up"
			trendPeriod="previous 5 minutes"
			icon={Activity}
			subRows={SUB_ROWS}
			{...props}
		/>,
	);
}

describe("MetricCard loading", () => {
	it("hides the value, trend, stale note and sub-rows while pending", () => {
		const html = metricCard({
			loading: true,
			staleNote: "Last updated 3m ago",
		});

		expect(html).not.toContain("12,345");
		expect(html).not.toContain("12%");
		expect(html).not.toContain("Last updated 3m ago");
		expect(html).not.toContain("Success rate");
		expect(html).not.toContain("Cache hit");
		expect(html).not.toContain("97%");
		// A pending tile must not be mistaken for a resolved zero either.
		expect(html).not.toContain(">0<");
		expect(html).toContain("animate-pulse");
	});

	it("keeps the icon, title and caption so the grid does not reflow", () => {
		const html = metricCard({ loading: true, caption: "· last 5m" });

		expect(html).toContain("Total Requests");
		expect(html).toContain("· last 5m");
	});

	it("lets a terminal failure win over loading", () => {
		// A read that FAILED must never be presented as "still loading".
		const html = metricCard({
			loading: true,
			unavailableReason: "Session data unavailable",
		});

		expect(html).toContain("Session data unavailable");
		expect(html).not.toContain("animate-pulse");
		expect(html).not.toContain("12,345");
	});

	it("renders value, trend and sub-rows once resolved", () => {
		const html = metricCard();

		expect(html).toContain("12,345");
		expect(html).toContain("Success rate");
		expect(html).not.toContain("animate-pulse");
	});
});

/** A pool with real numbers, so hiding them is observable. */
function poolResult(): PoolUsageResult {
	return {
		average: 61,
		activeAverage: 61,
		worst: { name: "alpha", pct: 61 },
		contributing: [
			{ name: "alpha", pct: 61 },
		] as PoolUsageResult["contributing"],
		exhausted: [],
		excluded: [],
		fallback: [],
		earliestResetMs: 1_700_000_000_000,
		earliestResetAccountName: "alpha",
		atRisk: [],
		familyWeekly: [],
	};
}

function poolCard(props: Partial<Parameters<typeof PoolMetricCard>[0]> = {}) {
	return renderToStaticMarkup(
		<PoolMetricCard
			title="5h Pool"
			icon={Gauge}
			result={poolResult()}
			window="five_hour"
			{...props}
		/>,
	);
}

describe("PoolMetricCard loading and unavailable", () => {
	it("renders the headline, chip and checkpoint line once resolved", () => {
		const html = poolCard();

		expect(html).toContain("61%");
		expect(html).toContain("1/1 active");
		expect(html).toContain("next checkpoint at");
	});

	it("hides the headline, chip, checkpoint line and inline details while pending", () => {
		// `computePoolUsage([], …)` returns an all-empty result that is
		// indistinguishable from "no accounts contribute", so a pending read must
		// not render a pool at all.
		const html = poolCard({ loading: true, inlineDetails: true });

		expect(html).not.toContain("61%");
		expect(html).not.toContain("active)");
		expect(html).not.toContain("next checkpoint at");
		expect(html).not.toContain("Pool usage");
		expect(html).toContain("animate-pulse");
	});

	it("says so explicitly when the accounts read failed", () => {
		const html = poolCard({
			unavailableReason: "Account data unavailable",
			inlineDetails: true,
		});

		expect(html).toContain("Account data unavailable");
		expect(html).not.toContain("61%");
		expect(html).not.toContain("active)");
		expect(html).not.toContain("next checkpoint at");
		expect(html).not.toContain("Pool usage");
		expect(html).not.toContain("animate-pulse");
	});

	it("ages the numbers when the latest accounts refresh failed", () => {
		// The quota percentages, next-checkpoint line and badges are all still
		// the last real reading, so they stay — but presenting them as current
		// alongside tiles that DO carry an age note is the claim to avoid.
		const html = poolCard({ staleNote: "Last updated 3m ago" });

		expect(html).toContain("Last updated 3m ago");
		expect(html).toContain("61%");
		expect(html).toContain("next checkpoint at");
	});

	it("does not age a tile that has no numbers yet", () => {
		expect(
			poolCard({ loading: true, staleNote: "Last updated 3m ago" }),
		).not.toContain("Last updated 3m ago");
		expect(
			poolCard({
				unavailableReason: "Account data unavailable",
				staleNote: "Last updated 3m ago",
			}),
		).not.toContain("Last updated 3m ago");
	});
});

describe("ChartsSection unavailable", () => {
	const props = {
		timeSeriesData: [],
		timeRange: "6h",
		modelData: [],
		accountModelUsageData: [],
		projectBreakdownData: [],
	};

	it("states the data is unavailable rather than drawing empty axes", () => {
		// Empty axes read as "no traffic in this range" — a measurement claim
		// nothing here actually made.
		const html = renderToStaticMarkup(
			<ChartsSection {...props} loading={false} unavailable={true} />,
		);

		expect(html).toContain("Chart data unavailable");
		// The card shells stay so the page keeps its shape.
		expect(html).toContain("Request Volume");
		expect(html).toContain("Usage by Project");
	});

	it("does not claim unavailability while still loading", () => {
		const html = renderToStaticMarkup(
			<ChartsSection {...props} loading={true} unavailable={false} />,
		);

		expect(html).not.toContain("Chart data unavailable");
	});
});
