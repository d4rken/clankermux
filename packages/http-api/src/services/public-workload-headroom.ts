import type { DatabaseOperations } from "@clankermux/database";
import { createPublicReadMemo } from "./public-read-memo";
import {
	computeWorkloadHeadroomScan,
	type WorkloadHeadroomSnapshot,
} from "./workload-headroom-scan";

/**
 * The memoized reader behind `GET /public/v1/workload-headroom`.
 *
 * MEMOIZED AND SINGLE-FLIGHT on the shared `createPublicReadMemo`, for the
 * same reason every reader here is and with a sharper cost: the scan underneath is the full runway
 * resolution — every account's usage tiers, the Codex payload recovery, the
 * prediction regressions — and each row then runs a pace probe of up to 50 pool
 * rebuilds. The memo is what stops an unauthenticated poll loop on the LAN
 * deciding how often that is paid.
 */

export interface PublicWorkloadHeadroomOptions {
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?: () => number;
	/** Memo lifetime. */
	ttlMs?: number;
	/** Negative-cache lifetime. */
	failureTtlMs?: number;
}

export function createPublicWorkloadHeadroomReader(
	dbOps: DatabaseOperations,
	options: PublicWorkloadHeadroomOptions = {},
) {
	return createPublicWorkloadHeadroomReaderFromScan(
		() => computeWorkloadHeadroomScan(dbOps),
		options,
	);
}

/**
 * The memo, over an injected scan.
 *
 * Split out as a seam so the caching behaviour can be tested without a
 * database, exactly as `createPublicPacingReaderFromScan` is: a test that had to
 * stand up the account query would be testing the query rather than the TTL.
 */
export function createPublicWorkloadHeadroomReaderFromScan(
	scan: () => Promise<WorkloadHeadroomSnapshot>,
	options: PublicWorkloadHeadroomOptions = {},
) {
	return createPublicReadMemo(() => scan(), {
		// A memo hit reports the instant the scan was COMPUTED, not the instant it
		// was asked for.
		computedAtMs: (snapshot) => snapshot.generatedAtMs,
		...options,
	});
}

export type PublicWorkloadHeadroomReader = ReturnType<
	typeof createPublicWorkloadHeadroomReader
>;
