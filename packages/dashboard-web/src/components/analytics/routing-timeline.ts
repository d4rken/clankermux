import type { RoutingAnalytics } from "@clankermux/types";
import type { TimeRange } from "../../constants";
import { formatAxisTime } from "../../lib/time-format";

/** Keep account names separate from chart field names and the overflow bucket. */
export function buildRoutingTimeline(
	routing: RoutingAnalytics | undefined,
	timeRange: TimeRange,
) {
	const accounts: Array<{ id: string; name: string }> = [];
	if (!routing?.timeline.length) return { data: [], accounts };

	const accountIds = new Map<string, string>();
	for (const account of routing.accountSplit.slice(0, 6)) {
		const id = `account_${accounts.length}`;
		accountIds.set(account.accountName, id);
		accounts.push({ id, name: account.accountName });
	}
	const buckets = new Map<number, Map<string, number>>();
	let hasOther = false;
	for (const point of routing.timeline) {
		const id = accountIds.get(point.accountName) ?? "other_accounts";
		if (id === "other_accounts") hasOther = true;
		let counts = buckets.get(point.ts);
		if (!counts) {
			counts = new Map();
			buckets.set(point.ts, counts);
		}
		counts.set(id, (counts.get(id) ?? 0) + point.requests);
	}
	if (hasOther) accounts.push({ id: "other_accounts", name: "Other" });
	const data = Array.from(buckets, ([ts, counts]) => ({
		ts,
		time: formatAxisTime(ts, timeRange),
		...Object.fromEntries(counts),
	})).sort((a, b) => a.ts - b.ts);
	return { data, accounts };
}
