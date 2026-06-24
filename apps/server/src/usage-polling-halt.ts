import {
	isInvalidGrantMessage,
	OAuthRefreshTokenError,
	PAUSE_REASON_NEEDS_REAUTH,
	TokenRefreshError,
} from "@clankermux/core";
import type { Account } from "@clankermux/types";

/**
 * True when a token-refresh failure is terminal — the OAuth *refresh token*
 * itself was rejected (`invalid_grant`), so it can never self-heal and needs a
 * manual reauth. NOT true for transient failures (network/429/5xx).
 *
 * The refresh chokepoint wraps the provider's `OAuthRefreshTokenError` into a
 * `TokenRefreshError` and may strip the `invalid_grant` marker from the message,
 * so we read the explicit `isInvalidGrant` flag it now carries (set from the raw
 * error). The other arms cover direct/un-wrapped errors and string fallbacks.
 */
function isUnrecoverableRefreshError(error: unknown): boolean {
	if (error instanceof OAuthRefreshTokenError) return true;
	if (error instanceof TokenRefreshError) return error.isInvalidGrant;
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	return isInvalidGrantMessage(message);
}

/**
 * Decide whether to STOP usage polling for an account after its token refresh
 * FAILED during a poll tick (only ever consulted from the token-refresh-failure
 * hook, so reaching here already means this tick's refresh failed).
 *
 * Halt only a *paused* account whose refresh token is unrecoverable — it can't
 * self-heal; it needs a manual reauth (which restarts polling via the
 * registered polling-restarter). Two reliable signals:
 *   (a) `pause_reason === 'oauth_invalid_grant'` — the refresh chokepoint
 *       already classified the refresh token as rejected (covers an account
 *       that was active when its token died and got auto-paused).
 *   (b) this tick's failure is itself a terminal invalid_grant — covers an
 *       account paused for a different terminal reason (e.g.
 *       `subscription_expired`) whose refresh token has ALSO been revoked, so
 *       the chokepoint's pause-if-active no-op'd and (a) was never set.
 *
 * A paused account with a still-valid refresh token (e.g. `subscription_expired`
 * with a working token, waiting to auto-recover on renewal) hits neither signal,
 * so it keeps polling. Transient refresh failures likewise keep retrying.
 *
 * Note: this intentionally also halts an account that was *active* when its
 * token died — the chokepoint auto-pauses it `oauth_invalid_grant` first, and a
 * needs-reauth account has nothing to gain from continued polling.
 */
export function shouldStopPollingPausedAccount(
	account: Account | null | undefined,
	error: unknown,
): boolean {
	if (!account?.paused) return false;
	if (account.pause_reason === PAUSE_REASON_NEEDS_REAUTH) return true;
	return isUnrecoverableRefreshError(error);
}
