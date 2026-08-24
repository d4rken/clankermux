// Account tier history — the effective-dated record of an account's plan tier
// and rate-limit tier.
//
// The `accounts` row only ever carries TODAY's value, so any analysis that
// attributes historical usage to a tier silently refiles the whole history
// under whatever the account moved to most recently. A tier change reads
// exactly like a change in what the subscription buys, which is the one thing
// such an analysis must be able to tell apart.

/**
 * How a tier record was produced.
 *
 *  - `identity-capture` — an identity write (token refresh, profile fetch, or
 *    token decode) observed a CHANGE in the effective tier values.
 *  - `seed` — the one-shot backfill that recorded each existing account's
 *    then-current tiers, so the series has a starting point. A seed row's
 *    `observed_at` is the backfill's own clock, NOT when the tier was adopted.
 */
export type AccountTierHistorySource = "identity-capture" | "seed";

/**
 * One effective-dated tier record. Written on CHANGE only: an incoming null
 * preserves the stored tier (the identity writes are COALESCE merges) and is
 * therefore not a change.
 */
export interface AccountTierHistoryRow {
	accountId: string;
	/** When the change was observed, ms since epoch. */
	observedAt: number;
	/** Effective plan tier after the write; null when never captured. */
	planTier: string | null;
	/** Effective rate-limit multiplier token after the write (e.g. "20x"). */
	rateLimitTier: string | null;
	source: AccountTierHistorySource;
	/** App version that recorded the row; null when unknown. */
	appVersion: string | null;
}
