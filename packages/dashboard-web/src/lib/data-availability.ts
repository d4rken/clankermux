/**
 * "Is this panel showing real data?" — the distinction between a genuine zero, a
 * read that failed outright, and a cached value the latest poll could not
 * refresh.
 *
 * Collapsing those three into `?? 0` is how a failed `/api/stats` read became
 * indistinguishable from "no active sessions" on the Overview.
 */

/** The subset of a React Query result these helpers need. */
export interface QueryAvailabilityInput {
	data: unknown;
	isError: boolean;
	/** React Query's timestamp of the last SUCCESSFUL fetch (0 if never). */
	dataUpdatedAt: number;
}

export type DataAvailability =
	/** Never loaded, or errored with nothing cached — render "unavailable". */
	| { state: "unavailable" }
	/**
	 * A cached payload is being shown, but the most recent poll failed. The
	 * numbers are real, just not current — say so rather than presenting them
	 * as live.
	 */
	| { state: "stale"; lastUpdatedAt: number }
	/** First fetch in flight, nothing cached yet. */
	| { state: "loading" }
	| { state: "ok" };

export function dataAvailability(
	query: QueryAvailabilityInput,
	isLoading: boolean,
): DataAvailability {
	if (query.isError) {
		// React Query keeps `data` after a refetch fails, so an error with cached
		// data is "stale", not "gone".
		return query.data === undefined
			? { state: "unavailable" }
			: { state: "stale", lastUpdatedAt: query.dataUpdatedAt };
	}
	if (query.data === undefined) {
		return isLoading ? { state: "loading" } : { state: "unavailable" };
	}
	return { state: "ok" };
}

/** Short human phrase for how old a stale reading is. */
export function staleAgeLabel(lastUpdatedAt: number, now = Date.now()): string {
	if (!lastUpdatedAt) return "unknown age";
	const seconds = Math.max(0, Math.floor((now - lastUpdatedAt) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}
