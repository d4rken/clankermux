// Codex/OpenAI raw window-observation types — the `x-codex-*` window lines a
// response carried, recorded as they arrived.
//
// A different axis from the normalized `UsageData` the routing path consumes.
// Normalization is lossy in exactly the dimensions a later analysis needs: it
// slots windows by duration (discarding the per-family 5-hour slots), collapses
// placeholder windows, and substitutes a default utilization on a 429. Every one
// of those is the right call for a routing decision and the wrong one for a
// record of what the provider said.

import type { UnifiedClaimObservationSource } from "./unified-claim-observation";

/** Which limit a window row belongs to: the account-wide one, or a family's. */
export type CodexWindowObservationScope = "root" | "family";

/** Which of a limit's two window slots the row came from. */
export type CodexWindowObservationSlot = "primary" | "secondary";

/**
 * One `x-codex-*` window line on one upstream attempt.
 *
 * `observationId` is unique per UPSTREAM ATTEMPT, not per request: a retry or a
 * failover produces several responses for one logical request, possibly from
 * different accounts, and folding them together would silently average readings
 * that describe different quota states. `requestId` correlates them and is
 * deliberately non-unique.
 *
 * Every reading is nullable and null means NO READING (absent or malformed); a
 * reported zero is stored as 0.
 */
export interface CodexWindowObservationRow {
	/** Unique per upstream attempt. */
	observationId: string;
	/** Logical request id — correlation only, NOT unique. */
	requestId: string;
	accountId: string;
	source: UnifiedClaimObservationSource;
	httpStatus: number;
	/** Request start, ms since epoch. */
	requestStartedAt: number;
	/** Headers-arrival time, ms since epoch — one instant per attempt. */
	observedAt: number;
	scope: CodexWindowObservationScope;
	/** Family codename, or the EMPTY STRING for a root row (never null). */
	familyCodename: string;
	slot: CodexWindowObservationSlot;
	/** The family's display name; null on root rows. */
	limitName: string | null;
	/** `-used-percent`; null = no reading, 0 = a reading of zero. */
	usedPercent: number | null;
	/** `-window-minutes` as reported. */
	windowMinutes: number | null;
	/** Absolute reset instant, ms since epoch. */
	resetAt: number | null;
	/** `x-codex-active-limit` verbatim — which limit the backend calls binding. */
	activeLimit: string | null;
}

/** Which quantity an OpenAI-compatible bucket row describes. */
export type OpenAiBucketName = "tokens" | "requests";

/**
 * One `x-ratelimit-*` bucket on one upstream attempt.
 *
 * Captured before `sanitizeHeaders` strips the whole `x-ratelimit-*` family on
 * the way to the client, which is the only window in which these readings exist.
 *
 * `resetRaw` is stored VERBATIM: the value is a duration string whose grammar is
 * undocumented, and a parsed number would bake a guess into the series.
 */
export interface OpenAiBucketObservationRow {
	/** Unique per upstream attempt, paired with `bucket`. */
	observationId: string;
	/** Logical request id — correlation only, NOT unique. */
	requestId: string;
	accountId: string;
	bucket: OpenAiBucketName;
	/** Request start, ms since epoch. */
	requestStartedAt: number;
	/** Headers-arrival time, ms since epoch. */
	observedAt: number;
	httpStatus: number;
	/** Upstream path the attempt was made against; null when unknown. */
	endpoint: string | null;
	limitValue: number | null;
	remaining: number | null;
	/** `x-ratelimit-reset-<bucket>` verbatim (e.g. "6m0s"). */
	resetRaw: string | null;
}
