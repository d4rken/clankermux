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
		// Update in-memory account with fresh token data from DB
		// This prevents using stale tokens after re-authentication
		const currentAccount = await proxyContext.dbOps.getAccount(account.id);
		if (currentAccount) {
			account.access_token = currentAccount.access_token;
			account.refresh_token = currentAccount.refresh_token;
			account.expires_at = currentAccount.expires_at;
		}

		// Get a valid access token (refreshes if necessary)
		return deps.getValidAccessToken(account, proxyContext);
	};
}
