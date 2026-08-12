import { getValidAccessToken, type ProxyContext } from "@clankermux/proxy";
import type { Account } from "@clankermux/types";

export interface UsagePollingTokenProviderDeps {
	getValidAccessToken: typeof getValidAccessToken;
}

/**
 * Create the token provider used by the 90s usage-polling loop.
 *
 * On every invocation it re-reads the account row from the DB and syncs the
 * token fields (`access_token`, `refresh_token`, `expires_at`) into the
 * long-lived in-memory account object, so re-authentication via the API is
 * picked up instead of refreshing with stale tokens. It then delegates to
 * `getValidAccessToken` (which refreshes if necessary).
 *
 * It deliberately never reads or writes paused state: the token refresh path
 * doesn't check `paused`, and the old resume/re-pause dance rewrote
 * `pause_reason` to 'manual' on every poll cycle, breaking auto-resume for
 * accounts paused with auto-resumable reasons (overage, rate_limit_window)
 * and briefly making manually-paused accounts routable.
 */
export function createUsagePollingTokenProvider(
	account: Account,
	proxyContext: ProxyContext,
	deps: UsagePollingTokenProviderDeps = { getValidAccessToken },
): () => Promise<string> {
	return async () => {
		// Update in-memory account with fresh token data from DB, so
		// re-authentication via the API is picked up instead of refreshing with
		// stale tokens. Guarded: the DB row can also be BEHIND the in-memory
		// account (a request-path rotation whose persist is still settling or
		// failed), and blindly copying it back would guarantee a replay of the
		// consumed refresh token on the next refresh — so each field is adopted
		// only when the DB copy is not older.
		const currentAccount = await proxyContext.dbOps.getAccount(account.id);
		if (currentAccount) {
			const dbIssuedAt = currentAccount.refresh_token_issued_at ?? null;
			const memIssuedAt = account.refresh_token_issued_at ?? null;
			const dbRefreshNotOlder =
				memIssuedAt === null ||
				(dbIssuedAt !== null && dbIssuedAt >= memIssuedAt);
			// Adopt the DB access token when it is not older by expiry — or when
			// it belongs to a strictly newer refresh generation (a re-auth's token
			// can carry a SHORTER expiry than a stale pre-re-auth one and must
			// still win; the pre-re-auth token may be revoked).
			const dbGenerationStrictlyNewer =
				dbIssuedAt !== null &&
				(memIssuedAt === null || dbIssuedAt > memIssuedAt) &&
				currentAccount.access_token !== account.access_token;
			if (
				(currentAccount.expires_at ?? 0) >= (account.expires_at ?? 0) ||
				dbGenerationStrictlyNewer
			) {
				account.access_token = currentAccount.access_token;
				account.expires_at = currentAccount.expires_at;
			}
			if (currentAccount.refresh_token && dbRefreshNotOlder) {
				account.refresh_token = currentAccount.refresh_token;
				account.refresh_token_issued_at =
					currentAccount.refresh_token_issued_at;
			}
		}

		// Get a valid access token (refreshes if necessary)
		return deps.getValidAccessToken(account, proxyContext);
	};
}
