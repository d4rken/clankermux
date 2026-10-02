import { type Account, PROVIDER_NAMES } from "@clankermux/types";

/**
 * When a Codex subscription that will not renew ends, if that is still ahead.
 * Its unused quota is lost then, even if the weekly window would reset later.
 * `identity_subscription_will_renew` is 1/0/null; only an explicit 0 counts,
 * since null means the provider did not say. A past end is ignored, so stale
 * metadata cannot keep acting on an account.
 */
export function nonRenewingSubscriptionEnd(
	account: Pick<
		Account,
		| "provider"
		| "identity_subscription_will_renew"
		| "identity_subscription_ends_at"
	>,
	now: number,
): number | null {
	if (account.provider !== PROVIDER_NAMES.CODEX) return null;
	if (account.identity_subscription_will_renew !== 0) return null;
	const end = account.identity_subscription_ends_at;
	if (typeof end !== "number" || !Number.isFinite(end) || end <= now)
		return null;
	return end;
}
