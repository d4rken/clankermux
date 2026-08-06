/**
 * Log history is a ONE-SHOT backfill in front of the live SSE stream, not a
 * polled resource.
 *
 * `useLogHistory` declared no query options, so it inherited the app-wide
 * `refetchInterval: REFRESH_INTERVALS.default` from App.tsx. Every interval
 * produced a new `history` array, LogsTab's effect called `setLogs(history)`,
 * and the live tail accumulated since the last refetch was thrown away. The
 * component-side hydration guard alone does not fix that — the query has to
 * stop refetching too.
 */
import { describe, expect, it } from "bun:test";
import { logHistoryQueryOptions } from "../queries";

describe("logHistoryQueryOptions", () => {
	it("opts out of the app-wide refetch interval", () => {
		expect(logHistoryQueryOptions.refetchInterval).toBe(false);
	});

	it("does not refetch when the window regains focus", () => {
		expect(logHistoryQueryOptions.refetchOnWindowFocus).toBe(false);
	});

	it("never goes stale, so nothing else can trigger a background refetch", () => {
		expect(logHistoryQueryOptions.staleTime).toBe(Number.POSITIVE_INFINITY);
	});
});
