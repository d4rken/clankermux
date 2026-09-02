import { describe, expect, it } from "bun:test";
import type {
	UsageHistoryResponse,
	UsageScopedHistoryResponse,
} from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type FamilyWindowChartState,
	UsageSawtoothChart,
	type UsageWindowChartState,
} from "./UsageSawtoothChart";

function emptyHistory(range: string): UsageHistoryResponse {
	return { range, bucketMs: 60_000, series: [], pool: [] };
}

function emptyScopedHistory(range: string): UsageScopedHistoryResponse {
	return { range, bucketMs: 60_000, families: [] };
}

function fableFamily(
	partial: Partial<FamilyWindowChartState> = {},
): FamilyWindowChartState {
	return {
		family: "fable",
		displayName: "Fable",
		usageHistory: emptyScopedHistory("7d"),
		loading: false,
		range: "7d",
		onRangeChange: () => {},
		...partial,
	};
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

	it("gives each per-family panel its own labelled selector", () => {
		const html = renderChart({}, {}, [fableFamily()]);

		expect(html.match(/role="combobox"/g)).toHaveLength(3);
		expect(html).toContain("Fable weekly window");
		expect(html).toContain('aria-label="Fable weekly graph time range"');
	});

	it("renders only the two account-wide panels when no family is reported", () => {
		for (const families of [undefined, []]) {
			const html = renderChart({}, {}, families);
			expect(html.match(/role="combobox"/g)).toHaveLength(2);
			expect(html).not.toContain("weekly window");
		}
	});
});

const EMPTY_CLAIM = "Collecting data";

function renderChart(
	fiveHour: Partial<UsageWindowChartState>,
	sevenDay: Partial<UsageWindowChartState>,
	families?: FamilyWindowChartState[],
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
			families={families}
		/>,
	);
}

describe("UsageSawtoothChart availability", () => {
	it("does not claim history is being collected while the read is in flight", () => {
		// A pending read has no rows either, so the empty state is unreachable
		// until it resolves — otherwise months of snapshots read as "none yet".
		const html = renderChart({ loading: true }, { loading: true });

		expect(html).not.toContain(EMPTY_CLAIM);
		// Both panels show the chart container's loading skeleton instead. The
		// COUNT is the assertion: one pulsing block per pending window.
		expect(html.match(/animate-pulse/g)).toHaveLength(2);
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

	it("keeps each family panel on its own state", () => {
		const html = renderChart(
			{ usageHistory: emptyHistory("24h") },
			{ usageHistory: emptyHistory("7d") },
			[
				fableFamily({ loading: true, usageHistory: undefined }),
				fableFamily({
					family: "opus",
					displayName: "Claude Opus 5",
					unavailableReason: "Usage history unavailable",
				}),
			],
		);

		// The two account-wide panels resolved empty; the Fable panel is in
		// flight; the Opus panel failed. Each says its own thing.
		expect(html.match(new RegExp(EMPTY_CLAIM, "g"))).toHaveLength(2);
		expect(html.match(/animate-pulse/g)).toHaveLength(1);
		expect(html.match(/Usage history unavailable/g)).toHaveLength(1);
	});

	it("keeps each window on its own state", () => {
		// The two panels read from separate queries; one being in flight must not
		// change what the other says.
		const html = renderChart(
			{ loading: true },
			{ usageHistory: emptyHistory("7d") },
		);

		expect(html.match(new RegExp(EMPTY_CLAIM, "g"))).toHaveLength(1);
		// One skeleton, not two: the resolved window must not borrow the
		// pending one's loading state.
		expect(html.match(/animate-pulse/g)).toHaveLength(1);
	});
});
