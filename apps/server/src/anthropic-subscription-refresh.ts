import { Logger } from "@clankermux/logger";
import type { AnthropicUsageObservation } from "@clankermux/providers";
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

export const ANTHROPIC_SUBSCRIPTION_RECHECK_INTERVAL_MS = 60_000;

export interface AnthropicSubscriptionRefreshDeps {
	/**
	 * Read the row. Called twice, both times for CURRENT state: once before the
	 * claim, and again after the fetch to confirm the account is still one this
	 * may write to.
	 */
	getAccount: (accountId: string) => Promise<Account | null>;
	/** Fetch + normalize a profile identity; fails open (null on any error). */
	fetchProfile: (accessToken: string) => Promise<AccountIdentity | null>;
	/**
	 * Persist a captured identity through the shared identity write, as a
	 * compare-and-swap on `expectedAccessToken`: the row must still hold the
	 * token this profile was read with. False means it no longer does and
	 * nothing was written.
	 */
	setIdentity: (
		accountId: string,
		identity: AccountIdentity,
		expectedAccessToken: string,
	) => Promise<boolean>;
	/**
	 * Claim this account's next read: stamp `identity_subscription_checked_at`
	 * only if the row is still an Anthropic OAuth account whose stamp is null or
	 * older than the throttle, in ONE statement, and report whether the stamp
	 * moved. False means another invocation owns this window.
	 */
	claimSubscriptionCheck: (
		accountId: string,
		nowMs: number,
		throttleMs: number,
	) => Promise<boolean>;
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
 * Whether this row is an account this module may read a profile for and write
 * an identity to, with no throttle in it.
 *
 * `claude-console-api` accounts are a different provider and have no OAuth
 * profile endpoint, and an Anthropic row without a refresh token is an API-key
 * account.
 */
export function isAnthropicSubscriptionRefreshEligible(
	account: Account,
): boolean {
	return account.provider === "anthropic" && Boolean(account.refresh_token);
}

/**
 * Whether this account's subscription state is stale enough to re-read.
 *
 * The throttle gates on `identity_subscription_checked_at`, which records the
 * last capture ATTEMPT rather than the last success — see
 * {@link refreshAnthropicSubscription} for why that distinction is what keeps a
 * failing account off every poll tick.
 *
 * This is a predicate over a row that was read at some earlier instant, so it
 * answers "worth trying", never "mine". The claim in
 * {@link AnthropicSubscriptionRefreshDeps.claimSubscriptionCheck} decides that,
 * against the same window.
 */
export function isAnthropicSubscriptionRefreshDue(
	account: Account,
	nowMs: number,
	throttleMs = ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS,
): boolean {
	if (!isAnthropicSubscriptionRefreshEligible(account)) return false;
	const checkedAt = account.identity_subscription_checked_at;
	return checkedAt == null || nowMs - checkedAt >= throttleMs;
}

/** The claim throttles attempts, including failed reads, across restarts. */
export async function refreshAnthropicSubscription(
	accountId: string,
	accessToken: string,
	deps: AnthropicSubscriptionRefreshDeps,
	options: { throttleMs?: number; isCurrent?: () => boolean } = {},
): Promise<void> {
	const log = deps.logger ?? new Logger("AnthropicSubscriptionRefresh");
	const nowMs = (deps.now ?? Date.now)();
	const isCurrent = options.isCurrent ?? (() => true);
	const throttleMs = Math.max(
		ANTHROPIC_SUBSCRIPTION_RECHECK_INTERVAL_MS,
		options.throttleMs ?? ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS,
	);
	try {
		if (!accessToken || !isCurrent()) return;
		const account = await deps.getAccount(accountId);
		if (
			!account ||
			!isCurrent() ||
			!isAnthropicSubscriptionRefreshDue(account, nowMs, throttleMs)
		)
			return;
		if (
			!(await deps.claimSubscriptionCheck(accountId, nowMs, throttleMs)) ||
			!isCurrent()
		)
			return;
		const identity = await deps.fetchProfile(accessToken);
		if (!identity || !isCurrent()) return;
		const current = await deps.getAccount(accountId);
		if (
			!current ||
			!isCurrent() ||
			!isAnthropicSubscriptionRefreshEligible(current)
		)
			return;
		if (!(await deps.setIdentity(accountId, identity, accessToken))) {
			log.debug(
				`discarding subscription read for ${account.name}: credentials changed during the read`,
			);
			return;
		}
		log.debug(`refreshed subscription state for ${current.name}`);
	} catch (err) {
		log.warn(
			`subscription refresh failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export interface AnthropicUsageObservationDeps
	extends AnthropicSubscriptionRefreshDeps {
	recordUsageAccess: (
		accountId: string,
		accessToken: string,
		permissionDenied: boolean,
	) => Promise<boolean>;
}

export async function observeAnthropicUsage(
	observation: AnthropicUsageObservation,
	deps: AnthropicUsageObservationDeps,
): Promise<void> {
	const { accountId, accessToken, outcome, firstPermissionDenial, isCurrent } =
		observation;
	if (!isCurrent()) return;
	const log = deps.logger ?? new Logger("AnthropicSubscriptionRefresh");
	try {
		const changed = await deps.recordUsageAccess(
			accountId,
			accessToken,
			outcome === "permission_denied",
		);
		if (!isCurrent()) return;
		if (changed)
			log.info(
				`Account ${accountId}: usage access ${outcome === "success" ? "restored" : "denied"}`,
			);
		await refreshAnthropicSubscription(accountId, accessToken, deps, {
			isCurrent,
			throttleMs:
				firstPermissionDenial || (outcome === "success" && changed)
					? ANTHROPIC_SUBSCRIPTION_RECHECK_INTERVAL_MS
					: ANTHROPIC_SUBSCRIPTION_REFRESH_INTERVAL_MS,
		});
	} catch (err) {
		log.warn(
			`usage access diagnosis failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
