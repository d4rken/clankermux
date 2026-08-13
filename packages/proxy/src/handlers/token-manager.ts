import {
	isInvalidGrantMessage,
	OAuthRefreshTokenError,
	PAUSE_REASON_NEEDS_REAUTH,
	registerDisposable,
	ServiceUnavailableError,
	TokenRefreshError,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { getProvider, type TokenRefreshResult } from "@clankermux/providers";
import type {
	Account,
	CodexRateLimitResetCreditConsumeRequest,
	CodexRateLimitResetCreditConsumeResult,
} from "@clankermux/types";
import { TOKEN_REFRESH_BACKOFF_MS, TOKEN_SAFETY_WINDOW_MS } from "../constants";
import {
	clearPendingRotationIfCurrent,
	flushPendingRotation,
	getPendingRotation,
	type PendingRotation,
	recordPendingRotation,
	resolvePendingAfterPersist,
} from "./pending-rotation-registry";
import { ERROR_MESSAGES, type ProxyContext } from "./proxy-types";
import {
	checkRefreshTokenHealth,
	getOAuthErrorMessage,
} from "./token-health-monitor";

const log = new Logger("TokenManager");

/**
 * Providers whose `refreshToken()` performs a genuine OAuth access-token exchange
 * — a real network round-trip that returns a NEW, usable bearer token. Only these
 * are eligible for a reactive stale-token refresh after an upstream 401.
 *
 * Deliberately a positive ALLOWLIST, not a denylist. Several providers carry a
 * `refresh_token` and/or report `supportsOAuth() === true`, yet inherit
 * `OpenAICompatibleProvider.refreshToken`, which just echoes `account.refresh_token`
 * back as the access token (no exchange) — Qwen is the notable case. Reactively
 * "refreshing" one of those would overwrite the stored access token with the
 * refresh token and retry upstream with the wrong bearer (credential corruption),
 * so a denylist that forgets one is a security bug. An allowlist fails safe: an
 * unlisted provider simply falls over on 401 as before. `anthropic` and `codex`
 * are the only providers with a real OAuth refresh; `claude-oauth` is the legacy
 * alias for anthropic OAuth accounts.
 */
const OAUTH_REACTIVE_REFRESH_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"claude-oauth",
	"codex",
]);

/**
 * Whether an account is eligible for a reactive access-token refresh after an
 * upstream 401. True only for accounts that hold a refresh token AND whose
 * provider does a genuine OAuth token exchange (see
 * OAUTH_REACTIVE_REFRESH_PROVIDERS). Used by the proxy's stale-token 401 recovery
 * to decide whether to refresh + retry the same account before failing over.
 */
export function canAttemptStaleTokenRefresh(account: Account): boolean {
	return (
		Boolean(account.refresh_token) &&
		OAUTH_REACTIVE_REFRESH_PROVIDERS.has(account.provider)
	);
}

/** Minimal slice of DatabaseOperations needed to pause an account for reauth. */
interface ReauthPauser {
	pauseAccountIfActive(
		accountId: string,
		reason: string,
		expectedRefreshToken?: string | null,
	): Promise<boolean>;
}

/**
 * If `error` is a terminal OAuth refresh failure (revoked/invalid refresh token),
 * pause the account with the dedicated `oauth_invalid_grant` reason so the load
 * balancer fails over and the dashboard prompts for re-auth. Guarded on the
 * account still being active *and* still holding the refresh token that failed,
 * so it never clobbers a manual pause or re-pauses a freshly re-authenticated
 * account. Detection covers both the typed `OAuthRefreshTokenError` (Anthropic)
 * and the message string (other OAuth providers). Returns true if it paused.
 *
 * Shared by every refresh path: `refreshAccessTokenSafe` (real requests +
 * Anthropic auto-refresh probes) and the proactive Qwen/Codex refreshers.
 */
export async function pauseAccountForReauthIfInvalidGrant(
	error: unknown,
	account: { id: string; name: string; refresh_token: string | null },
	dbOps: ReauthPauser,
): Promise<boolean> {
	const message = error instanceof Error ? error.message : String(error);
	const isInvalidGrant =
		error instanceof OAuthRefreshTokenError || isInvalidGrantMessage(message);
	if (!isInvalidGrant) return false;
	try {
		const paused = await dbOps.pauseAccountIfActive(
			account.id,
			PAUSE_REASON_NEEDS_REAUTH,
			account.refresh_token ?? undefined,
		);
		if (paused) {
			log.error(
				`Account "${account.name}" PAUSED — OAuth refresh token rejected (needs re-authentication). Reauth from the dashboard (Accounts tab); it will auto-resume on success.`,
			);
		}
		return paused;
	} catch (pauseErr) {
		log.error(
			`Failed to pause account ${account.name} after invalid_grant:`,
			pauseErr,
		);
		return false;
	}
}

// Track refresh failures for backoff with TTL cleanup
const refreshFailures = new Map<string, number>();
// Track consecutive backoff hits per account
const backoffCounters = new Map<string, number>();
const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FAILURE_RECORDS = 1000; // Prevent unbounded growth
const MAX_BACKOFF_RETRIES = 10; // After 10 backoff hits, check DB

// Single-flight coalesce cache: a very-recent SUCCESSFUL refresh, keyed by
// account id. OAuth providers rotate refresh tokens (a successful refresh
// returns a new one and invalidates the old), so two near-simultaneous refresh
// triggers each holding a stale `account` snapshot would race: the first wins
// and rotates, the second runs with the now-invalidated old token and fails
// with invalid_grant / refresh_token_reused. When a caller arrives within the
// coalesce window of a fresh refresh, we hand back the cached token instead of
// firing that doomed second rotation.
interface RecentRefresh {
	accessToken: string;
	expiresAt: number;
	at: number;
}
const recentRefreshes = new Map<string, RecentRefresh>();
const REFRESH_COALESCE_WINDOW_MS = 10_000; // reuse a very-recent successful refresh instead of racing a second rotation
const RECENT_REFRESH_MIN_HEADROOM_MS = 60_000; // only reuse while the cached token is still comfortably valid

/**
 * Record a very-recent SUCCESSFUL refresh for single-flight coalescing so a
 * near-simultaneous caller (including the proactive scheduler paths, which call
 * `provider.refreshToken` directly and share this module-level cache) reuses this
 * token instead of racing a second (doomed) rotation.
 */
export function recordRecentRefresh(
	accountId: string,
	accessToken: string,
	expiresAt: number,
): void {
	recentRefreshes.set(accountId, { accessToken, expiresAt, at: Date.now() });
}

