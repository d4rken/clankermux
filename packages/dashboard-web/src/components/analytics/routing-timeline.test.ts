import { expect, it } from "bun:test";
import type { RoutingAnalytics } from "@clankermux/types";
import { formatAxisTime } from "../../lib/time-format";
import { buildRoutingTimeline } from "./routing-timeline";

it("preserves counts for prototype and reserved account names in separate chart series", () => {
	const names = [
		"__proto__",
		"constructor",
		"ts",
		"time",
		"Other",
		"account_0",
		"overflow",
	];
	const ts = 1700000000000;
	const routing: RoutingAnalytics = {
		totalRequests: 42,
		flow: [],
		decisionBreakdown: [],
		accountSplit: names.map((accountName) => ({
			accountId: accountName,
			accountName,
			requests: 6,
			percentage: 0,
			successRate: 1,
			failoverAttempts: 0,
			topDecision: null,
		})),
		timeline: names.flatMap((accountName) =>
			[2, 4].map((requests) => ({
				ts,
				accountId: accountName,
				accountName,
				requests,
				decision: "selected",
				successRate: 1,
			})),
		),
	};
	const { data, accounts } = buildRoutingTimeline(routing, "24h");
	expect(data).toHaveLength(1);
	expect(data[0].ts).toBe(ts);
	expect(data[0].time).toBe(formatAxisTime(ts, "24h"));
	expect(accounts.map((account) => account.name)).toEqual([
		...names.slice(0, 6),
		"Other",
	]);
	expect(new Set(accounts.map((account) => account.id)).size).toBe(7);
	for (const account of accounts) {
		expect((data[0] as Record<string, string | number>)[account.id]).toBe(6);
		expect(account.id).not.toBe("ts");
		expect(account.id).not.toBe("time");
	}
});
