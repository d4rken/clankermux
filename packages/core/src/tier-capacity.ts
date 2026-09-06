import type { RunwayTierProvenance } from "@clankermux/types";

/**
 * The one place a subscription tier becomes a NUMBER.
 *
 * The demand-conserving runway scenario redistributes burn across a roster, and
 * percent-per-hour is not additive across tiers: 1 %/h of a Max 20x account is
 * four times the tokens of 1 %/h of a Max 5x. Redistribution therefore happens
 * in capacity units, and this table is what converts a tier into one.
 *
 * DECLARED ASSUMPTIONS, NOT MEASUREMENTS. The values come from the providers'
 * own pricing framing — Anthropic describes Max 5x and Max 20x as "5×" and
 * "20×" the Pro usage allowance; OpenAI describes Codex Pro at $100 as 5× Plus
 * and at $200 as 20× Plus. A cross-check against the quota-drift fits on
 * 2026-09-06 could neither confirm nor refute them: identified coefficients
 * existed for `anthropic|max|20x` and `codex|pro|` only, so no within-provider
 * ratio had two identified endpoints. Anything downstream that shows a figure
 * derived from these numbers has to disclose that it is an assumption.
 *
 * A LOOKUP, NOT A RULE. `plan_tier` and `rate_limit_tier` are open strings that
 * the identity extractors pass through lowercased, so a new token (`10x`) or a
 * new plan (`team`) resolves to `null` — unknown, to be disclosed — and is
 * never parsed out of the token's digits or defaulted to 1. `null` for the
 * rate-limit tier is a real recorded value for Codex, not a gap, which is why
 * it appears as a key rather than a wildcard.
 *
 * ONLY RATIOS WITHIN ONE SERVABLE CLASS CARRY MEANING. The absolute numbers are
 * on a shared 1/5/20 scale purely so the two providers read alike; nothing may
 * compare an Anthropic unit to a Codex unit. And this stays out of pool sizing:
 * `packages/types/src/pool-sizing.ts` declares tier a LABEL that is never a
 * capacity weight, and that rule still holds there — account-weeks are summed
 * from measured peaks, and multiplying one by a factor from this table would
 * invent a common unit the samples do not contain.
 *
 * Inline named constants — NO env var / feature gate.
 */

/** A subscription tier as captured on an account row or a usage snapshot. */
export interface AccountTier {
	provider: string;
	planTier: string | null;
	rateLimitTier: string | null;
	/**
	 * `"recorded"` = read off the account row / a tier-stamped snapshot;
	 * `"assumed"` = substituted (e.g. today's tier for a pre-2026-08-25 row).
	 */
	provenance: RunwayTierProvenance;
}

export interface TierCapacityEntry {
	provider: string;
	planTier: string;
	rateLimitTier: string | null;
	/**
	 * Relative capacity per 100 % of an account-wide window. Only ratios within
	 * one servable class carry meaning.
	 */
	units: number;
}

export const TIER_CAPACITY_TABLE: readonly TierCapacityEntry[] = [
	{ provider: "anthropic", planTier: "pro", rateLimitTier: null, units: 1 },
	// `default_claude_pro` normalises to the bare token "pro"
	// (`providers/anthropic/identity.ts`), so a Pro org can carry it on the
	// rate-limit side as well as the plan side.
	{ provider: "anthropic", planTier: "pro", rateLimitTier: "pro", units: 1 },
	{ provider: "anthropic", planTier: "max", rateLimitTier: "5x", units: 5 },
	{ provider: "anthropic", planTier: "max", rateLimitTier: "20x", units: 20 },
	{ provider: "codex", planTier: "plus", rateLimitTier: null, units: 1 },
	// `prolite` is a distinct persisted ChatGPT plan value, not a spelling of
	// `plus`: it appears in `account_tier_history` on its own. It maps to
	// OpenAI's $100 Codex tier, framed as 5× Plus.
	{ provider: "codex", planTier: "prolite", rateLimitTier: null, units: 5 },
	{ provider: "codex", planTier: "pro", rateLimitTier: null, units: 20 },
];

/**
 * The capacity units of one tier, or `null` when the table does not list it.
 *
 * Exact match on the triple `(provider, planTier, rateLimitTier)`. `null` means
 * UNKNOWN and must be disclosed by the caller: never substituted with 1, never
 * derived from the shape of the token.
 */
export function tierCapacityUnits(
	tier: Pick<AccountTier, "provider" | "planTier" | "rateLimitTier">,
): number | null {
	const entry = TIER_CAPACITY_TABLE.find(
		(candidate) =>
			candidate.provider === tier.provider &&
			candidate.planTier === tier.planTier &&
			candidate.rateLimitTier === tier.rateLimitTier,
	);
	return entry === undefined ? null : entry.units;
}
