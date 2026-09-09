import type { DatabaseOperations } from "@clankermux/database";
import { RequestRepository } from "@clankermux/database";
import type { StopsHistoryResponse } from "@clankermux/types";
import {
	computeStopsHistory,
	type StopsHistorySources,
} from "../handlers/stops-history-direct";
import { createPublicReadMemo } from "./public-read-memo";

/**
 * The de-identified, POOL-LEVEL record of requests the proxy actually refused.
 *
 * SAME COMPUTATION as `/api/analytics/stops-history`, not a second one:
 * `computeStopsHistory` classifies and counts, and this reader only chooses what
 * it is allowed to ask for. A second implementation is how a widget comes to
 * disagree with the dashboard about how often the pool said no.
 *
 * Three constraints, all of them because the surface is unauthenticated:
 *
 *  - FIXED RANGE. The dashboard route takes `?range=` because a signed-in
 *    session picked it. Here a range parameter would be an anonymous caller
 *    choosing how far back the server scans the request table, at whatever rate
 *    it likes. Seven days, always, and the payload states it.
 *  - COMPUTES ONLY WHAT IT PUBLISHES. The model breakdown is a second full scan
 *    of the range and the bucket grid builds a per-cause series; neither is on
 *    this wire, so neither is asked for.
 *  - NO FILTER SCOPE. The dashboard route narrows to the analytics filter panel
 *    a signed-in session had open. This surface publishes the POOL-LEVEL
 *    record, so it passes no filters at all: the accounts, keys and projects a
 *    selection names are exactly the identities this route exists not to
 *    disclose, and honoring them would also make the memo below per-caller.
 *  - MEMOIZED, SINGLE-FLIGHT, on the shared `createPublicReadMemo`. One read
 *    per {@link PublicStopsOptions.ttlMs}, and concurrent callers await the same
 *    in-flight promise rather than each starting a scan. Without it a poll loop
 *    on the LAN sets the query rate.
 */
export const PUBLIC_STOPS_RANGE = "7d" as const;

export interface PublicStopsOptions {
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?: () => number;
	/** Memo lifetime. */
	ttlMs?: number;
	/** Negative-cache lifetime. */
	failureTtlMs?: number;
}

export interface PublicStopsSnapshot {
	/**
	 * When the served counts were taken — the READ's own clock, so a memo hit
	 * reports the instant it was computed rather than the instant it was asked
	 * for. A client that saw the same `generatedAt` twice is looking at the same
	 * measurement twice, which is the truth.
	 */
	generatedAtMs: number;
	summary: StopsHistoryResponse;
}

export function createPublicStopsReader(
	dbOps: DatabaseOperations,
	options: PublicStopsOptions = {},
) {
	const now = options.now ?? (() => Date.now());

	// Built once per reader rather than per call: the repository is a thin
	// wrapper over the adapter, and rebuilding it on every unauthenticated GET
	// would be work with no answer attached to it.
	const requests = new RequestRepository(dbOps.getAdapter());
	const sources: StopsHistorySources = {
		getStopsByBucket: (opts) => requests.getStopsByBucket(opts),
		getStopModelBreakdown: (opts) => requests.getStopModelBreakdown(opts),
		countRequestsSince: (opts) => requests.countRequestsSince(opts),
		getCandidateCountDistribution: (opts) =>
			requests.getCandidateCountDistribution(opts),
		now,
	};

	return createPublicStopsReaderFromSources(sources, { ...options, now });
}

/**
 * The same reader over an injected sources seam, so the memo and the
 * single-flight behaviour can be tested without a database.
 */
export function createPublicStopsReaderFromSources(
	sources: StopsHistorySources,
	options: PublicStopsOptions = {},
) {
	return createPublicReadMemo(
		async (): Promise<PublicStopsSnapshot> => {
			const summary = await computeStopsHistory(sources, PUBLIC_STOPS_RANGE, {
				includeModelBreakdown: false,
				includeSeries: false,
			});
			return { generatedAtMs: summary.windowEndsAt, summary };
		},
		{
			computedAtMs: (snapshot) => snapshot.generatedAtMs,
			...options,
			now: options.now ?? sources.now ?? (() => Date.now()),
		},
	);
}

export type PublicStopsReader = ReturnType<typeof createPublicStopsReader>;
