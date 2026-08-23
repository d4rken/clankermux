import { describe, expect, it } from "bun:test";
import type { UsageHistoryResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import {
	UsageSawtoothChart,
	type UsageWindowChartState,
} from "./UsageSawtoothChart";

function emptyHistory(range: string): UsageHistoryResponse {
	return { range, bucketMs: 60_000, series: [], pool: [] };
}

describe("UsageSawtoothChart range selectors", () => {
	it("gives each quota-window graph its own labelled selector", () => {
		const html = renderToStaticMarkup(
			<UsageSawtoothChart
				accounts={[]}
				now={1_700_000_000_000}
				fiveHour={{
					usageHistory: emptyHistory("24h"),
					loading: false,
					range: "24h",
					onRangeChange: () => {},
				}}
				sevenDay={{
					usageHistory: emptyHistory("7d"),
					loading: false,
					range: "7d",
					onRangeChange: () => {},
				}}
			/>,
		);

		expect(html.match(/role="combobox"/g)).toHaveLength(2);
		expect(html).toContain('aria-label="5-hour graph time range"');
		expect(html).toContain('aria-label="7-day graph time range"');
	});
});

const EMPTY_CLAIM = "Collecting data";

function renderChart(
	fiveHour: Partial<UsageWindowChartState>,
	sevenDay: Partial<UsageWindowChartState>,
): string {
	return renderToStaticMarkup(
		<UsageSawtoothChart
			accounts={[]}
			now={1_700_000_000_000}
			fiveHour={{
				usageHistory: undefined,
				loading: false,
				range: "24h",
				onRangeChange: () => {},
				...fiveHour,
			}}
			sevenDay={{
				usageHistory: undefined,
				loading: false,
				range: "7d",
				onRangeChange: () => {},
				...sevenDay,
			}}
		/>,
	);
}

describe("UsageSawtoothChart availability", () => {
	it("does not claim history is being collected while the read is in flight", () => {
		// A pending read has no rows either, so the empty state is unreachable
		// until it resolves — otherwise months of snapshots read as "none yet".
		const html = renderChart({ loading: true }, { loading: true });

		expect(html).not.toContain(EMPTY_CLAIM);
		// Both panels show the chart container's spinner instead.
		expect(html.match(/animate-spin/g)).toHaveLength(2);
	});

	it("still claims history is being collected once the read resolves empty", () => {
		const html = renderChart(
			{ usageHistory: emptyHistory("24h") },
			{ usageHistory: emptyHistory("7d") },
		);

		expect(html.match(new RegExp(EMPTY_CLAIM, "g"))).toHaveLength(2);
	});

	it("says the read failed instead of claiming there is nothing to show", () => {
		const html = renderChart(
			{ unavailableReason: "Usage history unavailable" },
			{ unavailableReason: "Usage history unavailable" },
		);

		expect(html).not.toContain(EMPTY_CLAIM);
		expect(html.match(/Usage history unavailable/g)).toHaveLength(2);
	});

	it("keeps each window on its own state", () => {
		// The two panels read from separate queries; one being in flight must not
		// change what the other says.
		const html = renderChart(
			{ loading: true },
			{ usageHistory: emptyHistory("7d") },
		);

		expect(html.match(new RegExp(EMPTY_CLAIM, "g"))).toHaveLength(1);
		expect(html.match(/animate-spin/g)).toHaveLength(1);
	});
});
