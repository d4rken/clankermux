import { useEffect, useMemo, useState } from "react";
import { subscribePoolClock } from "../lib/pool-clock";
import { computePoolUsage, type PoolUsageResult } from "../lib/pool-usage";
import { useAccounts } from "./queries";

export interface PoolUsageSnapshot {
	/** The shared ticking clock every duration on the page is derived from. */
	now: number;
	fiveHour: PoolUsageResult;
	sevenDay: PoolUsageResult;
}

/**
 * The single quota computation behind every pool surface.
 *
 * Overview and Usage each used to call `computePoolUsage` twice against their
 * own clock. Same accounts, same code, two answers that could differ by up to
 * the refresh interval — a reader comparing the two pages saw a discrepancy
 * with no cause. This is one computation on one tick, memoised so mounting a
 * second consumer costs nothing.
 *
 * The `useAccounts()` read is already shared: React Query dedupes it by key, so
 * both callers get the same cache entry rather than two fetches.
 */
export function usePoolUsage(): PoolUsageSnapshot {
	const { data: accounts } = useAccounts();
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => subscribePoolClock(setNow), []);

	const fiveHour = useMemo(
		() => computePoolUsage(accounts ?? [], "five_hour", now),
		[accounts, now],
	);
	const sevenDay = useMemo(
		() => computePoolUsage(accounts ?? [], "seven_day", now),
		[accounts, now],
	);

	return { now, fiveHour, sevenDay };
}
