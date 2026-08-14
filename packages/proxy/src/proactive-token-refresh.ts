import {
	isInvalidGrantMessage,
	OAuthRefreshTokenError,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { Provider } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import { TOKEN_SAFETY_WINDOW_MS } from "./constants";
import {
	clearPendingRotationIfCurrent,
	flushPendingRotation,
	getPendingRotation,
	recordPendingRotation,
	resolvePendingAfterPersist,
} from "./handlers/pending-rotation-registry";
import {
	adoptAuthoritativeAccountTokens,
	getCoalescibleRecentRefresh,
	pauseAccountForReauthIfInvalidGrant,
	recordRecentRefresh,
	retryPersistOnOwnFlushedRotation,
} from "./handlers/token-manager";
import type { ProxyContext } from "./proxy";

const log = new Logger("ProactiveTokenRefresh");

/** The columns both proactive-refresh eligibility queries select. */
export interface ProactiveRefreshRow {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	custom_endpoint: string | null;
}

export type ProactiveRefreshOutcome =
	| {
			status: "skipped";
			reason: "pending-rotation" | "in-flight" | "coalesced";
	  }
	| { status: "refreshed"; accessToken: string }
	| { status: "failed"; error: unknown };

export interface ProactiveTokenRefreshParams {
	row: ProactiveRefreshRow;
	provider: Provider;
	/** Human-readable provider name for the log lines ("Qwen", "Codex"). */
	providerLabel: string;
	proxyContext: ProxyContext;
}

/**
 * Refresh ONE account's OAuth access token outside the request path.
 *
 * Shared by the proactive Qwen and Codex refreshers: both select rows whose
 * access token is expiring, then hand each row to this core. It calls
 * `provider.refreshToken` directly (not `refreshAccessTokenSafe`), so it owns
 * the same responsibilities the request path has — the pending-rotation
 * registry, the anchor-keyed persist CAS, invalid_grant classification and the
 * shared coalesce cache — rather than inheriting them.
 */
export async function refreshProactiveAccountToken({
	row,
	provider,
	providerLabel,
	proxyContext,
}: ProactiveTokenRefreshParams): Promise<ProactiveRefreshOutcome> {
	// Skip if a refresh is already in-flight for this account (deduplication).
	// Checked BEFORE the flush below: that refresh owns this account's next
	// anchor-keyed write, so flushing underneath it would race its own persist.
	if (proxyContext.refreshInFlight.has(row.id)) {
		log.debug(
			`Skipping proactive ${providerLabel} refresh for ${row.name} — refresh already in-flight`,
		);
		return { status: "skipped", reason: "in-flight" };
	}

	// Land any pending rotation before touching the provider. Whatever the
	// outcome, this row is not refreshable this tick: "persisted"/"superseded"
	// mean its refresh token was just consumed or replaced (replaying it can trip
	// provider reuse detection), and "failed" means the registry — not the row —
	// holds the live generation.
	const { outcome: flushOutcome } = await flushPendingRotation(
		row.id,
		proxyContext.dbOps,
	);
	if (flushOutcome !== "none") {
		log.info(
			`Skipping proactive ${providerLabel} refresh for ${row.name} — a pending refresh-token rotation flush reported "${flushOutcome}"; the row's refresh token is not the live generation.`,
		);
		return { status: "skipped", reason: "pending-rotation" };
	}

	const account: Account = {
		id: row.id,
		name: row.name,
		provider: row.provider,
		api_key: null,
		refresh_token: row.refresh_token,
		access_token: row.access_token,
		expires_at: row.expires_at,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		codex_auto_apply_reset_on_weekly_limit_enabled: false,
		custom_endpoint: row.custom_endpoint,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		notes: null,
		refresh_token_issued_at: null,
		renewal_anchor: null,
		renewal_cadence: null,
		renewal_price_usd_micros: null,
		renewal_auto_start_date: null,
		identity_external_id: null,
		identity_email: null,
		identity_organization_name: null,
		identity_plan_tier: null,
		identity_rate_limit_tier: null,
		identity_captured_at: null,
		identity_profile_fetched_at: null,
		consecutive_rate_limits: 0,
	};

	// Coalesce skip: a near-simultaneous refresh (this proactive path shares
	// token-manager's module-level cache) already produced a fresh token. Reuse it
	// rather than racing a second rotation that would fail as invalid_grant
	// against the just-invalidated old token.
	if (getCoalescibleRecentRefresh(row.id, account.access_token)) {
		log.debug(
			`Proactive refresh for ${row.name} skipped — a concurrent refresh already produced a fresh token`,
		);
		return { status: "skipped", reason: "coalesced" };
	}

	// Snapshot the refresh token this attempt will EXCHANGE so the persist below
	// can compare-and-swap on it (the backstop; see updateAccountTokens).
	const exchangedRefreshToken = row.refresh_token;

	log.info(`Refreshing ${providerLabel} token for account: ${row.name}`);

	try {
		// Register in refreshInFlight so concurrent request-triggered refreshes join
		// this one.
		const refreshPromise = provider
			.refreshToken(account, proxyContext.runtime.clientId)
			.then(async (result) => {
				// A rotation recorded while this exchange was in flight means the row
				// still holds ITS anchor, so the CAS must name that; its refresh token
				// also rides along when this refresh minted none of its own. With
				// nothing pending the row's own token is the fallback — Qwen's refresh
				// echoes rather than rotates, and the write must not blank the column.
				const pendingSnapshot = getPendingRotation(row.id);
				const persistAnchor =
					pendingSnapshot?.attemptedRefreshToken ?? exchangedRefreshToken;
				const effectiveRefreshToken =
					result.refreshToken ??
					pendingSnapshot?.refreshToken ??
					row.refresh_token;
				// What a CONCURRENT flush of that same entry writes into the row — the
				// entry's own refresh token, or its anchor when it carries none. A CAS
				// miss that finds exactly this token in the row was caused by OUR OWN
				// rotation landing, not by another writer (see the retry below).
				const pendingWrittenToken =
					pendingSnapshot?.refreshToken ??
					pendingSnapshot?.attemptedRefreshToken;

				// AWAIT the durable write via the canonical token-write path, which
				// COALESCE-merges identity (a null from a refresh lacking an id_token
				// never erases a previously-captured value; identity_captured_at
				// advances only when identity is present) and stamps
				// refresh_token_issued_at. Awaited so a proactive rotation is persisted
				// before we report success — a full/dropped writer queue must never
				// silently lose the rotated refresh token.
				let persisted: boolean;
				try {
					persisted = await proxyContext.dbOps.updateAccountTokens(
						row.id,
						result.accessToken,
						result.expiresAt,
						effectiveRefreshToken,
						result.identity ?? null,
						persistAnchor ?? undefined,
					);
				} catch (persistError) {
					// The provider already rotated, so this is a COMPLETED rotation with
					// a failed write, not a refresh failure: hold it in the registry and
					// resolve with the minted token rather than throwing into the catch
					// below (which would mislabel it and count a failure).
					recordPendingRotation(
						row.id,
						{
							accessToken: result.accessToken,
							expiresAt: result.expiresAt,
							refreshToken: effectiveRefreshToken,
							identity: result.identity ?? null,
							attemptedRefreshToken: persistAnchor ?? "",
						},
						proxyContext.dbOps,
					);
					log.error(
						`Failed to persist the proactive ${providerLabel} token refresh for ${row.name} — serving the in-memory token; the rotated refresh token is NOT durable and is lost on restart`,
						persistError,
					);
					recordRecentRefresh(row.id, result.accessToken, result.expiresAt);
					return result.accessToken;
				}

				if (!persisted) {
					// An anchor-keyed CAS misses either because the row genuinely moved
					// past the anchor — this entry (if any) then describes a dead
					// generation — or because our OWN pending rotation landed while this
					// write was in flight (handled by the re-anchored retry below).
					if (pendingSnapshot) {
						clearPendingRotationIfCurrent(row.id, pendingSnapshot);
					}
					let survivor = getPendingRotation(row.id);
					let recovered = false;
					if (!survivor && pendingWrittenToken) {
						const retry = await retryPersistOnOwnFlushedRotation(
							{ id: row.id, name: row.name },
							proxyContext.dbOps,
							{
								pendingWrittenToken,
								accessToken: result.accessToken,
								expiresAt: result.expiresAt,
								refreshToken: effectiveRefreshToken,
								identity: result.identity ?? null,
							},
						);
						if (retry.outcome === "persisted") {
							recovered = true;
						} else if (retry.outcome === "failed") {
							// Same handling as a first-attempt write failure, but anchored on
							// what the row holds NOW: the token our own flush put there.
							recordPendingRotation(
								row.id,
								{
									accessToken: result.accessToken,
									expiresAt: result.expiresAt,
									refreshToken: effectiveRefreshToken,
									identity: result.identity ?? null,
									attemptedRefreshToken: pendingWrittenToken,
								},
								proxyContext.dbOps,
							);
							log.error(
								`Failed to persist the proactive ${providerLabel} token refresh for ${row.name} — serving the in-memory token; the rotated refresh token is NOT durable and is lost on restart`,
								retry.error,
							);
							recordRecentRefresh(row.id, result.accessToken, result.expiresAt);
							return result.accessToken;
						} else if (retry.outcome === "superseded") {
							// The retry awaited too, so re-check for a rotation recorded
							// since: it would outrank whatever the row holds.
							survivor = getPendingRotation(row.id);
						}
					}
					if (!recovered) {
						if (
							survivor &&
							survivor.expiresAt - Date.now() > TOKEN_SAFETY_WINDOW_MS
						) {
							// A rotation recorded while this write was in flight is newer than
							// anything the row can hold — the registry outranks it.
							log.warn(
								`Proactive ${providerLabel} token persist for ${row.name} was superseded, but a newer unpersisted rotation is live in memory — serving it`,
							);
							return survivor.accessToken;
						}
						// CAS loss: a concurrent rotation or re-auth won. Don't cache or
						// claim success for the losing token; hand any joiners the
						// authoritative credentials instead (the winner may have
						// invalidated this attempt's session family).
						log.warn(
							`Proactive ${providerLabel} token persist for ${row.name} was superseded by a concurrent rotation or re-auth — adopting the authoritative DB credentials`,
						);
						const authoritative = await adoptAuthoritativeAccountTokens(
							account,
							proxyContext.dbOps,
						);
						return authoritative ?? result.accessToken;
					}
				}

				if (pendingSnapshot) {
					// This write carried the pending rotation into the row; a newer entry
					// recorded mid-write survives, rebased onto what was written.
					resolvePendingAfterPersist(
						row.id,
						pendingSnapshot,
						effectiveRefreshToken,
					);
				}
				// Feed the shared coalesce cache so a near-simultaneous
				// request-triggered refresh reuses this token instead of racing.
				recordRecentRefresh(row.id, result.accessToken, result.expiresAt);
				log.info(
					`${providerLabel} token refreshed for ${row.name}, expires at ${new Date(result.expiresAt).toISOString()}`,
				);
				return result.accessToken;
			})
			.finally(() => {
				// Identity-guarded: a reauth-triggered cache clear may have dropped
				// this entry and a newer refresh registered its own.
				if (proxyContext.refreshInFlight.get(row.id) === refreshPromise) {
					proxyContext.refreshInFlight.delete(row.id);
				}
			});

		proxyContext.refreshInFlight.set(row.id, refreshPromise);
		const accessToken = await refreshPromise;
		return { status: "refreshed", accessToken };
	} catch (error) {
		// This proactive path calls provider.refreshToken directly (bypassing
		// refreshAccessTokenSafe), so classify + pause-for-reauth here too, and
		// gate the log so a benign race loser doesn't alarm.
		const isInvalidGrant =
			error instanceof OAuthRefreshTokenError ||
			isInvalidGrantMessage(
				error instanceof Error ? error.message : String(error),
			);
		const pendingAtFailure = getPendingRotation(row.id);
		// The LIVE generation an entry describes: its own rotated token, or — for an
		// entry recorded from an echo/non-rotating refresh, which carries none — the
		// anchor itself. Falling back to the anchor is what keeps a genuinely
		// revoked token from being classified as a benign stale replay forever (an
		// `undefined` refresh token never matches).
		const pendingGeneration =
			pendingAtFailure?.refreshToken ?? pendingAtFailure?.attemptedRefreshToken;
		if (
			isInvalidGrant &&
			pendingAtFailure &&
			exchangedRefreshToken !== pendingGeneration
		) {
			// This attempt exchanged a generation the provider had already replaced
			// (a concurrent rotation is awaiting persist). The account is healthy.
			log.info(
				`Proactive ${providerLabel} refresh for ${row.name} exchanged a stale refresh-token generation while a rotation awaits persist; leaving it active.`,
			);
			return { status: "failed", error };
		}
		let paused: boolean;
		if (isInvalidGrant && pendingAtFailure) {
			// The LIVE pending token itself was rejected: that generation is dead and
			// must not be retried. The pause is keyed on the ANCHOR — what the row
			// actually holds — or its CAS would miss.
			clearPendingRotationIfCurrent(row.id, pendingAtFailure);
			paused = await pauseAccountForReauthIfInvalidGrant(
				error,
				{
					id: row.id,
					name: row.name,
					refresh_token: pendingAtFailure.attemptedRefreshToken,
				},
				proxyContext.dbOps,
			);
		} else {
			paused = await pauseAccountForReauthIfInvalidGrant(
				error,
				{ id: row.id, name: row.name, refresh_token: row.refresh_token },
				proxyContext.dbOps,
			);
		}
		if (paused) {
			// pauseAccountForReauthIfInvalidGrant already logged the reauth error.
		} else if (isInvalidGrant) {
			log.info(
				`Proactive ${providerLabel} refresh for ${row.name} was superseded by a concurrent refresh or the account is already flagged; leaving it active.`,
			);
		} else {
			log.error(
				`Failed to proactively refresh ${providerLabel} token for ${row.name}:`,
				error,
			);
		}
		return { status: "failed", error };
	}
}