/**
 * Return a very-recent successful refresh worth reusing instead of firing a
 * second (doomed) rotation, or null. Reusable only when: within the coalesce
 * window, the cached token still has comfortable expiry headroom, AND it differs
 * from the token the caller already holds (so a caller whose CURRENT token was
 * just rejected upstream still forces a real refresh — never served back its own
 * failing token).
 */
export function getCoalescibleRecentRefresh(
	accountId: string,
	currentAccessToken: string | null,
): { accessToken: string; expiresAt: number } | null {
	const recent = recentRefreshes.get(accountId);
	if (
		recent &&
		Date.now() - recent.at < REFRESH_COALESCE_WINDOW_MS &&
		recent.expiresAt - Date.now() > RECENT_REFRESH_MIN_HEADROOM_MS &&
		recent.accessToken !== currentAccessToken
	) {
		return { accessToken: recent.accessToken, expiresAt: recent.expiresAt };
	}
	return null;
}

/** Minimal slice of DatabaseOperations needed to re-read an account row. */
interface AccountReader {
	getAccount(accountId: string): Promise<Account | null>;
}

/**
 * After a lost persist CAS (the stored refresh token changed underneath a
 * successful refresh), re-read the row and install the AUTHORITATIVE DB
 * credentials onto the in-memory account. The winning writer (a concurrent
 * rotation or a manual re-auth) may have invalidated the losing token's whole
 * session family, so serving the just-minted-but-losing token risks immediate
 * 401s.
 *
 * The row IS the authority here, so its refresh token is adopted whenever the
 * row is readable — even when its access token is not servable — so the losing
 * refresh generation never survives in memory to be replayed. Returns the
 * adopted access token when it is servable (comfortably unexpired), else
 * null — callers then fall back to the minted ACCESS token only.
 *
 * Shared by every path that persists a rotation with the exchanged-token CAS
 * (`refreshAccessTokenSafe`, the proactive Codex/Qwen refreshers) and by the
 * in-flight join to sync a caller whose winner adopted rather than minted.
 */
export async function adoptAuthoritativeAccountTokens(
	account: Pick<
		Account,
		| "id"
		| "name"
		| "access_token"
		| "expires_at"
		| "refresh_token"
		| "refresh_token_issued_at"
	>,
	dbOps: AccountReader,
): Promise<string | null> {
	try {
		const dbAccount = await dbOps.getAccount(account.id);
		if (!dbAccount) return null;
		if (dbAccount.refresh_token) {
			account.refresh_token = dbAccount.refresh_token;
			account.refresh_token_issued_at = dbAccount.refresh_token_issued_at;
		}
		const dbAccessToken = dbAccount.access_token;
		const dbExpiresAt = dbAccount.expires_at;
		const servable =
			typeof dbAccessToken === "string" &&
			typeof dbExpiresAt === "number" &&
			dbExpiresAt - Date.now() > TOKEN_SAFETY_WINDOW_MS;
		if (!servable) return null;
		account.access_token = dbAccessToken;
		account.expires_at = dbExpiresAt;
		return dbAccessToken;
	} catch (error) {
		log.warn(
			`Failed to re-read account ${account.name} after a lost persist CAS — keeping the in-memory tokens`,
			error,
		);
		return null;
	}
}

/** Whether a pending rotation's access token is still worth serving. */
function isPendingAccessTokenServable(entry: PendingRotation): boolean {
	return entry.expiresAt - Date.now() > TOKEN_SAFETY_WINDOW_MS;
}

/**
 * Install a pending rotation's REFRESH generation on the in-memory account. The
 * stamp is the entry's `recordedAt` (when the provider committed the rotation),
 * never `Date.now()`: a later stamp would make a genuinely newer writer's row
 * look older to the staleness guards.
 */
function installPendingRefreshGeneration(
	account: Account,
	entry: PendingRotation,
): void {
	if (entry.refreshToken) {
		account.refresh_token = entry.refreshToken;
	}
	account.refresh_token_issued_at = entry.recordedAt;
}

/** Install a pending rotation's full credentials on the in-memory account. */
function installPendingRotationCredentials(
	account: Account,
	entry: PendingRotation,
): void {
	account.access_token = entry.accessToken;
	account.expires_at = entry.expiresAt;
	installPendingRefreshGeneration(account, entry);
}

/**
 * Re-read the account row right before firing a refresh and adopt fresher
 * credentials another writer already produced:
 *
 * - A valid access token with a STRICTLY newer expiry (comparison is by expiry,
 *   never by string difference, so a merely delayed read can't masquerade as
 *   "fresher") → adopt it and return it; the caller skips the refresh entirely.
 * - A rotated refresh token (guarded on `refresh_token_issued_at` not being
 *   older than the in-memory one) → adopt it and return null; the refresh
 *   proceeds with the LIVE token. Replaying the consumed one is a guaranteed
 *   invalid_grant, and on providers with reuse detection (Codex) it can
 *   invalidate the whole token family.
 *
 * This is what makes a stale in-memory snapshot (long-lived poller accounts,
 * request snapshots held across failover holds) safe to refresh from.
 */
