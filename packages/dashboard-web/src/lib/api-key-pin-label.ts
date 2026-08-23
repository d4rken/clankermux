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
 * Pure, so it can be unit-tested without mounting anything.
 */
export function describePinTarget(
	key: { pinnedAccountId: string | null; pinnedProviders: string[] | null },
	accounts: { id: string; name: string }[],
): string {
	if (key.pinnedAccountId) {
		const account = accounts.find((a) => a.id === key.pinnedAccountId);
		return `Pinned → ${account?.name ?? key.pinnedAccountId}`;
	}
	if (key.pinnedProviders && key.pinnedProviders.length > 0) {
		return `Pinned → ${key.pinnedProviders.join(", ")}`;
	}
	return "Unpinned";
}
