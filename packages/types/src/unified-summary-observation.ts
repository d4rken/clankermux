// Unified SUMMARY observation types — the response-level unified rate-limit
// fields Anthropic sends alongside (or instead of) the per-claim lines.
//
// Sibling of `unified_claim_observations`: that table records one row per CLAIM
// line, this one records the single summary block a response carried. The two
// are captured together from one response and share an `observedAt`, but the
// summary is NOT derivable from the claims — a burst 429 can carry only a
// `retry-after`, and the summary's `status`/`reset` describe whichever claim the
// provider chose to represent the account by, which is exactly the field the
// 2026-08-02 incidents turned on.

import type { UnifiedClaimObservationSource } from "./unified-claim-observation";

/**
 * One response's summary-level unified reading.
 *
 * Every field is nullable and null means THE HEADER WAS ABSENT (or did not
 * parse); a row exists only when at least one field was present. Values whose
 * units are not documented (`remaining`, `retryAfter`) are stored VERBATIM as
 * text rather than being coerced into a number whose meaning we would be
 * guessing at.
 */
export interface UnifiedSummaryObservationRow {
	/** The request that received the response (primary key). */
	requestId: string;
	accountId: string;
	source: UnifiedClaimObservationSource;
	/** HTTP status of the response the reading came from. */
	httpStatus: number;
	/** Request start, ms since epoch. */
	requestStartedAt: number;
	/** Headers-arrival time, ms since epoch. */
	observedAt: number;
	/** `anthropic-ratelimit-unified-status`, verbatim. */
	status: string | null;
	/** `anthropic-ratelimit-unified-reset` as ms since epoch. */
	resetAt: number | null;
	/** `anthropic-ratelimit-unified-remaining`, VERBATIM — units unknown. */
	remaining: string | null;
	/** `anthropic-ratelimit-unified-representative-claim`, verbatim. */
	representativeClaim: string | null;
	/** `anthropic-ratelimit-unified-fallback`, verbatim. */
	fallback: string | null;
	/** `anthropic-ratelimit-unified-fallback-percentage` as a strict decimal. */
	fallbackPercentage: number | null;
	/** `anthropic-ratelimit-unified-overage-status`, verbatim. */
	overageStatus: string | null;
	/** `anthropic-ratelimit-unified-overage-disabled-reason`, verbatim. */
	overageDisabledReason: string | null;
	/** `retry-after`, VERBATIM — seconds by spec, but not re-derived here. */
	retryAfter: string | null;
}