async function adoptDbTokensIfFresher(
	account: Account,
	ctx: ProxyContext,
): Promise<string | null> {
	// A pending rotation outranks the row: the provider already committed it and
	// the row still holds the token it consumed. Land it first — and while one
	// exists, the row is knowably stale, so the re-read below is skipped entirely
	// rather than allowed to adopt a consumed generation backwards.
	const { outcome: flushOutcome, entry: flushedEntry } =
		await flushPendingRotation(account.id, ctx.dbOps);
	if (flushOutcome === "persisted" && flushedEntry) {
		installPendingRotationCredentials(account, flushedEntry);
		if (isPendingAccessTokenServable(flushedEntry)) {
			refreshFailures.delete(account.id);
			backoffCounters.delete(account.id);
			log.info(
				`Persisted a pending rotation for account ${account.name} and adopted its access token — skipping the refresh`,
			);
			return flushedEntry.accessToken;
		}
		// The row now IS this entry, so a re-read could only repeat it; refresh
		// with the just-persisted refresh token.
		return null;
	}
	if (flushOutcome === "failed" || flushOutcome === "superseded") {
		// "failed" keeps the entry; "superseded" dropped it, but a NEWER entry
		// recorded meanwhile survives and still outranks the row.
		const live =
			flushOutcome === "failed" ? flushedEntry : getPendingRotation(account.id);
		if (live) {
			if (isPendingAccessTokenServable(live)) {
				installPendingRotationCredentials(account, live);
				log.info(
					`Serving the pending (unpersisted) access token for account ${account.name} — the stored row is known stale`,
				);
				return live.accessToken;
			}
			installPendingRefreshGeneration(account, live);
			return null;
		}
	}

	let dbAccount: Account | null;
	try {
		dbAccount = await ctx.dbOps.getAccount(account.id);
	} catch (error) {
		log.warn(
			`Pre-refresh DB re-read failed for account ${account.name} — refreshing with the in-memory tokens`,
			error,
		);
		return null;
	}
	if (!dbAccount) return null;

	const dbIssuedAt = dbAccount.refresh_token_issued_at ?? null;
	const memIssuedAt = account.refresh_token_issued_at ?? null;
	// A DB row predating issued-at tracking is never trusted over a snapshot
	// that carries a stamp; an unstamped snapshot always defers to the DB.
	const dbRefreshNotOlder =
		memIssuedAt === null || (dbIssuedAt !== null && dbIssuedAt >= memIssuedAt);

	const dbAccessToken = dbAccount.access_token;
	const dbExpiresAt = dbAccount.expires_at;
	// Adopt on a STRICTLY newer expiry — or, at equal/rounded expiry, on a
	// newer refresh generation (issued_at) with a differing token: the newer
	// generation proves this is not a delayed read of the caller's own
	// (possibly just-rejected) token, so serving it is safe. Consistent with
	// the policy above, an unstamped snapshot defers to a stamped DB row.
	const dbGenerationStrictlyNewer =
		dbIssuedAt !== null &&
		(memIssuedAt === null || dbIssuedAt > memIssuedAt) &&
		dbAccessToken !== account.access_token;
	if (
		typeof dbAccessToken === "string" &&
		typeof dbExpiresAt === "number" &&
		dbExpiresAt - Date.now() > TOKEN_SAFETY_WINDOW_MS &&
		(dbExpiresAt > (account.expires_at ?? 0) || dbGenerationStrictlyNewer)
	) {
		account.access_token = dbAccessToken;
		account.expires_at = dbExpiresAt;
		// A fresher ACCESS token does not imply a fresher REFRESH token (a
		// coalesced serve updates only the former), so the refresh token is
		// adopted under its own staleness guard.
		if (dbAccount.refresh_token && dbRefreshNotOlder) {
			account.refresh_token = dbAccount.refresh_token;
			account.refresh_token_issued_at = dbAccount.refresh_token_issued_at;
		}
		refreshFailures.delete(account.id);
		backoffCounters.delete(account.id);
		log.info(
			`Adopted a fresher access token from the DB for account ${account.name} — skipping the refresh`,
		);
		return dbAccessToken;
	}

	if (
		dbAccount.refresh_token &&
		dbAccount.refresh_token !== account.refresh_token &&
		dbRefreshNotOlder
	) {
		account.refresh_token = dbAccount.refresh_token;
		account.refresh_token_issued_at = dbAccount.refresh_token_issued_at;
		log.info(
			`Adopted a rotated refresh token from the DB for account ${account.name} before refreshing`,
		);
	}
	return null;
}

// Cleanup old failures periodically
let cleanupInterval: Timer | null = null;

export const startTokenCleanupInterval = () => {
	if (!cleanupInterval) {
		cleanupInterval = setInterval(() => {
			const now = Date.now();
			const toDelete: string[] = [];

			for (const [accountId, failureTime] of refreshFailures.entries()) {
				if (now - failureTime > FAILURE_TTL_MS) {
					toDelete.push(accountId);
				}
			}

			// Clean up both maps together
			toDelete.forEach((accountId) => {
				refreshFailures.delete(accountId);
				backoffCounters.delete(accountId);
			});

			// Expire stale coalesce-cache entries (short-lived by design).
			for (const [accountId, entry] of recentRefreshes.entries()) {
				if (now - entry.at > REFRESH_COALESCE_WINDOW_MS) {
					recentRefreshes.delete(accountId);
				}
			}

			// Enforce size limit during periodic cleanup to prevent memory bloat
			enforceMaxSize();

			if (toDelete.length > 0) {
				log.debug(`Cleaned up ${toDelete.length} expired failure records`);
			}
		}, FAILURE_TTL_MS / 10); // Run cleanup more frequently (every 30 seconds)
	}
};

export const stopTokenCleanupInterval = () => {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
};

// Start cleanup interval and register for shutdown
startTokenCleanupInterval();

// Register cleanup as disposable for proper shutdown
registerDisposable({
	dispose: () => {
		stopTokenCleanupInterval();
		refreshFailures.clear();
		backoffCounters.clear();
		recentRefreshes.clear();
	},
});

/**
 * Helper function to clean expired entries from refreshFailures Map
 */
function cleanupExpiredFailures(): void {
	const now = Date.now();
	const toDelete: string[] = [];

	for (const [accountId, failureTime] of refreshFailures.entries()) {
		if (now - failureTime > FAILURE_TTL_MS) {
			toDelete.push(accountId);
		}
	}

	toDelete.forEach((accountId) => {
		refreshFailures.delete(accountId);
		backoffCounters.delete(accountId); // Also clean up backoff counters
	});

	// Expire stale coalesce-cache entries (short-lived by design).
	for (const [accountId, entry] of recentRefreshes.entries()) {
		if (now - entry.at > REFRESH_COALESCE_WINDOW_MS) {
			recentRefreshes.delete(accountId);
		}
	}

	if (toDelete.length > 0) {
		log.debug(
			`Cleaned up ${toDelete.length} expired failure records during proactive cleanup`,
		);
	}
}

/**
 * Helper function to enforce maximum size limit on refreshFailures Map
 */
function enforceMaxSize(): void {
	if (refreshFailures.size > MAX_FAILURE_RECORDS) {
		// Remove oldest entries if we exceed the max size
		const _now = Date.now();
		const entries = Array.from(refreshFailures.entries()).sort(
			(a, b) => a[1] - b[1], // Sort by timestamp (oldest first)
		);

		const toRemove = entries.slice(
			0,
			refreshFailures.size - MAX_FAILURE_RECORDS + 1,
		);
		for (const [accountId] of toRemove) {
			refreshFailures.delete(accountId);
			backoffCounters.delete(accountId); // Also clean up backoff counters
		}

		if (toRemove.length > 0) {
			log.warn(
				`Removed ${toRemove.length} oldest failure records to maintain max size limit`,
			);
		}
	}
}

/**
 * Safely refreshes an access token with deduplication
 * @param account - The account to refresh token for
 * @param ctx - The proxy context
 * @returns Promise resolving to the new access token
 * @throws {TokenRefreshError} If token refresh fails
 * @throws {ServiceUnavailableError} If refresh promise is not found
 */
