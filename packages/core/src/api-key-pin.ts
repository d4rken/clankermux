/**
 * The per-key routing pin predicate, shared by the proxy (which enforces it)
 * and the dashboard (which projects capacity through it).
 *
 * The two used to be one activation check inline in `proxy.ts` and one raw
 * allow-predicate inline in `account-selector.ts`, safe together only because
 * the selector was never reached unless the proxy had already decided the pin
 * was active. Anything else calling the raw predicate — the dashboard passes
 * `ApiKeyResponse` rows straight through, and an unpinned key there is exactly
 * `{ accountId: null, providers: null }` — would have had every account
 * rejected. Keeping both rules in one place is what stops them drifting.
 */

export interface RoutingPin {
	accountId: string | null;
	providers: string[] | null;
}

/**
 * A pin constrains routing only when it names an account or a non-empty
 * provider class. `null`, both-null and an empty provider list all mean
 * "unpinned" — normal load balancing over the whole pool.
 */
export function isPinActive(pin: RoutingPin | null | undefined): boolean {
	if (!pin) return false;
	if (pin.accountId) return true;
	return pin.providers != null && pin.providers.length > 0;
}

/**
 * Whether a pinned key may route to this account. An inactive pin allows
 * everything; an account pin matches by id and takes precedence over a class
 * pin, which matches by provider.
 */
export function isAccountAllowedByPin(
	pin: RoutingPin | null | undefined,
	account: { id: string; provider: string },
): boolean {
	if (!isPinActive(pin) || !pin) return true;
	if (pin.accountId) return account.id === pin.accountId;
	return (pin.providers ?? []).includes(account.provider);
}
