import type { RoutingPin } from "@clankermux/core";

/**
 * Human-readable summary of an API key's routing pin, shown wherever a key's
 * routing target is named: the API Keys list, and the capacity surfaces that
 * project runway per key.
 *
 *   - pinned account   -> "Pinned → <accountName>" (falls back to the id when
 *     the account no longer exists)
 *   - pinned providers -> "Pinned → <providers joined with ', '>"
 *   - neither          -> "Unpinned" (normal load balancing)
 *
 * Takes a {@link RoutingPin} — the same shape the proxy enforces and
 * `/api/runway` serves per key — so a runway row's `pin` can be labelled
 * directly. Callers holding an `ApiKeyResponse` map its `pinnedAccountId` /
 * `pinnedProviders` onto it.
 *
 * Pure, so it can be unit-tested without mounting anything.
 */
export function describePinTarget(
	pin: RoutingPin,
	accounts: { id: string; name: string }[],
): string {
	if (pin.accountId) {
		const account = accounts.find((a) => a.id === pin.accountId);
		return `Pinned → ${account?.name ?? pin.accountId}`;
	}
	if (pin.providers && pin.providers.length > 0) {
		return `Pinned → ${pin.providers.join(", ")}`;
	}
	return "Unpinned";
}