export async function refreshAccessTokenSafe(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// Join an in-progress refresh BEFORE consulting the coalesce cache: an active
	// refresh yields the freshest result, so a caller holding an older token joins
	// it rather than being served a possibly-stale (or already-rejected) cached
	// token while a replacement refresh is mid-flight. Also re-invoked after the
	// pre-refresh DB re-read below, whose await opens a window for another caller
	// to register a refresh.
	const joinInFlightRefresh = async (): Promise<string | null> => {
		const inFlight = ctx.refreshInFlight.get(account.id);
		if (!inFlight) return null;
		const joinedToken = await inFlight;
		// Sync this caller's account to the winner's fresh token so the 401-retry
		// path (which re-derives from account.access_token) uses it.
		const recent = recentRefreshes.get(account.id);
		if (recent && recent.accessToken === joinedToken) {
			account.access_token = recent.accessToken;
			account.expires_at = recent.expiresAt;
		} else if (account.access_token !== joinedToken) {
			// The winner resolved with a token it did NOT cache — its persist CAS
			// lost and it adopted the authoritative DB credentials. Sync this
			// caller's whole snapshot from the same authority (best-effort); its
			// stale fields would otherwise feed the 401-retry path a rejected token
			// or replay a consumed refresh token later. If the authority has moved
			// on again (e.g. a re-auth since the winner's adoption), the adopted
			// token is fresher than the joined one — return THAT, never a token
			// older than the account state just installed.
			const adopted = await adoptAuthoritativeAccountTokens(account, ctx.dbOps);
			if (adopted) return adopted;
			// No servable authority: keep the snapshot consistent with the token
			// handed back. Its true expiry is unknown here — and the snapshot's
			// own expiry may be far-future (a 401-rejected token is not
			// necessarily near expiry) — so null it out, which getValidAccessToken
			// treats as "refresh before next use" rather than trusting a stale
			// horizon for a token it doesn't belong to.
			account.access_token = joinedToken;
			account.expires_at = null;
		}
		return joinedToken;
	};
	const joined = await joinInFlightRefresh();
	if (joined !== null) return joined;

	// Coalesce short-circuit next (before the backoff gate): a just-completed
	// refresh already produced a fresh token; reuse it rather than racing a second
	// rotation (which would fail as invalid_grant/refresh_token_reused against the
	// just-invalidated old token) — and skip the backoff gate, since serving a
	// cached token makes no network call. The helper only returns a token that
	// DIFFERS from this caller's current one, so a caller whose own token was just
	// rejected upstream still forces a real refresh.
	const coalesced = getCoalescibleRecentRefresh(
		account.id,
		account.access_token,
	);
	if (coalesced) {
		account.access_token = coalesced.accessToken;
		account.expires_at = coalesced.expiresAt;
		return coalesced.accessToken;
	}

	// Proactively clean expired entries before checking
	cleanupExpiredFailures();

	// Check for recent refresh failures and implement backoff
	const lastFailure = refreshFailures.get(account.id);
	if (lastFailure && Date.now() - lastFailure < TOKEN_REFRESH_BACKOFF_MS) {
		// Increment backoff counter
		const currentCount = backoffCounters.get(account.id) || 0;
		const newCount = currentCount + 1;
		backoffCounters.set(account.id, newCount);

		log.warn(
			`Account ${account.name} is in refresh backoff period (attempt ${newCount})`,
		);

		// After MAX_BACKOFF_RETRIES consecutive backoff hits, check DB for updated tokens
		if (newCount >= MAX_BACKOFF_RETRIES) {
			log.info(
				`Account ${account.name} has hit ${newCount} backoff attempts, checking DB for updated tokens`,
			);

			try {
				// Reload account from database
				const dbAccount = await ctx.dbOps.getAccount(account.id);
				if (dbAccount) {
					// Check if DB has a valid token that we don't have in memory
					const accessTokenFromDb = dbAccount.access_token;
					const expiresAtFromDb = dbAccount.expires_at;
					const hasValidToken =
						typeof accessTokenFromDb === "string" &&
						typeof expiresAtFromDb === "number" &&
						expiresAtFromDb - Date.now() > TOKEN_SAFETY_WINDOW_MS;

					if (hasValidToken && accessTokenFromDb !== account.access_token) {
						log.info(
							`Found updated token in DB for account ${account.name}, updating in-memory account`,
						);

						// Update in-memory account with DB data
						account.access_token = accessTokenFromDb;
						account.expires_at = expiresAtFromDb;
						if (dbAccount.refresh_token) {
							account.refresh_token = dbAccount.refresh_token;
						}
						account.last_used = Date.now();

						// Clear failure records and backoff counter
						refreshFailures.delete(account.id);
						backoffCounters.delete(account.id);

						log.info(
							`Successfully recovered token for account ${account.name} from DB`,
						);
						if (!dbAccount.access_token) {
							throw new TokenRefreshError(
								account.id,
								new Error("DB account has no access token"),
							);
						}
						return dbAccount.access_token;
					} else {
						log.warn(
							`DB token for account ${account.name} is not valid or same as in-memory`,
						);
					}
				} else {
					log.warn(
						`Account ${account.name} not found in DB during backoff recovery`,
					);
				}
			} catch (error) {
				log.error(
					`Failed to check DB for account ${account.name} during backoff recovery`,
					error,
				);
			}
		}

		throw new ServiceUnavailableError(
			`Token refresh for account ${account.name} is in backoff period after recent failure`,
		);
	} else {
		// Not in backoff, reset counter
		backoffCounters.delete(account.id);
	}

	// Re-read the row before firing a refresh: a concurrent refresh or re-auth
	// (possibly in another process sharing this DB) may already have produced
	// fresher credentials. Adopting a valid fresher access token skips the
	// refresh; adopting a rotated refresh token prevents replaying a consumed
	// one (a guaranteed invalid_grant, and family-invalidating on Codex).
	const adoptedToken = await adoptDbTokensIfFresher(account, ctx);
	if (adoptedToken) return adoptedToken;

	// The re-read awaited, so another caller may have registered a refresh in
	// the meantime — join it (with account sync) rather than racing a second
	// rotation.
	const joinedAfterAdopt = await joinInFlightRefresh();
	if (joinedAfterAdopt !== null) return joinedAfterAdopt;

	// A refresh may also have STARTED AND FINISHED entirely inside the re-read
	// window (nothing left to join, but its result is cached) — consume it
	// rather than exchanging a refresh token that rotation just consumed.
	const coalescedAfterReread = getCoalescibleRecentRefresh(
		account.id,
		account.access_token,
	);
	if (coalescedAfterReread) {
		account.access_token = coalescedAfterReread.accessToken;
		account.expires_at = coalescedAfterReread.expiresAt;
		return coalescedAfterReread.accessToken;
	}

	// Check if a refresh is already in progress for this account
	if (!ctx.refreshInFlight.has(account.id)) {
		// Get the provider for this account
		const provider = getProvider(account.provider) || ctx.provider;

		// Snapshot the refresh token this attempt is about to EXCHANGE, before the
		// network round-trip. The persist below is compare-and-swapped on it (the
		// backstop): if a concurrent reauth/rotation installs a new refresh token
		// while this refresh is in flight, the CAS clause no-ops the delayed write
		// so it can't overwrite the fresh credentials with this attempt's
		// stale-generation tokens.
		const exchangedRefreshToken = account.refresh_token;

		// Create a new refresh promise and store it
		const refreshPromise = provider
			.refreshToken(account, ctx.runtime.clientId)
			.then(async (result: TokenRefreshResult) => {
				// Generation stamp for the in-memory refresh token, captured BEFORE
				// the persist: the DB stamps its own now inside the write, and any
				// LATER writer (a re-auth landing while this continuation is queued)
				// stamps later still — so this stamp can never exceed a newer
				// generation's and make the staleness guards reject it as "older".
				const mintedAt = Date.now();
				// A pending rotation means an EARLIER persist threw: the row still
				// holds that entry's anchor, not the token this attempt exchanged, so
				// the CAS has to name the anchor or it would miss and be misread as a
				// supersede. The entry's refresh token also rides along when this
				// refresh minted none of its own — otherwise the write would leave the
				// consumed token in the row.
				const pendingSnapshot = getPendingRotation(account.id);
				const persistAnchor =
					pendingSnapshot?.attemptedRefreshToken ?? exchangedRefreshToken;
				const effectiveRefreshToken =
					result.refreshToken ?? pendingSnapshot?.refreshToken;
				// 1. AWAIT the durable write. The provider has already rotated the
				// refresh token — the old one is dead upstream — so a lost write
				// leaves the DB holding a consumed token whose next replay is an
				// invalid_grant that pauses a healthy account for reauth. The
				// exchanged-token CAS clause (WHERE refresh_token =
				// exchangedRefreshToken) is the backstop that no-ops the write if a
				// concurrent reauth/rotation installed new credentials while this
				// refresh was in flight — so a delayed write can't clobber them.
				let persistOutcome: "persisted" | "superseded" | "failed";
				try {
					persistOutcome = (await ctx.dbOps.updateAccountTokens(
						account.id,
						result.accessToken,
						result.expiresAt,
						effectiveRefreshToken,
						result.identity,
						persistAnchor ?? undefined,
					))
						? "persisted"
						: "superseded";
				} catch (persistError) {
					persistOutcome = "failed";
					// Hold the rotation in memory so a later touchpoint (or the
					// registry's own retry) can still land it; without it the row keeps
					// a token the provider already invalidated.
					recordPendingRotation(
						account.id,
						{
							accessToken: result.accessToken,
							expiresAt: result.expiresAt,
							refreshToken: effectiveRefreshToken,
							identity: result.identity ?? null,
							attemptedRefreshToken: persistAnchor ?? "",
						},
						ctx.dbOps,
					);
					log.error(
						`Failed to persist refreshed tokens for account ${account.name} — serving the in-memory token; the rotated refresh token is NOT durable and is lost on restart`,
						persistError,
					);
				}

				// Clear any previous failure record on successful refresh
				refreshFailures.delete(account.id);

				if (persistOutcome === "persisted" && pendingSnapshot) {
					// The write carried the pending rotation into the row, so the entry
					// is settled; a newer one recorded mid-write survives and is rebased
					// onto the token this write actually put there.
					resolvePendingAfterPersist(
						account.id,
						pendingSnapshot,
						effectiveRefreshToken,
					);
				}

				if (persistOutcome === "superseded") {
					// An anchor-keyed CAS can only miss because the row genuinely moved
					// past the anchor, so this entry (if any) describes a dead
					// generation.
					if (pendingSnapshot) {
						clearPendingRotationIfCurrent(account.id, pendingSnapshot);
					}
					const survivor = getPendingRotation(account.id);
					if (survivor) {
						// A rotation recorded while this write was in flight is newer than
						// anything the row can hold — the registry outranks it.
						installPendingRotationCredentials(account, survivor);
						account.last_used = Date.now();
						if (isPendingAccessTokenServable(survivor)) {
							log.warn(
								`Persist for account ${account.name} was superseded, but a newer unpersisted rotation is live in memory — serving it`,
							);
							return survivor.accessToken;
						}
					}
					// CAS loss: a concurrent rotation or re-auth won and the row holds
					// ITS credentials. The winner may have invalidated this attempt's
					// session family, so adopt and serve the authoritative tokens; the
					// losing token is neither installed nor cached for coalescing.
					log.warn(
						`Skipped persisting refreshed tokens for account ${account.name}: the stored refresh token changed underneath (a concurrent rotation or re-auth won) — adopting the authoritative DB credentials`,
					);
					const authoritative = await adoptAuthoritativeAccountTokens(
						account,
						ctx.dbOps,
					);
					if (authoritative) return authoritative;
					// No servable authoritative ACCESS token. The helper still adopted
					// the winner's refresh token when the row was readable; serve the
					// minted ACCESS token as a last resort for THIS caller, but never
					// install the losing refresh generation into memory — a fresh stamp
					// on it would block later adoption of the winner's token.
					account.access_token = result.accessToken;
					account.expires_at = result.expiresAt;
					account.last_used = Date.now();
					return result.accessToken;
				}

				// 2. Update the live in-memory account object
				// This prevents subsequent requests from seeing stale token data
				account.access_token = result.accessToken;
				account.expires_at = result.expiresAt;
				if (effectiveRefreshToken) {
					account.refresh_token = effectiveRefreshToken;
					account.refresh_token_issued_at = mintedAt;
				}
				account.last_used = Date.now();

				// Record for single-flight coalescing so a near-simultaneous caller
				// reuses this token instead of racing a second (doomed) rotation.
				// Deliberately ALSO on a failed persist: while the DB row is stale,
				// this cache is the only thing masking that doomed replay. (The
				// superseded case returned above — a losing token is never cached.)
				recordRecentRefresh(account.id, result.accessToken, result.expiresAt);

				if (persistOutcome === "persisted") {
					const expiresInSec = Math.round(
						(result.expiresAt - Date.now()) / 1000,
					);
					log.info(`Successfully refreshed token for account: ${account.name}`);
					log.debug(`refresh for ${account.name}:`, {
						expiresInSec,
						newRefreshToken: result.refreshToken !== exchangedRefreshToken,
						provider: account.provider,
					});
				}
				return result.accessToken;
			})
			.catch(async (error) => {
				// Record the failure timestamp for backoff
				refreshFailures.set(account.id, Date.now());
				// Enforce size limit after adding a new entry
				enforceMaxSize();

				const originalError =
					error instanceof Error ? error.message : String(error);
				const enhancedMessage = getOAuthErrorMessage(account, originalError);

				// Carry the invalid_grant classification (from the RAW error, before
				// getOAuthErrorMessage may strip the marker) on the wrapped error so
				// downstream consumers can reliably tell "needs reauth" from transient.
				const isInvalidGrant =
					error instanceof OAuthRefreshTokenError ||
					isInvalidGrantMessage(originalError);
				// Terminal auth failure (revoked/invalid refresh token): pause the
				// account for re-auth immediately so the LB fails over instead of
				// leaving it in rotation to fail every request. Awaited so the pause
				// lands before any caller (e.g. the auto-refresh scheduler) records a
				// generic failure that could otherwise mask the specific reason. The
				// pause is guarded on the stored refresh token still matching the one
				// that failed, so a rotation-race loser (token already rotated) returns
				// false and is NOT paused — that false is our benign-race signal.
				// Keyed on the immutable exchanged-token snapshot, NOT the live
				// account object: a concurrent writer (e.g. the usage poller's
				// pre-poll sync) can install a newer refresh token on the shared
				// object mid-refresh, and pausing against THAT token would match and
				// pause the healthy, freshly-rotated row.
				//
				// A pending rotation changes both questions — WHETHER to pause and
				// WHICH token to key it on — so it is classified first.
				const pendingAtFailure = getPendingRotation(account.id);
				let paused = false;
				let replayedStaleGeneration = false;
				if (
					isInvalidGrant &&
					pendingAtFailure &&
					exchangedRefreshToken !== pendingAtFailure.refreshToken
				) {
					// This attempt exchanged a generation the provider had already
					// replaced (a concurrent rotation is awaiting persist). The account
					// is healthy; pausing it would take a live account out of rotation.
					// The failure record is dropped for the same reason the benign-race
					// branch below drops it.
					replayedStaleGeneration = true;
					refreshFailures.delete(account.id);
					log.info(
						`Token refresh for account ${account.name} exchanged a stale refresh-token generation while a rotation awaits persist; leaving the account active.`,
					);
				} else if (isInvalidGrant && pendingAtFailure) {
					// The LIVE pending token itself was rejected: that generation is dead
					// and must not be retried. The pause is keyed on the ANCHOR — what
					// the row actually holds — or its CAS would miss and leave a dead
					// account in rotation.
					clearPendingRotationIfCurrent(account.id, pendingAtFailure);
					paused = await pauseAccountForReauthIfInvalidGrant(
						error,
						{
							id: account.id,
							name: account.name,
							refresh_token: pendingAtFailure.attemptedRefreshToken,
						},
						ctx.dbOps,
					);
				} else {
					paused = await pauseAccountForReauthIfInvalidGrant(
						error,
						{
							id: account.id,
							name: account.name,
							refresh_token: exchangedRefreshToken,
						},
						ctx.dbOps,
					);
				}
				if (paused) {
					// Genuine terminal auth failure: pauseAccountForReauthIfInvalidGrant
					// already logged an ERROR ("Account ... PAUSED — needs
					// re-authentication"). Don't double-log. Drop any coalesce entry so a
					// later caller doesn't reuse a token from a now-paused account.
					recentRefreshes.delete(account.id);
				} else if (isInvalidGrant && !replayedStaleGeneration) {
					// Terminal-looking auth error but the account was NOT newly flagged:
					// the stored refresh token no longer matches the one this attempt
					// used — a concurrent refresh already rotated it (benign race loser),
					// or the account is already paused/reauthed. Not actionable; log
					// quietly instead of alarming. Also drop the failure record recorded
					// at the top of this catch: a superseded/benign loser must not leave a
					// backoff entry that would reject the next legitimate refresh with
					// ServiceUnavailable.
					refreshFailures.delete(account.id);
					log.info(
						`Token refresh for account ${account.name} was not newly flagged for reauth (a concurrent refresh already rotated the token, or the account is already paused); leaving its state unchanged.`,
					);
				} else if (!isInvalidGrant) {
					// Non-auth transient failure (network / 5xx / unexpected). Keep prior
					// visibility.
					log.error(
						`Token refresh failed for account ${account.name}: ${enhancedMessage}`,
						error,
					);
				}
				throw new TokenRefreshError(
					account.id,
					new Error(enhancedMessage),
					isInvalidGrant,
				);
			})
			.finally(() => {
				// Clean up the map when done (success or failure). Identity-guarded:
				// a reauth-triggered clearAccountRefreshCache may have dropped this
				// entry and a NEWER refresh registered its own — this promise must
				// not delete that one.
				if (ctx.refreshInFlight.get(account.id) === refreshPromise) {
					ctx.refreshInFlight.delete(account.id);
				}
			});
		ctx.refreshInFlight.set(account.id, refreshPromise);
	}

	// Await the existing or new refresh promise — via the join helper so a
	// caller that lost the create race during the pre-refresh re-read still gets
	// its account snapshot synced to the winner's fresh token.
	const finalToken = await joinInFlightRefresh();
	if (finalToken === null) {
		throw new ServiceUnavailableError(
			`${ERROR_MESSAGES.REFRESH_NOT_FOUND} ${account.id}`,
		);
	}
	return finalToken;
}

