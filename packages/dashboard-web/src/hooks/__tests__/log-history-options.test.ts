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

function queryInState(status: string) {
	return { state: { status } };
}

describe("logHistoryQueryOptions", () => {
	it("opts a SUCCESSFUL load out of the app-wide refetch interval", () => {
		expect(
			logHistoryQueryOptions.refetchInterval(queryInState("success")),
		).toBe(false);
		expect(
			logHistoryQueryOptions.refetchInterval(queryInState("pending")),
		).toBe(false);
	});

	it("keeps retrying a FAILED load", () => {
		// LogsTab renders the error branch before the log list, so an error that
		// never clears hides live SSE lines that are arriving normally. The
		// app-wide interval used to recover this; opting out of it entirely took
		// that away.
		expect(logHistoryQueryOptions.refetchInterval(queryInState("error"))).toBe(
			30_000,
		);
	});

	it("does not refetch when the window regains focus", () => {
		expect(logHistoryQueryOptions.refetchOnWindowFocus).toBe(false);
	});

	it("never goes stale, so nothing else can trigger a background refetch", () => {
		expect(logHistoryQueryOptions.staleTime).toBe(Number.POSITIVE_INFINITY);
	});

	it("drops the cached history on unmount so every mount fetches afresh", () => {
		// The stream has no replay: a remount that hydrated a cached snapshot —
		// permanently fresh under staleTime: Infinity, so never refetched — would
		// silently omit everything emitted while the tab was away.
		expect(logHistoryQueryOptions.gcTime).toBe(0);
	});
});
