import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FamilyWeeklyUsage, PoolUsageResult } from "../../lib/pool-usage";
import { LimitsCapacityOverview } from "./LimitsCapacityOverview";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

function poolResult(overrides: Partial<PoolUsageResult> = {}): PoolUsageResult {
	return {
		average: 34,
		activeAverage: 34,
		worst: { name: "alpha", pct: 48 },
		contributing: [
			{ name: "alpha", pct: 48, resetMs: NOW + 90 * 60_000 },
			{ name: "beta", pct: 20, resetMs: NOW + 3 * 60 * 60_000 },
		],
		exhausted: [],
		excluded: [],
		fallback: [],
		earliestResetMs: NOW + 90 * 60_000,
		earliestResetAccountName: "alpha",
		atRisk: [],
		familyWeekly: [],
		...overrides,
	};
}

function renderOverview(
	fiveHour = poolResult(),
	sevenDay = poolResult({
		average: 51,
		activeAverage: 51,
		worst: { name: "beta", pct: 62 },
	}),
) {
	return renderToStaticMarkup(
		<LimitsCapacityOverview
			fiveHour={fiveHour}
			sevenDay={sevenDay}
			now={NOW}
		/>,
	);
}

describe("LimitsCapacityOverview", () => {
	it("turns the two windows into comparable visual summaries", () => {
		const html = renderOverview();

		expect(html).toContain("Quota overview");
		expect(html).toContain("5-hour window");
		expect(html).toContain("7-day window");
		expect(html).toContain("34%");
		expect(html).toContain("51%");
		expect(html).toContain("Average quota used");
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="34"');
		expect(html).toContain("2 of 2 accounts");
		expect(html).toContain("in 1h 30m");
		expect(html).toContain("Next checkpoint");
		expect(html).toContain("On pace");
	});

	it("keeps the routing boundary and aggregation explanation close by", () => {
		const html = renderOverview();

		expect(html).toContain("polled quota state, not routing availability");
		expect(html).toContain('aria-label="About quota calculations"');
		expect(html).toContain("Full breakdown");
		expect(html).toContain('href="#account-utilization"');
	});

	it("surfaces only exceptional account and model-family states inline", () => {
		const family: FamilyWeeklyUsage = {
			family: "fable",
			label: "Fable",
			worstPct: 92,
			worstAccountName: "weekly-hot",
			earliestResetMs: NOW + 2 * 24 * 60 * 60_000,
			elevated: true,
			exhaustedCount: 0,
			elevatedCount: 1,
			accounts: [
				{
					name: "weekly-hot",
					pct: 92,
					resetMs: NOW + 2 * 24 * 60 * 60_000,
				},
			],
		};
		const sevenDay = poolResult({
			average: 74,
			activeAverage: 74,
			atRisk: [
				{
					name: "weekly-hot",
					pct: 74,
					resetMs: NOW + 24 * 60 * 60_000,
					exhaustsAtMs: NOW + 4 * 60 * 60_000,
					timeToExhaustMs: 4 * 60 * 60_000,
					remainingMs: 24 * 60 * 60_000,
				},
			],
			familyWeekly: [family],
		});

		const html = renderOverview(poolResult(), sevenDay);

		expect(html).toContain("1 account may exhaust before reset");
		expect(html).toContain("Fable weekly at 92%");
		expect(html).toContain("Watch");
	});

	it("distinguishes unavailable and unknown accounts from reported usage", () => {
		const fiveHour = poolResult({
			average: 56,
			activeAverage: 34,
			exhausted: [{ name: "paused", reason: "paused", resetMs: null }],
			excluded: [{ name: "waiting", reason: "no_usage_data", resetMs: null }],
		});

		const html = renderOverview(fiveHour);

		expect(html).toContain("2 of 4 accounts");
		expect(html).toContain("1 unavailable");
		expect(html).toContain("1 unknown");
		expect(html).not.toContain("2 of 4 active");
	});

	it("does not call a partial account-wide reading on pace", () => {
		const partial = poolResult({
			average: 20,
			activeAverage: 20,
			excluded: [{ name: "waiting", reason: "no_usage_data", resetMs: null }],
		});

		const html = renderOverview(partial, partial);

		expect(html).toContain("Watch");
		expect(html).not.toContain("On pace");
	});

	it("keeps scoped-family alerts separate from the account-wide outlook", () => {
		const exhaustedFamily: FamilyWeeklyUsage = {
			family: "fable",
			label: "Fable",
			worstPct: 100,
			worstAccountName: "weekly-hot",
			earliestResetMs: NOW + 2 * 24 * 60 * 60_000,
			elevated: true,
			exhaustedCount: 1,
			elevatedCount: 1,
			accounts: [
				{
					name: "weekly-hot",
					pct: 100,
					resetMs: NOW + 2 * 24 * 60 * 60_000,
				},
			],
		};
		const sevenDay = poolResult({ familyWeekly: [exhaustedFamily] });

		const html = renderOverview(poolResult(), sevenDay);

		expect(html).toContain("On pace");
		expect(html).not.toContain("Limit reached");
		expect(html).toContain("Fable weekly exhausted on 1 of 1 account");
	});

	it("never presents missing evidence as zero usage", () => {
		const empty = poolResult({
			average: null,
			activeAverage: null,
			worst: null,
			contributing: [],
			exhausted: [],
			excluded: [],
			earliestResetMs: null,
			earliestResetAccountName: null,
		});

		const html = renderOverview(empty, empty);

		expect(html).toContain("Account-wide unknown");
		expect(html).toContain("No reported account-wide average");
		expect(html).not.toContain("0%");
	});

	it("describes non-window providers without assuming their billing model", () => {
		const withFallback = poolResult({
			fallback: [{ name: "zai", provider: "zai" }],
		});

		const html = renderOverview(withFallback);

		expect(html).toContain("Providers without this rolling window");
		expect(html).not.toContain(
			"Pay-as-you-go accounts, not included in this rolling-quota average",
		);
	});
});
