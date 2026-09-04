import type { DatabaseOperations } from "@clankermux/database";
import {
	computeWorkloadHeadroomScan,
	type WorkloadHeadroomSnapshot,
} from "./workload-headroom-scan";

/**
 * The memoized reader behind `GET /public/v1/workload-headroom`.
 *
 * MEMOIZED AND SINGLE-FLIGHT on the `public-pacing` pattern, for the same
 * reason and with a sharper cost: the scan underneath is the full runway
 * resolution — every account's usage tiers, the Codex payload recovery, the
 * prediction regressions — and each row then runs a pace probe of up to 50 pool
 * rebuilds. The memo is what stops an unauthenticated poll loop on the LAN
 * deciding how often that is paid.
 */

/** How long one computed answer is served before another read is allowed. */
const DEFAULT_TTL_MS = 60_000;

export interface PublicWorkloadHeadroomOptions {
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?: () => number;
	/** Memo lifetime. */
	ttlMs?: number;
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
	const now = options.now ?? (() => Date.now());
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

	let cached: WorkloadHeadroomSnapshot | null = null;
	let inFlight: Promise<WorkloadHeadroomSnapshot> | null = null;

	return async (): Promise<WorkloadHeadroomSnapshot> => {
		const nowMs = now();
		// A memo hit reports the instant it was COMPUTED, not the instant it was
		// asked for. A client seeing the same `generatedAt` twice is looking at the
		// same measurement twice, which is the truth.
		if (cached && nowMs - cached.generatedAtMs < ttlMs) return cached;
		// Checked before starting a read, so a burst of concurrent polls costs one
		// scan rather than one each.
		if (inFlight) return await inFlight;

		const read = scan();
		inFlight = read;
		try {
			cached = await read;
			return cached;
		} finally {
			// Cleared whether the read resolved or threw: a rejected promise left
			// here would serve the same failure to every later caller.
			inFlight = null;
		}
	};
}

export type PublicWorkloadHeadroomReader = ReturnType<
	typeof createPublicWorkloadHeadroomReader
>;
