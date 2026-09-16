import { PAUSE_REASON_NEEDS_REAUTH } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Account, AccountIdentity } from "@clankermux/types";

/**
 * Delay between successive per-account profile fetches. The Anthropic profile
 * endpoint shares the aggressively-rate-limited bucket as the usage endpoint, so
 * the backfill is deliberately SEQUENTIAL with a gap between accounts (a handful
 * of accounts is expected — never parallelize).
 */
const DEFAULT_STAGGER_MS = 2_500;

/**
 * Wait before the first fetch so the backfill doesn't pile onto the boot-time
 * usage-polling stagger wave (which itself fires one poll per Anthropic account
 * with a 5s stride). By the time this fires, the initial poll burst has settled.
 */
const DEFAULT_INITIAL_DELAY_MS = 15_000;

/**
 * Selection predicate for the one-time startup profile backfill.
 *
 * An account is a candidate when ALL hold:
 *   - provider is Anthropic OAuth: `provider === "anthropic"` with BOTH a
 *     refresh_token AND an access_token (api-key accounts have neither / an
 *     empty refresh_token, so the truthy checks exclude them).
 *   - it has never had a successful profile fetch: `identity_profile_fetched_at`
 *     is null. This is the one-time gate — once a fetch succeeds and stamps that
 *     column, the account is never re-selected on any future restart.
 *   - it is NOT paused for a dead/invalid refresh token. We mirror the exact
 *     predicate the usage poller uses to halt dead-token accounts —
 *     `pause_reason === PAUSE_REASON_NEEDS_REAUTH` (== "oauth_invalid_grant"),
 *     see `shouldStopPollingPausedAccount` in usage-polling-halt.ts — so we
 *     never hammer an account whose token can only be revived by manual reauth.
 *
 * Note we intentionally do NOT skip accounts paused for other reasons (e.g.
 * `overage`, `subscription_expired`): those may still hold a valid access token
 * whose profile is worth capturing once.
 */
export function isAnthropicProfileBackfillCandidate(account: Account): boolean {
	return (
		account.provider === "anthropic" &&
		!!account.refresh_token &&
		!!account.access_token &&
		account.identity_profile_fetched_at == null &&
		account.pause_reason !== PAUSE_REASON_NEEDS_REAUTH
	);
}

/**
 * Names the one-shot subscription re-capture in `strategies`. Once this row
 * exists the re-capture population is never selected again, on any restart.
 */
export const SUBSCRIPTION_RECAPTURE_MARKER =
	"backfill:anthropic-subscription-recapture";

/**
 * Selection predicate for the one-shot subscription re-capture: an Anthropic
 * OAuth account whose profile HAS been read but which holds no subscription
 * start.
 *
 * These accounts are exactly the ones
 * {@link isAnthropicProfileBackfillCandidate} can no longer see. Their profile
 * was captured before the profile endpoint's subscription fields were read, so
 * the stamp that retires them from that pass was set while the columns it now
 * fills were still null.
 *
 * The null-subscription half is NOT self-clearing: an account whose profile
 * genuinely reports no subscription data still matches after its fetch. That is
 * why the pass is gated on {@link SUBSCRIPTION_RECAPTURE_MARKER} and why this
 * predicate must never be the only thing between the pass and a fetch on every
 * boot.
 */
export function isAnthropicSubscriptionRecaptureCandidate(
	account: Account,
): boolean {
	return (
		account.provider === "anthropic" &&
		!!account.refresh_token &&
		!!account.access_token &&
		account.identity_profile_fetched_at != null &&
		account.identity_subscription_started_at == null &&
		account.pause_reason !== PAUSE_REASON_NEEDS_REAUTH
	);
}

export interface AnthropicProfileBackfillDeps {
	/** Snapshot of all accounts (the backfill filters down to its candidates). */
	getAccounts: () => Promise<Account[]>;
	/** Fetch + normalize a profile identity; MUST fail open (null on any error). */
	fetchProfile: (accessToken: string) => Promise<AccountIdentity | null>;
	/**
	 * Persist a captured identity, stamping `identity_profile_fetched_at` (the
	 * one-time gate). Called ONLY on a non-null fetch result.
	 */
	setIdentity: (accountId: string, identity: AccountIdentity) => Promise<void>;
	logger?: Logger;
	/** Delay between accounts (default 2.5s). */
	staggerMs?: number;
	/** Delay before the first fetch (default 15s). */
	initialDelayMs?: number;
	/** Injectable sleep — tests pass a no-op to avoid real timers. */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Claim {@link SUBSCRIPTION_RECAPTURE_MARKER}, returning true only for the
	 * caller that claimed it. Omit the dep and the re-capture population is never
	 * selected — the pass then covers accounts that have never had a profile
	 * fetch and nothing else.
	 */
	claimSubscriptionRecapture?: () => Promise<boolean>;
}