// Global registry for account refresh clearing functions
const refreshClearers: Map<string, (accountId: string) => void> = new Map();

// Global registry for session-affinity clearing functions (one per server).
// Each clearer wipes the affinity pins pointing at an account inside that
// server's in-memory load-balancing strategy.
const affinityClearers: Map<string, (accountId: string) => number> = new Map();

// Global registry for usage polling restart functions
const pollingRestarters: Map<string, (accountId: string) => Promise<boolean>> =
	new Map();

export interface CodexUsageRefreshOutcome {
	success: boolean;
	message: string;
}

export type CodexResetCreditConsumeDispatchOutcome =
	| {
			status: "completed";
			accountName: string;
			result: CodexRateLimitResetCreditConsumeResult;
			resetMetadataRefreshed: boolean;
			availableResetCount: number | null;
			localRateLimitStateCleared: boolean;
	  }
	| { status: "failed"; message: string };

// Global registry for codex on-demand usage refreshers (one per server). The
// manual "Refresh usage" click dispatches here; the registered refresher reads
// the FREE `GET /wham/usage` status (zero quota) — it does not spend.
const codexUsageRefreshers: Map<
	string,
	(accountId: string) => Promise<CodexUsageRefreshOutcome>
> = new Map();

// Per-account in-flight tracker so concurrent requests share a single fetch.
const codexUsageInflight: Map<
	string,
	Promise<CodexUsageRefreshOutcome>
