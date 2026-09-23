/**
 * Conversations (routing affinity keys) that recently sent a request at the
 * protected family's (Fable's) liveness tier.
 *
 * The pool-liveness reserve is tiered by the request's model, so a conversation
 * that mixes Fable turns with cheaper side requests sees its pinned account
 * reserved for the side requests only. Moving the pin on such a side request
 * would take the Fable turns off an account they may still use. Once no Fable
 * turn has happened for longer than Anthropic's longest prompt-cache TTL, there
 * is no warm Fable prefix left to protect.
 *
 * A routing hint, not persisted state: a restart forgets it, which at worst
 * lets one side request move a pin whose Fable cache was cold anyway.
 */

const PROTECTED_TIER_WINDOW_MS = 60 * 60 * 1000;
const MAX_CONVERSATIONS = 5000;

const lastProtectedTierTurn = new Map<string, number>();

export function recordProtectedTierTurn(conversationKey: string, now: number) {
	lastProtectedTierTurn.delete(conversationKey);
	lastProtectedTierTurn.set(conversationKey, now);
	// Oldest-touched first. The sweep stops at the first fresh entry, so an
	// expired one behind it waits for its own lookup to drop it.
	for (const [key, at] of lastProtectedTierTurn) {
		if (
			lastProtectedTierTurn.size <= MAX_CONVERSATIONS &&
			now - at <= PROTECTED_TIER_WINDOW_MS
		)
			break;
		lastProtectedTierTurn.delete(key);
	}
}

export function hasRecentProtectedTierTurn(
	conversationKey: string,
	now: number,
): boolean {
	const at = lastProtectedTierTurn.get(conversationKey);
	if (at === undefined) return false;
	lastProtectedTierTurn.delete(conversationKey);
	if (now - at > PROTECTED_TIER_WINDOW_MS) return false;
	// A conversation still being asked about stays at the back of the eviction
	// order, even between its Fable turns.
	lastProtectedTierTurn.set(conversationKey, at);
	return true;
}

export function resetConversationTierMemoryForTests(): void {
	lastProtectedTierTurn.clear();
}
