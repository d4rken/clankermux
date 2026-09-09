import type { Config } from "@clankermux/config";
import type { PacingSnapshot } from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import type { LoadBalancingStrategy } from "@clankermux/types";
import { computePacingScan } from "./pacing-scan";
import { createPublicReadMemo } from "./public-read-memo";

/**
 * The de-identified pacing scan for `GET /public/v1/pacing`.
 *
 * SAME COMPUTATION as `/api/pacing`, not a second one: `computePacingScan`
 * decides everything, and this reader only adds memoization. What the two
 * responses differ in is entirely what each is allowed to SAY — the DTO drops
 * account names and keeps join keys.
 *
 * READ-ONLY, and that is a property of the SCAN, not of this file: the shared
 * account assembler is handed `sideEffects: "read-only"` below, which withholds
 * the upstream Codex reset-credit refresh and the payload tier's re-seed of the
 * usage cache. Anything an anonymous GET could otherwise start — a provider
 * request, a token refresh, a write ROUTING then reads — is refused at that
 * parameter. The mount's docstring states the invariant; this is where the
 * pacing route keeps it.
 *
 * MEMOIZED, SINGLE-FLIGHT on the shared `createPublicReadMemo`, and for a
 * sharper reason than most readers have. The scan is built from the full
 * account list — session-stats SQL, active-session counts, usage snapshots,
 * prediction regressions and duplicate-login detection — because computing
 * pacing from
 * anything narrower would let it drift from the bars it sits beside. That is a
 * deliberate cost, and the memo is what stops an unauthenticated poll loop on
 * the LAN setting how often it is paid.
 */

export interface PublicPacingOptions {
	/** Clock seam. Defaults to `Date.now`; tests pin it to a fixed instant. */
	now?: () => number;
	/** Memo lifetime. */
	ttlMs?: number;
	/** Negative-cache lifetime. */
	failureTtlMs?: number;
}

export function createPublicPacingReader(
	dbOps: DatabaseOperations,
	config: Config,
	getStrategy?: () => LoadBalancingStrategy | null,
	options: PublicPacingOptions = {},
) {
	return createPublicPacingReaderFromScan(
		(nowMs) =>
			computePacingScan(dbOps, config, getStrategy, nowMs, "read-only"),
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
	return createPublicReadMemo(scan, {
		// The READ's own clock, so a memo hit reports the instant it was computed
		// rather than the instant it was asked for.
		computedAtMs: (snapshot) => snapshot.generatedAtMs,
		...options,
	});
}

export type PublicPacingReader = ReturnType<typeof createPublicPacingReader>;
