/**
 * Short-lived memory of family-weekly exhaustion learned from a 429.
 *
 * The reactive family-weekly rung in `handlers/proxy-operations.ts` resolves a
 * 429 into "account A's weekly quota for family F is spent until T", logs it,
 * and fails over WITHOUT an account-wide cooldown — deliberately, so the
 * account keeps serving its other model families. But it then dropped the
 * finding on the floor. The proactive gate re-derives eligibility from the
 * usage cache, which still reports headroom for F, so the very next request
 * picks A again and earns the same 429. Observed on 2026-08-17: eighteen
 * `claude-fable-5` requests to one account between 07:15:25 and 07:22:52, each
 * ~800ms, each rejected for the same reason.
 *
 * This map closes that loop. It is deliberately NOT a cooldown: it is scoped to
 * one (account, family) pair and leaves every other family on that account
 * untouched, preserving the behaviour the reactive rung's comment describes.
 *
 * A routing hint, NOT persisted state. The map is empty after a restart and
 * repopulates from the first 429 of each family.
 *
 * Entries expire at the family's own reset time, so a wrong entry cannot
 * outlive the window it describes, and the gate that reads this only ever
 * REORDERS candidates (see `applyFamilyMemoDemotion`) — it can never shrink the
 * pool, so a wrong entry costs ordering, never a refusal.
 *
 * Coverage is not universal, and the gap is the repeat cost this map exists to
 * remove. Two paths still re-ask a refused account on every request: a COMBO
 * request, whose candidates cannot be reordered because slots are matched
 * positionally; and a pool whose only candidate is the refused account, where
 * demoting it changes nothing. Both re-ask once per request rather than once
 * per window.
 */

import { getModelFamily, type ModelFamily } from "@clankermux/core";

interface FamilyWeeklyMemoEntry {
	/** Epoch ms at which the family's weekly window resets. */
	resetAt: number;
	/** Epoch ms at which the 429 that taught us this was observed. */
	observedAt: number;
}

/**
 * Hard ceiling on retained entries. The natural bound is accounts × families
 * (single digits × 4), so this is only a backstop against an unforeseen key
 * explosion — the same defensive posture as `MAX_PROBE_GATES` in
 * `handlers/rate-limit-cooldown.ts`.
 */
const MAX_MEMO_ENTRIES = 1_000;

/**
 * Longest reset an entry may claim. A weekly window is 7 days; anything past
 * this came from a header we misread, and storing it would park the entry far
 * beyond any window it could describe. Also keeps `resetAt` inside `Date`'s
 * representable range, so formatting one for a log line cannot throw.
 */
const MAX_MEMO_HORIZON_MS = 14 * 86_400_000;

const memo = new Map<string, FamilyWeeklyMemoEntry>();

function keyFor(accountId: string, family: ModelFamily): string {
	// Account ids are UUIDs and families are lowercase words, so neither side can
	// contain a colon and two distinct pairs cannot collide into one key.
	return `${accountId}:${family}`;
}

/** Drop entries whose window has already reset. */
function pruneExpired(now: number): void {
	for (const [key, entry] of memo) {
		if (now >= entry.resetAt) memo.delete(key);
	}
}

/**
 * Record that `accountId` is weekly-exhausted for `family` until `resetAt`,
 * as learned from a 429. A later observation replaces an earlier one, so a
 * reset time that moves outward is honoured rather than pinned to the first
 * sighting.
 *
 * A `resetAt` at or before `now` carries no information — the window it names
 * has already passed — so it is discarded rather than stored as an entry that
 * would expire on its first read. One further out than any real weekly window
 * is discarded too: it can only have come from a misread header, and honouring
 * it would outlast every window it might have meant.
 */
export function recordFamilyWeeklyExhausted(
	accountId: string,
	family: ModelFamily,
	resetAt: number,
	now: number,
): void {
	if (!Number.isFinite(resetAt) || resetAt <= now) return;
	if (resetAt > now + MAX_MEMO_HORIZON_MS) return;
	pruneExpired(now);
	if (memo.size >= MAX_MEMO_ENTRIES && !memo.has(keyFor(accountId, family))) {
		return;
	}
	memo.set(keyFor(accountId, family), { resetAt, observedAt: now });
}

/**
 * The epoch-ms reset time this account's `family` is exhausted until, or null
 * when nothing is known (or what was known has expired).
 */
export function getFamilyWeeklyExhaustedUntil(
	accountId: string,
	family: ModelFamily,
	now: number,
): number | null {
	const key = keyFor(accountId, family);
	const entry = memo.get(key);
	if (!entry) return null;
	if (now >= entry.resetAt) {
		memo.delete(key);
		return null;
	}
	return entry.resetAt;
}

/**
 * Forget what we learned about one (account, family) pair, because a request
 * that STARTED at `observedAfter` succeeded for that family — direct evidence
 * the window is open again.
 *
 * `observedAfter` is the clearing request's own start time, and an entry
 * recorded at or after it survives. Without that ordering the two can race the
 * wrong way round: a long request admitted while the window was still open can
 * return its 2xx after a concurrent, shorter request has already been refused
 * and recorded the exhaustion, and the older success would erase the newer
 * finding and reopen the repeat-429 loop this map exists to close.
 */
export function clearFamilyWeeklyExhausted(
	accountId: string,
	family: ModelFamily,
	observedAfter: number,
): void {
	const key = keyFor(accountId, family);
	const entry = memo.get(key);
	if (!entry) return;
	if (entry.observedAt >= observedAfter) return;
	memo.delete(key);
}

/**
 * Convenience for callers that hold an account and a request model rather than
 * an account id and a resolved family: is this account known to be
 * weekly-exhausted for that model's family right now?
 *
 * Anthropic-only, matching the gate — a memo is only ever written for an
 * Anthropic account, so asking about any other provider is always false.
 */
export function isFamilyWeeklyMemoExhausted(
	account: { id: string; provider: string },
	model: string | null,
	now: number,
): boolean {
	if (account.provider !== "anthropic") return false;
	const family = getModelFamily(model ?? "");
	if (!family) return false;
	return getFamilyWeeklyExhaustedUntil(account.id, family, now) !== null;
}

/** Test seam: every peer module in this package exports one. */
export function resetFamilyWeeklyMemoForTests(): void {
	memo.clear();
}
