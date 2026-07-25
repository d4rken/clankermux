import type { RateLimitCause } from "@clankermux/types";

/**
 * The shared vocabulary for the provider's `anthropic-ratelimit-unified-status`
 * header. Previously duplicated in four places (the Anthropic provider, the
 * anthropic-compatible base provider, the accounts handler and the dashboard's
 * account-status helper), which is how `rejected` — a value Anthropic emits in
 * production — ended up recognized by none of them.
 */

/**
 * Unambiguously account-wide provider blocks. Drives ROUTING-adjacent decisions
 * (the family-weekly gate reads this via `isAnthropicHardLimitStatus`).
 * Deliberately conservative — no `rejected`: promoting it would need header
 * captures from a family-scoped and a transient-burst 429 first.
 */
export const ACCOUNT_WIDE_HARD_STATUSES: ReadonlySet<string> = new Set([
	"rate_limited",
	"blocked",
	"queueing_hard",
	"payment_required",
]);

/**
 * Statuses meaning the provider is REFUSING the request. Superset of
 * {@link ACCOUNT_WIDE_HARD_STATUSES} including `rejected`, which Anthropic emits
 * in production (observed on live accounts) but which no released code
 * recognized.
 */
export const REJECTING_STATUSES: ReadonlySet<string> = new Set([
	...ACCOUNT_WIDE_HARD_STATUSES,
	"rejected",
]);

/**
 * Administrative / billing blocks that are NOT explained by a spent quota, and
 * therefore outrank weekly exhaustion in the presentation: an account that is
 * blocked or needs payment stays labelled that way even when its weekly window
 * also happens to be spent.
 */
export const INDEPENDENT_BLOCK_STATUSES: ReadonlySet<string> = new Set([
	"payment_required",
	"blocked",
]);

/**
 * The reason value the proxy persists when an Anthropic 429 reports
 * `overage-disabled-reason: out_of_credits` — a billing state, not a quota one.
 */
const OUT_OF_CREDITS_REASON = "out_of_credits";

/**
 * Administrative / billing blocks that a spent quota does not explain, so they
 * outrank weekly exhaustion wherever a cause is presented. Shared by
 * `/api/accounts` and `/health?detail=1` so the two surfaces cannot disagree
 * about whether an operator should wait for a reset or go and pay.
 *
 * The provider status is prefix-matched (case-insensitively) because the stored
 * column can carry a trailing suffix.
 */
export function isIndependentBlock(
	providerStatus: string | null | undefined,
	rateLimitedReason: string | null | undefined,
): boolean {
	if (rateLimitedReason === OUT_OF_CREDITS_REASON) return true;
	if (!providerStatus) return false;
	const normalized = providerStatus.toLowerCase();
	for (const status of INDEPENDENT_BLOCK_STATUSES) {
		if (normalized.startsWith(status)) return true;
	}
	return false;
}

/**
 * Soft / warning statuses that must NOT block account usage and must NOT be
 * treated as hard limits. The normal non-limited value `"allowed"` is not listed
 * here.
 */
export const SOFT_WARNING_STATUSES: ReadonlySet<string> = new Set([
	"allowed_warning",
	"queueing_soft",
]);

/** Every provider status the vocabulary recognizes (soft, hard and `rejected`). */
const PROVIDER_STATUS_CAUSES: ReadonlyMap<string, RateLimitCause> = new Map<
	string,
	RateLimitCause
>([
	["allowed", "allowed"],
	["allowed_warning", "allowed_warning"],
	["queueing_soft", "queueing_soft"],
	["queueing_hard", "queueing_hard"],
	["rate_limited", "rate_limited"],
	["blocked", "blocked"],
	["payment_required", "payment_required"],
	// `rejected` is the provider REFUSING the request; for presentation purposes
	// that is a rate limit. The raw value is preserved separately for diagnostics.
	["rejected", "rate_limited"],
]);

/**
 * Normalize a stored provider status to its {@link RateLimitCause}, or `null`
 * when the value is not part of the known vocabulary (a future Anthropic status
 * we have not been taught). Comparison is case-insensitive because the stored
 * column has historically held mixed-case values.
 */
export function providerStatusToCause(status: string): RateLimitCause | null {
	return PROVIDER_STATUS_CAUSES.get(status.trim().toLowerCase()) ?? null;
}

export type { RateLimitCause };
