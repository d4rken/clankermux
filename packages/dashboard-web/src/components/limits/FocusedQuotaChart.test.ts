import { describe, expect, it } from "bun:test";
import type { AccountResponse, UsageHistoryResponse } from "@clankermux/types";
import { buildFocusedQuotaChart } from "./UsageSawtoothChart";

const NOW = Date.UTC(2026, 8, 7);
const accounts = ["a", "b"].map(
	(id) =>
		({
			id,
			name: id,
			provider: "anthropic",
			usageData: {
				seven_day: {
					utilization: 30,
					resets_at: new Date(NOW + 86400000).toISOString(),
				},
			},
		}) as AccountResponse,
);
function chart(partial = false, showForecast = false) {
	const history = {
		range: "7d",
		bucketMs: 60000,
		series: [
			{
				accountId: "a",
				name: "a",
				provider: "anthropic",
				points: [{ ts: NOW - 60000, sevenDayPct: 20, fiveHourPct: 10 }],
			},
			{
				accountId: "b",
				name: "b",
				provider: "anthropic",
				points: [
					{
						ts: NOW - 60000,
						sevenDayPct: partial ? null : 80,
						fiveHourPct: 90,
					},
				],
			},
			{
				accountId: "codex",
				name: "c",
				provider: "codex",
				points: [{ ts: NOW - 60000, sevenDayPct: 100, fiveHourPct: 100 }],
			},
		],
		pool: [{ ts: NOW - 60000, sevenDayAvg: 99, fiveHourAvg: 99 }],
	} as UsageHistoryResponse;
	return buildFocusedQuotaChart(
		{
			accounts,
			now: NOW,
			window: "seven_day",
			history,
			showForecast,
			showAccounts: false,
		},
		["red", "blue"],
	);
}
describe("focused quota history", () => {
	it("calculates remaining quota only for selected accounts, ignoring the global pool", () => {
		const result = chart();
		expect(result.data[0].pool).toBe(50);
		expect(result.data[0].codex).toBeUndefined();
		expect(result.lines.map((l) => l.name)).toEqual(["Average remaining"]);
	});
	it("leaves a gap instead of changing the denominator when one sample is missing", () => {
		expect(chart(true).data[0].pool).toBeNull();
	});
	it("adds future values only when forecasts are enabled", () => {
		expect(chart().data.every((r) => r.ts <= NOW)).toBe(true);
		expect(chart(false, true).data.some((r) => r.ts > NOW)).toBe(true);
	});
});
