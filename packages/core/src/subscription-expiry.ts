/**
 * Recognising a subscription that no longer covers the service, from what the
 * REQUEST PATH says.
 *
 * Every matcher here answers one question: did the provider just refuse this
 * request because the plan does not include it? Nothing else qualifies. A past
 * period end, `will_renew: false`, a delinquency flag or a grace-period status
 * are all metadata that goes stale while access keeps working, so none of them
 * pauses an account — only an upstream refusal does.
 *
 * Mirrors the shape of `isInvalidGrantMessage` / `PAUSE_REASON_NEEDS_REAUTH` in
 * ./errors.ts: a canonical pause reason plus the predicates that produce it.
 */

/**
 * Canonical `pause_reason` for an account whose subscription no longer covers
 * the service. Terminal — it needs a human (renew, re-subscribe, restore the
 * seat) and will not self-heal, so nothing schedules retries against it.
 * Auto-cleared when a later subscription capture reports an active,
 * non-delinquent subscription. Kept here so the producers (the request path)
 * and the consumers (the dashboard, the resume) agree on the exact string.
 */
export const PAUSE_REASON_SUBSCRIPTION_EXPIRED = "subscription_expired";

/**
 * The Codex code for "your plan does not include this", as the official CLI
 * spells it — adjacent to `usage_limit_reached` in the same branch, and
 * nothing like it in meaning.
 */
const CODEX_USAGE_NOT_INCLUDED = "usage_not_included";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * True when a parsed Codex error body reports that the plan does not cover
 * Codex. Reads BOTH `error.code` and `error.type`: the Codex error mapper
 * itself keys on `code` first and `type` second, so a body may carry the value
 * under either key.
 *
 * Never true for `usage_limit_reached` or `insufficient_quota` — those are a
 * rate limit and a quota, both of which recover on their own, and pausing on
 * them would take a healthy account out of rotation until a human noticed.
 */
export function isCodexSubscriptionLapse(body: unknown): boolean {
	const error = asRecord(asRecord(body)?.error);
	if (!error) return false;
	const code = typeof error.code === "string" ? error.code.toLowerCase() : null;
	const type = typeof error.type === "string" ? error.type.toLowerCase() : null;
	return code === CODEX_USAGE_NOT_INCLUDED || type === CODEX_USAGE_NOT_INCLUDED;
}

/**
 * Devin's two ways of saying the seat is gone: the plan lapsed to free, or the
 * team removed the user.
 */
const DEVIN_LAPSE_MARKERS = [
	"free user account exceeded",
	"user is disabled by team",
] as const;

/**
 * True when a Devin upstream message reports a lapsed or removed seat.
 * Case-insensitive, matched on the message the server sent rather than on the
 * status, because a permission_denied covers several unrelated refusals.
 *
 * Explicitly false for quota exhaustion, which is a different condition with a
 * different recovery:
 *
 *   "Your daily usage quota has been exhausted"  → recovers at the daily reset
 *   "Reached overall message rate limit"         → recovers on its own
 */
export function isDevinSubscriptionLapse(
	message: string | null | undefined,
): boolean {
	if (!message) return false;
	const lower = message.toLowerCase();
	return DEVIN_LAPSE_MARKERS.some((marker) => lower.includes(marker));
}
