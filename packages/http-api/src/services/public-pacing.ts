import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import type { LoadBalancingStrategy } from "@clankermux/types";
import { computePacingScan, type PacingSnapshot } from "./pacing-scan";

/**
 * The de-identified pacing scan for `GET /public/v1/pacing`.
 *
 * SAME COMPUTATION as `/api/pacing`, not a second one: `computePacingScan`
 * decides everything, and this reader only adds memoization. What the two
 * responses differ in is entirely what each is allowed to SAY — the DTO drops
 * account names and keeps join keys.
 *
 * MEMOIZED, SINGLE-FLIGHT, on the `public-stops` pattern and for a sharper
 * reason than that reader has. The scan is built from the full account list —
 * session-stats SQL, active-session counts, usage snapshots, prediction
 * regressions and duplicate-login detection — because computing pacing from
 * anything narrower would let it drift from the bars it sits beside. That is a
 * deliberate cost, and the memo is what stops an unauthenticated poll loop on
 * the LAN setting how often it is paid.
 */

/** How long one computed answer is served before another read is allowed. */
const DEFAULT_TTL_MS = 60_000;

export interface PublicPacingOptions {
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?: () => number;
	/** Memo lifetime. */
	ttlMs?: number;
}

export function createPublicPacingReader(
	dbOps: DatabaseOperations,
	config: Config,
	getStrategy?: () => LoadBalancingStrategy | null,
	options: PublicPacingOptions = {},
) {
	return createPublicPacingReaderFromScan(
		(nowMs) => computePacingScan(dbOps, config, getStrategy, nowMs),
		options,
	);
}

/**
 * The memo, over an injected scan.
 *
 * Split out as a seam so the caching behaviour can be tested without a
 * database: the scan builds the whole account list, and a test that had to
 * stand one up would be testing the account query rather than the TTL. Same
 * split, and the same reason, as `createPublicStopsReaderFromSources`.
 */
export function createPublicPacingReaderFromScan(
	scan: (nowMs: number) => Promise<PacingSnapshot>,
	options: PublicPacingOptions = {},
) {
	const now = options.now ?? (() => Date.now());
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

	let cached: PacingSnapshot | null = null;
	let inFlight: Promise<PacingSnapshot> | null = null;

	return async (): Promise<PacingSnapshot> => {
		const nowMs = now();
		// `generatedAtMs` is the READ's own clock, so a memo hit reports the
		// instant it was computed rather than the instant it was asked for. A
		// client seeing the same value twice is looking at the same measurement
		// twice, which is the truth.
		if (cached && nowMs - cached.generatedAtMs < ttlMs) return cached;
		// Single flight, checked BEFORE starting a read: a burst of concurrent
		// polls costs one account build rather than one each.
		if (inFlight) return await inFlight;

		const read = scan(nowMs);
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

export type PublicPacingReader = ReturnType<typeof createPublicPacingReader>;
