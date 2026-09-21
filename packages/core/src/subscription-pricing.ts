/**
 * List prices for the subscription tiers this proxy can identify from a
 * provider's own profile, so an account's renewal price does not have to be
 * typed from memory.
 *
 * Every number here is a GUESS about an invoice, not a reading of one. No
 * provider exposes what it actually charges: Anthropic's OAuth profile carries
 * a plan type and a rate-limit multiplier, ChatGPT's subscriptions endpoint
 * carries a plan type and a billing period, and neither carries an amount. A
 * derived price is therefore only ever an estimate offered for confirmation —
 * `renewal_price_source = 'derived'` — and the payments auto-recorder refuses
 * to book one, because a VAT-inclusive, regional, promotional or grandfathered
 * subscription pays something this table cannot know.
 *
 * Returning null is a first-class answer and the right one whenever the tier
 * does not pin a single amount: per-seat plans (team, enterprise, business)
 * have no one price, Anthropic's `max` covers two, and a free plan has none.
 */

const USD = 1_000_000;

/** What a tier lookup needs; all four fields may be null on a fresh account. */
export interface SubscriptionPriceInput {
	/** Account provider, e.g. "anthropic", "codex". */
	provider: string | null;
	/** `identity_plan_tier` as captured, e.g. "max", "pro", "plus". */
	planTier: string | null;
	/** `identity_rate_limit_tier`, e.g. "20x"; Anthropic only. */
	rateLimitTier: string | null;
	/** Stored renewal cadence; null counts as monthly (the seeded default). */
	cadence: string | null;
}

/**
 * Anthropic, keyed by the normalised `identity_plan_tier`.
 *
 * `max` is deliberately absent: Claude Max is sold at two prices and the plan
 * type alone does not say which, so it is resolved from the rate-limit
 * multiplier in {@link ANTHROPIC_MAX_BY_RATE_LIMIT_TIER} instead.
 */
const ANTHROPIC_MONTHLY_USD_MICROS: Record<string, number> = {
	pro: 20 * USD,
};

/** Claude Max, disambiguated by `organization.rate_limit_tier`. */
const ANTHROPIC_MAX_BY_RATE_LIMIT_TIER: Record<string, number> = {
	"5x": 100 * USD,
	"20x": 200 * USD,
};

/**
 * Codex, keyed by the normalised `identity_plan_tier`.
 *
 * `prolite` is not a price this codebase can source from OpenAI's public plan
 * list; it is what the accounts on that plan type are billed. It is offered on
 * the same estimate-for-confirmation footing as every other row here.
 */
const CODEX_MONTHLY_USD_MICROS: Record<string, number> = {
	plus: 20 * USD,
	pro: 200 * USD,
	prolite: 100 * USD,
};

/**
 * Integer USD micros this account's tier is billed per renewal, or null when
 * the tier does not determine a single amount.
 *
 *   {provider: "anthropic", planTier: "max", rateLimitTier: "20x"} → 200_000_000
 *   {provider: "anthropic", planTier: "max", rateLimitTier: null}  → null
 *   {provider: "codex",     planTier: "prolite"}                   → 100_000_000
 *   {provider: "devin",     planTier: "Pro"}                       → null
 *
 * Only a MONTHLY cadence resolves. Every price here is a monthly one, and an
 * annual subscription is billed a discounted yearly figure this table does not
 * carry — stamping the monthly amount on a yearly cycle would understate the
 * renewal by an order of magnitude. A null cadence resolves as monthly, which
 * is what both the seeded and the provider-fallback cadence default to.
 */
export function deriveSubscriptionPriceUsdMicros(
	input: SubscriptionPriceInput,
): number | null {
	const cadence = input.cadence?.trim().toLowerCase() ?? "";
	if (cadence !== "" && cadence !== "monthly") return null;

	const planTier = input.planTier?.trim().toLowerCase();
	if (!planTier) return null;
	const provider = input.provider?.trim().toLowerCase() || "anthropic";

	if (provider === "anthropic") {
		if (planTier === "max") {
			const multiplier = input.rateLimitTier?.trim().toLowerCase();
			if (!multiplier) return null;
			return ANTHROPIC_MAX_BY_RATE_LIMIT_TIER[multiplier] ?? null;
		}
		return ANTHROPIC_MONTHLY_USD_MICROS[planTier] ?? null;
	}

	if (provider === "codex") {
		return CODEX_MONTHLY_USD_MICROS[planTier] ?? null;
	}

	return null;
}
