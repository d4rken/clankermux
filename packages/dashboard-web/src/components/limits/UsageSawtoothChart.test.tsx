import { describe, expect, it } from "bun:test";
import type { UsageHistoryResponse } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageSawtoothChart } from "./UsageSawtoothChart";

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
