import { isAccountAvailable } from "@clankermux/core";
import { type Account, PROVIDER_NAMES } from "@clankermux/types";
import { isSelfHealingPauseReason } from "./pause-reasons";

const RATE_LIMIT_RESET_BUFFER_MS = 1000;

/**
 * Providers whose `rate_limit_reset` is maintained from real usage evidence,
 * and so the only ones auto-unpause may trust an elapsed reset from. The single
 * definition: the capacity-restored path in `apps/server` consults it before
 * correcting a paused account's reset, so it never promises an unpause the gate
 * here would refuse.
 *
 * "Maintained" differs by provider, and Z.AI is the weakest of the three.
 * Anthropic and Codex write the column from a real response (unified headers /
 * the Codex observation). Z.AI has no such channel at all, so the usage-snapshot
 * sampler mirrors its representative window's reset instead, and does that only
 * while the account is ACTIVE. A paused Z.AI account therefore carries whatever
 * was last observed before the pause, never a fresher reading.
 *
 * In practice that has no consequence yet: {@link wouldAutoUnpause} also
 * requires `isSelfHealingPauseReason`, and no pause a Z.AI account currently
 * reaches satisfies it — `peak_hours` (which resumes itself when peak ends),
 * `manual` and `failure_threshold` are all durable. Read the Z.AI entry as
 * "ready if such a pause is ever added", not as a live recovery path.
 */
export function supportsWindowResetUnpause(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CODEX ||
		provider === PROVIDER_NAMES.ZAI
	);
}

/**
 * The structural half of the auto-unpause condition: the account is paused with
 * auto-fallback on, its provider reports a resettable usage window, that window
 * has elapsed, and no cooldown of our own is still running. Says nothing about
 * WHY the account is paused — see {@link wouldAutoUnpause} for that.
 *
 * Both strategies filter their auto-fallback candidates through this so the
 * two cannot drift: SessionStrategy.checkForAutoFallbackAccounts() used to
 * carry its own copy of the provider/window/cooldown test, and
 * LeastUsedStrategy resumed accounts whose cooldown had not expired at all.
 *
 * The cooldown boundary matches core `isAccountAvailable`, which requires
 * `rate_limited_until < now`: an account whose cooldown ends exactly at `now`
 * is still rate-limited, so unpausing it would only hand the pool an account
 * that the very next availability check rejects.
 */
export function isAutoUnpauseCandidate(
	account: Account,
	now: number = Date.now(),
): boolean {
	if (account.disabled || !account.paused) return false;
	if (!account.auto_fallback_enabled) return false;
	if (!supportsWindowResetUnpause(account.provider)) return false;

	const windowReset =
		account.rate_limit_reset != null &&
		account.rate_limit_reset < now - RATE_LIMIT_RESET_BUFFER_MS;
	if (!windowReset) return false;

	if (account.rate_limited_until && account.rate_limited_until >= now) {
		return false;
	}

	return true;
}

/**
 * Mirrors the auto-unpause condition that select() applies before testing
 * availability. Returns true when select() WOULD unpause this account on
 * its next call, without performing the unpause itself.
 *
 * Kept in sync with SessionStrategy.select() and
 * LeastUsedStrategy.autoUnpauseElapsedAccounts() — divergence here causes
 * peek() to flag the wrong account as Primary while real traffic goes
 * elsewhere.
 */
export function wouldAutoUnpause(
	account: Account,
	now: number = Date.now(),
): boolean {
	return (
		isAutoUnpauseCandidate(account, now) &&
		isSelfHealingPauseReason(account.pause_reason)
	);
}

/**
 * Side-effect-free availability check that includes the auto-unpause
 * simulation. Use in peek() so a paused-but-eligible account surfaces as
 * the would-be-primary instead of being skipped over because of its
 * stale `paused` flag.
 */
export function isPeekAvailable(
	account: Account,
	now: number = Date.now(),
): boolean {
	if (isAccountAvailable(account, now)) return true;
	if (!wouldAutoUnpause(account, now)) return false;
	// wouldAutoUnpause already validated the account is otherwise eligible
	// (paused with safe reason + auto-fallback + window elapsed). The only
	// remaining blocker isAccountAvailable would check is rate_limited_until,
	// which is independent of pause state.
	return !account.rate_limited_until || account.rate_limited_until < now;
}
