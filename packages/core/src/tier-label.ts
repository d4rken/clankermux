/**
 * The one spelling of a subscription tier label.
 *
 * Two surfaces need it: the account identity line, which reads it off the live
 * account row, and the pool-sizing panel, which reads it off the stored usage
 * samples. They must agree character for character — a reader comparing
 * "Max 20x" on one page with "max/20x" on another cannot tell whether the
 * difference is cosmetic or a different account.
 */

/**
 * Title-cased plan tier with the rate-limit multiplier appended when present,
 * e.g. plan "max" + tier "20x" → "Max 20x". When only one of the two is
 * captured, that one is shown alone; null when neither is.
 *
 * Pure and identity-free on purpose: the pool-sizing computation runs on
 * `usage_snapshots.plan_tier` / `rate_limit_tier` strings, with no account
 * object in reach.
 */
export function formatPlanTierLabel(
	planTier: string | null | undefined,
	rateLimitTier: string | null | undefined,
): string | null {
	const plan = planTier
		? planTier.charAt(0).toUpperCase() + planTier.slice(1)
		: null;
	const tier = rateLimitTier ?? null;
	if (plan && tier) return `${plan} ${tier}`;
	return plan ?? tier ?? null;
}