> = new Map();

// Read-only earned-reset metadata refreshers (one per server). Kept separate
// from codexUsageRefreshers because it targets a different free endpoint
// (`/rate-limit-reset-credits`); neither spends model quota.
const codexResetCreditsRefreshers: Map<
	string,
	(accountId: string) => Promise<CodexUsageRefreshOutcome>
> = new Map();
const codexResetCreditsInflight = new Map<
	string,
	Promise<CodexUsageRefreshOutcome>
>();

// Reset consumption is a state-changing operation. The registry dispatches to
// one server at a time and reuses the caller's idempotency key if it must fail
// over to another server after an ambiguous transport failure.
const codexResetCreditConsumers = new Map<
	string,
	(
		accountId: string,
		request: CodexRateLimitResetCreditConsumeRequest,
	) => Promise<CodexResetCreditConsumeDispatchOutcome>
>();
interface CodexResetCreditConsumeInflight {
	idempotencyKey: string;
	promise: Promise<CodexResetCreditConsumeDispatchOutcome>;
}
const codexResetCreditConsumeInflight = new Map<
	string,
	CodexResetCreditConsumeInflight
>();

/**
 * Register a function to restart usage polling for a specific account.
 * Used by the server to expose its polling restart capability to HTTP handlers.
 */
export function registerPollingRestarter(
	serverId: string,
	restarter: (accountId: string) => Promise<boolean>,
): void {
	pollingRestarters.set(serverId, restarter);
}

