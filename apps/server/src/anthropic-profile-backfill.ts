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
}

/**
 * One-time, staggered, fail-open startup backfill of Anthropic OAuth account
 * profile identities. Fetches `GET /api/oauth/profile` for accounts that have
 * never had a successful profile fetch and merges the result into their identity
 * columns via {@link AnthropicProfileBackfillDeps.setIdentity}.
 *
 * Guarantees:
 *   - Idempotent across restarts: gated on `identity_profile_fetched_at IS NULL`
 *     (via {@link isAnthropicProfileBackfillCandidate}). A success stamps that
 *     column so the account is never re-fetched; a null (failed/rate-limited)
 *     fetch leaves it null so the account is retried on the next boot.
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
		const candidates = allAccounts.filter(isAnthropicProfileBackfillCandidate);
		const skipped = allAccounts.length - candidates.length;

		if (candidates.length === 0) {
			log.debug(`profile backfill: no candidates (${skipped} skipped)`);
			return;
		}
		log.info(
			`profile backfill: ${candidates.length} Anthropic account(s) missing profile identity, ${skipped} skipped`,
		);

		if (initialDelayMs > 0) await sleep(initialDelayMs);

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