/**
 * One-time, staggered, fail-open startup backfill of Anthropic OAuth account
 * profile identities. Fetches `GET /api/oauth/profile` and merges the result
 * into the identity columns via
 * {@link AnthropicProfileBackfillDeps.setIdentity}.
 *
 * Two populations, each with its own one-shot gate, sharing one staggered loop:
 *   - accounts that have never had a successful profile fetch
 *     ({@link isAnthropicProfileBackfillCandidate});
 *   - accounts whose profile was fetched before the subscription fields were
 *     captured ({@link isAnthropicSubscriptionRecaptureCandidate}), gated on
 *     {@link SUBSCRIPTION_RECAPTURE_MARKER} because their own predicate does not
 *     clear itself.
 *
 * Guarantees:
 *   - Idempotent across restarts: the first population is gated on
 *     `identity_profile_fetched_at IS NULL`, so a success stamps that column and
 *     the account is never re-fetched while a null (failed/rate-limited) fetch
 *     leaves it eligible next boot; the second is gated on the marker, so it is
 *     selected once per database whatever any profile returns.
 *   - Crash-safe: the ENTIRE body is wrapped so no error — from the account
 *     query, a fetch, or a write — can ever escape. Callers fire-and-forget it.
 *   - Non-blocking: sleeps an initial delay, then processes accounts one at a
 *     time with a gap between each. Intended to be launched (not awaited) after
 *     the server is listening.
 */
export async function runAnthropicProfileBackfill(
	deps: AnthropicProfileBackfillDeps,
): Promise<void> {
	const log = deps.logger ?? new Logger("AnthropicProfileBackfill");
	const staggerMs = deps.staggerMs ?? DEFAULT_STAGGER_MS;
	const initialDelayMs = deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	try {
		const allAccounts = await deps.getAccounts();
		const neverFetched = allAccounts.filter(
			isAnthropicProfileBackfillCandidate,
		);
		const missingSubscription = deps.claimSubscriptionRecapture
			? allAccounts.filter(isAnthropicSubscriptionRecaptureCandidate)
			: [];
		const skipped =
			allAccounts.length - neverFetched.length - missingSubscription.length;

		if (neverFetched.length === 0 && missingSubscription.length === 0) {
			log.debug(`profile backfill: no candidates (${skipped} skipped)`);
			return;
		}
		log.info(
			`profile backfill: ${neverFetched.length} Anthropic account(s) missing profile identity, ${missingSubscription.length} missing subscription capture, ${skipped} skipped`,
		);

		if (initialDelayMs > 0) await sleep(initialDelayMs);

		// Claimed here rather than up front: the claim retires the re-capture
		// population permanently, so it is spent only once the pass is about to do
		// the fetches, and only when there is something to re-capture. Both
		// populations then share ONE staggered loop — two concurrent loops would
		// double the rate into the profile endpoint's shared bucket.
		const recapture =
			missingSubscription.length > 0 && (await claimRecapture(deps, log))
				? missingSubscription
				: [];
		const candidates = [...neverFetched, ...recapture];
		if (candidates.length === 0) {
			log.debug("profile backfill: nothing to do after the re-capture claim");
			return;
		}

		let fetched = 0;
		let failed = 0;
		for (const [index, account] of candidates.entries()) {
			// Stagger between accounts (not before the first — the initial delay
			// already covered that).
			if (index > 0 && staggerMs > 0) await sleep(staggerMs);
			try {
				const accessToken = account.access_token;
				if (!accessToken) {
					// Shouldn't happen (predicate requires a truthy token), but stay safe.
					failed++;
					continue;
				}
				const identity = await deps.fetchProfile(accessToken);
				if (!identity) {
					// Fail-open: leave identity_profile_fetched_at null so it retries
					// on a future restart.
					failed++;
					log.debug(
						`profile backfill: fetch returned null for ${account.name} (will retry next restart)`,
					);
					continue;
				}
				await deps.setIdentity(account.id, identity);
				fetched++;
				log.debug(`profile backfill: captured identity for ${account.name}`);
			} catch (err) {
				failed++;
				log.warn(
					`profile backfill: error for account ${account.name}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		log.info(
			`profile backfill: ${fetched} fetched, ${skipped} skipped, ${failed} failed`,
		);
	} catch (err) {
		// Belt-and-braces: a failure here must never crash the server.
		log.error(
			`profile backfill aborted: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/**
 * Claim the one-shot re-capture marker, fail-closed: a claim that throws leaves
 * the marker unclaimed and skips the population this boot, rather than letting
 * an unavailable database turn into an unguarded re-fetch.
 */
async function claimRecapture(
	deps: AnthropicProfileBackfillDeps,
	log: Logger,
): Promise<boolean> {
	if (!deps.claimSubscriptionRecapture) return false;
	try {
		const claimed = await deps.claimSubscriptionRecapture();
		if (!claimed) {
			log.debug(
				`profile backfill: ${SUBSCRIPTION_RECAPTURE_MARKER} already claimed, skipping re-capture`,
			);
		}
		return claimed;
	} catch (err) {
		log.warn(
			`profile backfill: could not claim ${SUBSCRIPTION_RECAPTURE_MARKER}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return false;
	}
}
