import { isKnownProvider } from "@clankermux/types";

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
	excludedProviders?: string[] | null;
}

/**
 * A pin constrains routing when it names an account or a non-empty
 * provider allow-list or exclusion list. Missing selectors and a legacy empty
 * allow-list are inactive.
 */
export function isPinActive(pin: RoutingPin | null | undefined): boolean {
	if (!pin) return false;
	if (pin.accountId) return true;
	return (
		(pin.providers?.length ?? 0) > 0 || (pin.excludedProviders?.length ?? 0) > 0
	);
}

/**
 * Whether a pinned key may route to this account. An inactive pin allows
 * everything. Exclusions match exact provider names; an account pin matches
 * by id, and a provider allow-list matches by provider.
 */
export function isAccountAllowedByPin(
	pin: RoutingPin | null | undefined,
	account: { id: string; provider: string },
): boolean {
	if (pin?.excludedProviders != null && !isRoutingPinValid(pin)) return false;
	if (!isPinActive(pin) || !pin) return true;
	if (pin.excludedProviders?.includes(account.provider)) return false;
	if (pin.accountId) return account.id === pin.accountId;
	return pin.providers == null || pin.providers.includes(account.provider);
}

export function isRoutingPinValid(pin: RoutingPin): boolean {
	const modes = [pin.accountId, pin.providers, pin.excludedProviders].filter(
		(value) => value != null,
	);
	if (modes.length > 1) return false;
	if (
		pin.accountId !== null &&
		(typeof pin.accountId !== "string" || !pin.accountId.trim())
	)
		return false;
	return [pin.providers, pin.excludedProviders].every(
		(list) =>
			list == null ||
			(Array.isArray(list) && list.length > 0 && list.every(isKnownProvider)),
	);
}
