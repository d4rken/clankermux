import { Logger } from "@clankermux/logger";
import type { Account, AccountIdentity } from "@clankermux/types";

/**
 * How stale an account's subscription capture may get before the next usage
 * poll re-reads the profile. Same 6h the Codex coordinator uses
 * (`CODEX_SUBSCRIPTION_CHECK_INTERVAL_MS`).
 *
 * The profile endpoint shares the usage endpoint's rate-limit bucket, which the
 * 90s usage poll already spends ~960 requests a day per account into; four more
 * is not a cost worth a cheaper cadence.
 */
export const ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AnthropicSubscriptionRefreshDeps {
	/** Re-read the row: the throttle and the provider gate need CURRENT state. */
	getAccount: (accountId: string) => Promise<Account | null>;
	/** Fetch + normalize a profile identity; fails open (null on any error). */
	fetchProfile: (accessToken: string) => Promise<AccountIdentity | null>;
	/** Persist a captured identity through the shared identity write. */
	setIdentity: (accountId: string, identity: AccountIdentity) => Promise<void>;
	/** Advance the throttle alone, with no claim about what was observed. */
	touchSubscriptionCheck: (
		accountId: string,
		checkedAtMs: number,
	) => Promise<void>;
	now?: () => number;
	logger?: Logger;
	/**
	 * How the read is detached from the poll that resolved the token. The default
	 * drops the (never-rejecting) promise on the floor, which is the point: the
	 * poll must not wait on a profile read. Tests inject a collector so they can
	 * await the read they triggered.
	 */
	detach?: (read: Promise<void>) => void;
}

/**
 * Whether this account's subscription state is stale enough to re-read.
 *
 * The provider gate is `anthropic` plus a refresh token: `claude-console-api`
 * accounts are a different provider and have no OAuth profile endpoint, and an
 * Anthropic row without a refresh token is an API-key account.
 *
 * The throttle gates on `identity_subscription_checked_at`, which records the
 * last capture ATTEMPT rather than the last success — see
 * {@link refreshAnthropicSubscription} for why that distinction is what keeps a
 * failing account off every poll tick.
 */
export function isAnthropicSubscriptionRefreshDue(
	account: Account,
	nowMs: number,
): boolean {
	if (account.provider !== "anthropic") return false;
	if (!account.refresh_token) return false;
	const checkedAt = account.identity_subscription_checked_at;
	return (
		checkedAt == null ||
		nowMs - checkedAt >= ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS
	);
}

/**
 * Re-read one Anthropic OAuth account's profile and persist what it reports, at
 * most once per {@link ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS}.
 *
 * Strictly additive, in the same sense as the Codex coordinator's subscription
 * capture: it never reports a failure to its caller, never touches credential
 * health, and never pauses or resumes anything. `accessToken` is the token the
 * caller resolved for this very moment — never one captured earlier, which is
 * the staleness that makes a read 401 against credentials that have since
 * rotated.
 *
 * Every attempt stamps the throttle, success and failure alike. Stamping only
 * on success would re-issue the profile GET on every 90s poll for an account
 * whose profile endpoint is failing, which is the load this throttle exists to
 * prevent.
 */
export async function refreshAnthropicSubscription(
	accountId: string,
	accessToken: string,
	deps: AnthropicSubscriptionRefreshDeps,
): Promise<void> {
	const log = deps.logger ?? new Logger("AnthropicSubscriptionRefresh");
	const nowMs = (deps.now ?? Date.now)();

	try {
		if (!accessToken) return;
		const account = await deps.getAccount(accountId);
		if (!account) return;
		if (!isAnthropicSubscriptionRefreshDue(account, nowMs)) return;

		try {
			const identity = await deps.fetchProfile(accessToken);
			if (identity) {
				// Written through the identity COALESCE merge, so the Anthropic-gated
				// renewal-anchor seeding still runs for an account that has no anchor.
				// The merge cannot CLEAR a column: a status that changes (active →
				// canceled) is a new non-null value and lands, a status the profile
				// stops reporting altogether stays at its last observed value.
				await deps.setIdentity(accountId, identity);
				log.debug(`refreshed subscription state for ${account.name}`);
			} else {
				// Fail-open: the read says nothing about the subscription, so only the
				// throttle moves — writing the empty state would erase what an earlier
				// successful read observed.
				log.debug(
					`subscription refresh returned nothing for ${account.name} (retrying after the throttle)`,
				);
			}
		} finally {
			await deps.touchSubscriptionCheck(accountId, nowMs);
		}
	} catch (err) {
		log.warn(
			`subscription refresh failed for account ${accountId}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/**
 * Compose the usage poller's token provider with the throttled subscription
 * re-read.
 *
 * The token provider is the seam because it already has exactly the lifecycle
 * the read needs: it is invoked once per poll (so the read inherits the poll's
 * cadence and its boot stagger), it resolves a live token at that moment, and
 * `usageCache.stopPolling` drops it — so an account that stops polling stops
 * being read, with no second timer to keep in step.
 *
 * The read is detached rather than awaited: a slow or failing profile fetch
 * must not delay the usage poll, and {@link refreshAnthropicSubscription} never
 * rejects, so it cannot fail one either. A token-resolution failure is passed
 * through untouched — the poller's own `onTokenRefreshFailure` handling depends
 * on seeing it — and issues no read.
 */
export function withAnthropicSubscriptionRefresh(
	accountId: string,
	tokenProvider: () => Promise<string>,
	deps: AnthropicSubscriptionRefreshDeps,
): () => Promise<string> {
	const detach =
		deps.detach ??
		((read: Promise<void>) => {
			void read;
		});
	return async () => {
		const accessToken = await tokenProvider();
		if (accessToken) {
			detach(refreshAnthropicSubscription(accountId, accessToken, deps));
		}
		return accessToken;
	};
}