/**
 * Restart usage polling for an account across all registered servers.
 * Returns true if at least one server successfully restarted polling.
 */
export async function restartUsagePollingForAccount(
	accountId: string,
): Promise<boolean> {
	let anySuccess = false;
	for (const [serverId, restarter] of pollingRestarters) {
		try {
			const ok = await restarter(accountId);
			if (ok) {
				anySuccess = true;
				log.info(
					`Restarted usage polling for account ${accountId} on server ${serverId}`,
				);
			}
		} catch (error) {
			log.error(
				`Failed to restart usage polling for account ${accountId} on server ${serverId}:`,
				error,
			);
		}
	}
	return anySuccess;
}

/**
 * Register a function that performs an on-demand codex usage refresh for a
 * given account. The server registers a callback that has access to its
 * proxy context so token refresh + DB updates can run via the normal path.
 */
export function registerCodexUsageRefresher(
	serverId: string,
	refresher: (accountId: string) => Promise<CodexUsageRefreshOutcome>,
): void {
	codexUsageRefreshers.set(serverId, refresher);
}

/**
 * Unregister a previously registered codex usage refresher.
 */
export function unregisterCodexUsageRefresher(serverId: string): void {
	codexUsageRefreshers.delete(serverId);
}

export function registerCodexResetCreditsRefresher(
	serverId: string,
	refresher: (accountId: string) => Promise<CodexUsageRefreshOutcome>,
): void {
	codexResetCreditsRefreshers.set(serverId, refresher);
}

export function unregisterCodexResetCreditsRefresher(serverId: string): void {
	codexResetCreditsRefreshers.delete(serverId);
}

export function registerCodexResetCreditConsumer(
	serverId: string,
	consumer: (
		accountId: string,
		request: CodexRateLimitResetCreditConsumeRequest,
	) => Promise<CodexResetCreditConsumeDispatchOutcome>,
): void {
	codexResetCreditConsumers.set(serverId, consumer);
}

export function unregisterCodexResetCreditConsumer(serverId: string): void {
	codexResetCreditConsumers.delete(serverId);
}

/**
 * Consume one earned reset through exactly one registered proxy server.
 * Concurrent retries of the same account/idempotency key share one attempt.
 */
export async function consumeCodexResetCreditForAccount(
	accountId: string,
	request: CodexRateLimitResetCreditConsumeRequest,
): Promise<CodexResetCreditConsumeDispatchOutcome> {
	const existing = codexResetCreditConsumeInflight.get(accountId);
	if (existing) {
		if (existing.idempotencyKey === request.idempotencyKey) {
			return existing.promise;
		}
		return {
			status: "failed",
			message:
				"Another reset-credit consume attempt is already in progress for this account; refresh metadata before retrying.",
		};
	}

	const promise =
		(async (): Promise<CodexResetCreditConsumeDispatchOutcome> => {
			if (codexResetCreditConsumers.size === 0) {
				return {
					status: "failed",
					message:
						"No proxy server is registered to consume Codex reset credits.",
				};
			}

			let lastFailure: CodexResetCreditConsumeDispatchOutcome | null = null;
			for (const [serverId, consumer] of codexResetCreditConsumers) {
				try {
					const outcome = await consumer(accountId, request);
					if (outcome.status === "completed") {
						log.info(
							`Consumed Codex reset credit for account ${accountId} via server ${serverId} (outcome: ${outcome.result.outcome})`,
						);
						return outcome;
					}
					lastFailure = outcome;
				} catch (error) {
					log.error(
						`Codex reset-credit consume via server ${serverId} threw for account ${accountId}:`,
						error,
					);
					lastFailure = {
						status: "failed",
						message: error instanceof Error ? error.message : String(error),
					};
				}
			}
			return (
				lastFailure ?? {
					status: "failed",
					message: "Codex reset-credit consume failed for unknown reasons.",
				}
			);
		})();

	const entry: CodexResetCreditConsumeInflight = {
		idempotencyKey: request.idempotencyKey,
		promise,
	};
	codexResetCreditConsumeInflight.set(accountId, entry);
	void promise.finally(() => {
		if (codexResetCreditConsumeInflight.get(accountId) === entry) {
			codexResetCreditConsumeInflight.delete(accountId);
		}
	});
	return promise;
}

/**
 * Refresh earned reset metadata through one registered proxy server. Concurrent
 * dashboard polls for the same account share a single read-only request.
 */
