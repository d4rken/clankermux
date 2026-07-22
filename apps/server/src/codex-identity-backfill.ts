import { Logger } from "@clankermux/logger";
import type { Account, AccountIdentity } from "@clankermux/types";

/**
 * Selection predicate for the one-time startup Codex identity backfill.
 *
 * An account is a candidate when ALL hold:
 *   - provider is Codex (`provider === "codex"`).
 *   - it has an access token to decode (`access_token` truthy — api-key Codex
 *     accounts have none, so this excludes them).
 *   - it is still missing at least one of the two identity fields the decode can
 *     supply: `identity_external_id` OR `identity_email` is null. Once BOTH are
 *     populated the account is skipped, so a backfilled account is never
 *     re-processed on a future restart.
 *
 * Unlike the Anthropic profile backfill, there is no dead-token / pause guard:
 * the decode is a pure LOCAL JWT parse (no network), and even an expired token
 * decodes fine.
 */
export function isCodexIdentityBackfillCandidate(account: Account): boolean {
	return (
		account.provider === "codex" &&
		!!account.access_token &&
		(account.identity_external_id == null || account.identity_email == null)
	);
}

export interface CodexIdentityBackfillDeps {
	/** Snapshot of all accounts (the backfill filters down to its candidates). */
	getAccounts: () => Promise<Account[]>;
	/**
	 * Decode the access token into a normalized identity, or null if the token
	 * cannot be decoded. Pure local decode — no network.
	 */
	extractIdentity: (accessToken: string) => AccountIdentity | null;
	/** Persist a captured identity (does NOT stamp identity_profile_fetched_at). */
	setIdentity: (accountId: string, identity: AccountIdentity) => Promise<void>;
	logger?: Logger;
}

function hasAnyIdentityField(identity: AccountIdentity): boolean {
	return (
		identity.externalAccountId != null ||
		identity.email != null ||
		identity.planTier != null
	);
}

/**
 * One-time, LOCAL, crash-safe startup backfill of Codex account identities.
 *
 * Codex identity is normally captured on a token refresh (JWT decode); an
 * account whose token hasn't refreshed since the feature shipped stays blank in
 * the dashboard. This routine decodes the stored access token of every candidate
 * ({@link isCodexIdentityBackfillCandidate}) and merges any resolved fields into
 * the account's identity columns via {@link CodexIdentityBackfillDeps.setIdentity}.
 *
 * Because the decode is a pure local parse (no network), it is far simpler than
 * the Anthropic profile backfill: no stagger, no initial delay, no fail-open
 * network handling, no dead-token skip — candidates are processed synchronously
 * in a single loop.
 *
 * Guarantees:
 *   - Idempotent across restarts: gated on a missing external id OR email, so an
 *     account with both populated is never re-selected.
 *   - Crash-safe: the ENTIRE body is wrapped so no error can escape. Each account
 *     is additionally isolated so one failure never stops the rest. Callers
 *     fire-and-forget it.
 */
export async function runCodexIdentityBackfill(
	deps: CodexIdentityBackfillDeps,
): Promise<void> {
	const log = deps.logger ?? new Logger("CodexIdentityBackfill");

	try {
		const allAccounts = await deps.getAccounts();
		const candidates = allAccounts.filter(isCodexIdentityBackfillCandidate);

		if (candidates.length === 0) {
			log.debug("codex identity backfill: no candidates");
			return;
		}
		log.info(
			`codex identity backfill: ${candidates.length} Codex account(s) missing identity`,
		);

		let captured = 0;
		let skipped = 0;
		let failed = 0;
		for (const account of candidates) {
			try {
				const accessToken = account.access_token;
				if (!accessToken) {
					// Shouldn't happen (predicate requires a truthy token), but stay safe.
					skipped++;
					continue;
				}
				const identity = deps.extractIdentity(accessToken);
				if (!identity || !hasAnyIdentityField(identity)) {
					skipped++;
					log.debug(
						`codex identity backfill: nothing to capture for ${account.name}`,
					);
					continue;
				}
				await deps.setIdentity(account.id, identity);
				captured++;
				log.debug(
					`codex identity backfill: captured identity for ${account.name}`,
				);
			} catch (err) {
				failed++;
				log.warn(
					`codex identity backfill: error for account ${account.name}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		log.info(
			`codex identity backfill: ${captured} captured, ${skipped} skipped, ${failed} failed`,
		);
	} catch (err) {
		// Belt-and-braces: a failure here must never crash the server.
		log.error(
			`codex identity backfill aborted: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}