export async function refreshCodexResetCreditsForAccount(
	accountId: string,
): Promise<CodexUsageRefreshOutcome> {
	const existing = codexResetCreditsInflight.get(accountId);
	if (existing) return existing;

	const promise = (async (): Promise<CodexUsageRefreshOutcome> => {
		if (codexResetCreditsRefreshers.size === 0) {
			return {
				success: false,
				message:
					"No proxy server is registered to refresh Codex reset metadata.",
			};
		}

		let lastFailure: CodexUsageRefreshOutcome | null = null;
		for (const [serverId, refresher] of codexResetCreditsRefreshers) {
			try {
				const result = await refresher(accountId);
				if (result.success) {
					log.debug(
						`Refreshed Codex reset metadata for account ${accountId} via server ${serverId}`,
					);
					return result;
				}
				lastFailure = result;
			} catch (error) {
				log.error(
					`Codex reset metadata refresh via server ${serverId} threw for account ${accountId}:`,
					error,
				);
				lastFailure = {
					success: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		}
		return (
			lastFailure ?? {
				success: false,
				message: "Codex reset metadata refresh failed for unknown reasons.",
			}
		);
	})();

	codexResetCreditsInflight.set(accountId, promise);
	void promise.finally(() => {
		if (codexResetCreditsInflight.get(accountId) === promise) {
			codexResetCreditsInflight.delete(accountId);
		}
	});
	return promise;
}

/**
 * Refresh codex usage data for an account by dispatching to a registered
 * server. Iterates serverId-keyed callbacks **sequentially** and returns the
 * first successful outcome — we never fan-out because every call costs a
 * real codex request. Concurrent callers for the same accountId share a
 * single in-flight promise.
 */
export async function refreshCodexUsageForAccount(
	accountId: string,
): Promise<CodexUsageRefreshOutcome> {
	const existing = codexUsageInflight.get(accountId);
	if (existing) {
		log.debug(`Reusing in-flight codex usage refresh for account ${accountId}`);
		return existing;
	}

	const promise = (async (): Promise<CodexUsageRefreshOutcome> => {
		if (codexUsageRefreshers.size === 0) {
			return {
				success: false,
				message: "No proxy server is registered to handle codex usage refresh.",
			};
		}

		let lastFailure: CodexUsageRefreshOutcome | null = null;
		for (const [serverId, refresher] of codexUsageRefreshers) {
			try {
				const result = await refresher(accountId);
				if (result.success) {
					log.info(
						`Refreshed codex usage for account ${accountId} via server ${serverId}`,
					);
					return result;
				}
				lastFailure = result;
			} catch (error) {
				log.error(
					`Codex usage refresh via server ${serverId} threw for account ${accountId}:`,
					error,
				);
				lastFailure = {
					success: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		}
		return (
			lastFailure ?? {
				success: false,
				message: "Codex usage refresh failed for unknown reasons.",
			}
		);
	})();

	codexUsageInflight.set(accountId, promise);
	promise.finally(() => {
		codexUsageInflight.delete(accountId);
	});
	return promise;
}

/**
 * Register a function to clear refresh cache for a specific account
 * Used by the server to register its refresh clearing capability
 */
export function registerRefreshClearer(
	serverId: string,
	clearer: (accountId: string) => void,
): void {
	refreshClearers.set(serverId, clearer);
}

/**
 * Clear refresh cache for an account across all registered servers
 */
export function clearAccountRefreshCache(accountId: string): void {
	// Clear module-level backoff/failure state for this account (not per-server)
	// so a just-re-authenticated account can immediately attempt a fresh refresh
	// instead of waiting out the backoff window.
	refreshFailures.delete(accountId);
	backoffCounters.delete(accountId);
	// Drop any coalesce-cached token so a stale token from before reauth is never
	// served after new credentials are installed.
	recentRefreshes.delete(accountId);
	for (const [serverId, clearer] of refreshClearers) {
		try {
			clearer(accountId);
			log.info(
				`Cleared refresh cache for account ${accountId} on server ${serverId}`,
			);
		} catch (error) {
			log.error(
				`Failed to clear refresh cache for account ${accountId} on server ${serverId}:`,
				error,
			);
		}
	}
}

/**
 * Register a function that clears session-affinity pins for a specific account.
 * Used by the server to expose its load-balancing strategy's
 * clearAffinityForAccount capability to HTTP handlers.
 */
export function registerAffinityClearer(
	serverId: string,
	fn: (accountId: string) => number,
): void {
	affinityClearers.set(serverId, fn);
}

/**
 * Clear session-affinity pins for an account across all registered servers.
 * Returns the total number of pins cleared (summed across servers).
 */
export function clearAccountAffinity(accountId: string): number {
	let total = 0;
	for (const [serverId, clearer] of affinityClearers) {
		try {
			const cleared = clearer(accountId);
			total += cleared;
			if (cleared > 0) {
				log.info(
					`Cleared ${cleared} affinity pin(s) for account ${accountId} on server ${serverId}`,
				);
			}
		} catch (error) {
			log.error(
				`Failed to clear affinity pins for account ${accountId} on server ${serverId}:`,
				error,
			);
		}
	}
	return total;
}

/**
 * Internal function to clear refresh cache with specific context
 * This is what the server registers as its clearer function
 */
function _clearAccountRefreshCacheWithContext(
	accountId: string,
	ctx: ProxyContext,
): void {
	// Clear any in-flight refresh for this account
	ctx.refreshInFlight.delete(accountId);

	// Clear refresh failure records and backoff
	refreshFailures.delete(accountId);
	backoffCounters.delete(accountId);

	log.info(`Cleared refresh cache for account ${accountId}`);
}

/**
 * Gets a valid access token for an account, refreshing if necessary
 * @param account - The account to get token for
 * @param ctx - The proxy context
 * @returns Promise resolving to a valid access token
 */
export async function getValidAccessToken(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// For API key providers, return the API key directly without OAuth token refresh logic
	if (
		account.provider === "openai-compatible" ||
		account.provider === "zai" ||
		account.provider === "claude-console-api" ||
		account.provider === "anthropic-compatible" ||
		account.provider === "minimax"
	) {
		if (account.api_key) {
			return account.api_key;
		}
		throw new Error(`No API key available for account ${account.name}`);
	}

	// API key accounts don't use access tokens
	if (!account.refresh_token && account.api_key) {
		// Return empty string - the API key will be used in prepareHeaders
		return "";
	}

	// Check if token exists and won't expire within the safety window
	if (
		account.access_token &&
		account.expires_at &&
		account.expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS
	) {
		return account.access_token;
	}

	// Check refresh token health before attempting refresh
	const tokenHealth = checkRefreshTokenHealth(account);

	// Log token health warnings for OAuth accounts
	if (tokenHealth.hasRefreshToken) {
		if (tokenHealth.status === "expired" || tokenHealth.status === "critical") {
			log.error(`🚨 ${tokenHealth.message}`);
		} else if (tokenHealth.status === "warning") {
			log.warn(`⚠️ ${tokenHealth.message}`);
		}
	}

	// Token is expired, missing, or will expire soon
	const reason = !account.access_token
		? "missing"
		: !account.expires_at
			? "no expiry"
			: account.expires_at <= Date.now()
				? "expired"
				: "expiring soon";

	log.info(`Token ${reason} for account: ${account.name}`);
	return await refreshAccessTokenSafe(account, ctx);
}
